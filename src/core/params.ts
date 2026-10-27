/**
 * 调色参数契约（纯逻辑，无 RN / Expo 依赖，可在 Node 里直接单测）。
 *
 * 这些字段名与范围是与 UI、AI、LUT 共用的接口契约：
 * 改动必须同步 需求.md / 实现方案.md，否则 AI 返回的 JSON 会对不上滑块。
 */

export type ParamKey =
  | 'brightness'
  | 'contrast'
  | 'saturation'
  | 'temperature'
  | 'tint'
  | 'highlights'
  | 'shadows'
  | 'sharpen'
  | 'clarity'
  | 'grain'
  | 'vignette'
  | 'lutStrength';

export type EditParams = Record<ParamKey, number>;

export type GroupKey = 'light' | 'color' | 'detail' | 'fx';

export interface ParamMeta {
  key: ParamKey;
  label: string;
  group: GroupKey;
  min: number;
  max: number;
  step: number;
  /** 该参数在 UI 上的一句话解释 */
  hint: string;
}

/**
 * 顺序即契约：这份列表的顺序必须与 SKSL 里 uniform 的声明顺序一致，
 * 因为 uniformsFor() 是按它逐项压进 number[] 的（顺序错了参数就会串位）。
 * tests/shader.test.ts 会强制校验。
 *
 * 注意：UI 的分组顺序由 GROUP_PARAMS 决定，与这里的顺序无关。
 */
export const PARAM_LIST: ParamMeta[] = [
  { key: 'brightness', label: '亮度', group: 'light', min: -100, max: 100, step: 1, hint: '整体曝光，±50 约等于 ±1EV' },
  { key: 'contrast', label: '对比度', group: 'light', min: -100, max: 100, step: 1, hint: '绕中灰的 S 曲线强度' },
  { key: 'saturation', label: '饱和度', group: 'color', min: -100, max: 100, step: 1, hint: '整体色彩浓度' },
  { key: 'temperature', label: '色温', group: 'color', min: -100, max: 100, step: 1, hint: '正值偏暖（加黄），负值偏冷（加蓝）' },
  { key: 'tint', label: '色调', group: 'color', min: -100, max: 100, step: 1, hint: '正值偏洋红，负值偏绿' },
  { key: 'highlights', label: '高光', group: 'light', min: -100, max: 100, step: 1, hint: '只影响亮部，压回天空细节' },
  { key: 'shadows', label: '阴影', group: 'light', min: -100, max: 100, step: 1, hint: '只影响暗部，提亮死黑' },
  { key: 'sharpen', label: '锐化', group: 'detail', min: 0, max: 100, step: 1, hint: '边缘锐度' },
  { key: 'clarity', label: '清晰度', group: 'detail', min: 0, max: 100, step: 1, hint: '中频局部对比，让质感更立体' },
  { key: 'grain', label: '颗粒', group: 'fx', min: 0, max: 100, step: 1, hint: '胶片颗粒，暗部更明显' },
  { key: 'vignette', label: '暗角', group: 'fx', min: 0, max: 100, step: 1, hint: '四周压暗，收拢视线' },
  { key: 'lutStrength', label: 'LUT 浓度', group: 'fx', min: 0, max: 100, step: 1, hint: 'LUT 与原图的混合比例' },
];

export const PARAM_KEYS: ParamKey[] = PARAM_LIST.map((p) => p.key);

export const PARAM_META: Record<ParamKey, ParamMeta> = PARAM_LIST.reduce(
  (acc, meta) => {
    acc[meta.key] = meta;
    return acc;
  },
  {} as Record<ParamKey, ParamMeta>,
);

export const GROUPS: { key: GroupKey; label: string }[] = [
  { key: 'light', label: '光' },
  { key: 'color', label: '色' },
  { key: 'detail', label: '细节' },
  { key: 'fx', label: '效果' },
];

