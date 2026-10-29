import { describe, expect, it } from 'vitest';

import {
  CAPTURE_TARGET_OPTIONS,
  DEFAULT_CAPTURE_TARGET,
  captureTargetLabel,
  normalizeCaptureTarget,
} from '../src/core/captureTarget';

/** 照片保存位置：只允许相机 `0xD222` 的合法枚举，写野值会让相机不再回传 */
describe('capture target', () => {
  it('默认是出厂值 17', () => {
    expect(DEFAULT_CAPTURE_TARGET).toBe(17);
    expect(normalizeCaptureTarget(undefined)).toBe(17);
  });

  it('三个合法值都保留', () => {
    for (const option of CAPTURE_TARGET_OPTIONS) {
      expect(normalizeCaptureTarget(option.value)).toBe(option.value);
    }
    expect(CAPTURE_TARGET_OPTIONS.map((o) => o.value).sort((a, b) => a - b)).toEqual([1, 16, 17]);
  });

  it('非法值回落到默认（机身收到野值会停止回传）', () => {
    expect(normalizeCaptureTarget(0)).toBe(DEFAULT_CAPTURE_TARGET);
    expect(normalizeCaptureTarget(2)).toBe(DEFAULT_CAPTURE_TARGET);
    expect(normalizeCaptureTarget(99)).toBe(DEFAULT_CAPTURE_TARGET);
    expect(normalizeCaptureTarget('abc')).toBe(DEFAULT_CAPTURE_TARGET);
    expect(normalizeCaptureTarget(null)).toBe(DEFAULT_CAPTURE_TARGET);
  });

  it('字符串也能收敛', () => {
    expect(normalizeCaptureTarget('16')).toBe(16);
  });

  it('标签可读', () => {
    expect(captureTargetLabel(17)).toBe('仅平板');
    expect(captureTargetLabel(1)).toBe('两边都存');
    expect(captureTargetLabel(16)).toBe('仅存储卡');
    expect(captureTargetLabel(123)).toBe('仅平板');
  });
});
