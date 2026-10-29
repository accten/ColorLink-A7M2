import { describe, expect, it } from 'vitest';

import {
  cloneSession,
  defaultEditorSession,
  describeSession,
  gradeOf,
  isSessionNeutral,
  normalizeSession,
  sessionEquals,
} from '../src/core/session';
import { DEFAULT_PARAMS } from '../src/core/params';
import { defaultCurveSet, insertCurvePoint, isIdentityCurveSet } from '../src/core/curve';

describe('编辑会话', () => {
  it('默认会话是"原图"：参数全默认、曲线恒等、没有 LUT', () => {
    const session = defaultEditorSession();
    expect(session.params).toEqual(DEFAULT_PARAMS);
    expect(isIdentityCurveSet(session.curves)).toBe(true);
    expect(session.presetId).toBe('original');
    expect(session.lutPath).toBeNull();
    expect(isSessionNeutral(session)).toBe(true);
  });

  it('任一参数、曲线或 LUT 都会让它不再是"原图"', () => {
    expect(isSessionNeutral({ ...defaultEditorSession(), params: { ...DEFAULT_PARAMS, grain: 5 } })).toBe(false);

    const withCurve = defaultEditorSession();
    withCurve.curves = { ...defaultCurveSet(), rgb: insertCurvePoint(defaultCurveSet().rgb, 0.5, 0.6) };
    expect(isSessionNeutral(withCurve)).toBe(false);

    expect(isSessionNeutral({ ...defaultEditorSession(), lutPath: 'file:///luts/x.cube' })).toBe(false);
  });

  it('旧版本存档（没有 curves 字段）回退成恒等曲线', () => {
    const restored = normalizeSession({
      params: { ...DEFAULT_PARAMS, contrast: 20, grain: 9 },
      presetId: 'film',
      lutPath: null,
      lutName: null,
    });
    expect(restored.params.contrast).toBe(20);
    expect(restored.params.grain).toBe(9);
    expect(isIdentityCurveSet(restored.curves)).toBe(true);
    expect(restored.presetId).toBe('film');
  });

  it('垃圾输入不抛出，直接回默认值', () => {
    expect(normalizeSession(null)).toEqual(defaultEditorSession());
    expect(normalizeSession('nope')).toEqual(defaultEditorSession());

    const junk = normalizeSession({ params: 'x', curves: 3, lutPath: 42 });
    expect(junk.params).toEqual(DEFAULT_PARAMS);
    expect(isIdentityCurveSet(junk.curves)).toBe(true);
    expect(junk.presetId).toBeNull();
    expect(junk.lutPath).toBeNull();
  });

  it('越界与未知字段按 normalizeParams 的规则收敛', () => {
    const restored = normalizeSession({
      params: { ...DEFAULT_PARAMS, contrast: 999, bogus: 3 },
    });
    expect(restored.params.contrast).toBe(100);
    expect((restored.params as Record<string, number>).bogus).toBeUndefined();
  });

  it('sessionEquals 逐字段比较（含曲线与 LUT）', () => {
    const a = defaultEditorSession();
    const b = cloneSession(a);
    expect(sessionEquals(a, b)).toBe(true);

    const withCurve = cloneSession(a);
    withCurve.curves = { ...withCurve.curves, r: insertCurvePoint(withCurve.curves.r, 0.4, 0.7) };
    expect(sessionEquals(a, withCurve)).toBe(false);

    expect(sessionEquals(a, { ...a, lutPath: 'x.cube' })).toBe(false);
    expect(sessionEquals(a, { ...a, presetId: 'film' })).toBe(false);
    expect(sessionEquals(a, { ...a, params: { ...a.params, tint: 3 } })).toBe(false);
  });

  it('gradeOf 只取调色部分，且是深拷贝（改剪贴板不会污染原会话）', () => {
    const session = defaultEditorSession();
    session.params.temperature = 30;
    const grade = gradeOf(session);
    expect(grade.params.temperature).toBe(30);
    grade.params.temperature = -30;
    grade.curves.rgb[0].y = 1;
    expect(session.params.temperature).toBe(30);
    expect(session.curves.rgb[0].y).toBe(0);
  });

  it('cloneSession 是深拷贝', () => {
    const session = defaultEditorSession();
    const copy = cloneSession(session);
    copy.params.brightness = 10;
    copy.curves.r[0].y = 0.5;
    expect(session.params.brightness).toBe(0);
    expect(session.curves.r[0].y).toBe(0);
  });

  it('摘要优先参数，其次曲线，最后 LUT', () => {
    expect(describeSession(defaultEditorSession())).toBe('原图');

    const paramsOnly = defaultEditorSession();
    paramsOnly.params.contrast = 12;
    expect(describeSession(paramsOnly)).toContain('对比度 +12');

    const curveOnly = defaultEditorSession();
    curveOnly.curves = { ...curveOnly.curves, rgb: insertCurvePoint(curveOnly.curves.rgb, 0.5, 0.7) };
    expect(describeSession(curveOnly)).toBe('曲线');

    const lutOnly = { ...defaultEditorSession(), lutPath: 'file:///luts/x.cube', lutName: 'x.cube' };
    expect(describeSession(lutOnly)).toBe('LUT x.cube');
  });
});
