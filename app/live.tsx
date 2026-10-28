import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { Href, router } from 'expo-router';
import { SonyCameraView } from 'expo-sony-camera';
import React, { useEffect, useState } from 'react';
import { Animated, Pressable, StatusBar, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Label, T } from '@/design/ui';
import { color, space } from '@/design/tokens';
import { currentLiveFrames, useAppStore } from '@/state/useAppStore';

const FRAME_INTERVAL_MS = 96;

/** 机身的实时取景比例（A7M2 的取景帧就是 3:2，竖屏时上下留黑更像监视器） */
const LIVE_ASPECT = 3 / 2;

/**
 * 监看页（monitor）。
 *
 * 设计目标对齐专业监看器的形态：画面占满宽度、竖屏上下留黑边、四周只有极简状态与快门，
 * 曝光参数只读显示（改参数请直接在相机上改）。
 *
 * 真机取景由 expo-sony-camera 的原生 View 直接上屏；演示模式用轮播帧模拟推流，
 * 两者共用同一套外框，所以接真机时这一页不需要重写。
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
  const exposure = camera.exposure;

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <StatusBar hidden />

      {/* 顶部状态条：只读，极简 */}
      <View style={styles.topBar}>
        <View style={styles.topLeft}>
          <View style={[styles.dot, { backgroundColor: connected ? color.ok : color.textFaint }]} />
          <T variant="mono" style={styles.topText}>
            LIVE
          </T>
          <T variant="mono" style={styles.topTextMuted}>
            {`${camera.fps ?? 0} FPS`}
          </T>
        </View>
        <T variant="mono" style={styles.topTextMuted} numberOfLines={1}>
          {camera.info ? `${camera.info.model} · ${camera.info.firmware}` : 'ILCE-7M2'}
        </T>
        <View style={styles.topRight}>
          <Ionicons name="battery-half-outline" size={13} color="rgba(244,242,238,0.66)" />
          <T variant="mono" style={styles.topTextMuted}>
            {camera.battery != null ? `${camera.battery}%` : '—'}
          </T>
        </View>
      </View>

      {/* 画面：3:2，上下留黑，等比占满宽度 */}
      <View style={styles.stage}>
        <Pressable style={styles.frameBox} onPress={() => setZoomed((z) => !z)}>
          {camera.mode === 'usb' ? (
            camera.caps?.liveView === false ? (
              <View style={styles.placeholder}>
                <Ionicons name="videocam-off-outline" size={26} color={color.textFaint} />
                <T variant="body" style={styles.noLiveTitle}>
                  本机型不支持 USB 实时取景
                </T>
                <T variant="monoMuted" style={styles.noLiveHint}>
                  仍可按快门远程拍摄
                </T>
              </View>
            ) : (
              <SonyCameraView
                active={camera.phase === 'live' || camera.phase === 'ready'}
                style={{ width: '100%', height: '100%' }}
              />
            )
          ) : currentFrame != null ? (
            <Image
              source={currentFrame}
              style={[styles.frame, zoomed && { transform: [{ scale: 1.8 }] }]}
              contentFit="cover"
              transition={0}
            />
          ) : (
            <View style={styles.placeholder}>
              <Ionicons name="videocam-off-outline" size={26} color={color.textFaint} />
              <T variant="monoMuted" style={{ marginTop: space.md }}>
                演示帧不可用
              </T>
            </View>
          )}

          {gridVisible ? (
            <View pointerEvents="none" style={StyleSheet.absoluteFill}>
              {[1, 2].map((i) => (
                <View key={`v${i}`} style={[styles.gridLineV, { left: `${(i * 100) / 3}%` }]} />
              ))}
              {[1, 2].map((i) => (
                <View key={`h${i}`} style={[styles.gridLineH, { top: `${(i * 100) / 3}%` }]} />
              ))}
            </View>
          ) : null}

          <View pointerEvents="none" style={styles.watermark}>
            <T variant="mono" style={styles.watermarkText}>
              ColorLink
            </T>
          </View>
        </Pressable>
      </View>

      {/* 只读曝光参数：跟监视器一样一排摆开，值从相机来（取不到就显示 —） */}
      <View style={styles.exposureBar}>
        <ExposureCell label="快门" value={exposure?.shutter} />
        <ExposureCell label="光圈" value={exposure?.aperture} />
        <ExposureCell label="ISO" value={exposure?.iso} />
        <ExposureCell label="EV" value={exposure?.ev} />
        <ExposureCell label="白平衡" value={exposure?.wb} />
      </View>

      {/* 底部控制 */}
      <View style={[styles.bottom, { paddingBottom: insets.bottom + space.lg }]}>
        <View style={styles.bottomRow}>
          <Pressable onPress={close} style={styles.sideBtn} hitSlop={10}>
            <Ionicons name="exit-outline" size={20} color={color.textMuted} />
            <T variant="monoMuted" style={styles.sideLabel}>
              结束
            </T>
          </Pressable>

          <Pressable onPress={shoot} disabled={!connected || capturing} accessibilityRole="button" accessibilityLabel="快门">
            <Animated.View
              style={[styles.shutterOuter, { transform: [{ scale: shutterScale }], opacity: connected ? 1 : 0.35 }]}
            >
              <View style={[styles.shutterInner, capturing && { backgroundColor: color.warn }]} />
            </Animated.View>
          </Pressable>

          <Pressable onPress={() => router.push('/gallery' as Href)} style={styles.sideBtn} hitSlop={10}>
            <Ionicons name="images-outline" size={20} color={color.textMuted} />
            <T variant="monoMuted" style={styles.sideLabel}>
              图库
            </T>
          </Pressable>
        </View>

        <View style={styles.toolsRow}>
          <Pressable onPress={() => setGridVisible((g) => !g)} hitSlop={10} style={styles.toolBtn}>
            <Ionicons name="grid-outline" size={15} color={gridVisible ? color.accent : color.textFaint} />
            <Label>三分线</Label>
          </Pressable>
          <Pressable onPress={() => setZoomed((z) => !z)} hitSlop={10} style={styles.toolBtn}>
            <Ionicons name="scan-outline" size={15} color={zoomed ? color.accent : color.textFaint} />
            <Label>{zoomed ? '还原' : '放大'}</Label>
          </Pressable>
          {camera.mode === 'demo' ? (
            <View style={styles.toolBtn}>
              <T variant="monoMuted" style={{ fontSize: 10 }}>
                演示帧
              </T>
            </View>
          ) : null}
        </View>
      </View>

      {camera.mode === 'usb' && camera.error ? (
        <View style={styles.errorLayer} pointerEvents="none">
          <Ionicons name="alert-circle-outline" size={22} color={color.warn} />
          <T variant="body" style={styles.errorTitle}>
            {camera.error.message}
          </T>
          {(camera.error.hints ?? []).slice(0, 2).map((hint) => (
            <T key={hint} variant="monoMuted" style={styles.errorHint}>
              · {hint}
            </T>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function ExposureCell({ label, value }: { label: string; value?: string }) {
  return (
    <View style={styles.exposureCell}>
      <T variant="mono" style={styles.exposureValue} numberOfLines={1}>
        {value ?? '—'}
      </T>
      <Label>{label}</Label>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  topLeft: { flexDirection: 'row', alignItems: 'center', gap: 6, width: 120 },
  topRight: { flexDirection: 'row', alignItems: 'center', gap: 4, justifyContent: 'flex-end', width: 120 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  topText: { fontSize: 10.5, letterSpacing: 1.2, color: 'rgba(244,242,238,0.9)' },
  topTextMuted: { fontSize: 10.5, letterSpacing: 0.6, color: 'rgba(244,242,238,0.5)' },

  stage: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  frameBox: {
    width: '100%',
    aspectRatio: LIVE_ASPECT,
    backgroundColor: '#000',
    overflow: 'hidden',
  },
  frame: { width: '100%', height: '100%' },
  placeholder: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  noLiveTitle: { color: color.text, marginTop: space.md, textAlign: 'center' },
  noLiveHint: { marginTop: 4, textAlign: 'center' },

  gridLineV: { position: 'absolute', top: 0, bottom: 0, width: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.14)' },
  gridLineH: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.14)' },
  watermark: { position: 'absolute', right: 10, bottom: 8 },
  watermarkText: { fontSize: 9.5, letterSpacing: 1.6, color: 'rgba(244,242,238,0.22)' },

  exposureBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  exposureCell: { alignItems: 'center', gap: 3, minWidth: 52 },
  exposureValue: { fontSize: 12.5, color: 'rgba(244,242,238,0.92)' },

  bottom: { paddingHorizontal: space.xl, gap: space.md },
  bottomRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sideBtn: { alignItems: 'center', gap: 4, width: 64 },
  sideLabel: { fontSize: 10 },
  shutterOuter: {
    width: 78,
    height: 78,
    borderRadius: 39,
    borderWidth: 2,
    borderColor: 'rgba(244,242,238,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterInner: { width: 62, height: 62, borderRadius: 31, backgroundColor: color.accent },
  toolsRow: { flexDirection: 'row', justifyContent: 'center', gap: space.xl },
  toolBtn: { flexDirection: 'row', alignItems: 'center', gap: 5 },

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
