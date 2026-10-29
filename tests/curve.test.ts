import { describe, expect, it } from 'vitest';

import {
  MAX_CURVE_POINTS,
  buildCurveTable,
  cloneCurveSet,
  curveSetEquals,
  defaultCurveSet,
  evaluateCurve,
  identityCurve,
  insertCurvePoint,
  isIdentityCurve,
  isIdentityCurveSet,
  moveCurvePoint,
  nearestCurvePoint,
  normalizeCurve,
  normalizeCurveSet,
  removeCurvePoint,
  type CurvePoint,
  type CurveSet,
} from '../src/core/curve';

const points = (list: [number, number][]): CurvePoint[] => list.map(([x, y]) => ({ x, y }));

describe('曲线求值', () => {
  it('恒等曲线在任何位置都返回自身', () => {
    const identity = identityCurve();
    for (const x of [0, 0.1, 0.5, 0.83, 1]) {
      expect(evaluateCurve(identity, x)).toBeCloseTo(x, 6);
    }
  });

  it('两点曲线就是线性插值', () => {
    const curve = points([
      [0, 0.2],
      [1, 0.8],
    ]);
    expect(evaluateCurve(curve, 0.5)).toBeCloseTo(0.5, 6);
    expect(evaluateCurve(curve, 0.25)).toBeCloseTo(0.35, 6);
  });

  it('三点 S 曲线：中间点抬高、两端不动', () => {
    const sCurve = points([
      [0, 0],
      [0.5, 0.62],
      [1, 1],
    ]);
    expect(evaluateCurve(sCurve, 0.5)).toBeCloseTo(0.62, 4);
    expect(evaluateCurve(sCurve, 0)).toBeCloseTo(0, 6);
    expect(evaluateCurve(sCurve, 1)).toBeCloseTo(1, 6);
  });

  it('单调不反转：输出序列随输入单调不减（不允许过冲）', () => {
    const sCurve = points([
      [0, 0],
      [0.35, 0.2],
      [0.65, 0.85],
      [1, 1],
    ]);
    let previous = -1;
    for (let i = 0; i <= 100; i++) {
      const value = evaluateCurve(sCurve, i / 100);
      expect(value).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = value;
    }
  });

  it('越界输入被夹取，输出始终在 0..1', () => {
    const curve = points([
      [0, 0],
      [1, 1],
    ]);
    expect(evaluateCurve(curve, -1)).toBe(0);
    expect(evaluateCurve(curve, 2)).toBe(1);
    const steep = points([
      [0, 0.7],
      [0.2, 0.95],
      [1, 1],
    ]);
    for (let i = 0; i <= 50; i++) {
      const value = evaluateCurve(steep, i / 50);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe('控制点规整与编辑', () => {
  it('端点固定到 0 / 1，并按 x 排序', () => {
    const messy = points([
      [0.6, 0.7],
      [0.1, 0.3],
      [0.4, 0.5],
    ]);
    const normalized = normalizeCurve(messy);
    expect(normalized[0].x).toBe(0);
    expect(normalized[normalized.length - 1].x).toBe(1);
    for (let i = 1; i < normalized.length; i++) {
      expect(normalized[i].x).toBeGreaterThan(normalized[i - 1].x);
    }
  });

  it('少于两个点回退为恒等曲线', () => {
    expect(isIdentityCurve(normalizeCurve([]))).toBe(true);
    expect(isIdentityCurve(normalizeCurve([{ x: 0.3, y: 0.6 }]))).toBe(true);
  });

  it('插入控制点落在正确位置', () => {
    const curve = insertCurvePoint(identityCurve(), 0.5, 0.6);
    expect(curve).toHaveLength(3);
    expect(curve[1]).toEqual({ x: 0.5, y: 0.6 });
  });

  it('端点不能被插入或删除', () => {
    const atZero = insertCurvePoint(identityCurve(), 0, 0.5);
    expect(atZero).toHaveLength(2);
    const removed = removeCurvePoint(identityCurve(), 0);
    expect(removed).toHaveLength(2);
  });

  it('中间点可以删除，回到恒等', () => {
    const curve = insertCurvePoint(identityCurve(), 0.4, 0.5);
    expect(isIdentityCurve(removeCurvePoint(curve, 1))).toBe(true);
  });

  it('移动控制点不会越过邻居，端点只能上下移动', () => {
    const curve = insertCurvePoint(identityCurve(), 0.5, 0.5);
    const moved = moveCurvePoint(curve, 1, 2, 1.4);
    expect(moved[1].x).toBeLessThan(1);
    expect(moved[1].y).toBe(1);

    const endpoint = moveCurvePoint(curve, 0, 0.8, 0.3);
    expect(endpoint[0]).toEqual({ x: 0, y: 0.3 });
  });

  it('控制点数量有上限', () => {
    let curve = identityCurve();
    for (let i = 1; i < MAX_CURVE_POINTS + 4; i++) {
      curve = insertCurvePoint(curve, i / (MAX_CURVE_POINTS + 5), 0.5);
    }
    expect(curve.length).toBeLessThanOrEqual(MAX_CURVE_POINTS);
  });

  it('最近控制点命中与空点', () => {
    const curve = points([
      [0, 0],
      [0.5, 0.5],
      [1, 1],
    ]);
    expect(nearestCurvePoint(curve, 0.52, 0.48)).toBe(1);
    expect(nearestCurvePoint(curve, 0.25, 0.75)).toBe(-1);
  });
});

describe('曲线纹理打包', () => {
  it('恒等曲线的表就是 0..255', () => {
    const table = buildCurveTable(defaultCurveSet());
    expect(table).toHaveLength(256 * 4);
    for (let i = 0; i < 256; i++) {
      expect(table[i * 4]).toBe(i);
      expect(table[i * 4 + 1]).toBe(i);
      expect(table[i * 4 + 2]).toBe(i);
      expect(table[i * 4 + 3]).toBe(255);
    }
  });

  it('主曲线与单通道曲线按「主 → 通道」复合', () => {
    // 主曲线反相，R 通道恒等 → 结果只看主曲线
    const inverted: CurveSet = {
      rgb: points([
        [0, 1],
        [1, 0],
      ]),
      r: identityCurve(),
      g: identityCurve(),
      b: identityCurve(),
    };
    const table = buildCurveTable(inverted);
    expect(table[0]).toBe(255);
    expect(table[255 * 4]).toBe(0);
    expect(table[128 * 4]).toBe(127);
  });

  it('单通道曲线只影响自己的通道', () => {
    const set: CurveSet = {
      ...defaultCurveSet(),
      r: points([
        [0, 0],
        [1, 1],
      ]),
      g: points([
        [0, 1],
        [1, 0],
      ]),
    };
    const table = buildCurveTable(set);
    expect(table[10 * 4]).toBe(10);
    expect(table[10 * 4 + 1]).toBe(245);
    expect(table[10 * 4 + 2]).toBe(10);
  });
});

describe('持久化输入的安全网', () => {
  it('垃圾输入回退为恒等曲线', () => {
    expect(isIdentityCurveSet(normalizeCurveSet(null))).toBe(true);
    expect(isIdentityCurveSet(normalizeCurveSet('nope'))).toBe(true);
    expect(isIdentityCurveSet(normalizeCurveSet({ rgb: 'x' }))).toBe(true);
  });

  it('合法输入被规整后保留形状', () => {
    const parsed = normalizeCurveSet({
      rgb: [
        { x: 0, y: 0 },
        { x: 0.5, y: 0.7 },
        { x: 1, y: 1 },
      ],
    });
    expect(parsed.rgb).toHaveLength(3);
    expect(parsed.rgb[1].y).toBeCloseTo(0.7);
    expect(isIdentityCurveSet(parsed)).toBe(false);
  });

  it('曲线相等比较按控制点逐点判断', () => {
    const a = defaultCurveSet();
    const b = cloneCurveSet(a);
    expect(curveSetEquals(a, b)).toBe(true);
    b.r = insertCurvePoint(b.r, 0.5, 0.6);
    expect(curveSetEquals(a, b)).toBe(false);
  });
});
