import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseCube, sampleLut } from '../src/core/lut';

/**
 * 用真实文件校验随仓库分发的 LUT（用户手测会直接导入这两个文件）。
 * 如果解析器与文件格式对不上，这里先红，而不是等到手机上"导入后画面没变化"。
 */

const root = join(__dirname, '..', 'luts');

const read = (name: string) => readFileSync(join(root, name), 'utf8');

describe('随仓库分发的示例 LUT', () => {
  it('sample-identity.cube：17³、可解析、恒等', () => {
    const result = parseCube(read('sample-identity.cube'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lut.size).toBe(17);
    expect(result.lut.data).toHaveLength(17 * 17 * 17 * 3);

    const samples: [number, number, number][] = [
      [0, 0, 0],
      [0.5, 0.5, 0.5],
      [1, 1, 1],
      [0.25, 0.6, 0.1],
    ];
    for (const [r, g, b] of samples) {
      const [outR, outG, outB] = sampleLut(result.lut, r, g, b);
      expect(outR).toBeCloseTo(r, 2);
      expect(outG).toBeCloseTo(g, 2);
      expect(outB).toBeCloseTo(b, 2);
    }
  });

  it('sample-teal-orange.cube：暗部偏青、亮部偏暖', () => {
    const result = parseCube(read('sample-teal-orange.cube'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lut.size).toBe(17);

    const dark = sampleLut(result.lut, 0.05, 0.05, 0.05);
    expect(dark[2]).toBeGreaterThan(dark[0]); // 暗部：蓝 > 红

    const bright = sampleLut(result.lut, 0.95, 0.95, 0.95);
    expect(bright[0]).toBeGreaterThan(bright[2]); // 亮部：红 > 蓝
  });

  it('两个文件都没有越界采样值', () => {
    for (const name of ['sample-identity.cube', 'sample-teal-orange.cube']) {
      const result = parseCube(read(name));
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const min = Math.min(...result.lut.data);
      const max = Math.max(...result.lut.data);
      expect(min).toBeGreaterThanOrEqual(0);
      expect(max).toBeLessThanOrEqual(1);
    }
  });
});
