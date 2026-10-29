/**
 * 调色的纯逻辑部分（无 Skia 依赖，可在 Node 里单测）。
 *
 * 这里有两个"必须与 GPU 实现保持一致"的东西：
 *  1. uniform 的排列顺序 —— 决定参数会不会串位（色温变成对比度这种脚底打滑的 bug）；
 *  2. 参数语义的参考实现 —— 用 CPU 复刻一遍 shader 的数学，验证"正数=更暖/更亮"这类契约，
 *     避免把符号写反却只能靠肉眼看出来。
 */

import { EditParams, HslBandKey, PARAM_LIST, PARAM_KEYS } from './params';

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055);

export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
};

const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

type RGB = [number, number, number];

/** 与 SKSL 声明顺序严格对应：srcSize(vec2), lutSize, hasLut, hasCurve, 然后全部参数。 */
export const UNIFORM_PREFIX = ['srcSize', 'lutSize', 'hasLut', 'hasCurve'] as const;

/** 扁平化 uniform 数组（喂给 RuntimeEffect.makeShaderWithChildren）。 */
export function uniformsFor(
  params: EditParams,
  width: number,
  height: number,
  lutSize: number,
  hasLut: boolean,
  hasCurve = false,
): number[] {
  const values = [width, height, Math.max(2, lutSize), hasLut ? 1 : 0, hasCurve ? 1 : 0];
  for (const meta of PARAM_LIST) values.push(params[meta.key]);
  return values;
}

/** 命名版 uniform（喂给声明式 <Shader uniforms={...}>）。 */
export function uniformsObject(
  params: EditParams,
  width: number,
  height: number,
  lutSize: number,
  hasLut: boolean,
  hasCurve = false,
): Record<string, number | number[]> {
  const object: Record<string, number | number[]> = {
    srcSize: [width, height],
    lutSize: Math.max(2, lutSize),
    hasLut: hasLut ? 1 : 0,
    hasCurve: hasCurve ? 1 : 0,
  };
  for (const meta of PARAM_LIST) object[meta.key] = params[meta.key];
  return object;
}

/** 等比缩放到目标长边（不放大）。导出尺寸计算，必须与「不裁切」的预期一致。 */
export function fitWithin(width: number, height: number, longEdge: number): { width: number; height: number } {
  const maxSide = Math.max(width, height) || 1;
  const scale = Math.min(1, longEdge / maxSide);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/* ------------------------------------------------------------------ */
/* HSL 工具（与 SKSL 的 rgb2hsl / hsl2rgb / bandWeight 一一对应）        */
/* ------------------------------------------------------------------ */

export function rgbToHsl([r, g, b]: RGB): RGB {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  if (d < 1e-4) return [0, 0, l];

  const s = l > 0.5 ? d / Math.max(1e-4, 2 - mx - mn) : d / Math.max(1e-4, mx + mn);
  let h: number;
  // 用「等于最大值」判定：蓝色最大时 r >= g 也成立，用 >= 会把蓝色算成红色分支
  if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function hue2rgb(p: number, q: number, t: number): number {
  let tt = t;
  if (tt < 0) tt += 1;
  if (tt > 1) tt -= 1;
  if (tt < 1 / 6) return p + (q - p) * 6 * tt;
  if (tt < 0.5) return q;
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
  return p;
}

export function hslToRgb([h, s, l]: RGB): RGB {
  if (s < 1e-4) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)];
}

/** 色带三角形权重，按 360° 环绕。 */
export function bandWeight(hueDeg: number, center: number, halfWidth: number): number {
  const raw = Math.abs(hueDeg - center);
  const d = Math.min(raw, 360 - raw);
  return clamp01(1 - d / halfWidth);
}

const HSL_BANDS_UI: { center: number; halfWidth: number; prefix: HslBandKey }[] = [
  { center: 0, halfWidth: 45, prefix: 'red' },
  { center: 30, halfWidth: 45, prefix: 'orange' },
  { center: 60, halfWidth: 45, prefix: 'yellow' },
  { center: 120, halfWidth: 55, prefix: 'green' },
  { center: 180, halfWidth: 55, prefix: 'aqua' },
  { center: 240, halfWidth: 50, prefix: 'blue' },
  { center: 280, halfWidth: 45, prefix: 'purple' },
  { center: 320, halfWidth: 45, prefix: 'magenta' },
];

