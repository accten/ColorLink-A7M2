import { describe, expect, it } from 'vitest';

import {
  clamp01,
  fitWithin,
  gradePixelReference,
  referenceLuma,
  uniformsFor,
  uniformsObject,
} from '../src/core/grade';
import { DEFAULT_PARAMS, PARAM_KEYS, type EditParams } from '../src/core/params';

const base = (over: Partial<EditParams> = {}): EditParams => ({ ...DEFAULT_PARAMS, ...over });
const MID: [number, number, number] = [0.5, 0.5, 0.5];
const WARM_PIXEL: [number, number, number] = [0.72, 0.5, 0.34];

describe('uniform 排列（参数串位 = 静默错色的根源）', () => {
  it('扁平数组：前 5 个固定，其余按 PARAM_KEYS 顺序', () => {
    const values = uniformsFor(DEFAULT_PARAMS, 1200, 800, 33, true, true);
    expect(values).toHaveLength(5 + PARAM_KEYS.length);
    expect(values.slice(0, 5)).toEqual([1200, 800, 33, 1, 1]);
    expect(values.slice(5)).toEqual(PARAM_KEYS.map((k) => DEFAULT_PARAMS[k]));
  });

  it('lutSize 下限为 2，hasLut / hasCurve 归一为 0/1', () => {
    const values = uniformsFor(DEFAULT_PARAMS, 10, 10, 1, false);
    expect(values[2]).toBe(2);
    expect(values[3]).toBe(0);
    expect(values[4]).toBe(0);
  });

  it('命名版与扁平版一致', () => {
    const params = base({ temperature: 24, grain: 9 });
    const object = uniformsObject(params, 300, 200, 17, true, true);
    expect(object.srcSize).toEqual([300, 200]);
    expect(object.lutSize).toBe(17);
    expect(object.hasLut).toBe(1);
    expect(object.hasCurve).toBe(1);
    expect(object.temperature).toBe(24);
    expect(object.grain).toBe(9);
    const flat = uniformsFor(params, 300, 200, 17, true, true);
    expect(flat[5 + PARAM_KEYS.indexOf('temperature')]).toBe(24);
    expect(flat[5 + PARAM_KEYS.indexOf('grain')]).toBe(9);
  });
});

describe('fitWithin（导出尺寸）', () => {
  it('不放大', () => {
    expect(fitWithin(1200, 800, 4000)).toEqual({ width: 1200, height: 800 });
  });

  it('按长边缩放且保持比例', () => {
    const out = fitWithin(6000, 4000, 4000);
    expect(out).toEqual({ width: 4000, height: 2667 });
    expect(out.width / out.height).toBeCloseTo(6000 / 4000, 2);
  });

  it('竖图按高度缩放', () => {
    expect(fitWithin(4000, 6000, 3000)).toEqual({ width: 2000, height: 3000 });
  });

  it('极端输入不返回 0', () => {
    expect(fitWithin(1, 1, 4000)).toEqual({ width: 1, height: 1 });
    expect(fitWithin(0, 0, 4000)).toEqual({ width: 1, height: 1 });
  });
});

