/**
 * 调色参数契约（纯逻辑，无 RN / Expo 依赖，可在 Node 里直接单测）。
 *
 * 这些字段名与范围是与 UI、AI、LUT 共用的接口契约：
 * 改动必须同步 需求.md / 实现方案.md，否则 AI 返回的 JSON 会对不上滑块。
 *
 * 参数集对齐 Lightroom / darktable / ImageToolbox 一类成熟修图工具的常用面板：
 * 光（曝光/对比/高光/阴影/白场/黑场/褪色/去雾）、色（饱和/自然饱和/色相/色温/色调/分离色调）、
 * HSL 八色相、细节（锐化/清晰度/降噪）、效果（颗粒/暗角/LUT 浓度）。
 */

/** HSL 混色器的八个色相带（顺序与 Lightroom 一致） */
export type HslBandKey = 'red' | 'orange' | 'yellow' | 'green' | 'aqua' | 'blue' | 'purple' | 'magenta';

export type HslParamKey =
  | `${HslBandKey}Hue`
  | `${HslBandKey}Sat`
  | `${HslBandKey}Lum`;

export type ParamKey =
  | 'brightness'
  | 'contrast'
  | 'saturation'
  | 'vibrance'
  | 'hue'
  | 'temperature'
  | 'tint'
  | 'highlights'
  | 'shadows'
  | 'whites'
  | 'blacks'
  | 'fade'
  | 'dehaze'
  | 'splitShadowHue'
  | 'splitShadowSat'
  | 'splitHighlightHue'
  | 'splitHighlightSat'
  | HslParamKey
  | 'sharpen'
  | 'clarity'
  | 'noiseReduction'
  | 'grain'
  | 'vignette'
  | 'lutStrength';

export type EditParams = Record<ParamKey, number>;

export type GroupKey = 'light' | 'color' | 'hsl' | 'curve' | 'detail' | 'fx';

export interface ParamMeta {
  key: ParamKey;
  label: string;
  group: GroupKey;
  min: number;
  max: number;
  step: number;
  /** 默认值 = "原图"语义。除 LUT 浓度外一律 0。 */
  default: number;
  /** 该参数在 UI 上的一句话解释 */
  hint: string;
}

export interface HslBandMeta {
  key: HslBandKey;
  label: string;
  /** 色带小圆点的取样色 */
  swatch: string;
}

export const HSL_BANDS: HslBandMeta[] = [
  { key: 'red', label: '红', swatch: '#E2534A' },
  { key: 'orange', label: '橙', swatch: '#E39445' },
  { key: 'yellow', label: '黄', swatch: '#D8C24A' },
  { key: 'green', label: '绿', swatch: '#5FA35C' },
  { key: 'aqua', label: '青', swatch: '#4FA6A6' },
  { key: 'blue', label: '蓝', swatch: '#4E79C7' },
  { key: 'purple', label: '紫', swatch: '#8358B5' },
  { key: 'magenta', label: '品红', swatch: '#C05A9A' },
];

export function hslParamKeys(band: HslBandKey): [ParamKey, ParamKey, ParamKey] {
  return [`${band}Hue`, `${band}Sat`, `${band}Lum`];
}

const hslMeta = (band: HslBandMeta): ParamMeta[] => {
  const [hueKey, satKey, lumKey] = hslParamKeys(band.key);
  return [
    { key: hueKey, label: `${band.label} · 色相`, group: 'hsl', min: -100, max: 100, step: 1, default: 0, hint: `只旋转${band.label}色区，不影响其它颜色` },
    { key: satKey, label: `${band.label} · 饱和`, group: 'hsl', min: -100, max: 100, step: 1, default: 0, hint: `${band.label}色区的浓淡` },
    { key: lumKey, label: `${band.label} · 明度`, group: 'hsl', min: -100, max: 100, step: 1, default: 0, hint: `${band.label}色区的明暗` },
  ];
};

/**
 * 顺序即契约：这份列表的顺序必须与 SKSL 里 uniform 的声明顺序一致，
 * 因为 uniformsFor() 是按它逐项压进 number[] 的（顺序错了参数就会串位）。
 * tests/shader.test.ts 会强制校验。
 *
 * 注意：UI 的分组顺序由 GROUP_PARAMS 决定，与这里的顺序无关；这里按渲染管线顺序排，
 * 便于和 shader 对照阅读。
 */