function applyHueMix(color: RGB, params: EditParams): RGB {
  const [h, s, l] = rgbToHsl(color);
  const hueDeg = (((h + params.hue / 360) % 1) + 1) % 1;
  const degrees = hueDeg * 360;

  let wMax = 0;
  let dHue = 0;
  let dSat = 0;
  let dLum = 0;
  for (const band of HSL_BANDS_UI) {
    const weight = bandWeight(degrees, band.center, band.halfWidth);
    wMax = Math.max(wMax, weight);
    dHue += weight * params[`${band.prefix}Hue`];
    dSat += weight * params[`${band.prefix}Sat`];
    dLum += weight * params[`${band.prefix}Lum`];
  }
  // 按最大权重归一（不是按和）：色带中心的颜色必须拿到 100% 的调整量
  const total = Math.max(1e-4, wMax);
  dHue /= total;
  dSat /= total;
  dLum /= total;

  const nextH = (((hueDeg + (dHue * (60 / 360)) / 100) % 1) + 1) % 1;
  const nextS = clamp01(s * (1 + dSat / 100));
  const midWeight = 1 - Math.abs(l * 2 - 1); // 中间调权重，端点收敛
  const nextL = clamp01(l + (dLum / 100) * 0.28 * midWeight);
  return hslToRgb([nextH, nextS, nextL]);
}

/** 分离色调的色度向量：以中灰为中心，权重由阴影/高光遮罩给出。 */
function splitColor(hueDeg: number, amount: number, weight: number): RGB {
  if (amount <= 0.01) return [0, 0, 0];
  const hue = (((hueDeg / 360) % 1) + 1) % 1;
  const base = hslToRgb([hue, 1, 0.5]);
  const k = (amount / 100) * weight;
  return [(base[0] - 0.5) * k, (base[1] - 0.5) * k, (base[2] - 0.5) * k];
}

/**
 * 参数语义的 CPU 参考实现（不含 LUT / 曲线 / 锐化这类纹理或邻域运算）。
 *
 * 与 SKSL 的唯一区别：这里接收 0..1 的 sRGB 输入输出，LUT、色调曲线、锐化、
 * 清晰度、降噪不在参考范围内 —— 它们依赖纹理采样，由 GPU 路径负责，用色卡肉眼验收。
 */