export const GROUP_PARAMS: Record<GroupKey, ParamKey[]> = {
  light: ['brightness', 'contrast', 'highlights', 'shadows'],
  color: ['saturation', 'temperature', 'tint'],
  detail: ['clarity', 'sharpen'],
  fx: ['grain', 'vignette', 'lutStrength'],
};

export const DEFAULT_PARAMS: EditParams = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0,
  tint: 0,
  highlights: 0,
  shadows: 0,
  sharpen: 0,
  clarity: 0,
  grain: 0,
  vignette: 0,
  lutStrength: 100,
};

export function clampValue(key: ParamKey, value: number): number {
  const meta = PARAM_META[key];
  if (!Number.isFinite(value)) return DEFAULT_PARAMS[key];
  const stepped = Math.round(value / meta.step) * meta.step;
  return Math.min(meta.max, Math.max(meta.min, Math.round(stepped * 100) / 100));
}

/**
 * 外部输入（AI 返回 / 预设文件 / 旧版本数据）的归一化：
 * 丢弃未知字段、缺失字段回默认、越界值夹取，并把每一处修正记进 warnings。
 */
export function normalizeParams(
  input: Partial<Record<ParamKey, unknown>> | null | undefined,
  options: { keepMissingDefaults?: boolean } = {},
): { params: EditParams; warnings: string[] } {
  const warnings: string[] = [];
  const params: EditParams = { ...DEFAULT_PARAMS };

  if (!input || typeof input !== 'object') {
    return { params, warnings: ['参数对象为空，已回退默认值'] };
  }

  for (const key of PARAM_KEYS) {
    const raw = (input as Record<string, unknown>)[key];
    if (raw === undefined) {
      if (!options.keepMissingDefaults) warnings.push(`缺少字段 ${key}，按默认值处理`);
      continue;
    }
    const num = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(num)) {
      warnings.push(`${key} 不是数字，按默认值处理`);
      continue;
    }
    const clamped = clampValue(key, num);
    if (clamped !== num) warnings.push(`${key}=${num} 越界，已夹取到 ${clamped}`);
    params[key] = clamped;
  }

  const unknown = Object.keys(input).filter((k) => !PARAM_KEYS.includes(k as ParamKey));
  if (unknown.length) warnings.push(`忽略未知字段：${unknown.join(', ')}`);

  return { params, warnings };
}

export function isNeutral(params: EditParams): boolean {
  return PARAM_KEYS.every((key) => params[key] === DEFAULT_PARAMS[key]);
}

export function resetParams(): EditParams {
  return { ...DEFAULT_PARAMS };
}

export function applyPresetParams(partial: Partial<EditParams>): EditParams {
  return normalizeParams(partial, { keepMissingDefaults: true }).params;
}

/** 只改一个键（滑块 onCommit 用，避免整对象重建产生无谓重渲染）。 */
export function withParam(params: EditParams, key: ParamKey, value: number): EditParams {
  return { ...params, [key]: clampValue(key, value) };
}

export interface ParamDiff {
  key: ParamKey;
  label: string;
  from: number;
  to: number;
  delta: number;
}

export function diffParams(before: EditParams, after: EditParams): ParamDiff[] {
  return PARAM_KEYS.filter((key) => before[key] !== after[key]).map((key) => ({
    key,
    label: PARAM_META[key].label,
    from: before[key],
    to: after[key],
    delta: after[key] - before[key],
  }));
}

export function formatParamValue(key: ParamKey, value: number): string {
  const meta = PARAM_META[key];
  if (meta.min < 0) {
    if (value === 0) return '0';
    return value > 0 ? `+${value}` : `${value}`;
  }
  return `${value}`;
}

/** UI 上的一句话摘要，用于图库卡片 / 任务中心。 */
export function describeParams(params: EditParams): string {
  const diff = diffParams(DEFAULT_PARAMS, params);
  if (!diff.length) return '原图';
  return diff
    .slice(0, 3)
    .map((d) => `${d.label} ${d.delta > 0 ? '+' : ''}${d.delta}`)
    .join(' · ');
}
