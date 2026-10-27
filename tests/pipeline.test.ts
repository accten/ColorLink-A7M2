import { describe, expect, it } from 'vitest';

import {
  exportFileName,
  findAssetByHash,
  newAssetId,
  uniqueFileName,
  type Asset,
} from '../src/core/asset';
import { BUILTIN_PRESETS } from '../src/core/presets';
import { PARAM_KEYS, PARAM_LIST, clampValue, type EditParams } from '../src/core/params';
import { looksLikeNoop } from '../src/core/ai';

const makeAsset = (id: string, hash: string): Asset => ({
  id,
  fileName: `${id}.jpg`,
  uri: `file:///ingest/${id}.jpg`,
  capturedAt: 1_700_000_000_000,
  width: 6000,
  height: 4000,
  originalHash: hash,
  bytes: 8_000_000,
  status: 'ingested',
  source: 'camera',
});

describe('一拍一传去重', () => {
  const assets = [makeAsset('a', 'hash-a'), makeAsset('b', 'hash-b')];

  it('命中已有摘要', () => {
    expect(findAssetByHash(assets, 'hash-b')?.id).toBe('b');
  });

  it('空摘要不误判（哈希失败时不能把照片丢掉）', () => {
    expect(findAssetByHash(assets, '')).toBeUndefined();
  });

  it('新摘要判为不重复', () => {
    expect(findAssetByHash(assets, 'hash-c')).toBeUndefined();
  });

  it('连续 5 次拍摄、其中 2 次同图 → 只入库 4 张', () => {
    const hashes = ['h1', 'h2', 'h1', 'h3', 'h1'];
    const lib: Asset[] = [];
    for (const [i, hash] of hashes.entries()) {
      if (findAssetByHash(lib, hash)) continue;
      lib.push(makeAsset(`id-${i}`, hash));
    }
    expect(lib).toHaveLength(3); // h1/h2/h3 各一份
    expect(lib.map((a) => a.originalHash)).toEqual(['h1', 'h2', 'h3']);
  });

  it('assetId 不会在连拍时撞车', () => {
    const date = new Date(2026, 9, 29, 14, 30, 12);
    const ids = new Set([1, 2, 3, 4, 5].map((seq) => newAssetId(date, seq)));
    expect(ids.size).toBe(5);
  });
});

describe('导出文件名不覆盖', () => {
  const date = new Date(2026, 9, 29, 14, 30, 12);

  it('同一秒导出两次 → 第二次加 -2', () => {
    const first = exportFileName('DSC01234.JPG', date);
    const taken = new Set([first]);
    const second = uniqueFileName(exportFileName('DSC01234.JPG', date), (n) => taken.has(n));
    expect(second).toBe('DSC01234_edited_20261029_143012-2.jpg');
  });

  it('第三次继续递增', () => {
    const base = exportFileName('a.png', date);
    const taken = new Set([base, base.replace('.jpg', '-2.jpg')]);
    expect(uniqueFileName(base, (n) => taken.has(n))).toBe(base.replace('.jpg', '-3.jpg'));
  });

  it('无冲突时原样返回', () => {
    expect(uniqueFileName('x_edited_1.jpg', () => false)).toBe('x_edited_1.jpg');
  });

  it('没有扩展名也能正确加后缀', () => {
    expect(uniqueFileName('name', (n) => n === 'name')).toBe('name-2');
  });
});

describe('内置预设', () => {
  it('至少 6 个、id 唯一、含"原图"', () => {
    expect(BUILTIN_PRESETS.length).toBeGreaterThanOrEqual(6);
    expect(new Set(BUILTIN_PRESETS.map((p) => p.id)).size).toBe(BUILTIN_PRESETS.length);
    expect(BUILTIN_PRESETS[0].id).toBe('original');
  });

  it('所有取值都在参数范围内（预设是契约的一部分）', () => {
    for (const preset of BUILTIN_PRESETS) {
      for (const meta of PARAM_LIST) {
        const value = preset.params[meta.key];
        expect(value).toBeGreaterThanOrEqual(meta.min);
        expect(value).toBeLessThanOrEqual(meta.max);
        expect(clampValue(meta.key, value)).toBe(value);
      }
    }
  });

  it('"原图"预设是全默认值', () => {
    const original = BUILTIN_PRESETS[0];
    expect(PARAM_KEYS.every((k) => original.params[k] === (k === 'lutStrength' ? 100 : 0))).toBe(true);
  });

  it('每个非"原图"预设至少改动 2 个字段（否则预设没有存在意义）', () => {
    for (const preset of BUILTIN_PRESETS.slice(1)) {
      const changed = PARAM_KEYS.filter(
        (k) => preset.params[k] !== (k === 'lutStrength' ? 100 : 0),
      );
      expect(changed.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('AI 结果"无变化"判定与 LUT 浓度', () => {
  const neutral = BUILTIN_PRESETS[0].params as EditParams;

  it('全默认（lutStrength=100）视为无变化', () => {
    expect(looksLikeNoop(neutral, '调成胶片感')).toBe(true);
  });

  it('lutStrength 被调低也算有变化（用户可能只想减淡 LUT）', () => {
    expect(looksLikeNoop({ ...neutral, lutStrength: 40 }, 'LUT 淡一点')).toBe(false);
  });
});
