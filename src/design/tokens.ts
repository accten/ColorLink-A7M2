import { Platform, TextStyle } from 'react-native';

/**
 * 设计令牌。
 *
 * 视觉参考（GitHub 开源项目）：
 *  - obytes/react-native-template-obytes (MIT)：令牌驱动的布局、间距/圆角体系、极简页面骨架
 *  - Shopify/react-native-skia examples：画布即视图（取景/编辑共用一块 GPU 画布）
 *
 * 取向：近黑底 + 暖白字 + 单一点缀色；所有分隔线用 1px 低对比 hairline；
 * 大标题收紧字距、小标签放大字距 —— 这是"高级"感最省钱的两种手法。
 */

export const color = {
  bg: '#08090A',
  bgElev: '#0C0E10',
  surface: '#111316',
  surfaceHi: '#171A1E',
  surfacePress: '#1D2025',
  hairline: 'rgba(255,255,255,0.075)',
  hairlineStrong: 'rgba(255,255,255,0.16)',
  text: '#F4F2EE',
  textMuted: '#9AA0A6',
  textFaint: '#646A70',
  accent: '#E8DFCF',
  accentInk: '#0A0B0C',
  ok: '#7FD1A6',
  warn: '#E0C07B',
  danger: '#E0868A',
  scrim: 'rgba(0,0,0,0.66)',
} as const;

export const space = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 48,
} as const;

export const radius = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 22,
  pill: 999,
} as const;

export const HIT = 44;

const monoFont = Platform.select({ ios: 'Menlo', default: 'monospace' });

export const typography = {
  display: {
    color: color.text,
    fontSize: 34,
    lineHeight: 38,
    letterSpacing: -1.1,
    fontWeight: '600',
  } as TextStyle,
  title: {
    color: color.text,
    fontSize: 21,
    lineHeight: 27,
    letterSpacing: -0.5,
    fontWeight: '600',
  } as TextStyle,
  section: {
    color: color.text,
    fontSize: 16,
    lineHeight: 22,
    letterSpacing: -0.2,
    fontWeight: '600',
  } as TextStyle,
  body: {
    color: color.text,
    fontSize: 15,
    lineHeight: 21,
    letterSpacing: -0.1,
    fontWeight: '400',
  } as TextStyle,
  bodyMuted: {
    color: color.textMuted,
    fontSize: 14,
    lineHeight: 20,
    letterSpacing: -0.05,
    fontWeight: '400',
  } as TextStyle,
  label: {
    color: color.textFaint,
    fontSize: 10.5,
    lineHeight: 14,
    letterSpacing: 1.5,
    fontWeight: '600',
    textTransform: 'uppercase',
  } as TextStyle,
  mono: {
    color: color.text,
    fontFamily: monoFont,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0.2,
    fontVariant: ['tabular-nums'],
  } as TextStyle,
  monoMuted: {
    color: color.textMuted,
    fontFamily: monoFont,
    fontSize: 11,
    lineHeight: 15,
    letterSpacing: 0.2,
    fontVariant: ['tabular-nums'],
  } as TextStyle,
} as const;

export const motion = {
  fast: 120,
  base: 180,
  slow: 260,
} as const;

export const shadow = {
  sheet: {
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: -8 },
    elevation: 24,
  },
} as const;
