import { Image } from 'expo-image';
import React, { useEffect, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { formatBytes, formatDimensions } from '@/core/asset';
import { color, radius, space, typography } from '@/design/tokens';
import { useAppStore } from '@/state/useAppStore';

/**
 * 拍完自动预览。
 *
 * 为什么放在根布局而不是相册/监看页：快门可以在任意页面按（机身快门更是在用户手里），
 * 回传完成那一刻不该因为"当前在设置页"就没有反馈。挂在最外层一层全屏浮层最简单、也最不容易漏。
 *
 * 交互只保留两条：轻点关闭、到点自动关闭。摄影机前的用户没空点按钮，所以不做多按钮操作。
 */
export function CapturePreviewOverlay() {
  const preview = useAppStore((s) => s.capturePreview);
  const dismiss = useAppStore((s) => s.dismissCapturePreview);
  const insets = useSafeAreaInsets();
  const [fade] = useState(() => new Animated.Value(0));
  const [progress] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (!preview) return;
    fade.setValue(0);
    progress.setValue(0);
    Animated.timing(fade, {
      toValue: 1,
      duration: 180,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
    // 进度条只做"还剩多久"的暗示：不用 setTimeout 动画，跟着总时长线性走
    Animated.timing(progress, {
      toValue: 1,
      duration: preview.seconds * 1000,
      easing: Easing.linear,
      useNativeDriver: true,
    }).start();
    const timer = setTimeout(() => {
      Animated.timing(fade, { toValue: 0, duration: 200, useNativeDriver: true }).start(({ finished }) => {
        // 淡出被打断（比如又来一张)时不要清掉新的那张
        if (finished) dismiss();
      });
    }, preview.seconds * 1000);
    return () => clearTimeout(timer);
  }, [preview, fade, progress, dismiss]);

  if (!preview) return null;

  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.host, { opacity: fade }]}>
      <Pressable style={styles.pressArea} onPress={dismiss} accessibilityRole="imagebutton" accessibilityLabel="关闭预览">
        <Image
          source={{ uri: preview.uri }}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          transition={160}
        />
      </Pressable>

      <View
        pointerEvents="none"
        style={[styles.caption, { paddingBottom: insets.bottom + space.lg }]}
      >
        <Text style={styles.fileName} numberOfLines={1}>
          {preview.fileName}
        </Text>
        <Text style={styles.meta}>
          {preview.width > 0 ? `${formatDimensions(preview.width, preview.height)} · ` : ''}
          {formatBytes(preview.bytes)}
        </Text>
      </View>

      <View pointerEvents="none" style={[styles.progressTrack, { bottom: insets.bottom + space.sm }]}>
        <Animated.View
          style={[
            styles.progressBar,
            {
              transform: [
                { scaleX: progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) },
              ],
            },
          ]}
        />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  host: { backgroundColor: 'rgba(6,7,8,0.97)' },
  pressArea: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' },
  // 文件名压在图片下方的渐变区上；这里用一块半透明底替代渐变，少一层依赖
  caption: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: space.xl,
    paddingTop: space.xxxl,
    backgroundColor: 'rgba(6,7,8,0.72)',
    alignItems: 'center',
    gap: 2,
  },
  fileName: { ...typography.body, fontWeight: '600' },
  meta: { ...typography.monoMuted },
  progressTrack: {
    position: 'absolute',
    left: space.xl,
    right: space.xl,
    height: 2,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.10)',
    overflow: 'hidden',
  },
  progressBar: {
    flex: 1,
    backgroundColor: color.accent,
    transformOrigin: 'left center',
  },
});
