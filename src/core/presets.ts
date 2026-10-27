import { EditParams, applyPresetParams } from './params';

/**
 * 内置预设。需求 FR-05 要求至少 6 个；这里的取值刻意"克制"——
 * 预设是起点不是终点，用户之后还要自己推滑块。
 */
export interface Preset {
  id: string;
  name: string;
  description: string;
  isBuiltin: boolean;
  params: EditParams;
  lutPath?: string | null;
}

const builtin = (
  id: string,
  name: string,
  description: string,
  partial: Partial<EditParams>,
): Preset => ({
  id,
  name,
  description,
  isBuiltin: true,
  params: applyPresetParams(partial),
  lutPath: null,
});

export const BUILTIN_PRESETS: Preset[] = [
  builtin('original', '原图', '不做任何调整', {}),
  builtin('film', '胶片', '低饱和 + 颗粒 + 轻暗角', {
    contrast: 8,
    saturation: -14,
    temperature: 10,
    tint: 3,
    highlights: -12,
    shadows: 10,
    grain: 16,
    vignette: 7,
    clarity: 4,
  }),
  builtin('cinema', '电影感', '青橙分离 + 压高光', {
    contrast: 14,
    saturation: -6,
    temperature: -8,
    tint: -4,
    highlights: -20,
    shadows: 14,
    clarity: 8,
    vignette: 12,
  }),
  builtin('clean', '清透', '提亮阴影 + 略降对比', {
    brightness: 6,
    contrast: -6,
    saturation: 4,
    temperature: -3,
    highlights: -6,
    shadows: 16,
    sharpen: 12,
    clarity: 6,
  }),
  builtin('warm', '暖调', '金色时刻', {
    brightness: 4,
    contrast: 6,
    saturation: 6,
    temperature: 20,
    tint: 5,
    highlights: -8,
    shadows: 8,
    clarity: 5,
    vignette: 6,
  }),
  builtin('cool', '冷调', '清冷静谧', {
    contrast: 8,
    saturation: -2,
    temperature: -18,
    tint: -3,
    highlights: -10,
    shadows: 6,
    clarity: 7,
    grain: 5,
  }),
];

export function findPreset(presets: Preset[], id: string): Preset | undefined {
  return presets.find((p) => p.id === id);
}

/** 预设文件（FR-08 的导入/导出格式）。 */
export interface PresetFile {
  version: 1;
  name: string;
  params: EditParams;
  lutPath?: string | null;
}

export function toPresetFile(name: string, params: EditParams, lutPath?: string | null): PresetFile {
  return { version: 1, name, params, lutPath: lutPath ?? null };
}
