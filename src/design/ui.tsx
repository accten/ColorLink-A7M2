import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { color, HIT, motion, radius, shadow, space, typography } from './tokens';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

/* ------------------------------------------------------------------ */
/* 文本                                                                 */
/* ------------------------------------------------------------------ */

export function T({
  variant = 'body',
  children,
  style,
  numberOfLines,
}: {
  variant?: keyof typeof typography;
  children: React.ReactNode;
  style?: ViewStyle | object;
  numberOfLines?: number;
}) {
  return (
    <Text style={[typography[variant], style]} numberOfLines={numberOfLines}>
      {children}
    </Text>
  );
}

export function Label({ children, style }: { children: React.ReactNode; style?: object }) {
  return <Text style={[typography.label, style]}>{children}</Text>;
}

/* ------------------------------------------------------------------ */
/* 容器                                                                 */
/* ------------------------------------------------------------------ */

export function Screen({
  children,
  scroll = true,
  padded = true,
  bottomInset = true,
  style,
}: {
  children: React.ReactNode;
  scroll?: boolean;
  padded?: boolean;
  bottomInset?: boolean;
  style?: ViewStyle;
}) {
  const insets = useSafeAreaInsets();
  const contentStyle = [
    padded && { paddingHorizontal: space.xl },
    { paddingBottom: bottomInset ? insets.bottom + space.huge : space.xl },
  ];

  if (!scroll) {
    return <View style={[styles.screen, { paddingTop: insets.top }, contentStyle, style]}>{children}</View>;
  }
  return (
    <View style={[styles.screen, style]}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[{ paddingTop: insets.top + space.sm }, ...contentStyle]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
    </View>
  );
}

export function TopBar({
  title,
  subtitle,
  onBack,
  right,
  transparent = false,
}: {
  title?: string;
  subtitle?: string;
  onBack?: () => void;
  right?: React.ReactNode;
  transparent?: boolean;
}) {
  return (
    <View style={[styles.topBar, !transparent && styles.topBarBorder]}>
      <View style={styles.topBarLeft}>
        {onBack ? (
          <Pressable
            onPress={onBack}
            hitSlop={12}
            style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.55 }]}
            accessibilityRole="button"
            accessibilityLabel="返回"
          >
            <Ionicons name="chevron-back" size={22} color={color.text} />
          </Pressable>
        ) : null}
        <View style={{ flexShrink: 1 }}>
          {title ? <T variant="section">{title}</T> : null}
          {subtitle ? (
            <Text style={[typography.monoMuted, { marginTop: 2 }]} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
      </View>
      <View style={styles.topBarRight}>{right}</View>
    </View>
  );
}

export function Card({
  children,
  padded = true,
  style,
}: {
  children: React.ReactNode;
  padded?: boolean;
  style?: ViewStyle;
}) {
  return <View style={[styles.card, padded && { padding: space.lg }, style]}>{children}</View>;
}

export function Hairline({ inset = 0 }: { inset?: number }) {
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: color.hairline, marginLeft: inset }} />;
}

export function Row({
  label,
  value,
  hint,
  right,
  onPress,
  mono = true,
}: {
  label: string;
  value?: string;
  hint?: string;
  right?: React.ReactNode;
  onPress?: () => void;
  mono?: boolean;
}) {
  const body = (
    <View style={styles.row}>
      <View style={{ flex: 1, paddingRight: space.md }}>
        <T variant="body">{label}</T>
        {hint ? (
          <Text style={[typography.monoMuted, { marginTop: 3 }]} numberOfLines={2}>
            {hint}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text style={mono ? typography.mono : typography.bodyMuted} numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      {right}
      {onPress ? <Ionicons name="chevron-forward" size={16} color={color.textFaint} style={{ marginLeft: 6 }} /> : null}
    </View>
  );

  if (!onPress) return body;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => (pressed ? { opacity: 0.6 } : null)}>
      {body}
    </Pressable>
  );
}

/* ------------------------------------------------------------------ */
/* 控件                                                                 */
/* ------------------------------------------------------------------ */

