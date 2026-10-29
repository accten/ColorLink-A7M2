/**
 * 端到端验证：用 CanvasKit（Skia 的 wasm 版本）真的把调色 shader 跑起来，
 * 把渲染结果和 CPU 参考实现（core/grade.ts）逐项对比。
 *
 * 这一步能抓到"字符串单测抓不到"的问题：
 *   - uniform 顺序错位（色温变成对比度这类）→ 结果会差出天际
 *   - shader 编译失败 → 画面全黑
 *   - 参数语义写反（正数变暗）→ 与参考实现符号相反
 *
 * shader 与参考实现都用精确 sRGB 曲线，所以两边应当几乎完全一致（误差只来自 half 精度）。
 *
 * 用法：node scripts/check-sksl.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CanvasKitInit = require('canvaskit-wasm/bin/canvaskit.js');

const source = fs.readFileSync(path.resolve('src/features/grading/shader.ts'), 'utf8');
const sksl = source.match(/export const GRADE_SKSL = `([\s\S]*?)`;/)[1];

// —— 参数表（与 core/params.ts 的 PARAM_LIST 顺序一致）——
const PARAM_KEYS = [
  'brightness', 'contrast', 'saturation', 'vibrance', 'hue', 'temperature', 'tint',
  'highlights', 'shadows', 'whites', 'blacks', 'fade', 'dehaze',
  'splitShadowHue', 'splitShadowSat', 'splitHighlightHue', 'splitHighlightSat',
  'redHue', 'redSat', 'redLum', 'orangeHue', 'orangeSat', 'orangeLum',
  'yellowHue', 'yellowSat', 'yellowLum', 'greenHue', 'greenSat', 'greenLum',
  'aquaHue', 'aquaSat', 'aquaLum', 'blueHue', 'blueSat', 'blueLum',
  'purpleHue', 'purpleSat', 'purpleLum', 'magentaHue', 'magentaSat', 'magentaLum',
  'sharpen', 'clarity', 'noiseReduction', 'grain', 'vignette', 'lutStrength',
];
const DEFAULTS = Object.fromEntries(PARAM_KEYS.map((k) => [k, k === 'lutStrength' ? 100 : 0]));

const CanvasKit = await CanvasKitInit({
  locateFile: (file) => path.resolve('node_modules/canvaskit-wasm/bin', file),
});

let compileError = null;
const effect = CanvasKit.RuntimeEffect.Make(sksl, (err) => {
  compileError = err;
});
if (!effect || compileError) {
  console.error('SKSL 编译失败：', compileError);
  process.exit(1);
}

const IMG_INFO = {
  width: 1,
  height: 1,
  colorType: CanvasKit.ColorType.RGBA_8888,
  alphaType: CanvasKit.AlphaType.Unpremul,
  colorSpace: CanvasKit.ColorSpace.SRGB,
};
const CURVE_INFO = { ...IMG_INFO, width: 256 };
const LUT_INFO = { width: 2, height: 4, colorType: CanvasKit.ColorType.RGBA_8888, alphaType: CanvasKit.AlphaType.Unpremul, colorSpace: CanvasKit.ColorSpace.SRGB };

function makeImage(info, bytes) {
  const image = CanvasKit.MakeImage(info, bytes, info.width * 4);
  if (!image) throw new Error('MakeImage 失败');
  return image;
}

// 恒等 LUT（2³ 打包成 2×4：行 = b*2+g，列 = r）
const lutBytes = new Uint8Array(2 * 4 * 4);
for (let b = 0; b < 2; b++) {
  for (let g = 0; g < 2; g++) {
    const row = b * 2 + g;
    for (let r = 0; r < 2; r++) {
      const offset = (row * 2 + r) * 4;
      lutBytes[offset] = r * 255;
      lutBytes[offset + 1] = g * 255;
      lutBytes[offset + 2] = b * 255;
      lutBytes[offset + 3] = 255;
    }
  }
}
const lutImage = makeImage(LUT_INFO, lutBytes);

const curveBytes = new Uint8Array(256 * 4);
for (let i = 0; i < 256; i++) {
  curveBytes[i * 4] = i;
  curveBytes[i * 4 + 1] = i;
  curveBytes[i * 4 + 2] = i;
  curveBytes[i * 4 + 3] = 255;
}
const curveImage = makeImage(CURVE_INFO, curveBytes);

const surface = CanvasKit.MakeSurface(1, 1);
if (!surface) throw new Error('MakeSurface 失败');

function render(rgb, params) {
  const bytes = new Uint8Array([
    Math.round(rgb[0] * 255),
    Math.round(rgb[1] * 255),
    Math.round(rgb[2] * 255),
    255,
  ]);
  const img = makeImage(IMG_INFO, bytes);

  const uniforms = new Float32Array(5 + PARAM_KEYS.length);
  uniforms[0] = 1; // srcSize.x
  uniforms[1] = 1; // srcSize.y
  uniforms[2] = 2; // lutSize
  uniforms[3] = 0; // hasLut
  uniforms[4] = 1; // hasCurve（恒等曲线，结果不变，但走真实分支）
  PARAM_KEYS.forEach((key, i) => {
    uniforms[5 + i] = params[key] ?? DEFAULTS[key];
  });

  const childShaders = [
    img.makeShaderOptions(CanvasKit.TileMode.Clamp, CanvasKit.TileMode.Clamp, CanvasKit.FilterMode.Linear, CanvasKit.MipmapMode.None),
    lutImage.makeShaderOptions(CanvasKit.TileMode.Clamp, CanvasKit.TileMode.Clamp, CanvasKit.FilterMode.Nearest, CanvasKit.MipmapMode.None),
    curveImage.makeShaderOptions(CanvasKit.TileMode.Clamp, CanvasKit.TileMode.Clamp, CanvasKit.FilterMode.Linear, CanvasKit.MipmapMode.None),
  ];

  const shader = effect.makeShaderWithChildren(uniforms, childShaders);
  if (!shader) throw new Error('makeShaderWithChildren 失败');

  const paint = new CanvasKit.Paint();
  paint.setShader(shader);
  const canvas = surface.getCanvas();
  canvas.clear(CanvasKit.BLACK);
  canvas.drawRect(CanvasKit.LTRBRect(0, 0, 1, 1), paint);
  surface.flush();
  paint.delete();

  const snapshot = surface.makeImageSnapshot();
  const pixels = snapshot.readPixels(0, 0, {
    width: 1,
    height: 1,
    colorType: CanvasKit.ColorType.RGBA_8888,
    alphaType: CanvasKit.AlphaType.Unpremul,
    colorSpace: CanvasKit.ColorSpace.SRGB,
  });
  snapshot.delete();
  img.delete();
  return [pixels[0] / 255, pixels[1] / 255, pixels[2] / 255];
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055);
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
};

/** core/grade.ts 的等价实现（只抄管线的标量部分，不抄 LUT/曲线/锐化） */
function reference(rgb, p) {
  const wb = [Math.pow(2, p.temperature / 250), Math.pow(2, -p.tint / 250), Math.pow(2, -p.temperature / 250)];
  const exposure = Math.pow(2, p.brightness / 50);
  let lin = rgb.map(srgbToLinear);
  lin = [lin[0] * wb[0] * exposure, lin[1] * wb[1] * exposure, lin[2] * wb[2] * exposure];
  let c = lin.map(linearToSrgb);
  const k = 1 + (p.contrast / 100) * 0.8;
  c = c.map((v) => clamp01((v - 0.5) * k + 0.5));
  const l0 = luma(...c);
  const gainHi = 1 + (p.highlights / 200) * smoothstep(0.5, 1, l0);
  const gainLo = 1 + (p.shadows / 200) * (1 - smoothstep(0, 0.5, l0));
  c = c.map((v) => clamp01(v * gainHi * gainLo));

  if (Math.abs(p.whites) > 0.01 || Math.abs(p.blacks) > 0.01) {
    const lw = luma(...c);
    const endHi = smoothstep(0.6, 1, lw);
    const endLo = 1 - smoothstep(0, 0.4, lw);
    const w = (p.whites / 100) * 0.22 * endHi;
    const b = (p.blacks / 100) * 0.22 * endLo;
    c = c.map((v) => clamp01(v + w * (1 - v) + b * (1 - v)));
  }

  if (Math.abs(p.dehaze) > 0.01) {
    const dh = p.dehaze / 100;
    const lm = luma(...c);
    const midMask = 1 - Math.abs(lm * 2 - 1);
    const shift = dh * 0.18 * (lm - 0.5) * midMask;
    c = c.map((v) => clamp01(v + shift));
    const sat = Math.max(0, Math.min(2, 1 + dh * 0.35));
    const l2 = luma(...c);
    c = c.map((v) => l2 + (v - l2) * sat);
  }

  if (p.fade > 0.01) {
    const f = p.fade / 100;
    c = c.map((v) => clamp01(v * (1 - 0.14 * f) + 0.1 * f));
    const lf = luma(...c);
    const sat = 1 - 0.18 * f;
    c = c.map((v) => lf + (v - lf) * sat);
  }

  const l1 = luma(...c);
  const sat = 1 + p.saturation / 100;
  c = c.map((v) => l1 + (v - l1) * sat);

  if (Math.abs(p.vibrance) > 0.01) {
    const mx = Math.max(...c);
    const mn = Math.min(...c);
    const chroma = mx - mn;
    const weight = clamp01(1 - chroma * 1.4);
    const factor = Math.max(0, 1 + (p.vibrance / 100) * weight);
    const lv = luma(...c);
    c = c.map((v) => lv + (v - lv) * factor);
  }

  // 色相 / HSL
  const hsl = rgbToHsl(c);
  const hueDeg = (((hsl[0] + p.hue / 360) % 1) + 1) % 1;
  const degrees = hueDeg * 360;
  const bands = [
    [0, 45, 'red'], [30, 45, 'orange'], [60, 45, 'yellow'], [120, 55, 'green'],
    [180, 55, 'aqua'], [240, 50, 'blue'], [280, 45, 'purple'], [320, 45, 'magenta'],
  ];
  let wMax = 0;
  let dH = 0;
  let dS = 0;
  let dL = 0;
  for (const [center, halfWidth, prefix] of bands) {
    const raw = Math.abs(degrees - center);
    const d = Math.min(raw, 360 - raw);
    const w = clamp01(1 - d / halfWidth);
    wMax = Math.max(wMax, w);
    dH += w * p[`${prefix}Hue`];
    dS += w * p[`${prefix}Sat`];
    dL += w * p[`${prefix}Lum`];
  }
  const total = Math.max(1e-4, wMax);
  const nextHue = (((hueDeg + (dH / total) * (60 / 360) / 100) % 1) + 1) % 1;
  const nextSat = clamp01(hsl[1] * (1 + dS / total / 100));
  const nextL = clamp01(hsl[2] + (dL / total / 100) * 0.28 * (1 - Math.abs(hsl[2] * 2 - 1)));
  c = hslToRgb([nextHue, nextSat, nextL]);

  if (p.splitShadowSat > 0.01 || p.splitHighlightSat > 0.01) {
    const lc = luma(...c);
    const shadowMask = 1 - smoothstep(0, 0.6, lc);
    const highlightMask = smoothstep(0.4, 1, lc);
    const shade = splitColor(p.splitShadowHue, p.splitShadowSat, shadowMask);
    const hi = splitColor(p.splitHighlightHue, p.splitHighlightSat, highlightMask);
    c = [clamp01(c[0] + shade[0] + hi[0]), clamp01(c[1] + shade[1] + hi[1]), clamp01(c[2] + shade[2] + hi[2])];
  }

  const r = Math.hypot(0.5 - 0.5, 0.5 - 0.5) * Math.SQRT2;
  const vig = 1 - (p.vignette / 100) * smoothstep(0.35, 0.95, r);
  return c.map((v) => clamp01(v * vig));
}

