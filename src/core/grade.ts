/**
 * 调色的纯逻辑部分（无 Skia 依赖，可在 Node 里单测）。
 *
 * 这里有两个"必须与 GPU 实现保持一致"的东西：
 *  1. uniform 的排列顺序 —— 决定参数会不会串位（色温变成对比度这种脚底打滑的 bug）；
 *  2. 参数语义的参考实现 —— 用 CPU 复刻一遍 shader 的数学，验证"正数=更暖/更亮"这类契约，
 *     避免把符号写反却只能靠肉眼看出来。
 */

import { EditParams, PARAM_LIST, PARAM_KEYS } from './params';

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055);

export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
};

const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** 与 SKSL 声明顺序严格对应：srcSize(vec2), lutSize, hasLut, 然后 12 个参数。 */
export const UNIFORM_PREFIX = ['srcSize', 'lutSize', 'hasLut'] as const;

/** 扁平化 uniform 数组（喂给 RuntimeEffect.makeShaderWithChildren）。 */
export function uniformsFor(
  params: EditParams,
  width: number,
  height: number,
  lutSize: number,
  hasLut: boolean,
): number[] {
  const values = [width, height, Math.max(2, lutSize), hasLut ? 1 : 0];
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
): Record<string, number | number[]> {
  const object: Record<string, number | number[]> = {
    srcSize: [width, height],
    lutSize: Math.max(2, lutSize),
    hasLut: hasLut ? 1 : 0,
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

/**
 * 参数语义的 CPU 参考实现（不含 LUT / 锐化这类邻域运算）。
 *
 * 与 SKSL 的唯一区别：这里接收 0..1 的 sRGB 输入输出，邻域项（clarify/sharpen）与
 * LUT 不在参考范围内 —— 它们依赖纹理采样，由 GPU 路径负责，用色卡肉眼验收。
 */
export function gradePixelReference(
  rgb: [number, number, number],
  params: EditParams,
  uv: { x: number; y: number } = { x: 0.5, y: 0.5 },
): [number, number, number] {
  const wb: [number, number, number] = [
    Math.pow(2, params.temperature / 250),
    Math.pow(2, -params.tint / 250),
    Math.pow(2, -params.temperature / 250),
  ];
  const exposure = Math.pow(2, params.brightness / 50);

  // 线性域：白平衡 + 曝光
  let lin = rgb.map((v) => srgbToLinear(v)) as [number, number, number];
  lin = [lin[0] * wb[0] * exposure, lin[1] * wb[1] * exposure, lin[2] * wb[2] * exposure];

  // 显示域
  let c = lin.map((v) => linearToSrgb(v)) as [number, number, number];

  const k = 1 + (params.contrast / 100) * 0.8;
  c = [clamp01((c[0] - 0.5) * k + 0.5), clamp01((c[1] - 0.5) * k + 0.5), clamp01((c[2] - 0.5) * k + 0.5)];

  const l0 = luma(c[0], c[1], c[2]);
  const wHi = smoothstep(0.5, 1, l0);
  const wLo = 1 - smoothstep(0, 0.5, l0);
  const gainHi = 1 + (params.highlights / 200) * wHi;
  const gainLo = 1 + (params.shadows / 200) * wLo;
  c = [clamp01(c[0] * gainHi * gainLo), clamp01(c[1] * gainHi * gainLo), clamp01(c[2] * gainHi * gainLo)];

  const l1 = luma(c[0], c[1], c[2]);
  const sat = 1 + params.saturation / 100;
  c = [l1 + (c[0] - l1) * sat, l1 + (c[1] - l1) * sat, l1 + (c[2] - l1) * sat];

  const r = Math.hypot(uv.x - 0.5, uv.y - 0.5) * Math.SQRT2;
  const vig = 1 - (params.vignette / 100) * smoothstep(0.35, 0.95, r);

  return [clamp01(c[0] * vig), clamp01(c[1] * vig), clamp01(c[2] * vig)];
}

/** 参考实现的亮度，测试里用得多。 */
export function referenceLuma(rgb: [number, number, number], params: EditParams): number {
  const out = gradePixelReference(rgb, params);
  return luma(out[0], out[1], out[2]);
}

export const PARAM_ORDER = PARAM_KEYS;
