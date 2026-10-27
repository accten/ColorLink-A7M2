import { describe, expect, it } from 'vitest';

import { identityLut, packLut, parseCube, sampleLut } from '../src/core/lut';

const cube2 = `# 2x2x2 identity
TITLE "identity"
LUT_3D_SIZE 2
DOMAIN_MIN 0 0 0
DOMAIN_MAX 1 1 1
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`;

describe('parseCube', () => {
  it('解析合法 2³ LUT', () => {
    const result = parseCube(cube2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lut.size).toBe(2);
    expect(result.lut.data).toHaveLength(2 * 2 * 2 * 3);
    // 数据行顺序 r 最快：第二行 (1,0,0) 落在 index 3..5
    expect(Array.from(result.lut.data.slice(3, 6))).toEqual([1, 0, 0]);
  });

  it('拒绝 1D LUT', () => {
    const result = parseCube('LUT_1D_SIZE 16\n0 0 0\n1 1 1\n');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('1D');
  });

  it('拒绝缺少 LUT_3D_SIZE', () => {
    const result = parseCube('0 0 0\n1 1 1\n');
    expect(result.ok).toBe(false);
  });

  it('拒绝数据量不匹配', () => {
    const result = parseCube('LUT_3D_SIZE 3\n0 0 0\n1 1 1\n');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('不匹配');
  });

  it('拒绝越界尺寸与坏数据行', () => {
    expect(parseCube('LUT_3D_SIZE 100\n').ok).toBe(false);
    expect(parseCube('LUT_3D_SIZE 2\n0 0\n').ok).toBe(false);
    expect(parseCube('LUT_3D_SIZE 2\n0 0 x\n').ok).toBe(false);
    expect(parseCube('').ok).toBe(false);
  });

  it('修正越界采样值到 0..1', () => {
    const text = 'LUT_3D_SIZE 2\n' + Array.from({ length: 8 }, () => '2 -1 0.5').join('\n');
    const result = parseCube(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lut.data[0]).toBe(1);
    expect(result.lut.data[1]).toBe(0);
    expect(result.lut.data[2]).toBeCloseTo(0.5);
  });
});

describe('packLut', () => {
  it('布局为宽=size 高=size²，且 b 决定行块', () => {
    const lut = identityLut(3);
    const packed = packLut(lut);
    expect(packed.width).toBe(3);
    expect(packed.height).toBe(9);
    expect(packed.pixels).toHaveLength(3 * 9 * 4);

    // (r=2, g=0, b=1) → 行 y = 1*3+0 = 3, 列 x = 2
    const idx = (3 * 3 + 2) * 4;
    expect(packed.pixels[idx]).toBe(255); // r
    expect(packed.pixels[idx + 1]).toBe(0); // g
    expect(packed.pixels[idx + 2]).toBe(128); // b = 0.5 → round(127.5) = 128
    expect(packed.pixels[idx + 3]).toBe(255);
  });
});

describe('sampleLut', () => {
  it('恒等 LUT 的三线性取样近似回到输入', () => {
    const lut = identityLut(17);
    const [r, g, b] = sampleLut(lut, 0.25, 0.5, 0.75);
    expect(r).toBeCloseTo(0.25, 1);
    expect(g).toBeCloseTo(0.5, 1);
    expect(b).toBeCloseTo(0.75, 1);
  });

  it('已解析的 cube 取样结果与数据一致', () => {
    const parsed = parseCube(cube2);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(sampleLut(parsed.lut, 0, 0, 0)).toEqual([0, 0, 0]);
    const white = sampleLut(parsed.lut, 1, 1, 1);
    expect(white.map((v) => Math.round(v))).toEqual([1, 1, 1]);
  });

  it('输入夹取到 0..1', () => {
    const lut = identityLut(2);
    expect(sampleLut(lut, -1, 5, 0.5)).toEqual([0, 1, 0.5]);
  });
});