function rgbToHsl([r, g, b]) {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  if (d < 1e-4) return [0, 0, l];
  const s = l > 0.5 ? d / Math.max(1e-4, 2 - mx - mn) : d / Math.max(1e-4, mx + mn);
  let h;
  if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}
function hue2rgb(p, q, t) {
  let tt = t;
  if (tt < 0) tt += 1;
  if (tt > 1) tt -= 1;
  if (tt < 1 / 6) return p + (q - p) * 6 * tt;
  if (tt < 0.5) return q;
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
  return p;
}
function hslToRgb([h, s, l]) {
  if (s < 1e-4) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)];
}
function splitColor(hueDeg, amount, weight) {
  if (amount <= 0.01) return [0, 0, 0];
  const base = hslToRgb([(((hueDeg / 360) % 1) + 1) % 1, 1, 0.5]);
  const k = (amount / 100) * weight;
  return base.map((v) => (v - 0.5) * k);
}

const pixels = [
  [0.5, 0.5, 0.5],
  [0.72, 0.5, 0.34],
  [0.15, 0.15, 0.8],
  [0.2, 0.2, 0.2],
  [0.88, 0.88, 0.88],
];

const cases = [
  ['identity', {}],
  ['brightness+40', { brightness: 40 }],
  ['temperature+60', { temperature: 60 }],
  ['tint-50', { tint: -50 }],
  ['contrast+60', { contrast: 60 }],
  ['highlights-80', { highlights: -80 }],
  ['shadows+70', { shadows: 70 }],
  ['whites+60', { whites: 60 }],
  ['blacks-60', { blacks: -60 }],
  ['fade+80', { fade: 80 }],
  ['dehaze+50', { dehaze: 50 }],
  ['saturation-70', { saturation: -70 }],
  ['vibrance+80', { vibrance: 80 }],
  ['hue+90', { hue: 90 }],
  ['split blue/amber', { splitShadowHue: 210, splitShadowSat: 80, splitHighlightHue: 40, splitHighlightSat: 70 }],
  ['hsl red sat -80', { redSat: -80 }],
  ['hsl blue hue +60', { blueHue: 60 }],
  ['vignette+100', { vignette: 100 }],
  ['contrast+hue+split', { contrast: 30, hue: -40, splitShadowHue: 200, splitShadowSat: 50 }],
];

let failures = 0;
let maxDelta = 0;

for (const [name, overrides] of cases) {
  const params = { ...DEFAULTS, ...overrides };
  for (const rgb of pixels) {
    const gpu = render(rgb, params);
    const cpu = reference(rgb, params);
    const deltas = gpu.map((v, i) => Math.abs(v - cpu[i]));
    const delta = Math.max(...deltas);
    maxDelta = Math.max(maxDelta, delta);
    if (delta > 0.035) {
      failures += 1;
      console.log(
        `✗ ${name} rgb=${rgb.map((v) => v.toFixed(2)).join(',')}`,
        `gpu=${gpu.map((v) => v.toFixed(3)).join(',')}`,
        `cpu=${cpu.map((v) => v.toFixed(3)).join(',')}`,
        `Δ=${delta.toFixed(3)}`,
      );
    }
  }
}

console.log(`\n最大偏差 = ${maxDelta.toFixed(4)}，失败 ${failures} 项`);
process.exit(failures ? 1 : 0);
