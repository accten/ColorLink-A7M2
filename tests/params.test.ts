import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PARAMS,
  clampValue,
  diffParams,
  describeParams,
  formatParamValue,
  isNeutral,
  normalizeParams,
  withParam,
} from '../src/core/params';

describe('clampValue', () => {
  it('把越界值夹回范围', () => {
    expect(clampValue('brightness', 400)).toBe(100);
    expect(clampValue('brightness', -400)).toBe(-100);
    expect(clampValue('sharpen', -5)).toBe(0);
    expect(clampValue('grain', 120)).toBe(100);
  });

  it('非数字回退默认值', () => {
    expect(clampValue('contrast', Number.NaN)).toBe(0);
    expect(clampValue('contrast', Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('按 step 取整且不产生浮点毛刺', () => {
    expect(clampValue('clarity', 12.6)).toBe(13);
    expect(Number.isInteger(clampValue('clarity', 12.4))).toBe(true);
  });
});

describe('normalizeParams', () => {
  it('缺字段按默认并给出 warning', () => {
    const { params, warnings } = normalizeParams({ brightness: 10 });
    expect(params.brightness).toBe(10);
    expect(params.contrast).toBe(0);
    expect(warnings.some((w) => w.includes('contrast'))).toBe(true);
  });

  it('越界值被夹取并记录', () => {
    const { params, warnings } = normalizeParams({ temperature: 220 });
    expect(params.temperature).toBe(100);
    expect(warnings.some((w) => w.includes('temperature'))).toBe(true);
  });

  it('未知字段被忽略', () => {
    const { warnings } = normalizeParams({ brightness: 1, vignettee: 5 } as never);
    expect(warnings.some((w) => w.includes('vignettee'))).toBe(true);
  });

  it('空对象 / null 安全', () => {
    expect(normalizeParams(null).params).toEqual(DEFAULT_PARAMS);
    expect(normalizeParams(undefined).warnings.length).toBeGreaterThan(0);
  });

  it('keepMissingDefaults=true 时不刷"缺字段"噪音', () => {
    const { warnings } = normalizeParams({ grain: 10 }, { keepMissingDefaults: true });
    expect(warnings.filter((w) => w.includes('缺少字段'))).toHaveLength(0);
  });
});

describe('params helpers', () => {
  it('isNeutral 只认全默认', () => {
    expect(isNeutral(DEFAULT_PARAMS)).toBe(true);
    expect(isNeutral({ ...DEFAULT_PARAMS, tint: 1 })).toBe(false);
  });

  it('withParam 不修改原对象', () => {
    const next = withParam(DEFAULT_PARAMS, 'contrast', 20);
    expect(next.contrast).toBe(20);
    expect(DEFAULT_PARAMS.contrast).toBe(0);
  });

  it('diffParams 只列变化项', () => {
    const diff = diffParams(DEFAULT_PARAMS, { ...DEFAULT_PARAMS, shadows: 10, grain: 4 });
    expect(diff.map((d) => d.key).sort()).toEqual(['grain', 'shadows']);
  });

  it('describeParams 给出人话摘要', () => {
    expect(describeParams(DEFAULT_PARAMS)).toBe('原图');
    expect(describeParams({ ...DEFAULT_PARAMS, contrast: 12 })).toContain('对比度 +12');
  });

  it('formatParamValue 有符号参数带 +', () => {
    expect(formatParamValue('brightness', 12)).toBe('+12');
    expect(formatParamValue('brightness', -3)).toBe('-3');
    expect(formatParamValue('brightness', 0)).toBe('0');
    expect(formatParamValue('grain', 30)).toBe('30');
  });
});
