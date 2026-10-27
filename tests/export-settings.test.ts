import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EXPORT_LONG_EDGE,
  EXPORT_QUALITY_OPTIONS,
  EXPORT_SIZE_OPTIONS,
  exportQualityLabel,
  exportSizeLabel,
  normalizeLongEdge,
} from '../src/core/exportOptions';

/** 导出尺寸/质量：0 = 原图，是这一版新增的导出模式，必须锁住语义 */
describe('export settings', () => {
  it('0 表示原图尺寸，必须原样保留', () => {
    expect(normalizeLongEdge(0)).toBe(0);
    expect(normalizeLongEdge('0')).toBe(0);
  });

  it('其它值收敛到 1024..8192', () => {
    expect(normalizeLongEdge(6000)).toBe(6000);
    expect(normalizeLongEdge(100)).toBe(1024);
    expect(normalizeLongEdge(99999)).toBe(8192);
    expect(normalizeLongEdge(-5)).toBe(1024);
  });

  it('非法值回落到默认', () => {
    expect(normalizeLongEdge(undefined)).toBe(DEFAULT_EXPORT_LONG_EDGE);
    expect(normalizeLongEdge('abc')).toBe(DEFAULT_EXPORT_LONG_EDGE);
    expect(normalizeLongEdge(Number.NaN)).toBe(DEFAULT_EXPORT_LONG_EDGE);
  });

  it('选项里包含原图与原图质量', () => {
    expect(EXPORT_SIZE_OPTIONS).toContain(0);
    expect(EXPORT_SIZE_OPTIONS).toContain(6000);
    expect(EXPORT_QUALITY_OPTIONS).toContain(100);
  });

  it('标签对 0 与 100 有专门文案', () => {
    expect(exportSizeLabel(0)).toBe('原图');
    expect(exportSizeLabel(4000)).toBe('4000');
    expect(exportQualityLabel(100)).toBe('100（原图）');
    expect(exportQualityLabel(90)).toBe('90');
  });
});
