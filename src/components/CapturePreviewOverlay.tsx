/* eslint-disable react-hooks/refs -- PanResponder 的 handler 只在触摸事件里跑，规则无法区分渲染期与事件期 */
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  BackHandler,
  Easing,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { formatBytes, formatClock, formatDimensions } from '@/core/asset';
import { isPersistentPreview } from '@/core/capturePreview';
import { color, radius, space, typography } from '@/design/tokens';
import { CapturePreview, useAppStore } from '@/state/useAppStore';

/** 按钮栏静置多久自动隐藏（和系统相册一致：一两秒后自动收起，点画面再出现） */
const CHROME_HIDE_DELAY_MS = 2_600;

/** 双击判定的窗口：窗口内的第二次点击算双击，用于放大/还原 */
const DOUBLE_TAP_MS = 240;

/** 双击放大到的倍数 */
const DOUBLE_TAP_SCALE = 2.5;

/** 捏合缩放的上限 */
const MAX_SCALE = 4;

/** 小于这个倍数就当作 1 倍（手指抖动导致 scale=1.02 时不该卡在"半放大"状态） */
const SNAP_TO_FIT_SCALE = 1.05;

/**
 * 拍完自动预览。
 *
 * 为什么放在根布局而不是相册/监看页：快门可以在任意页面按（机身快门更是在用户手里），
 * 回传完成那一刻不该因为"当前在设置页"就没有反馈。挂在最外层一层全屏浮层最简单、也最不容易漏。
 *
 * 交互照系统相册来：**点画面不关闭**，只切换按钮栏的显隐；按钮是「编辑 / 关闭 / 详情」。
 * 按钮栏静置 2.6 秒自动隐藏；到点自动关闭由设置里的时长决定（选「一直」就不自动关）。
 * 放大：双击原地放大到 2.5 倍、再双击还原；捏合可连续缩放（1~4 倍）；放大后单指拖动平移。
 */
export function CapturePreviewOverlay() {
  const preview = useAppStore((s) => s.capturePreview);
  // 换一张照片就整块重挂（key=preview.id）：缩放/按钮栏/详情面板的状态跟着新照片归零，
  // 也避免在 effect 里 setState 重置它们。
  if (!preview) return null;
  return <PreviewStage key={preview.id} preview={preview} />;
}

