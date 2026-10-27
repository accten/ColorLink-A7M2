import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import React, { useCallback, useState } from 'react';
import { Alert, StyleSheet, Switch, TextInput, View } from 'react-native';

import { eventLog } from '@/core/log';
import { Button, Card, Hairline, Label, Row, Screen, Segmented, Sheet, T } from '@/design/ui';
import { color, radius, space, typography } from '@/design/tokens';
import { logFile, writeTextAtomic } from '@/services/paths';
import { EXPORT_QUALITY_OPTIONS, EXPORT_SIZE_OPTIONS, exportQualityLabel, exportSizeLabel, maskKey } from '@/services/settings';
import { isUsbTransportAvailable } from '@/services/camera/usb';
import { useAppStore } from '@/state/useAppStore';

// 版本号只有 app.json 一处来源，避免界面上写死后忘了改
const appVersion = Constants.expoConfig?.version ?? '—';

export default function SettingsScreen() {
  const settings = useAppStore((s) => s.settings);
  const apiKey = useAppStore((s) => s.apiKey);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const saveKey = useAppStore((s) => s.saveKey);
  const removeKey = useAppStore((s) => s.removeKey);
  const notify = useAppStore((s) => s.notify);

  const [keySheet, setKeySheet] = useState(false);
  const [draftKey, setDraftKey] = useState('');
  const [logSheet, setLogSheet] = useState(false);
  const [logText, setLogText] = useState('');

  const usbReady = isUsbTransportAvailable();

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