export const PARAM_LIST: ParamMeta[] = [
  { key: 'brightness', label: '亮度', group: 'light', min: -100, max: 100, step: 1, default: 0, hint: '整体曝光，±50 约等于 ±1EV' },
  { key: 'contrast', label: '对比度', group: 'light', min: -100, max: 100, step: 1, default: 0, hint: '绕中灰的 S 曲线强度' },
  { key: 'saturation', label: '饱和度', group: 'color', min: -100, max: 100, step: 1, default: 0, hint: '整体色彩浓度' },
  { key: 'vibrance', label: '自然饱和', group: 'color', min: -100, max: 100, step: 1, default: 0, hint: '优先提亮低饱和区，肤色更不易过火' },
  { key: 'hue', label: '色相', group: 'color', min: -180, max: 180, step: 1, default: 0, hint: '整体色相旋转，±180° 为反向' },
  { key: 'temperature', label: '色温', group: 'color', min: -100, max: 100, step: 1, default: 0, hint: '正值偏暖（加黄），负值偏冷（加蓝）' },
  { key: 'tint', label: '色调', group: 'color', min: -100, max: 100, step: 1, default: 0, hint: '正值偏洋红，负值偏绿' },
  { key: 'highlights', label: '高光', group: 'light', min: -100, max: 100, step: 1, default: 0, hint: '只影响亮部，压回天空细节' },
  { key: 'shadows', label: '阴影', group: 'light', min: -100, max: 100, step: 1, default: 0, hint: '只影响暗部，提亮死黑' },
  { key: 'whites', label: '白场', group: 'light', min: -100, max: 100, step: 1, default: 0, hint: '最亮端点的位置，决定"白"从哪里开始' },
  { key: 'blacks', label: '黑场', group: 'light', min: -100, max: 100, step: 1, default: 0, hint: '最暗端点的位置，正=提黑、负=压实' },
  { key: 'fade', label: '褪色', group: 'light', min: 0, max: 100, step: 1, default: 0, hint: '哑光胶片感：抬黑位、略降反差' },
  { key: 'dehaze', label: '去雾', group: 'light', min: -100, max: 100, step: 1, default: 0, hint: '正=去掉灰雾（中频对比+饱和），负=加雾' },
  { key: 'splitShadowHue', label: '阴影色相', group: 'color', min: 0, max: 360, step: 1, default: 0, hint: '给暗部染色的色相角；浓度 0 时无效' },
  { key: 'splitShadowSat', label: '阴影浓度', group: 'color', min: 0, max: 100, step: 1, default: 0, hint: '暗部染色强度' },
  { key: 'splitHighlightHue', label: '高光色相', group: 'color', min: 0, max: 360, step: 1, default: 0, hint: '给亮部染色的色相角；浓度 0 时无效' },
  { key: 'splitHighlightSat', label: '高光浓度', group: 'color', min: 0, max: 100, step: 1, default: 0, hint: '亮部染色强度' },
  ...HSL_BANDS.flatMap(hslMeta),
  { key: 'sharpen', label: '锐化', group: 'detail', min: 0, max: 100, step: 1, default: 0, hint: '边缘锐度' },
  { key: 'clarity', label: '清晰度', group: 'detail', min: 0, max: 100, step: 1, default: 0, hint: '中频局部对比，让质感更立体' },
  { key: 'noiseReduction', label: '降噪', group: 'detail', min: 0, max: 100, step: 1, default: 0, hint: '邻域平滑，高 ISO 出片更干净' },
  { key: 'grain', label: '颗粒', group: 'fx', min: 0, max: 100, step: 1, default: 0, hint: '胶片颗粒，暗部更明显' },
  { key: 'vignette', label: '暗角', group: 'fx', min: 0, max: 100, step: 1, default: 0, hint: '四周压暗，收拢视线' },
  { key: 'lutStrength', label: 'LUT 浓度', group: 'fx', min: 0, max: 100, step: 1, default: 100, hint: 'LUT 与原图的混合比例' },
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
  { key: 'hsl', label: 'HSL' },
  { key: 'curve', label: '曲线' },
  { key: 'detail', label: '细节' },
  { key: 'fx', label: '效果' },
];

export const GROUP_PARAMS: Record<GroupKey, ParamKey[]> = {
  light: ['brightness', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'fade', 'dehaze'],
  color: [
    'saturation',
    'vibrance',
    'hue',
    'temperature',
    'tint',
    'splitShadowHue',
    'splitShadowSat',
    'splitHighlightHue',
    'splitHighlightSat',
  ],
  hsl: PARAM_LIST.filter((meta) => meta.group === 'hsl').map((meta) => meta.key),
  /** 曲线由 CurveEditor 直接编辑，没有线性滑块 */
  curve: [],
  detail: ['sharpen', 'clarity', 'noiseReduction'],
  fx: ['grain', 'vignette', 'lutStrength'],
};

export const DEFAULT_PARAMS: EditParams = PARAM_LIST.reduce((acc, meta) => {
  acc[meta.key] = meta.default;
  return acc;
}, {} as EditParams);

export function clampValue(key: ParamKey, value: number): number {
  const meta = PARAM_META[key];
  if (!Number.isFinite(value)) return meta.default;
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
  return PARAM_KEYS.every((key) => params[key] === PARAM_META[key].default);
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
  // 色相类是角度，直接带度数更直观
  if (key.endsWith('Hue') && meta.max === 360) return `${Math.round(value)}°`;
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