function PreviewStage({ preview }: { preview: CapturePreview }) {
  const dismiss = useAppStore((s) => s.dismissCapturePreview);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();

  const [fade] = useState(() => new Animated.Value(0));
  const [progress] = useState(() => new Animated.Value(0));
  const [chrome] = useState(() => new Animated.Value(1));
  const [chromeVisible, setChromeVisible] = useState(true);
  const [details, setDetails] = useState(false);

  // ---- 放大 / 平移 ----
  const [scale] = useState(() => new Animated.Value(1));
  const [offsetX] = useState(() => new Animated.Value(0));
  const [offsetY] = useState(() => new Animated.Value(0));
  /** 手势里要同步读当前值：Animated.Value 读不到，另存一份 */
  const zoomRef = useRef({ scale: 1, x: 0, y: 0 });
  const pinchStartRef = useRef<{ distance: number; scale: number } | null>(null);
  const panStartRef = useRef({ x: 0, y: 0 });
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clampOffset = useCallback(
    (nextScale: number, x: number, y: number) => {
      // 放大后可以平移的范围 = 多出来的画面的一半
      const maxX = (screenWidth * (nextScale - 1)) / 2;
      const maxY = (screenHeight * (nextScale - 1)) / 2;
      return {
        x: Math.min(maxX, Math.max(-maxX, x)),
        y: Math.min(maxY, Math.max(-maxY, y)),
      };
    },
    [screenHeight, screenWidth],
  );

  const applyZoom = useCallback(
    (nextScale: number, x: number, y: number) => {
      const clampedScale = Math.min(MAX_SCALE, Math.max(1, nextScale));
      const offset = clampOffset(clampedScale, x, y);
      zoomRef.current = { scale: clampedScale, x: offset.x, y: offset.y };
      scale.setValue(clampedScale);
      offsetX.setValue(offset.x);
      offsetY.setValue(offset.y);
    },
    [clampOffset, offsetX, offsetY, scale],
  );

  const animateZoom = useCallback(
    (nextScale: number, x: number, y: number) => {
      const clampedScale = Math.min(MAX_SCALE, Math.max(1, nextScale));
      const offset = clampOffset(clampedScale, x, y);
      zoomRef.current = { scale: clampedScale, x: offset.x, y: offset.y };
      Animated.parallel([
        Animated.timing(scale, { toValue: clampedScale, duration: 180, useNativeDriver: false }),
        Animated.timing(offsetX, { toValue: offset.x, duration: 180, useNativeDriver: false }),
        Animated.timing(offsetY, { toValue: offset.y, duration: 180, useNativeDriver: false }),
      ]).start();
    },
    [clampOffset, offsetX, offsetY, scale],
  );

  /** 双击：以点击点为中心放大到 2.5 倍；已放大则还原 */
  const toggleZoom = useCallback(
    (tapX: number, tapY: number) => {
      if (zoomRef.current.scale > SNAP_TO_FIT_SCALE) {
        animateZoom(1, 0, 0);
        return;
      }
      // 让点到的那个点大致留在原处：位移 = (屏幕中心 - 点击点) × (倍数 - 1)
      const dx = (screenWidth / 2 - tapX) * (DOUBLE_TAP_SCALE - 1);
      const dy = (screenHeight / 2 - tapY) * (DOUBLE_TAP_SCALE - 1);
      animateZoom(DOUBLE_TAP_SCALE, dx, dy);
    },
    [animateZoom, screenHeight, screenWidth],
  );

  // PanResponder 的 handler 全是触摸事件回调，读 ref 不在渲染期发生
  // （文件头的 eslint-disable 已说明为什么整文件关掉这条规则）。
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        // 不抢按下事件：轻点要留给 Pressable 切按钮栏
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (event, gesture) => {
          if (event.nativeEvent.touches.length >= 2) return true;
          return (
            zoomRef.current.scale > SNAP_TO_FIT_SCALE &&
            (Math.abs(gesture.dx) > 4 || Math.abs(gesture.dy) > 4)
          );
        },
        onPanResponderGrant: (event) => {
          panStartRef.current = { x: zoomRef.current.x, y: zoomRef.current.y };
          const touches = event.nativeEvent.touches;
          pinchStartRef.current =
            touches.length >= 2
              ? { distance: touchDistance(touches), scale: zoomRef.current.scale }
              : null;
        },
        onPanResponderMove: (event, gesture) => {
          const touches = event.nativeEvent.touches;
          if (touches.length >= 2) {
            const start = pinchStartRef.current;
            if (!start) {
              pinchStartRef.current = { distance: touchDistance(touches), scale: zoomRef.current.scale };
              return;
            }
            const ratio = touchDistance(touches) / Math.max(1, start.distance);
            applyZoom(start.scale * ratio, zoomRef.current.x, zoomRef.current.y);
            return;
          }
          if (zoomRef.current.scale > SNAP_TO_FIT_SCALE) {
            applyZoom(
              zoomRef.current.scale,
              panStartRef.current.x + gesture.dx,
              panStartRef.current.y + gesture.dy,
            );
          }
        },
        onPanResponderRelease: () => {
          pinchStartRef.current = null;
          // 捏回到 1 倍附近就整到 1 倍，别留半放大状态
          if (zoomRef.current.scale <= SNAP_TO_FIT_SCALE) animateZoom(1, 0, 0);
        },
        onPanResponderTerminate: () => {
          pinchStartRef.current = null;
          if (zoomRef.current.scale <= SNAP_TO_FIT_SCALE) animateZoom(1, 0, 0);
        },
        onPanResponderTerminationRequest: () => true,
      }),
    [animateZoom, applyZoom],
  );

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

  // 卸载时清掉"单击/双击"判定的定时器
  useEffect(
    () => () => {
      if (tapTimerRef.current) clearTimeout(tapTimerRef.current);
    },
    [],
  );

  // 系统返回键：只退出预览，不退出 App（预览在最外层，不拦就会一路退到桌面）
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      close();
      return true;
    });
    return () => subscription.remove();
  }, [close]);

  const persistent = isPersistentPreview(preview.seconds);

  const handleTap = useCallback(
    (tapX: number, tapY: number) => {
      // 双击：放大/还原；单击：切按钮栏。第二次点击落在窗口内就取消单击
      if (tapTimerRef.current) {
        clearTimeout(tapTimerRef.current);
        tapTimerRef.current = null;
        toggleZoom(tapX, tapY);
        return;
      }
      tapTimerRef.current = setTimeout(() => {
        tapTimerRef.current = null;
        setChromeVisible((visible) => !visible);
      }, DOUBLE_TAP_MS);
    },
    [toggleZoom],
  );

  const onEdit = () => {
    const id = preview.assetId;
    dismiss();
    router.push({ pathname: '/editor/[id]', params: { id } });
  };

  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.host, { opacity: fade }]}>
      <View style={StyleSheet.absoluteFill} {...panResponder.panHandlers}>
        {/* 点画面只切按钮栏，不关闭；双击放大 */}
        <Pressable
          style={styles.pressArea}
          onPress={(event) =>
            handleTap(event.nativeEvent.locationX, event.nativeEvent.locationY)
          }
          accessibilityRole="imagebutton"
          accessibilityLabel={chromeVisible ? '隐藏按钮' : '显示按钮'}
        >
          <Animated.View
            style={[
              StyleSheet.absoluteFill,
              { transform: [{ scale }, { translateX: offsetX }, { translateY: offsetY }] },
            ]}
          >
            <Image
              source={{ uri: preview.uri }}
              style={StyleSheet.absoluteFill}
              contentFit="contain"
              transition={160}
            />
          </Animated.View>
        </Pressable>
      </View>

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
        style={[styles.bottom, { paddingBottom: insets.bottom + space.lg, opacity: chrome }]}
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
              {'  ·  双击放大 / 捏合缩放'}
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

/** 两指之间的距离（捏合缩放用） */
function touchDistance(touches: readonly { pageX: number; pageY: number }[]): number {
  if (touches.length < 2) return 0;
  const dx = touches[0].pageX - touches[1].pageX;
  const dy = touches[0].pageY - touches[1].pageY;
  return Math.sqrt(dx * dx + dy * dy);
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
  pressArea: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