export function gradePixelReference(
  rgb: RGB,
  params: EditParams,
  uv: { x: number; y: number } = { x: 0.5, y: 0.5 },
): RGB {
  const wb: RGB = [
    Math.pow(2, params.temperature / 250),
    Math.pow(2, -params.tint / 250),
    Math.pow(2, -params.temperature / 250),
  ];
  const exposure = Math.pow(2, params.brightness / 50);

  // 线性域：白平衡 + 曝光
  let lin = rgb.map((v) => srgbToLinear(v)) as RGB;
  lin = [lin[0] * wb[0] * exposure, lin[1] * wb[1] * exposure, lin[2] * wb[2] * exposure];

  // 显示域
  let c = lin.map((v) => linearToSrgb(v)) as RGB;

  const k = 1 + (params.contrast / 100) * 0.8;
  c = [clamp01((c[0] - 0.5) * k + 0.5), clamp01((c[1] - 0.5) * k + 0.5), clamp01((c[2] - 0.5) * k + 0.5)];

  const l0 = luma(c[0], c[1], c[2]);
  const wHi = smoothstep(0.5, 1, l0);
  const wLo = 1 - smoothstep(0, 0.5, l0);
  const gainHi = 1 + (params.highlights / 200) * wHi;
  const gainLo = 1 + (params.shadows / 200) * wLo;
  c = [clamp01(c[0] * gainHi * gainLo), clamp01(c[1] * gainHi * gainLo), clamp01(c[2] * gainHi * gainLo)];

  // 白场 / 黑场端点
  if (Math.abs(params.whites) > 0.01 || Math.abs(params.blacks) > 0.01) {
    const lw = luma(c[0], c[1], c[2]);
    const endHi = smoothstep(0.6, 1, lw);
    const endLo = 1 - smoothstep(0, 0.4, lw);
    const w = (params.whites / 100) * 0.22 * endHi;
    const b = (params.blacks / 100) * 0.22 * endLo;
    c = [clamp01(c[0] + w * (1 - c[0]) + b * (1 - c[0])), clamp01(c[1] + w * (1 - c[1]) + b * (1 - c[1])), clamp01(c[2] + w * (1 - c[2]) + b * (1 - c[2]))];
  }

  // 去雾
  if (Math.abs(params.dehaze) > 0.01) {
    const dh = params.dehaze / 100;
    const lm = luma(c[0], c[1], c[2]);
    const midMask = 1 - Math.abs(lm * 2 - 1);
    const shift = dh * 0.18 * (lm - 0.5) * midMask;
    c = [clamp01(c[0] + shift), clamp01(c[1] + shift), clamp01(c[2] + shift)];
    const sat = Math.max(0, Math.min(2, 1 + dh * 0.35));
    const l2 = luma(c[0], c[1], c[2]);
    c = [l2 + (c[0] - l2) * sat, l2 + (c[1] - l2) * sat, l2 + (c[2] - l2) * sat];
  }

  // 褪色（哑光）
  if (params.fade > 0.01) {
    const f = params.fade / 100;
    c = [
      clamp01(c[0] * (1 - 0.14 * f) + 0.1 * f),
      clamp01(c[1] * (1 - 0.14 * f) + 0.1 * f),
      clamp01(c[2] * (1 - 0.14 * f) + 0.1 * f),
    ];
    const lf = luma(c[0], c[1], c[2]);
    const sat = 1 - 0.18 * f;
    c = [lf + (c[0] - lf) * sat, lf + (c[1] - lf) * sat, lf + (c[2] - lf) * sat];
  }

  // 饱和度
  const l1 = luma(c[0], c[1], c[2]);
  const sat = 1 + params.saturation / 100;
  c = [l1 + (c[0] - l1) * sat, l1 + (c[1] - l1) * sat, l1 + (c[2] - l1) * sat];

  // 自然饱和
  if (Math.abs(params.vibrance) > 0.01) {
    const mx = Math.max(c[0], c[1], c[2]);
    const mn = Math.min(c[0], c[1], c[2]);
    const chroma = mx - mn;
    const weight = clamp01(1 - chroma * 1.4);
    const factor = Math.max(0, 1 + (params.vibrance / 100) * weight);
    const lv = luma(c[0], c[1], c[2]);
    c = [lv + (c[0] - lv) * factor, lv + (c[1] - lv) * factor, lv + (c[2] - lv) * factor];
  }

  // 色相旋转 + HSL 八色带
  if (Math.abs(params.hue) > 0.01 || hasHslMixer(params)) {
    c = applyHueMix(c, params);
  }

  // 分离色调
  if (params.splitShadowSat > 0.01 || params.splitHighlightSat > 0.01) {
    const lc = luma(c[0], c[1], c[2]);
    const shadowMask = 1 - smoothstep(0, 0.6, lc);
    const highlightMask = smoothstep(0.4, 1, lc);
    const sh = splitColor(params.splitShadowHue, params.splitShadowSat, shadowMask);
    const hi = splitColor(params.splitHighlightHue, params.splitHighlightSat, highlightMask);
    c = [clamp01(c[0] + sh[0] + hi[0]), clamp01(c[1] + sh[1] + hi[1]), clamp01(c[2] + sh[2] + hi[2])];
  }

  const r = Math.hypot(uv.x - 0.5, uv.y - 0.5) * Math.SQRT2;
  const vig = 1 - (params.vignette / 100) * smoothstep(0.35, 0.95, r);

  return [clamp01(c[0] * vig), clamp01(c[1] * vig), clamp01(c[2] * vig)];
}

function hasHslMixer(params: EditParams): boolean {
  return HSL_BANDS_UI.some(
    (band) =>
      Math.abs(params[`${band.prefix}Hue`]) > 0.01 ||
      Math.abs(params[`${band.prefix}Sat`]) > 0.01 ||
      Math.abs(params[`${band.prefix}Lum`]) > 0.01,
  );
}

/** 参考实现的亮度，测试里用得多。 */
export function referenceLuma(rgb: RGB, params: EditParams): number {
  const out = gradePixelReference(rgb, params);
  return luma(out[0], out[1], out[2]);
}

export const PARAM_ORDER = PARAM_KEYS;
