import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { formatBytes, formatClock, formatDimensions } from '@/core/asset';
import { isPersistentPreview } from '@/core/capturePreview';
import { color, radius, space, typography } from '@/design/tokens';
import { CapturePreview, useAppStore } from '@/state/useAppStore';

/** 按钮栏静置多久自动隐藏（和系统相册一致：一两秒后自动收起，点画面再出现） */
const CHROME_HIDE_DELAY_MS = 2_600;

/**
 * 拍完自动预览。
 *
 * 为什么放在根布局而不是相册/监看页：快门可以在任意页面按（机身快门更是在用户手里），
 * 回传完成那一刻不该因为"当前在设置页"就没有反馈。挂在最外层一层全屏浮层最简单、也最不容易漏。
 *
 * 交互照系统相册来：**点画面不关闭**，只切换按钮栏的显隐；按钮是「编辑 / 关闭 / 详情」三件事。
 * 按钮栏静置 2.6 秒自动隐藏，画面留白；到点自动关闭仍由设置里的时长决定（选「一直」就不自动关）。
 */
export function CapturePreviewOverlay() {
  const preview = useAppStore((s) => s.capturePreview);
  // 换一张照片就整块重挂（key=preview.id）：按钮栏/详情面板的状态跟着新照片归零，
  // 又在 effect 里 setState 重置它们（react-hooks 规则也不允许）。
  if (!preview) return null;
  return <PreviewStage key={preview.id} preview={preview} />;
}

function PreviewStage({ preview }: { preview: CapturePreview }) {
  const dismiss = useAppStore((s) => s.dismissCapturePreview);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [fade] = useState(() => new Animated.Value(0));
  const [progress] = useState(() => new Animated.Value(0));
  const [chrome] = useState(() => new Animated.Value(1));
  const [chromeVisible, setChromeVisible] = useState(true);
  const [details, setDetails] = useState(false);

  const close = useCallback(() => {
    Animated.timing(fade, { toValue: 0, duration: 200, useNativeDriver: true }).start(({ finished }) => {
      // 淡出被打断（比如又来一张）时不要清掉新的那张
      if (finished) dismiss();
    });
  }, [fade, dismiss]);

  useEffect(() => {
    fade.setValue(0);
    progress.setValue(0);
    Animated.timing(fade, {
      toValue: 1,
      duration: 180,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
    // 「一直」：不设倒计时，直到用户按「关闭」
    if (isPersistentPreview(preview.seconds)) return;
    // 进度条只做"还剩多久"的暗示：不用 setTimeout 动画，跟着总时长线性走
    Animated.timing(progress, {
      toValue: 1,
      duration: preview.seconds * 1000,
      easing: Easing.linear,
      useNativeDriver: true,
    }).start();
    const timer = setTimeout(close, preview.seconds * 1000);
    return () => clearTimeout(timer);
  }, [preview.seconds, fade, progress, close]);

  // 按钮栏淡入淡出
  useEffect(() => {
    Animated.timing(chrome, {
      toValue: chromeVisible ? 1 : 0,
      duration: 160,
      useNativeDriver: true,
    }).start();
  }, [chromeVisible, chrome]);

  // 静置自动隐藏；任何一次点击都会重置计时
  useEffect(() => {
    if (!chromeVisible) return;
    const timer = setTimeout(() => setChromeVisible(false), CHROME_HIDE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [chromeVisible]);

  const persistent = isPersistentPreview(preview.seconds);

  const onEdit = () => {
    const id = preview.assetId;
    dismiss();
    router.push({ pathname: '/editor/[id]', params: { id } });
  };

  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.host, { opacity: fade }]}>
      {/* 点画面只切按钮栏，不关闭 */}
      <Pressable
        style={styles.pressArea}
        onPress={() => setChromeVisible((visible) => !visible)}
        accessibilityRole="imagebutton"
        accessibilityLabel={chromeVisible ? '隐藏按钮' : '显示按钮'}
      >
        <Image
          source={{ uri: preview.uri }}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          transition={160}
        />
      </Pressable>

      <Animated.View
        pointerEvents={chromeVisible ? 'auto' : 'none'}
        style={[styles.topBar, { paddingTop: insets.top + space.sm, opacity: chrome }]}
      >
        <Pressable onPress={close} hitSlop={10} style={styles.iconButton} accessibilityLabel="关闭">
          <Ionicons name="close" size={22} color={color.text} />
        </Pressable>
        <View style={styles.topBarActions}>
          <Pressable onPress={onEdit} hitSlop={10} style={styles.iconButton} accessibilityLabel="编辑">
            <Ionicons name="create-outline" size={20} color={color.text} />
          </Pressable>
          <Pressable
            onPress={() => setDetails((open) => !open)}
            hitSlop={10}
            style={[styles.iconButton, details && styles.iconButtonActive]}
            accessibilityLabel="详情"
          >
            <Ionicons name="information-circle-outline" size={21} color={color.text} />
          </Pressable>
        </View>
      </Animated.View>

      <Animated.View
        pointerEvents="none"
        style={[
          styles.bottom,
          { paddingBottom: insets.bottom + space.lg, opacity: chrome },
        ]}
      >
        {details ? (
          <View style={styles.detailList}>
            <DetailRow label="文件" value={preview.fileName} />
            {preview.width > 0 ? (
              <DetailRow label="尺寸" value={formatDimensions(preview.width, preview.height)} />
            ) : null}
            <DetailRow label="大小" value={formatBytes(preview.bytes)} />
            <DetailRow label="时间" value={formatClock(preview.capturedAt)} />
            <DetailRow label="预览" value={persistent ? '一直显示' : `${preview.seconds} 秒后收起`} />
          </View>
        ) : (
          <>
            <Text style={styles.fileName} numberOfLines={1}>
              {preview.fileName}
            </Text>
            <Text style={styles.meta}>
              {preview.width > 0 ? `${formatDimensions(preview.width, preview.height)} · ` : ''}
              {formatBytes(preview.bytes)}
            </Text>
          </>
        )}
      </Animated.View>

      {/* 有倒计时才画进度条；「一直」没有时限 */}
      {persistent ? null : (
        <Animated.View
          pointerEvents="none"
          style={[styles.progressTrack, { bottom: insets.bottom, opacity: chrome }]}
        >
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
        </Animated.View>
      )}
    </Animated.View>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  host: { backgroundColor: 'rgba(6,7,8,0.97)' },
  pressArea: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.md,
    paddingBottom: space.sm,
    backgroundColor: 'rgba(6,7,8,0.55)',
  },
  topBarActions: { flexDirection: 'row', gap: space.xs },
  iconButton: {
    width: 44,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
  },
  iconButtonActive: { backgroundColor: 'rgba(255,255,255,0.14)' },
  // 文件名/详情压在图片下方；用半透明底代替渐变，少一层依赖
  bottom: {
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
  detailList: { alignSelf: 'stretch', gap: space.xxs },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', gap: space.lg },
  detailLabel: { ...typography.monoMuted, color: color.textFaint },
  detailValue: { ...typography.monoMuted, color: color.text, flexShrink: 1, textAlign: 'right' },
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
