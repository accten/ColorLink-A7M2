import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { Href, router } from 'expo-router';
import React, { useCallback } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';

import { formatBytes, formatClock, formatDimensions } from '@/core/asset';
import { describeParams } from '@/core/params';
import { Button, Card, Dot, Hairline, Label, Pill, Screen, Stat, T } from '@/design/ui';
import { color, radius, space } from '@/design/tokens';
import { isUsbTransportAvailable } from '@/services/camera/usb';
import { useAppStore } from '@/state/useAppStore';

export default function ConnectScreen() {
  const camera = useAppStore((s) => s.camera);
  const cameraBusy = useAppStore((s) => s.cameraBusy);
  const capturing = useAppStore((s) => s.capturing);
  const assets = useAppStore((s) => s.assets);
  const sessions = useAppStore((s) => s.sessions);
  const connect = useAppStore((s) => s.connectCamera);
  const disconnect = useAppStore((s) => s.disconnectCamera);
  const startLive = useAppStore((s) => s.startLiveView);
  const capture = useAppStore((s) => s.capture);

  const connected = camera.phase === 'ready' || camera.phase === 'live';
  const usbReady = isUsbTransportAvailable();
  const recent = assets.slice(0, 3);
  const latestSession = assets.length ? sessions[assets[0].id] : undefined;

  const openLive = useCallback(() => {
    void startLive().then(() => router.push('/live' as Href));
  }, [startLive]);

  const confirmDisconnect = useCallback(() => {
    Alert.alert('断开相机连接？', '断开后取景与自动回传会停止，已接收的照片不受影响。', [
      { text: '取消', style: 'cancel' },
      { text: '断开', style: 'destructive', onPress: () => void disconnect() },
    ]);
  }, [disconnect]);

  return (
    <Screen>
      <View style={styles.header}>
        <Label>A7M2 · USB PTP2</Label>
        <T variant="display" style={{ marginTop: 6 }}>
          ColorLink
        </T>
        <T variant="bodyMuted" style={{ marginTop: 4 }}>
          联机监视 · 一拍一传 · 本地调色
        </T>
      </View>

      <Card style={{ marginTop: space.xxl }}>
        <View style={styles.statusRow}>
          <View style={styles.statusLeft}>
            <Dot tone={connected ? 'ok' : camera.phase === 'error' ? 'danger' : 'idle'} />
            <T variant="body" style={styles.statusText}>
              {connected
                ? '已连接'
                : camera.phase === 'connecting'
                  ? '连接中…'
                  : camera.phase === 'error'
                    ? '连接异常'
                    : '未连接'}
            </T>
          </View>
          <Pill tone={camera.mode === 'demo' ? 'warn' : connected ? 'ok' : 'neutral'}>
            {camera.mode === 'demo' ? '演示模式' : 'USB 联机'}
          </Pill>
        </View>

        <T variant="title" style={{ marginTop: space.lg }}>
          {camera.info?.model ?? 'ILCE-7M2'}
        </T>
        <T variant="monoMuted" style={{ marginTop: 4 }}>
          {camera.info
            ? `${camera.info.firmware} · ${camera.info.mode === 'demo' ? '模拟帧' : '实时取景'}`
            : '等待相机接入'}
        </T>

        <Hairline />

        <View style={styles.statsRow}>
          <Stat label="电量" value={camera.battery != null ? `${camera.battery}%` : '—'} />
          <Stat label="存储" value={camera.mediaRemaining != null ? `${camera.mediaRemaining} 张` : '—'} />
          <Stat label="取景" value={camera.fps ? `${camera.fps} fps` : connected ? (camera.caps?.liveView === false ? '不支持' : '待机') : '—'} />
        </View>

        {camera.error ? (
          <View style={styles.errorBox}>
            <T variant="body" style={{ color: color.danger, fontSize: 13 }}>
              {camera.error.message}
            </T>
            {camera.error.hints.map((hint) => (
              <T key={hint} variant="monoMuted" style={{ marginTop: 4 }}>
                · {hint}
              </T>
            ))}
          </View>
        ) : null}

        <View style={{ marginTop: space.lg, gap: space.sm }}>
          {connected ? (
            <>
              <Button
                title="进入取景"
                onPress={openLive}
                variant="primary"
                size="lg"
                icon="scan-outline"
              />
              <View style={{ flexDirection: 'row', gap: space.sm }}>
                <Button
                  title={capturing ? '拍摄中…' : '远程快门'}
                  onPress={() => void capture()}
                  loading={capturing}
                  style={{ flex: 1 }}
                  icon="radio-button-on-outline"
                />
                <Button title="断开" onPress={confirmDisconnect} variant="ghost" style={{ flex: 1 }} />
              </View>
            </>
          ) : (
            <>
              <Button
                title={cameraBusy ? '连接中…' : '连接相机'}
                onPress={() => void connect(usbReady ? 'usb' : 'demo')}
                loading={cameraBusy}
                variant="primary"
                size="lg"
                icon="camera-outline"
                disabled={!usbReady}
              />
              <Button
                title="使用演示模式"
                onPress={() => void connect('demo')}
                variant="secondary"
                icon="sparkles-outline"
              />
            </>
          )}
        </View>
      </Card>

      {!usbReady ? (
        <View style={styles.hintBar}>
          <Ionicons name="information-circle-outline" size={15} color={color.textMuted} />
          <T variant="monoMuted" style={{ flex: 1 }}>
            当前构建未链接 expo-sony-camera：USB 联机走不通，先用演示模式验证全流程。接入步骤见
            docs/sony-transport.md。
          </T>
        </View>
      ) : null}

      <View style={styles.sectionHead}>
        <Label>最近接收</Label>
        <Pressable onPress={() => router.push('/gallery' as Href)} hitSlop={8}>
          <T variant="monoMuted">全部 {assets.length} →</T>
        </Pressable>
      </View>

      {recent.length ? (
        <Card padded={false} style={{ overflow: 'hidden' }}>
          {recent.map((asset, index) => (
            <View key={asset.id}>
              {index > 0 ? <Hairline inset={space.lg} /> : null}
              <Pressable
                onPress={() => router.push(`/editor/${asset.id}` as Href)}
                style={({ pressed }) => [styles.recentRow, pressed && { backgroundColor: color.surfaceHi }]}
              >
                <Image
                  source={{ uri: asset.thumbUri ?? asset.uri }}
                  style={styles.recentThumb}
                  contentFit="cover"
                  transition={120}
                  recyclingKey={asset.id}
                />
                <View style={{ flex: 1, marginLeft: space.md }}>
                  <T variant="mono" numberOfLines={1}>
                    {asset.fileName}
                  </T>
                  <T variant="monoMuted" style={{ marginTop: 3 }} numberOfLines={1}>
                    {formatClock(asset.capturedAt)} · {formatDimensions(asset.width, asset.height)} ·{' '}
                    {formatBytes(asset.bytes)}
                  </T>
                </View>
                <Ionicons name="chevron-forward" size={16} color={color.textFaint} />
              </Pressable>
            </View>
          ))}
        </Card>
      ) : (
        <Card>
          <T variant="bodyMuted">还没有照片。连上相机后按一次快门，这里会出现第一张。</T>
        </Card>
      )}

      {assets.length ? (
        <View style={{ marginTop: space.xl }}>
          <Label>最近一张的调色</Label>
          <T variant="monoMuted" style={{ marginTop: 6 }}>
            {describeParams(latestSession?.params ?? { ...useAppStore.getState().session(assets[0].id).params })}
          </T>
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { paddingTop: space.lg },
  statusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  statusLeft: { flexDirection: 'row', alignItems: 'center' },
  statusText: { fontSize: 13.5, color: color.textMuted, marginLeft: 6 },
  statsRow: { flexDirection: 'row', paddingVertical: space.lg, gap: space.md },
  errorBox: {
    marginTop: space.md,
    backgroundColor: 'rgba(224,134,138,0.08)',
    borderRadius: radius.sm,
    padding: space.md,
  },
  hintBar: {
    flexDirection: 'row',
    gap: space.sm,
    alignItems: 'flex-start',
    marginTop: space.md,
    padding: space.md,
    borderRadius: radius.sm,
    backgroundColor: color.bgElev,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
  },
  sectionHead: {
    marginTop: space.xxl,
    marginBottom: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  recentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  recentThumb: { width: 46, height: 46, borderRadius: radius.sm, backgroundColor: color.surfaceHi },
});
