import { describe, expect, it } from 'vitest';

import {
  CAPTURE_FORMAT_OPTIONS,
  DEFAULT_CAPTURE_FORMAT,
  captureFormatLabel,
  normalizeCaptureFormat,
} from '../src/core/captureFormat';

/** 画质：只允许相机 0xD253 的三个合法值（1=RAW，2=RAW+JPEG，3=JPEG） */
describe('capture format', () => {
  it('默认 JPEG(3)', () => {
    expect(DEFAULT_CAPTURE_FORMAT).toBe(3);
    expect(normalizeCaptureFormat(undefined)).toBe(3);
  });

  it('三个合法值都保留', () => {
    for (const option of CAPTURE_FORMAT_OPTIONS) {
      expect(normalizeCaptureFormat(option.value)).toBe(option.value);
    }
    expect(CAPTURE_FORMAT_OPTIONS.map((o) => o.value).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it('非法值回落到 JPEG', () => {
    expect(normalizeCaptureFormat(0)).toBe(3);
    expect(normalizeCaptureFormat(99)).toBe(3);
    expect(normalizeCaptureFormat('abc')).toBe(3);
    expect(normalizeCaptureFormat(null)).toBe(3);
  });

  it('字符串也能收敛', () => {
    expect(normalizeCaptureFormat('1')).toBe(1);
    expect(normalizeCaptureFormat('2')).toBe(2);
  });

  it('标签可读', () => {
    expect(captureFormatLabel(3)).toBe('JPEG');
    expect(captureFormatLabel(1)).toBe('RAW');
    expect(captureFormatLabel(2)).toBe('JPEG+RAW');
    expect(captureFormatLabel(42)).toBe('JPEG');
  });
});
