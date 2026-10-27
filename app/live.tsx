import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { Href, router } from 'expo-router';
import { SonyCameraView } from 'expo-sony-camera';
import React, { useEffect, useState } from 'react';
import { Animated, Pressable, StatusBar, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Label, Pill, T } from '@/design/ui';
import { color, space } from '@/design/tokens';
import { currentLiveFrames, useAppStore } from '@/state/useAppStore';

const FRAME_INTERVAL_MS = 96;

/**
 * 取景页。
 *
 * 设计参考 Shopify/react-native-skia 的示例结构与 Apple 相机 App 的取景范式：
 * 画面占满、控制层半透明浮在边缘、只有快门是实心圆 —— 其余全部降噪。
 *
 * 真机取景会由 expo-sony-camera 的原生 View 直接上屏；演示模式用轮播帧模拟推流，
 * 两者共用同一套控制层，所以接真机时这一页不需要重写。
 */
export default function LiveScreen() {
  const insets = useSafeAreaInsets();
  const camera = useAppStore((s) => s.camera);
  const capturing = useAppStore((s) => s.capturing);
  const capture = useAppStore((s) => s.capture);
  const stopLive = useAppStore((s) => s.stopLiveView);

  const frames = currentLiveFrames();
  const [index, setIndex] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  const [gridVisible, setGridVisible] = useState(false);
  const [shutterScale] = useState(() => new Animated.Value(1));

  useEffect(() => {
    if (frames.length < 2) return;
    const timer = setInterval(() => setIndex((i) => (i + 1) % frames.length), FRAME_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [frames.length]);

  const close = () => {
    void stopLive();
    router.back();
  };

  const shoot = () => {
    Animated.sequence([
      Animated.timing(shutterScale, { toValue: 0.86, duration: 90, useNativeDriver: true }),
      Animated.spring(shutterScale, { toValue: 1, useNativeDriver: true, damping: 14, stiffness: 220 }),
    ]).start();
    void capture();
  };

  const connected = camera.phase === 'ready' || camera.phase === 'live';
  const currentFrame = frames.length ? frames[index % frames.length] : null;

  return (
    <View style={styles.root}>
      <StatusBar hidden />

      <Pressable style={styles.canvas} onPress={() => setZoomed((z) => !z)}>
        {camera.mode === 'usb' ? (
          // 真机取景由原生 View 直接上屏，帧不经过 JS
          <SonyCameraView
            active={camera.phase === 'live' || camera.phase === 'ready'}
            style={{ width: '100%', height: '100%' }}
          />
        ) : currentFrame != null ? (
          <Image
            source={currentFrame}
            style={[styles.frame, zoomed && { transform: [{ scale: 1.8 }] }]}
            contentFit="contain"
            transition={0}
          />
        ) : (
          <View style={styles.placeholder}>
            <Ionicons name="videocam-off-outline" size={26} color={color.textFaint} />
            <T variant="monoMuted" style={{ marginTop: space.md }}>
              演示帧不可用
            </T>
            <T variant="monoMuted" style={{ marginTop: 4 }}>
              当前 {connected ? '已连接' : '未连接相机'}
            </T>
          </View>
        )}

        {camera.mode === 'usb' && camera.error ? (
          // 真机联机失败时把原因和下一步直接摆在画面上：用户在这一页最需要知道「为什么没画面」
          <View style={styles.errorLayer} pointerEvents="none">
            <Ionicons name="alert-circle-outline" size={22} color={color.warn} />
            <T variant="body" style={styles.errorTitle}>
              {camera.error.message}
            </T>
            {(camera.error.hints ?? []).slice(0, 3).map((hint) => (
              <T key={hint} variant="monoMuted" style={styles.errorHint}>
                · {hint}
              </T>
            ))}
          </View>
        ) : null}

        {gridVisible ? (
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            {[1, 2].map((i) => (
              <View
                key={`v${i}`}
                style={[styles.gridLineV, { left: `${(i * 100) / 3}%` }]}
              />
            ))}
            {[1, 2].map((i) => (
              <View key={`h${i}`} style={[styles.gridLineH, { top: `${(i * 100) / 3}%` }]} />
            ))}
          </View>
        ) : null}
      </Pressable>

      {/* 顶部信息层 */}
      <View style={[styles.top, { paddingTop: insets.top + space.sm }]} pointerEvents="box-none">
        <Pressable onPress={close} hitSlop={12} style={styles.roundBtn}>
          <Ionicons name="close" size={20} color={color.text} />
        </Pressable>

        <View style={styles.topMeta}>
          <View style={styles.topMetaRow}>
            <View style={styles.liveDot} />
            <Meta>LIVE</Meta>
            <View style={styles.metaDivider} />
            <Meta>{`${camera.fps ?? 0} FPS`}</Meta>
            <View style={styles.metaDivider} />
            <Meta>{camera.battery != null ? `${camera.battery}%` : '—'}</Meta>
          </View>
          <T variant="mono" style={styles.topModel} numberOfLines={1}>
            {camera.info ? `${camera.info.model} · ${camera.info.firmware}` : 'ILCE-7M2'}
          </T>
        </View>

        <Pressable onPress={() => setGridVisible((g) => !g)} hitSlop={12} style={styles.roundBtn}>
          <Ionicons name="grid-outline" size={17} color={gridVisible ? color.accent : color.textMuted} />
        </Pressable>
      </View>

      {/* 底部控制层 */}
      <View style={[styles.bottom, { paddingBottom: insets.bottom + space.lg }]} pointerEvents="box-none">
        <View style={styles.bottomRow} pointerEvents="box-none">
          <Pressable onPress={close} style={styles.sideBtn} hitSlop={10}>
            <Ionicons name="exit-outline" size={19} color={color.textMuted} />
            <T variant="monoMuted" style={{ fontSize: 10.5 }}>结束</T>
          </Pressable>

          <Pressable onPress={shoot} disabled={!connected || capturing} accessibilityRole="button" accessibilityLabel="快门">
            <Animated.View
              style={[
                styles.shutterOuter,
                { transform: [{ scale: shutterScale }], opacity: connected ? 1 : 0.35 },
              ]}
            >
              <View style={[styles.shutterInner, capturing && { backgroundColor: color.warn }]} />
            </Animated.View>
          </Pressable>

          <Pressable onPress={() => router.push('/gallery' as Href)} style={styles.sideBtn} hitSlop={10}>
            <Ionicons name="images-outline" size={19} color={color.textMuted} />
            <T variant="monoMuted" style={{ fontSize: 10.5 }}>图库</T>
          </Pressable>
        </View>

        <View style={styles.hintRow}>
          <Label>轻点画面 {zoomed ? '还原' : '放大 1.8×'}</Label>
          {camera.mode === 'demo' ? <Pill tone="warn">演示帧</Pill> : null}
        </View>
      </View>
    </View>
  );
}

function Meta({ children }: { children: React.ReactNode }) {
  return (
    <T variant="mono" style={styles.metaText}>
      {children}
    </T>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  canvas: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  frame: { width: '100%', height: '100%' },
  placeholder: { alignItems: 'center' },
  gridLineV: { position: 'absolute', top: 0, bottom: 0, width: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.14)' },
  gridLineH: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.14)' },
  top: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
  },
  roundBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(12,14,16,0.72)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairlineStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topMeta: { alignItems: 'center', paddingTop: 4 },
  topMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  metaText: { fontSize: 10.5, letterSpacing: 1.1, color: 'rgba(244,242,238,0.86)' },
  metaDivider: { width: 1, height: 9, backgroundColor: 'rgba(255,255,255,0.24)' },
  liveDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: color.danger },
  topModel: { marginTop: 4, color: 'rgba(244,242,238,0.5)', fontSize: 10.5, letterSpacing: 0.6 },
  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: space.xl,
    gap: space.md,
  },
  bottomRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sideBtn: { alignItems: 'center', gap: 4, width: 64 },
  shutterOuter: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 2,
    borderColor: 'rgba(244,242,238,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterInner: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: color.accent,
  },
  hintRow: { alignItems: 'center', gap: space.sm },
  errorLayer: {
    position: 'absolute',
    left: space.xl,
    right: space.xl,
    top: '38%',
    paddingHorizontal: space.lg,
    paddingVertical: space.lg,
    borderRadius: 14,
    backgroundColor: 'rgba(12,14,16,0.9)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairlineStrong,
    alignItems: 'center',
    gap: 6,
  },
  errorTitle: { color: color.text, textAlign: 'center', marginTop: 2 },
  errorHint: { textAlign: 'center' },
});