export function Button({
  title,
  onPress,
  variant = 'secondary',
  size = 'md',
  disabled = false,
  loading = false,
  icon,
  style,
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'md' | 'lg';
  disabled?: boolean;
  loading?: boolean;
  icon?: IconName;
  style?: ViewStyle;
}) {
  const [pressed, setPressed] = useState(false);
  const palette = {
    primary: { bg: color.accent, fg: color.accentInk, border: 'transparent' },
    secondary: { bg: color.surfaceHi, fg: color.text, border: color.hairline },
    ghost: { bg: 'transparent', fg: color.textMuted, border: 'transparent' },
    danger: { bg: 'rgba(224,134,138,0.10)', fg: color.danger, border: 'rgba(224,134,138,0.28)' },
  }[variant];

  const height = size === 'lg' ? 52 : HIT;
  const inactive = disabled || loading;

  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      accessibilityRole="button"
      style={[
        styles.button,
        {
          height,
          backgroundColor: palette.bg,
          borderColor: palette.border,
          opacity: inactive ? 0.4 : pressed ? 0.82 : 1,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={palette.fg} />
      ) : (
        <>
          {icon ? <Ionicons name={icon} size={size === 'lg' ? 18 : 16} color={palette.fg} /> : null}
          <Text
            style={{
              color: palette.fg,
              fontSize: size === 'lg' ? 15 : 14,
              fontWeight: '600',
              letterSpacing: -0.1,
              marginLeft: icon ? 8 : 0,
            }}
          >
            {title}
          </Text>
        </>
      )}
    </Pressable>
  );
}

export function IconButton({
  name,
  onPress,
  size = 20,
  color: tint = color.textMuted,
  disabled,
  label,
}: {
  name: IconName;
  onPress: () => void;
  size?: number;
  color?: string;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.iconBtn, { opacity: disabled ? 0.35 : pressed ? 0.55 : 1 }]}
    >
      <Ionicons name={name} size={size} color={tint} />
    </Pressable>
  );
}

export function Pill({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'accent';
}) {
  const map = {
    neutral: { bg: 'rgba(255,255,255,0.06)', fg: color.textMuted },
    ok: { bg: 'rgba(127,209,166,0.12)', fg: color.ok },
    warn: { bg: 'rgba(224,192,123,0.12)', fg: color.warn },
    danger: { bg: 'rgba(224,134,138,0.12)', fg: color.danger },
    accent: { bg: 'rgba(232,223,207,0.14)', fg: color.accent },
  }[tone];
  return (
    <View style={{ backgroundColor: map.bg, paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill }}>
      <Text style={{ color: map.fg, fontSize: 11, fontWeight: '600', letterSpacing: 0.3 }}>{children}</Text>
    </View>
  );
}

export function Dot({ tone = 'ok', size = 7 }: { tone?: 'ok' | 'warn' | 'danger' | 'idle'; size?: number }) {
  const map = { ok: color.ok, warn: color.warn, danger: color.danger, idle: color.textFaint };
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: map[tone] }} />;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <View style={styles.segmented}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            onPress={() => onChange(opt.value)}
            style={[styles.segment, active && styles.segmentActive]}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
          >
            <Text
              style={{
                color: active ? color.text : color.textMuted,
                fontSize: 12.5,
                fontWeight: '600',
                letterSpacing: -0.1,
              }}
              numberOfLines={1}
            >
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * 横向可滚动的标签条。
 *
 * 调色面板从 4 组涨到 6 组（光/色/HSL/曲线/细节/效果），Segmented 在窄屏上
 * 会把每个标签挤成两个字；标签条让每个分组都有足够的点击宽度。
 */
export function TabStrip<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.tabStrip}
      keyboardShouldPersistTaps="handled"
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            onPress={() => onChange(opt.value)}
            style={[styles.tabChip, active && styles.tabChipActive]}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
          >
            <Text
              style={{
                color: active ? color.text : color.textMuted,
                fontSize: 12.5,
                fontWeight: '600',
                letterSpacing: -0.1,
              }}
              numberOfLines={1}
            >
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/**
 * 自绘滑块：PanResponder + 绝对坐标（pageX）。
 *
 * 用 pageX 而不是 locationX：locationX 是相对"被按到的那个子视图"算的，
 * 手指按在圆点上时坐标是相对圆点的 —— 真机表现就是"一碰圆点数值直接跳到最左/最右"。
 * 轨道的位置与宽度通过 onLayout + measureInWindow 记录，换算成绝对坐标后再算取值。
 */
