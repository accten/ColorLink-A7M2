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
    expect(names).toEqual(['img', 'lut', 'curve', ...UNIFORM_PREFIX, ...PARAM_KEYS]);
  });

  it('三个 shader 子节点顺序固定为 img、lut、curve', () => {
    const shaders = uniformDecls.filter((u) => u.type === 'shader').map((u) => u.name);
    expect(shaders).toEqual(['img', 'lut', 'curve']);
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
  it('shader 用像素坐标取样（不是 0..1），且带 +0.5 半像素对齐', () => {
    expect(GRADE_SKSL).toContain('lut.eval(float2(i0.x + 0.5, py))');
    expect(GRADE_SKSL).toContain('lut.eval(float2(i1.x + 0.5, py))');
  });

  it('蓝色轴决定行块，与 packLut 的 y = b*n + g 一致', () => {
    expect(GRADE_SKSL).toMatch(/rowBase = bz \* n \+ 0\.5/);
    expect(GRADE_SKSL).toContain('py = rowBase + gy');
    // 采样坐标要落在行块内，不能再除以 n
    expect(GRADE_SKSL).not.toMatch(/rowBase[\s\S]{0,40}\/ \(n\)/);
  });

  it('是三线性插值（8 点），不是只插蓝轴', () => {
    // 两层 z × 两层 y，每层里 r 方向取两个点插值
    expect(GRADE_SKSL).toMatch(/for \(int z = 0; z < 2; z\+\+\)/);
    expect(GRADE_SKSL).toMatch(/for \(int y = 0; y < 2; y\+\+\)/);
    expect(GRADE_SKSL).toMatch(/mix\(s0, s1, half\(t\.x\)\)/);
    expect(GRADE_SKSL).toMatch(/\* half\(wy\)/);
    expect(GRADE_SKSL).toMatch(/\* half\(wz\)/);
  });

  it('LUT 浓度可调，且按 0..100 归一', () => {
    expect(GRADE_SKSL).toContain('lutStrength / 100.0');
  });

  it('没有 LUT 时跳过采样（hasLut 门控）', () => {
    expect(GRADE_SKSL).toContain('hasLut > 0.5');
  });
});

describe('色调曲线纹理契约', () => {
  it('按像素坐标取样，且 0..1 映射到 256 个像素中心', () => {
    expect(GRADE_SKSL).toContain('float(s.r) * 255.0 + 0.5');
    expect(GRADE_SKSL).toContain('float(s.g) * 255.0 + 0.5');
    expect(GRADE_SKSL).toContain('float(s.b) * 255.0 + 0.5');
  });

  it('三个通道各自取样（纹理里已经是主曲线 ∘ 单通道曲线）', () => {
    expect(GRADE_SKSL).toMatch(/curve\.eval\(float2\(float\(s\.r\)[\s\S]{0,40}\)\.r/);
    expect(GRADE_SKSL).toMatch(/curve\.eval\(float2\(float\(s\.g\)[\s\S]{0,40}\)\.g/);
    expect(GRADE_SKSL).toMatch(/curve\.eval\(float2\(float\(s\.b\)[\s\S]{0,40}\)\.b/);
  });

  it('曲线在分离色调之后、锐化之前', () => {
    const splitIdx = GRADE_SKSL.indexOf('splitColor(splitShadowHue');
    const curveIdx = GRADE_SKSL.indexOf('c = applyCurve(c);');
    const sharpenIdx = GRADE_SKSL.indexOf('sharpen / 100.0');
    expect(curveIdx).toBeGreaterThan(splitIdx);
    expect(curveIdx).toBeLessThan(sharpenIdx);
  });
});

describe('HSL 八色带契约', () => {
  it('八个色带都用同一套权重函数，并按最大权重归一化', () => {
    expect(GRADE_SKSL).toContain('half bandWeight(');
    expect(GRADE_SKSL.match(/bandWeight\(hueDeg/g)?.length).toBe(8);
    // 按最大权重归一：色带中心必须拿到 100% 调整量（按和会被邻居色带稀释）
    expect(GRADE_SKSL).toContain('half wMax = max(');
    expect(GRADE_SKSL).toContain('/ wNorm');
  });

  it('色相旋转按度数（/360）换算', () => {
    expect(GRADE_SKSL).toContain('hue / 360.0');
    expect(GRADE_SKSL).toContain('dHue * (60.0 / 360.0) / 100.0');
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
