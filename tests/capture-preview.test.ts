import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PREVIEW_SECONDS,
  PERSISTENT_PREVIEW,
  PREVIEW_SECONDS_OPTIONS,
  isPersistentPreview,
  normalizePreviewSeconds,
  previewSecondsLabel,
} from '../src/core/capturePreview';

/** 拍完预览时长：0 = 关闭，-1 = 一直；档位之外的输入要收敛而不能让预览失效 */
describe('capture preview seconds', () => {
  it('默认 3 秒，且默认值必须在档位里', () => {
    expect(DEFAULT_PREVIEW_SECONDS).toBe(3);
    expect(PREVIEW_SECONDS_OPTIONS).toContain(DEFAULT_PREVIEW_SECONDS);
  });

  it('0 是合法值（关闭），不能被默认值顶掉', () => {
    expect(normalizePreviewSeconds(0)).toBe(0);
    expect(normalizePreviewSeconds('0')).toBe(0);
  });

  it('-1 是「一直」，必须原样保留', () => {
    expect(normalizePreviewSeconds(PERSISTENT_PREVIEW)).toBe(PERSISTENT_PREVIEW);
    expect(normalizePreviewSeconds('-1')).toBe(PERSISTENT_PREVIEW);
    expect(isPersistentPreview(PERSISTENT_PREVIEW)).toBe(true);
    expect(isPersistentPreview(0)).toBe(false);
  });

  it('档位内的值原样保留', () => {
    for (const option of PREVIEW_SECONDS_OPTIONS) {
      expect(normalizePreviewSeconds(option)).toBe(option);
    }
    expect(normalizePreviewSeconds('10')).toBe(10);
  });

  it('档位之间的值归到最近的时长档（不会被吸到「一直」）', () => {
    expect(normalizePreviewSeconds(4)).toBe(3);
    expect(normalizePreviewSeconds(7)).toBe(5);
    expect(normalizePreviewSeconds(8)).toBe(10);
    expect(normalizePreviewSeconds(-3)).toBe(0);
    expect(normalizePreviewSeconds(-0.4)).toBe(0);
  });

  it('非法值回落到默认', () => {
    expect(normalizePreviewSeconds(undefined)).toBe(DEFAULT_PREVIEW_SECONDS);
    expect(normalizePreviewSeconds(null)).toBe(DEFAULT_PREVIEW_SECONDS);
    expect(normalizePreviewSeconds('abc')).toBe(DEFAULT_PREVIEW_SECONDS);
    expect(normalizePreviewSeconds(Number.NaN)).toBe(DEFAULT_PREVIEW_SECONDS);
  });

  it('标签：0 = 关闭，-1 = 一直', () => {
    expect(previewSecondsLabel(0)).toBe('关闭');
    expect(previewSecondsLabel(3)).toBe('3 秒');
    expect(previewSecondsLabel(PERSISTENT_PREVIEW)).toBe('一直');
  });
});