export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  onCommit,
  disabled = false,
  tint = color.accent,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
  disabled?: boolean;
  tint?: string;
}) {
  const trackRef = useRef<React.ComponentRef<typeof View>>(null);
  const [track, setTrack] = useState({ x: 0, width: 1 });

  const measureTrack = useCallback(() => {
    trackRef.current?.measureInWindow((x, _y, width) => {
      setTrack({ x, width: Math.max(1, width) });
    });
  }, []);

  const clampToStep = useCallback(
    (raw: number) => {
      const clamped = Math.min(max, Math.max(min, raw));
      const snapped = Math.round((clamped - min) / step) * step + min;
      return Math.min(max, Math.max(min, Math.round(snapped * 100) / 100));
    },
    [min, max, step],
  );

  const fromPageX = useCallback(
    (pageX: number) => {
      const ratio = Math.min(1, Math.max(0, (pageX - track.x) / track.width));
      return clampToStep(min + ratio * (max - min));
    },
    [clampToStep, min, max, track.x, track.width],
  );

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !disabled,
        onMoveShouldSetPanResponder: () => !disabled,
        onPanResponderGrant: (e) => onChange(fromPageX(e.nativeEvent.pageX)),
        onPanResponderMove: (e) => onChange(fromPageX(e.nativeEvent.pageX)),
        onPanResponderRelease: (e) => onCommit?.(fromPageX(e.nativeEvent.pageX)),
        onPanResponderTerminate: (e) => onCommit?.(fromPageX(e.nativeEvent.pageX)),
      }),
    [disabled, fromPageX, onChange, onCommit],
  );

  const pct = max === min ? 0 : Math.min(1, Math.max(0, (value - min) / (max - min)));
  const zeroPct = max === min ? 0 : Math.min(1, Math.max(0, (0 - min) / (max - min)));
  const bipolar = min < 0 && max > 0;

  return (
    <View
      ref={trackRef}
      style={{ height: 34, justifyContent: 'center', opacity: disabled ? 0.4 : 1 }}
      onLayout={measureTrack}
      {...responder.panHandlers}
    >
      <View style={styles.track}>
        <View
          style={[
            styles.trackFill,
            bipolar
              ? {
                  left: `${Math.min(pct, zeroPct) * 100}%`,
                  width: `${Math.abs(pct - zeroPct) * 100}%`,
                }
              : { left: 0, width: `${pct * 100}%` },
            { backgroundColor: tint },
          ]}
        />
        {bipolar ? (
          <View
            style={{
              position: 'absolute',
              left: `${zeroPct * 100}%`,
              width: StyleSheet.hairlineWidth,
              top: -3,
              bottom: -3,
              backgroundColor: color.hairlineStrong,
            }}
          />
        ) : null}
      </View>
      <View style={[styles.thumb, { left: `${pct * 100}%`, borderColor: tint }]} />
    </View>
  );
}

export function ParamRow({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  onCommit,
  onReset,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
  onReset?: () => void;
  format?: (v: number) => string;
}) {
  const dirty = value !== 0;
  return (
    <View style={styles.paramRow}>
      <View style={styles.paramHead}>
        <Text style={[typography.body, { fontSize: 14 }]}>{label}</Text>
        <Pressable onPress={onReset} disabled={!onReset} hitSlop={8}>
          <Text style={[typography.mono, { color: dirty ? color.accent : color.textFaint }]}>
            {format ? format(value) : value > 0 ? `+${value}` : `${value}`}
          </Text>
        </Pressable>
      </View>
      <Slider value={value} min={min} max={max} step={step} onChange={onChange} onCommit={onCommit} />
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* 浮层                                                                 */
/* ------------------------------------------------------------------ */

export function Sheet({
  visible,
  onClose,
  title,
  children,
  maxHeightRatio = 0.86,
}: {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  maxHeightRatio?: number;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: color.scrim }]} onPress={onClose} />
        <View
          style={[
            styles.sheet,
            shadow.sheet,
            { maxHeight: `${maxHeightRatio * 100}%`, paddingBottom: insets.bottom + space.lg },
          ]}
        >
          <View style={styles.sheetHandle} />
          {title ? (
            <View style={styles.sheetHead}>
              <T variant="section">{title}</T>
              <IconButton name="close" onPress={onClose} label="关闭" />
            </View>
          ) : null}
          {children}
        </View>
      </View>
    </Modal>
  );
}

