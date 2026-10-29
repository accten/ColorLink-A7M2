import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import * as Linking from 'expo-linking';
import React, { useCallback, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';

import { eventLog } from '@/core/log';
import { AI_PROVIDERS, effectiveAiConfig, findProvider, normalizeAiBaseUrl } from '@/core/aiProvider';
import { PREVIEW_SECONDS_OPTIONS, previewSecondsLabel } from '@/core/capturePreview';
import { CAPTURE_TARGET_OPTIONS } from '@/core/captureTarget';
import { Button, Card, Banner, Hairline, Label, Row, Screen, Segmented, Sheet, T } from '@/design/ui';
import { color, radius, space, typography } from '@/design/tokens';
import { logFile, writeTextAtomic } from '@/services/paths';
import {
  EXPORT_QUALITY_OPTIONS,
  EXPORT_SIZE_OPTIONS,
  exportQualityLabel,
  exportSizeLabel,
  maskKey,
} from '@/services/settings';
import { probeAiConnection } from '@/services/aiClient';
import { isUsbTransportAvailable } from '@/services/camera/usb';
import { CAPTURE_DESTINATION_PROBES, CAPTURE_HANDLE_PROBES, PROBE_PRESETS, PROBE_SEQUENCE, formatProbeResult, probeVendorOp, type ProbeResult } from '@/services/camera/sonyProbe';
import { useAppStore } from '@/state/useAppStore';

// 版本号只有 app.json 一处来源，避免界面上写死后忘了改
const appVersion = Constants.expoConfig?.version ?? '—';

export default function SettingsScreen() {
  const settings = useAppStore((s) => s.settings);
  const assets = useAppStore((s) => s.assets);
  const apiKey = useAppStore((s) => s.apiKey);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const saveKey = useAppStore((s) => s.saveKey);
  const removeKey = useAppStore((s) => s.removeKey);
  const notify = useAppStore((s) => s.notify);
  const connectCamera = useAppStore((s) => s.connectCamera);

  const [keySheet, setKeySheet] = useState(false);
  const [draftKey, setDraftKey] = useState('');
  const [logSheet, setLogSheet] = useState(false);
  const [logText, setLogText] = useState('');
  const [probeSheet, setProbeSheet] = useState(false);
  const [probeBusy, setProbeBusy] = useState(false);
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);
  const [sequenceText, setSequenceText] = useState('');
  const [providerSheet, setProviderSheet] = useState(false);
  const [editField, setEditField] = useState<'baseUrl' | 'model' | null>(null);
  const [draftField, setDraftField] = useState('');
  const [testingAi, setTestingAi] = useState(false);

  const usbReady = isUsbTransportAvailable();
  const thumbCount = assets.filter((a) => (a.thumbUri ?? '').includes('/thumbs/')).length;
  /** 设置页展示的"最终生效配置"（供应商默认 + 用户覆盖） */
  const aiConfig = useMemo(() => effectiveAiConfig(settings), [settings]);

  const openKeySheet = useCallback(() => {
    setDraftKey('');
    setKeySheet(true);
  }, []);

  const commitKey = useCallback(async () => {
    const value = draftKey.trim();
    if (!aiConfig.requiresKey && !value) {
      // 本地模型不填 Key 也可以，直接关掉
      setKeySheet(false);
      return;
    }
    if (value.length < 4) {
      notify('warn', 'Key 看起来太短，请粘贴完整的 API Key');
      return;
    }
    await saveKey(value);
    setKeySheet(false);
  }, [aiConfig.requiresKey, draftKey, notify, saveKey]);

  const selectProvider = useCallback(
    async (providerId: string) => {
      setProviderSheet(false);
      // 换供应商时清空地址/模型覆盖，回到该供应商的默认值
      await updateSettings({ aiProviderId: providerId, aiBaseUrl: '', aiModel: '' });
      const provider = findProvider(providerId);
      notify('ok', `已切换到 ${provider.name}`);
    },
    [notify, updateSettings],
  );

  const openEdit = useCallback(
    (field: 'baseUrl' | 'model') => {
      setDraftField(field === 'baseUrl' ? aiConfig.baseUrl : aiConfig.model);
      setEditField(field);
    },
    [aiConfig.baseUrl, aiConfig.model],
  );

  const commitEdit = useCallback(async () => {
    if (!editField) return;
    const text = draftField.trim();

    if (editField === 'baseUrl') {
      const normalized = normalizeAiBaseUrl(text);
      if (text && !normalized) {
        notify('warn', '请求地址无效：只支持 http/https');
        return;
      }
      await updateSettings({ aiBaseUrl: normalized });
      notify('ok', normalized ? `请求地址已保存：${normalized}` : `已恢复 ${aiConfig.providerName} 的默认地址`);
    } else {
      await updateSettings({ aiModel: text });
      notify('ok', text ? `模型已保存：${text}` : `已恢复 ${aiConfig.providerName} 的默认模型`);
    }
    setEditField(null);
  }, [aiConfig.providerName, draftField, editField, notify, updateSettings]);

  const runAiTest = useCallback(async () => {
    if (testingAi) return;
    setTestingAi(true);
    try {
      const state = useAppStore.getState();
      const config = effectiveAiConfig(state.settings);
      const result = await probeAiConnection(config, state.apiKey);
      notify(result.ok ? 'ok' : 'danger', result.message);
      eventLog.info('ai.test', { ok: result.ok, provider: config.providerId, latencyMs: result.latencyMs });
    } finally {
      setTestingAi(false);
    }
  }, [notify, testingAi]);

  const openProviderDocs = useCallback(() => {
    const docs = aiConfig.provider.docs;
    if (!docs) {
      notify('warn', '该供应商没有登记文档地址');
      return;
    }
    void Linking.openURL(docs).catch(() => notify('warn', '无法打开浏览器'));
  }, [aiConfig.provider.docs, notify]);

  const exportLogs = useCallback(async () => {
    try {
      const text = eventLog.toText();
      const file = logFile(`colorlink-${Date.now()}.log`);
      await writeTextAtomic(file, text);
      notify('ok', `日志已写入 ${file.uri}`);
    } catch (error) {
      notify('danger', `日志写入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [notify]);

  /** 确保 USB 联机处于 ready/live：断了就重连，最多等 6 秒 */
  const ensureConnected = useCallback(async () => {
    const isReady = () => {
      const phase = useAppStore.getState().camera.phase;
      return phase === 'ready' || phase === 'live';
    };
    if (isReady()) return true;
    await connectCamera('usb');
    for (let i = 0; i < 20; i += 1) {
      if (isReady()) return true;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return isReady();
  }, [connectCamera]);

  const runProbe = useCallback(
    async (op: number, params: number[], dataHex?: string) => {
      setProbeBusy(true);
      await ensureConnected();
      const result = await probeVendorOp(op, params, dataHex);
      setProbeResult(result);
      setProbeBusy(false);
    },
    // ensureConnected 只依赖 store，不需重新创建
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /**
   * 探测序列：每条之前自动确保联机。
   *
   * A7M2 对未实现的操作会直接不回包（USB 读超时、管线被打断），之后必须先重连；
   * 手动一条条点很容易在"已断开"的状态下白试，所以这里统一重连 + 逐条执行 + 汇总。
   */
  const runProbeSequence = useCallback(async () => {
    setProbeBusy(true);
    const lines: string[] = [];
    for (const preset of PROBE_SEQUENCE) {
      const ready = await ensureConnected();
      if (!ready) {
        lines.push(`${preset.label}: 未联机，跳过`);
        continue;
      }
      const result = await probeVendorOp(preset.op, preset.params);
      lines.push(`${preset.label}: ${formatProbeResult(result).replace(/\n/g, ' ')}`);
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    setSequenceText(lines.join('\n'));
    setProbeBusy(false);
  }, [ensureConnected]);

  const previewLogs = useCallback(() => {
    const entries = eventLog.list().slice(-40);
    setLogText(
      entries.length
        ? entries
            .map((e) => {
              // 带上 data：真机上排查问题时，错误原因（第几步失败、哪个文件）都在这里
              const data = e.data ? ` ${JSON.stringify(e.data)}` : '';
              return `${new Date(e.at).toLocaleTimeString()} ${e.level.toUpperCase()} ${e.event}${data}`;
            })
            .join('\n')
        : '暂无事件',
    );
    setLogSheet(true);
  }, []);

  return (
    <Screen>
      <View style={styles.header}>
        <Label>偏好与诊断</Label>
        <T variant="title" style={{ marginTop: 6 }}>
          设置
        </T>
      </View>

      {/* AI */}
      <View style={styles.section}>
        <Label>AI 调色</Label>
        <Card style={{ marginTop: space.sm }}>
          <Row
            label="供应商"
            value={aiConfig.providerName}
            hint="点开选择常用供应商：名称、请求地址、默认模型都列在里面"
            onPress={() => setProviderSheet(true)}
          />
          <Hairline />
          <Pressable onPress={() => openEdit('baseUrl')} style={styles.fieldRow}>
            <View style={styles.fieldHead}>
              <T variant="body">请求地址</T>
              <Ionicons name="create-outline" size={14} color={color.textFaint} />
            </View>
            <T variant="monoMuted" style={{ marginTop: 4 }} numberOfLines={2}>
              {aiConfig.baseUrl || '未填写（点这里填写）'}
            </T>
            <T variant="monoMuted" style={[styles.fieldHint, { color: color.textFaint }]} numberOfLines={1}>
              实际请求：{aiConfig.chatUrl || '—'}
            </T>
          </Pressable>
          <Hairline />
          <Pressable onPress={() => openEdit('model')} style={styles.fieldRow}>
            <View style={styles.fieldHead}>
              <T variant="body">模型</T>
              <Ionicons name="create-outline" size={14} color={color.textFaint} />
            </View>
            <T variant="mono" style={{ marginTop: 4 }}>
              {aiConfig.model || '未填写（点这里填写）'}
            </T>
            <T variant="monoMuted" style={[styles.fieldHint, { color: color.textFaint }]}>
              必须是支持图片输入（vision）的模型，否则会被供应商拒绝
            </T>
          </Pressable>
          <Hairline />
          <Row
            label="API Key"
            value={aiConfig.requiresKey ? maskKey(apiKey) : '本地地址，可不填'}
            hint={`按供应商分开保存，只存在本机安全存储；当前是 ${aiConfig.providerName}`}
            onPress={openKeySheet}
          />
          {apiKey ? (
            <>
              <Hairline />
              <Row
                label="清除当前供应商的 Key"
                onPress={() =>
                  Alert.alert('清除 API Key？', `清除后 ${aiConfig.providerName} 的 AI 调色入口会置灰。`, [
                    { text: '取消', style: 'cancel' },
                    { text: '清除', style: 'destructive', onPress: () => void removeKey() },
                  ])
                }
                right={<Ionicons name="trash-outline" size={16} color={color.textFaint} />}
              />
            </>
          ) : null}
          <Hairline />
          <Row
            label="测试连接"
            value={testingAi ? '测试中…' : undefined}
            hint="先试 /models，再发一条 1 token 请求；结果会显示在通知里"
            onPress={() => void runAiTest()}
          />
          {aiConfig.provider.docs ? (
            <>
              <Hairline />
              <Row
                label="获取 Key / 接口文档"
                value={aiConfig.provider.name}
                onPress={openProviderDocs}
                right={<Ionicons name="open-outline" size={15} color={color.textFaint} />}
              />
            </>
          ) : null}
          {aiConfig.missing ? (
            <View style={{ marginTop: space.sm }}>
              <Banner tone="warn" text={`${aiConfig.missing}，AI 调色暂不可用。点上面的「供应商」选择一家，或填写自定义地址。`} />
            </View>
          ) : null}
        </Card>
        <T variant="monoMuted" style={{ marginTop: space.sm }}>
          请求走 OpenAI 兼容的 /chat/completions（图片以 data URL 放在 image_url 里）。
          除 AI 调色外，其余功能完全离线。
        </T>
      </View>

      {/* 导出 */}
      <View style={styles.section}>
        <Label>导出</Label>
        <Card style={{ marginTop: space.sm }}>
          <T variant="body" style={{ marginBottom: space.sm }}>
            导出长边
          </T>
          <Segmented
            value={String(settings.exportLongEdge)}
            options={EXPORT_SIZE_OPTIONS.map((value) => ({
              value: String(value),
              label: exportSizeLabel(value),
            }))}
            onChange={(v) => void updateSettings({ exportLongEdge: Number(v) })}
          />
          <T variant="monoMuted" style={{ marginTop: space.sm }}>
            原图 = 按原图像素 1:1 导出（不缩放）；6000 会还原 A7M2 全部 24MP。
            显存不足时容易 OOM，默认 4000 更稳。
          </T>

          <Hairline />

          <T variant="body" style={{ marginVertical: space.sm }}>
            JPEG 质量
          </T>
          <Segmented
            value={String(settings.jpegQuality)}
            options={EXPORT_QUALITY_OPTIONS.map((value) => ({
              value: String(value),
              label: exportQualityLabel(value),
            }))}
            onChange={(v) => void updateSettings({ jpegQuality: Number(v) })}
          />
          <T variant="monoMuted" style={{ marginTop: space.sm }}>
            100 是 JPEG 最高质量。没做任何调色时选「原图尺寸 + 100」会直接复制原图字节，
            不重新编码。
          </T>
        </Card>
      </View>

      {/* 拍摄 */}
      <View style={styles.section}>
        <Label>拍摄</Label>
        <Card style={{ marginTop: space.sm }}>
          <T variant="body" style={{ marginBottom: space.sm }}>
            拍完自动预览
          </T>
          <Segmented
            value={String(settings.previewSeconds)}
            options={PREVIEW_SECONDS_OPTIONS.map((value) => ({
              value: String(value),
              label: previewSecondsLabel(value),
            }))}
            onChange={(v) => void updateSettings({ previewSeconds: Number(v) })}
          />
          <T variant="monoMuted" style={{ marginTop: space.sm }}>
            照片回传完成后全屏展示这么久，轻点一下可以提前关掉；关掉之后照片照样进相册。
          </T>
        </Card>
      </View>

      {/* 相机 */}
      <View style={styles.section}>
        <Label>相机</Label>
        <Card style={{ marginTop: space.sm }}>
          <T variant="body" style={{ marginBottom: space.sm }}>
            照片保存位置（部分机型有效）
          </T>
          <Segmented
            value={String(settings.captureTarget)}
            options={CAPTURE_TARGET_OPTIONS.map((option) => ({
              value: String(option.value),
              label: option.label,
            }))}
            onChange={(v) => void updateSettings({ captureTarget: Number(v) })}
          />
          <T variant="monoMuted" style={{ marginTop: space.sm }}>
            {CAPTURE_TARGET_OPTIONS.find((o) => o.value === settings.captureTarget)?.hint ?? ''}
          </T>
          <T variant="monoMuted" style={{ marginTop: space.xs }}>
            实测 ILCE-7M2 在 USB「PC 遥控」模式下三个值都不会写卡（固件行为，App 改不动）；
            这一项留给支持「PC + 存储卡」的机型。
          </T>
          <Hairline />
          <Row
            label="启动时自动连演示相机"
            hint="关掉后每次进入都要手动连接"
            right={
              <Switch
                value={settings.demoMode}
                onValueChange={(v) => void updateSettings({ demoMode: v })}
                trackColor={{ false: color.surfaceHi, true: 'rgba(232,223,207,0.32)' }}
                thumbColor={settings.demoMode ? color.accent : color.textFaint}
              />
            }
          />
          <Hairline />
          <Row label="USB 联机模块" value={usbReady ? '已链接' : '未链接'} hint={usbReady ? undefined : '见 docs/sony-transport.md'} />
          <Hairline />
          <Row label="协议" value="PTP2 (ISO 15740)" />
        </Card>
      </View>

      {/* 诊断 */}
      <View style={styles.section}>
        <Label>诊断</Label>
        <Card style={{ marginTop: space.sm }}>
          <Row label="查看事件日志" hint={`${eventLog.list().length} 条`} onPress={previewLogs} />
          <Hairline />
          <Row label="导出日志到文件" onPress={() => void exportLogs()} />
          <Hairline />
          <Row
            label="缩略图"
            value={`${thumbCount}/${assets.length} 张`}
            hint="列表用 480px 缩略图；原图只在编辑 / 导出时解码"
          />
          <Hairline />
          <Row
            label="Sony 协议探测"
            hint="逆向取图用：逐条发厂商操作，结果写进事件日志"
            onPress={() => setProbeSheet(true)}
          />
        </Card>
      </View>

      {/* 关于 */}
      <View style={styles.section}>
        <Label>关于</Label>
        <Card style={{ marginTop: space.sm }}>
          <Row label="ColorLink" value={appVersion} />
          <Hairline />
          <Row label="目标机身" value="ILCE-7M2" />
          <Hairline />
          <Row label="调色引擎" value="Skia / SkSL" />
        </Card>
        <T variant="monoMuted" style={{ marginTop: space.sm }}>
          Sony 已公告 Camera Control PTP2 命令可能自 2027 年起在部分机型失效；本项目将相机层抽象为可替换
          transport，为后续 PTP3 迁移预留接口。
        </T>
      </View>

      <Sheet visible={probeSheet} onClose={() => setProbeSheet(false)} title="Sony 协议探测">
        <T variant="monoMuted" style={{ marginBottom: space.sm }}>
          逐条点、逐条看：结果会写进事件日志。遇到不回包的操作可能打断 USB 连接，
          重连一次即可（新版会先自动关旧会话）。
        </T>
        <Button
          title={probeBusy ? '探测中…' : '一键探测序列（自动重连）'}
          onPress={() => void runProbeSequence()}
          variant="primary"
          disabled={probeBusy}
          style={{ marginBottom: space.md }}
        />
        <T variant="monoMuted" style={{ marginBottom: 4 }}>
          回传目标（先写属性，再拍一张看回传）
        </T>
        {CAPTURE_DESTINATION_PROBES.map((preset) => (
          <Button
            key={preset.id}
            title={preset.label}
            onPress={() => void runProbe(preset.op, preset.params, preset.dataHex)}
            variant="secondary"
            disabled={probeBusy}
            style={{ marginBottom: space.sm }}
          />
        ))}
        <T variant="monoMuted" style={{ marginBottom: 4 }}>
          取图句柄（拍完后立刻点）
        </T>
        {CAPTURE_HANDLE_PROBES.map((preset) => (
          <Button
            key={preset.id}
            title={preset.label}
            onPress={() => void runProbe(preset.op, preset.params, preset.dataHex)}
            variant="secondary"
            disabled={probeBusy}
            style={{ marginBottom: space.sm }}
          />
        ))}
        <ScrollView style={{ maxHeight: 240 }} showsVerticalScrollIndicator={false}>
          {PROBE_PRESETS.map((preset) => (
            <View key={preset.id} style={{ marginBottom: space.md }}>
              <Button
                title={`${preset.label}${probeBusy ? ' …' : ''}`}
                onPress={() => void runProbe(preset.op, preset.params, preset.dataHex)}
                variant="secondary"
                disabled={probeBusy}
              />
              <T variant="monoMuted" style={{ marginTop: 4 }}>
                {preset.hint}
              </T>
            </View>
          ))}
        </ScrollView>
        {sequenceText ? (
          <View style={{ marginTop: space.sm }}>
            <Label>序列结果</Label>
            <T variant="monoMuted" style={{ marginTop: 4, lineHeight: 15 }}>
              {sequenceText}
            </T>
          </View>
        ) : null}
        {probeResult ? (
          <View style={{ marginTop: space.sm }}>
            <Label>最近一次结果</Label>
            <T variant="monoMuted" style={{ marginTop: 4, lineHeight: 16 }}>
              {formatProbeResult(probeResult)}
            </T>
          </View>
        ) : null}
      </Sheet>
      <Sheet visible={keySheet} onClose={() => setKeySheet(false)} title={`${aiConfig.providerName} API Key`}>
        <T variant="monoMuted" style={{ marginBottom: space.sm }}>
          {aiConfig.provider.docs
            ? `从 ${aiConfig.provider.docs} 获取。`
            : `在 ${aiConfig.providerName} 控制台获取。`}
          Key 只保存在本机安全存储里，按供应商分开存。
        </T>
        <TextInput
          value={draftKey}
          onChangeText={setDraftKey}
          placeholder="sk-..."
          placeholderTextColor={color.textFaint}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
        {!aiConfig.requiresKey ? (
          <T variant="monoMuted" style={{ marginTop: space.xs }}>
            当前是本地地址，Key 可以不填（留空点保存即可）。
          </T>
        ) : null}
        <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.md }}>
          <Button title="取消" onPress={() => setKeySheet(false)} variant="ghost" style={{ flex: 1 }} />
          <Button title="保存" onPress={() => void commitKey()} variant="primary" style={{ flex: 1 }} />
        </View>
      </Sheet>

      <Sheet visible={providerSheet} onClose={() => setProviderSheet(false)} title="AI 供应商">
        <T variant="monoMuted" style={{ marginBottom: space.sm }}>
          选一家会带出它默认的请求地址与模型，选完仍可手动修改；切换供应商会重置这两项。
        </T>
        <ScrollView style={{ maxHeight: 430 }} showsVerticalScrollIndicator={false}>
          {AI_PROVIDERS.map((provider) => {
            const active = provider.id === aiConfig.providerId;
            return (
              <Pressable
                key={provider.id}
                onPress={() => void selectProvider(provider.id)}
                style={[styles.providerRow, active && styles.providerRowActive]}
              >
                <View style={{ flex: 1, paddingRight: space.sm }}>
                  <T variant="body" style={{ fontSize: 14, fontWeight: '600' }}>
                    {provider.name}
                  </T>
                  <T variant="monoMuted" style={{ marginTop: 2 }} numberOfLines={2}>
                    {provider.baseUrl || '需要填写完整地址'}
                  </T>
                  <T variant="monoMuted" style={{ marginTop: 2, color: color.textFaint }} numberOfLines={2}>
                    {provider.note}
                    {provider.vision ? '' : ' · 官方未提供视觉能力'}
                  </T>
                </View>
                {active ? <Ionicons name="checkmark-circle" size={18} color={color.accent} /> : null}
              </Pressable>
            );
          })}
        </ScrollView>
        <T variant="monoMuted" style={{ marginTop: space.sm }}>
          所有供应商都按 OpenAI 兼容协议调用（/chat/completions）。地址可指向自建网关
          （one-api / new-api 等），填到 /v1 即可。
        </T>
      </Sheet>

      <Sheet
        visible={editField !== null}
        onClose={() => setEditField(null)}
        title={editField === 'baseUrl' ? '请求地址' : '模型名'}
      >
        <T variant="monoMuted" style={{ marginBottom: space.sm }}>
          {editField === 'baseUrl'
            ? '填到 /v1 或完整的 /chat/completions 都可以，结尾斜杠会自动处理；本地模型用 http://IP:端口/v1。'
            : '填供应商控制台里的模型名（区分大小写）；火山方舟通常填 ep- 开头的接入点 ID。留空 = 用供应商默认模型。'}
        </T>
        <TextInput
          value={draftField}
          onChangeText={setDraftField}
          placeholder={editField === 'baseUrl' ? 'https://api.example.com/v1' : 'model-name'}
          placeholderTextColor={color.textFaint}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.md }}>
          <Button title="恢复默认" onPress={() => setDraftField('')} variant="ghost" style={{ flex: 1 }} />
          <Button title="取消" onPress={() => setEditField(null)} variant="ghost" style={{ flex: 1 }} />
          <Button title="保存" onPress={() => void commitEdit()} variant="primary" style={{ flex: 1 }} />
        </View>
      </Sheet>

      <Sheet visible={logSheet} onClose={() => setLogSheet(false)} title="最近事件">
        <T variant="monoMuted" style={{ lineHeight: 17 }}>
          {logText}
        </T>
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { paddingTop: space.lg, paddingBottom: space.lg },
  section: { marginTop: space.xl },
  input: {
    ...typography.mono,
    backgroundColor: color.surface,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairlineStrong,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    fontSize: 13,
  },
  fieldRow: { paddingVertical: space.md },
  fieldHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  fieldHint: { marginTop: 3 },
  providerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
  },
  providerRowActive: {
    backgroundColor: 'rgba(232,223,207,0.06)',
  },
});
