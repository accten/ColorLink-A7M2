import { describe, expect, it } from 'vitest';

import { BUILTIN_PRESETS } from '../src/core/presets';
import { DEFAULT_PARAMS, isNeutral, normalizeParams } from '../src/core/params';

/** 内置预设是调色功能的入口，规则要守住：唯一 id、参数合法、原图=中性 */
describe('builtin presets', () => {
  it('至少有 9 个预设且 id 唯一', () => {
    expect(BUILTIN_PRESETS.length).toBeGreaterThanOrEqual(9);
    const ids = BUILTIN_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每个预设的参数都在合法范围内', () => {
    for (const preset of BUILTIN_PRESETS) {
      const { params, warnings } = normalizeParams(preset.params, { keepMissingDefaults: true });
      expect(warnings, `${preset.id} 有越界参数`).toEqual([]);
      expect(params).toEqual(preset.params);
    }
  });

  it('原图预设必须是中性参数', () => {
    const original = BUILTIN_PRESETS.find((p) => p.id === 'original');
    expect(original).toBeDefined();
    expect(original?.params).toEqual(DEFAULT_PARAMS);
    expect(isNeutral(original?.params ?? DEFAULT_PARAMS)).toBe(true);
  });

  it('黑白预设把饱和度拉到最低', () => {
    const mono = BUILTIN_PRESETS.find((p) => p.id === 'mono');
    expect(mono?.params.saturation).toBe(-100);
  });

  it('新增的预设都要有名字与说明', () => {
    for (const id of ['mono', 'portrait', 'punch', 'night']) {
      const preset = BUILTIN_PRESETS.find((p) => p.id === id);
      expect(preset, `缺少预设 ${id}`).toBeDefined();
      expect(preset?.name.length ?? 0).toBeGreaterThan(0);
      expect(preset?.description.length ?? 0).toBeGreaterThan(4);
      expect(isNeutral(preset?.params ?? DEFAULT_PARAMS)).toBe(false);
    }
  });
});