export function Empty({ icon, title, hint }: { icon: IconName; title: string; hint?: string }) {
  return (
    <View style={{ alignItems: 'center', paddingVertical: space.huge }}>
      <View style={styles.emptyIcon}>
        <Ionicons name={icon} size={22} color={color.textFaint} />
      </View>
      <T variant="body" style={{ marginTop: space.lg }}>
        {title}
      </T>
      {hint ? (
        <Text style={[typography.monoMuted, { marginTop: 6, textAlign: 'center', maxWidth: 260 }]}>{hint}</Text>
      ) : null}
    </View>
  );
}

export function Banner({
  tone = 'warn',
  text,
  action,
  onAction,
}: {
  tone?: 'warn' | 'danger' | 'ok';
  text: string;
  action?: string;
  onAction?: () => void;
}) {
  const map = {
    warn: { bg: 'rgba(224,192,123,0.09)', fg: color.warn },
    danger: { bg: 'rgba(224,134,138,0.09)', fg: color.danger },
    ok: { bg: 'rgba(127,209,166,0.09)', fg: color.ok },
  }[tone];
  return (
    <View style={[styles.banner, { backgroundColor: map.bg }]}>
      <Text style={{ color: map.fg, fontSize: 12.5, lineHeight: 18, flex: 1 }}>{text}</Text>
      {action && onAction ? (
        <Pressable onPress={onAction} hitSlop={8}>
          <Text style={{ color: map.fg, fontSize: 12.5, fontWeight: '700' }}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <View style={{ flex: 1 }}>
      <Label>{label}</Label>
      <Text style={[typography.mono, { marginTop: 6, color: tone ?? color.text }]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bg },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
    minHeight: 56,
  },
  topBarBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.hairline },
  topBarLeft: { flexDirection: 'row', alignItems: 'center', flexShrink: 1, gap: 6 },
  topBarRight: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  iconBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
  card: {
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: space.md,
    minHeight: HIT,
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.lg,
  },
  segmented: {
    flexDirection: 'row',
    backgroundColor: color.bgElev,
    borderRadius: radius.md,
    padding: 3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
    gap: 2,
  },
  segment: {
    flex: 1,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
  },
  segmentActive: {
    backgroundColor: color.surfaceHi,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairlineStrong,
  },
  tabStrip: { gap: 6, paddingRight: space.lg, paddingVertical: 2 },
  tabChip: {
    height: 30,
    paddingHorizontal: space.md,
    justifyContent: 'center',
    borderRadius: radius.pill,
    backgroundColor: color.bgElev,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
  },
  tabChipActive: {
    backgroundColor: color.surfaceHi,
    borderColor: color.hairlineStrong,
  },
  track: {
    height: 2,
    borderRadius: 1,
    backgroundColor: 'rgba(255,255,255,0.12)',
    overflow: 'visible',
  },
  trackFill: { position: 'absolute', top: 0, bottom: 0, borderRadius: 1 },
  thumb: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    marginLeft: -7,
    backgroundColor: color.bg,
    borderWidth: 1.5,
  },
  paramRow: { paddingTop: space.md },
  paramHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheet: {
    backgroundColor: color.bgElev,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairlineStrong,
    paddingHorizontal: space.xl,
    paddingTop: space.sm,
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.18)',
    marginBottom: space.sm,
  },
  sheetHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: space.sm,
  },
  emptyIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    borderRadius: radius.sm,
  },
});

export const transitions = motion;