describe('参数语义（CPU 参考实现，与 SKSL 同一套公式）', () => {
  it('默认参数近似恒等（允许 sRGB 往返 1e-3）', () => {
    const out = gradePixelReference(MID, DEFAULT_PARAMS);
    expect(out[0]).toBeCloseTo(0.5, 2);
    expect(out[1]).toBeCloseTo(0.5, 2);
    expect(out[2]).toBeCloseTo(0.5, 2);
  });

  it('亮度：+ 提亮、- 压暗', () => {
    const up = referenceLuma(MID, base({ brightness: 50 }));
    const down = referenceLuma(MID, base({ brightness: -50 }));
    const mid = referenceLuma(MID, DEFAULT_PARAMS);
    expect(up).toBeGreaterThan(mid);
    expect(down).toBeLessThan(mid);
  });

  it('色温：正=更暖（R/B 比值上升），负=更冷', () => {
    const warm = gradePixelReference(MID, base({ temperature: 60 }));
    const cool = gradePixelReference(MID, base({ temperature: -60 }));
    expect(warm[0] / warm[2]).toBeGreaterThan(1.1);
    expect(cool[0] / cool[2]).toBeLessThan(0.9);
  });

  it('色调：正=偏洋红（G 相对下降），负=偏绿', () => {
    const magenta = gradePixelReference(MID, base({ tint: 60 }));
    const green = gradePixelReference(MID, base({ tint: -60 }));
    expect(magenta[1]).toBeLessThan(magenta[0]);
    expect(green[1]).toBeGreaterThan(green[0]);
  });

  it('对比度：对中灰几乎不动，对偏亮/偏暗都推离 0.5', () => {
    const params = base({ contrast: 80 });
    const dark = gradePixelReference([0.3, 0.3, 0.3], params)[0];
    const bright = gradePixelReference([0.7, 0.7, 0.7], params)[0];
    const mid = gradePixelReference(MID, params)[0];
    expect(mid).toBeCloseTo(0.5, 2);
    expect(dark).toBeLessThan(0.3);
    expect(bright).toBeGreaterThan(0.7);
  });

  it('饱和度 -100 得到灰度', () => {
    const out = gradePixelReference(WARM_PIXEL, base({ saturation: -100 }));
    expect(out[0]).toBeCloseTo(out[1], 3);
    expect(out[1]).toBeCloseTo(out[2], 3);
  });

  it('高光只影响亮部：压高光让亮像素变暗，对暗像素几乎不生效', () => {
    const params = base({ highlights: -100 });
    const brightBefore = 0.82;
    const darkBefore = 0.12;
    const brightAfter = gradePixelReference([brightBefore, brightBefore, brightBefore], params)[0];
    const darkAfter = gradePixelReference([darkBefore, darkBefore, darkBefore], params)[0];
    expect(brightAfter).toBeLessThan(brightBefore);
    expect(Math.abs(darkAfter - darkBefore)).toBeLessThan(Math.abs(brightAfter - brightBefore));
  });

  it('阴影提亮对暗部的作用大于亮部', () => {
    const params = base({ shadows: 100 });
    const darkGain = gradePixelReference([0.14, 0.14, 0.14], params)[0] - 0.14;
    const brightGain = gradePixelReference([0.86, 0.86, 0.86], params)[0] - 0.86;
    expect(darkGain).toBeGreaterThan(0);
    expect(darkGain).toBeGreaterThan(brightGain);
  });

  it('暗角：中心不变，四角变暗', () => {
    const params = base({ vignette: 100 });
    const center = gradePixelReference(MID, params, { x: 0.5, y: 0.5 })[1];
    const corner = gradePixelReference(MID, params, { x: 0, y: 0 })[1];
    expect(center).toBeCloseTo(0.5, 2);
    expect(corner).toBeLessThan(center - 0.1);
  });

  it('亮度单调：滑块越大结果越亮', () => {
    const series = [-100, -50, 0, 50, 100].map((v) => referenceLuma(MID, base({ brightness: v })));
    for (let i = 1; i < series.length; i++) expect(series[i]).toBeGreaterThan(series[i - 1]);
  });

  it('输出永远在 0..1 且无 NaN（极端参数）', () => {
    const extremes: EditParams = {
      ...DEFAULT_PARAMS,
      brightness: 100,
      contrast: 100,
      saturation: 100,
      vibrance: 100,
      hue: 180,
      temperature: 100,
      tint: -100,
      highlights: 100,
      shadows: 100,
      whites: 100,
      blacks: -100,
      fade: 100,
      dehaze: 100,
      splitShadowHue: 200,
      splitShadowSat: 100,
      splitHighlightHue: 40,
      splitHighlightSat: 100,
      redHue: 100,
      orangeHue: -100,
      yellowSat: 100,
      greenLum: -100,
      aquaHue: 100,
      blueSat: -100,
      purpleLum: 100,
      magentaHue: -100,
      sharpen: 100,
      clarity: 100,
      noiseReduction: 100,
      grain: 100,
      vignette: 100,
      lutStrength: 100,
    };
    const out = gradePixelReference([1, 0.02, 0.6], extremes, { x: 0, y: 0 });
    for (const v of out) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('clamp01 边界', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.42)).toBe(0.42);
  });
});

describe('新增面板的语义（自然饱和 / 色相 / 黑白场 / 褪色 / 分离色调 / HSL）', () => {
  const chroma = ([r, g, b]: [number, number, number]) => Math.max(r, g, b) - Math.min(r, g, b);

  it('自然饱和：对低饱和像素的提升大于高饱和像素', () => {
    const params = base({ vibrance: 80 });
    const low = chroma(gradePixelReference([0.55, 0.5, 0.46], params));
    const lowBefore = chroma([0.55, 0.5, 0.46]);
    const high = chroma(gradePixelReference([0.85, 0.15, 0.15], params));
    const highBefore = chroma([0.85, 0.15, 0.15]);
    expect(low - lowBefore).toBeGreaterThan(high - highBefore);
  });

  it('色相 +120° 把红色转到绿色', () => {
    const out = gradePixelReference([0.8, 0.12, 0.12], base({ hue: 120 }));
    expect(out[1]).toBeGreaterThan(out[0]);
  });

  it('黑场 + 提亮暗部，黑场 - 压实暗部', () => {
    const lifted = gradePixelReference([0.06, 0.06, 0.06], base({ blacks: 100 }))[0];
    const crushed = gradePixelReference([0.2, 0.2, 0.2], base({ blacks: -100 }))[0];
    expect(lifted).toBeGreaterThan(0.06);
    expect(crushed).toBeLessThan(0.2);
  });

  it('白场 + 把接近白的地方推得更白', () => {
    const before = 0.86;
    const after = gradePixelReference([before, before, before], base({ whites: 100 }))[0];
    expect(after).toBeGreaterThan(before);
  });

  it('褪色抬高黑位（哑光），但不会把整张图压暗', () => {
    const before = 0.03;
    const black = gradePixelReference([before, before, before], base({ fade: 100 }))[0];
    const white = gradePixelReference([0.9, 0.9, 0.9], base({ fade: 100 }))[0];
    expect(black).toBeGreaterThan(before + 0.05);
    expect(white).toBeGreaterThan(0.8);
  });

  it('分离色调：阴影偏蓝、高光偏暖', () => {
    const shadow = gradePixelReference(
      [0.18, 0.18, 0.18],
      base({ splitShadowHue: 210, splitShadowSat: 100 }),
    );
    expect(shadow[2]).toBeGreaterThan(shadow[0]);
    const highlight = gradePixelReference(
      [0.88, 0.88, 0.88],
      base({ splitHighlightHue: 40, splitHighlightSat: 100 }),
    );
    expect(highlight[0]).toBeGreaterThan(highlight[2]);
  });

  it('HSL 红色带降饱和只影响红色像素', () => {
    const red = gradePixelReference([0.8, 0.15, 0.15], base({ redSat: -100 }));
    expect(chroma(red)).toBeLessThan(0.2);
    const blue = gradePixelReference([0.15, 0.15, 0.8], base({ redSat: -100 }));
    expect(chroma(blue)).toBeGreaterThan(0.4);
  });
});
