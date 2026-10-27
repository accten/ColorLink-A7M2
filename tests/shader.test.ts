import { describe, expect, it } from 'vitest';

import { GRADE_SKSL, GRADE_UNIFORM_KEYS } from '../src/features/grading/shader';
import { PARAM_KEYS } from '../src/core/params';
import { UNIFORM_PREFIX } from '../src/core/grade';

/**
 * 着色器与 JS 侧的契约测试。
 *
 * 这类"两个文件必须逐字对齐"的地方（uniform 顺序、LUT 纹理布局）最容易出静默 bug：
 * 编译能过、界面能点，但颜色全错或参数串位。用字符串断言把契约钉住。
 */

const uniformDecls = [...GRADE_SKSL.matchAll(/uniform\s+(shader|float2|float)\s+(\w+)\s*;/g)].map((m) => ({
  type: m[1],
  name: m[2],
}));

describe('SKSL uniform 契约', () => {
  it('声明的 uniform 数量与顺序严格匹配 JS 侧', () => {
    const names = uniformDecls.map((u) => u.name);
    expect(names).toEqual(['img', 'lut', ...UNIFORM_PREFIX, ...PARAM_KEYS]);
  });

  it('两个 shader 子节点顺序固定为 img、lut', () => {
    const shaders = uniformDecls.filter((u) => u.type === 'shader').map((u) => u.name);
    expect(shaders).toEqual(['img', 'lut']);
  });

  it('没有重复声明', () => {
    const names = uniformDecls.map((u) => u.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('没有任何 uniform 是 int/bool（避免与 number[] 传参错位）', () => {
    expect(GRADE_SKSL).not.toMatch(/uniform\s+(int|bool|half)\b/);
  });

  it('导出常量覆盖全部 uniform 名', () => {
    expect(new Set(GRADE_UNIFORM_KEYS)).toEqual(new Set(uniformDecls.map((u) => u.name)));
  });
});

describe('LUT 采样与打包布局同步', () => {
  it('shader 用像素坐标取样（不是 0..1）', () => {
    expect(GRADE_SKSL).toContain('lut.eval(px)');
    expect(GRADE_SKSL).toContain('float2 px = float2(rg.x + 0.5, bb * n + rg.y + 0.5)');
  });

  it('蓝色轴决定行块，与 packLut 的 y = b*n + g 一致', () => {
    expect(GRADE_SKSL).toMatch(/bb \* n \+ rg\.y/);
    // 采样坐标要落在行块内，所以分母是 n*n
    expect(GRADE_SKSL).not.toMatch(/bb \* n \+ rg\.y[\s\S]{0,40}\/ \(n\)/);
  });

  it('LUT 浓度可调，且按 0..100 归一', () => {
    expect(GRADE_SKSL).toContain('lutStrength / 100.0');
  });

  it('没有 LUT 时跳过采样（hasLut 门控）', () => {
    expect(GRADE_SKSL).toContain('hasLut > 0.5');
  });
});

describe('着色器管线顺序', () => {
  it('白平衡/曝光在线性域，对比/LUT 在显示域', () => {
    const linearIdx = GRADE_SKSL.indexOf('toLinear(src)');
    const srgbIdx = GRADE_SKSL.indexOf('toSrgb(lin)');
    const lutIdx = GRADE_SKSL.indexOf('sampleLut(c)');
    expect(linearIdx).toBeGreaterThan(0);
    expect(srgbIdx).toBeGreaterThan(linearIdx);
    expect(lutIdx).toBeGreaterThan(srgbIdx);
  });

  it('颗粒不依赖时间（拖动滑块时不应闪烁）', () => {
    expect(GRADE_SKSL).toMatch(/fract\(sin\(dot\(xy/);
    expect(GRADE_SKSL).not.toMatch(/iTime|uTime|time/);
  });

  it('暗角在锐化之后，避免边缘被压暗后噪点更脏', () => {
    expect(GRADE_SKSL.indexOf('vignette / 100.0')).toBeGreaterThan(GRADE_SKSL.indexOf('sharpen / 100.0'));
  });
});
