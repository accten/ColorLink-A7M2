import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import React, { useCallback, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';

import { eventLog } from '@/core/log';
import { Button, Card, Hairline, Label, Row, Screen, Segmented, Sheet, T } from '@/design/ui';
import { color, radius, space, typography } from '@/design/tokens';
import { logFile, writeTextAtomic } from '@/services/paths';
import { EXPORT_QUALITY_OPTIONS, EXPORT_SIZE_OPTIONS, exportQualityLabel, exportSizeLabel, maskKey } from '@/services/settings';
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

  const usbReady = isUsbTransportAvailable();
  const thumbCount = assets.filter((a) => (a.thumbUri ?? '').includes('/thumbs/')).length;

  const openKeySheet = useCallback(() => {
    setDraftKey('');
    setKeySheet(true);
  }, []);

  const commitKey = useCallback(async () => {
    if (draftKey.trim().length < 8) {
      notify('warn', 'Key 看起来太短，请粘贴完整的 DeepSeek API Key');
      return;
    }
    await saveKey(draftKey);
    setKeySheet(false);
  }, [draftKey, notify, saveKey]);

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
            label="DeepSeek API Key"
            value={maskKey(apiKey)}
            hint="存入系统安全存储（Keystore），不写日志、不进构建产物"
            onPress={openKeySheet}
          />
          {apiKey ? (
            <>
              <Hairline />
              <Row
                label="清除 Key"
                onPress={() =>
                  Alert.alert('清除 API Key？', '清除后 AI 调色入口会置灰。', [
                    { text: '取消', style: 'cancel' },
                    { text: '清除', style: 'destructive', onPress: () => void removeKey() },
                  ])
                }
                right={<Ionicons name="trash-outline" size={16} color={color.textFaint} />}
              />
            </>
          ) : null}
        </Card>
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

      {/* 相机 */}
      <View style={styles.section}>
        <Label>相机</Label>
        <Card style={{ marginTop: space.sm }}>
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
      <Sheet visible={keySheet} onClose={() => setKeySheet(false)} title="DeepSeek API Key">
        <T variant="monoMuted" style={{ marginBottom: space.sm }}>
          从 platform.deepseek.com 获取。Key 只保存在本机安全存储里。
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
        <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.md }}>
          <Button title="取消" onPress={() => setKeySheet(false)} variant="ghost" style={{ flex: 1 }} />
          <Button title="保存" onPress={() => void commitKey()} variant="primary" style={{ flex: 1 }} />
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
});
