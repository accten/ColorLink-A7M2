import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { color, radius, space } from '@/design/tokens';
import { useAppStore } from '@/state/useAppStore';

const ICONS = {
  ok: 'checkmark-circle-outline',
  warn: 'alert-circle-outline',
  danger: 'warning-outline',
} as const;

const TINTS = {
  ok: color.ok,
  warn: color.warn,
  danger: color.danger,
} as const;

/**
 * 全局轻提示：从底部浮起，3.2s 自动消失。
 * 不用系统 Toast，是因为需要和 App 的深色视觉一致，并且要能带一个"排查"按钮。
 */
export function NoticeHost() {
  const notice = useAppStore((s) => s.notice);
  const dismiss = useAppStore((s) => s.dismissNotice);
  const insets = useSafeAreaInsets();
  const [progress] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (!notice) return;
    progress.setValue(0);
    Animated.spring(progress, { toValue: 1, useNativeDriver: true, damping: 18, stiffness: 180 }).start();
    const timer = setTimeout(() => {
      Animated.timing(progress, { toValue: 0, duration: 180, useNativeDriver: true }).start(() => dismiss());
    }, 3200);
    return () => clearTimeout(timer);
  }, [notice, progress, dismiss]);

  if (!notice) return null;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.wrap,
        {
          bottom: insets.bottom + 74,
          opacity: progress,
          transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
        },
      ]}
    >
      <Pressable onPress={dismiss} style={styles.card} accessibilityRole="alert">
        <Ionicons name={ICONS[notice.tone]} size={16} color={TINTS[notice.tone]} />
        <Text style={styles.text} numberOfLines={3}>
          {notice.text}
        </Text>
        {notice.action ? (
          <Pressable
            hitSlop={8}
            onPress={() => {
              notice.action?.run();
              dismiss();
            }}
          >
            <Text style={[styles.action, { color: TINTS[notice.tone] }]}>{notice.action.label}</Text>
          </Pressable>
        ) : null}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    alignItems: 'center',
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: '#15181B',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairlineStrong,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    maxWidth: 520,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  text: { color: color.text, fontSize: 13, lineHeight: 18, flexShrink: 1 },
  action: { fontSize: 13, fontWeight: '700', marginLeft: space.xs },
});
