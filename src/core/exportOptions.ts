/**
 * 导出尺寸/质量的纯逻辑（不依赖 expo，便于单测）。
 *
 * `longEdge === 0` 是"原图尺寸"约定：导出时按原图像素 1:1 渲染，不缩放。
 */

export const DEFAULT_EXPORT_LONG_EDGE = 4000;
export const DEFAULT_EXPORT_QUALITY = 92;

/** 0 表示原图尺寸 */
export const EXPORT_SIZE_OPTIONS = [0, 2048, 3000, 4000, 6000];

/** 100 = 原图质量（JPEG 最高质量，体积最大） */
export const EXPORT_QUALITY_OPTIONS = [80, 90, 95, 100];

export function exportSizeLabel(value: number): string {
  if (value === 0) return '原图';
  return String(value);
}

export function exportQualityLabel(value: number): string {
  return value >= 100 ? '100（原图）' : String(value);
}

/** 0 = 原图；其它值收敛到 1024..8192，非法值回落到默认 */
export function normalizeLongEdge(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return DEFAULT_EXPORT_LONG_EDGE;
  if (Math.round(num) === 0) return 0;
  return Math.min(8192, Math.max(1024, Math.round(num)));
}
