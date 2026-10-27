/**
 * 生成演示素材：6 张抽象光影构图 + 1 张色卡（纯代码绘制 + 自写 PNG 编码）。
 *
 * 为什么要自己生成：没有 A7M2 实机时，取景 / 图库 / 调色 / 导出都需要真实像素；
 * 用代码生成可以保证来源干净、可复现、且每张图覆盖不同的调色难点
 * （高光、暗部、肤色、大面积中间调、色准）。
 *
 * 运行：node scripts/demo-assets.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets', 'demo');
const W = 900;
const H = 600;
// 演示素材会被内联成 base64 进 JS（见 framesB64.ts）：颗粒是噪声，会让 PNG 体积翻几倍，
// 而颗粒在调色面板里本来就能实时加，所以这里压到最低。
const BAKED_GRAIN_MAX = 0.45;

/* ---------------- PNG 编码 ---------------- */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgb) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    rgb.copy(raw, y * stride + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- 基本工具 ---------------- */
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
};
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** 画布内部统一线性光：hex 先解码成线性，输出时再编码回 sRGB。 */
const hex = (h) => [
  srgbToLinear(parseInt(h.slice(1, 3), 16) / 255),
  srgbToLinear(parseInt(h.slice(3, 5), 16) / 255),
  srgbToLinear(parseInt(h.slice(5, 7), 16) / 255),
];
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const canvas = () => ({ buf: new Float32Array(W * H * 3) });

/** 沿 angle 的线性渐变，两端锚色。 */
function diagonal(c, a, z, angle = 0.6) {
  const ca = hex(a);
  const cz = hex(z);
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const project = (x, y) => x * dx + y * dy;
  const corners = [project(0, 0), project(W, 0), project(0, H), project(W, H)];
  const lo = Math.min(...corners);
  const hi = Math.max(...corners);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = clamp01((project(x, y) - lo) / (hi - lo || 1));
      const col = mix3(ca, cz, t * t * (3 - 2 * t));
      const i = (y * W + x) * 3;
      c.buf[i] = col[0];
      c.buf[i + 1] = col[1];
      c.buf[i + 2] = col[2];
    }
  }
}

/** 柔光池（加法混合，指数衰减）。 */
function glow(c, cx, cy, radius, color, strength = 0.5) {
  const col = hex(color);
  const r2 = radius * radius;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2 * 9) continue;
      const a = strength * Math.exp(-d2 / r2);
      const i = (y * W + x) * 3;
      c.buf[i] += col[0] * a;
      c.buf[i + 1] += col[1] * a;
      c.buf[i + 2] += col[2] * a;
    }
  }
}

/** 软边矩形（覆盖混合，可选投影）。 */
function softRect(c, x0, y0, w, h, color, feather = 40, alpha = 0.5, shadow = 0) {
  const col = hex(color);
  const xs = Math.max(0, Math.floor(x0 - feather));
  const ys = Math.max(0, Math.floor(y0 - feather));
  const xe = Math.min(W, Math.ceil(x0 + w + feather));
  const ye = Math.min(H, Math.ceil(y0 + h + feather));
  for (let y = ys; y < ye; y++) {
    for (let x = xs; x < xe; x++) {
      const fx = smooth(x0 - feather, x0, x) * (1 - smooth(x0 + w, x0 + w + feather, x));
      const fy = smooth(y0 - feather, y0, y) * (1 - smooth(y0 + h, y0 + h + feather, y));
      const a = alpha * fx * fy;
      if (a <= 0.001) continue;
      const i = (y * W + x) * 3;
      c.buf[i] = c.buf[i] * (1 - a) + col[0] * a;
      c.buf[i + 1] = c.buf[i + 1] * (1 - a) + col[1] * a;
      c.buf[i + 2] = c.buf[i + 2] * (1 - a) + col[2] * a;
      if (shadow > 0) {
        const sy = y - (y0 + h);
        if (sy > 0) {
          const k = Math.exp(-sy / (h * 0.9)) * shadow;
          c.buf[i] *= 1 - k;
          c.buf[i + 1] *= 1 - k;
          c.buf[i + 2] *= 1 - k;
        }
      }
    }
  }
}

/** 地平线 / 前景剪影，给构图一个物理重心。 */
function horizon(c, y0, color, alpha = 0.92, feather = 80) {
  const col = hex(color);
  const ys = Math.max(0, Math.floor(y0 - feather));
  for (let y = ys; y < H; y++) {
    const a = alpha * smooth(y0 - feather, y0, y);
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      c.buf[i] = c.buf[i] * (1 - a) + col[0] * a;
      c.buf[i + 1] = c.buf[i + 1] * (1 - a) + col[1] * a;
      c.buf[i + 2] = c.buf[i + 2] * (1 - a) + col[2] * a;
    }
  }
}

function vignette(c, amount) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const nx = (x / W - 0.5) * 2;
      const ny = (y / H - 0.5) * 2;
      const d = Math.min(1, Math.sqrt(nx * nx + ny * ny) / 1.414);
      const m = 1 - amount * smooth(0.15, 1, d);
      const i = (y * W + x) * 3;
      c.buf[i] *= m;
      c.buf[i + 1] *= m;
      c.buf[i + 2] *= m;
    }
  }
}

/** filmic 压缩：保高光层次，避免死白。 */
function tonemap(c, exposure = 1.0) {
  for (let i = 0; i < c.buf.length; i++) {
    const x = Math.max(0, c.buf[i] * exposure);
    c.buf[i] = x / (1 + x * 0.68);
  }
}

/** 输出：sRGB 编码 + 在 sRGB 域加颗粒（暗部不会被放大成噪点）。 */
function toSrgb(c, grainAmount = 0, seed = 1) {
  const out = Buffer.alloc(W * H * 3);
  const enc = (v) => {
    const x = clamp01(v);
    const s = x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
    return clamp01(s) * 255;
  };
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < c.buf.length; i += 3) {
    const n = grainAmount === 0 ? 0 : (rnd() - 0.5) * grainAmount;
    out[i] = Math.round(clamp01((enc(c.buf[i]) + n) / 255) * 255);
    out[i + 1] = Math.round(clamp01((enc(c.buf[i + 1]) + n) / 255) * 255);
    out[i + 2] = Math.round(clamp01((enc(c.buf[i + 2]) + n) / 255) * 255);
  }
  return out;
}

/* ---------------- 场景 ---------------- */
const scenes = {
  // 高调：天际 + 暖光，考验 highlights / 白平衡
  dawn: {
    exposure: 1.5,
    grain: 2.4,
    draw(c) {
      diagonal(c, '#efc3a2', '#3d2c4c', 0.55);
      glow(c, 760, 200, 360, '#ffe1bd', 0.6);
      glow(c, 260, 430, 300, '#8f7bb0', 0.22);
      horizon(c, 590, '#221a2b', 0.95, 60);
      vignette(c, 0.22);
    },
  },

  // 暖冷对比：考验 temperature / tint 方向
  dusk: {
    exposure: 1.45,
    grain: 2.6,
    draw(c) {
      diagonal(c, '#0b1f33', '#b8784e', 1.9);
      glow(c, 880, 110, 320, '#5f8fd0', 0.42);
      glow(c, 600, 530, 280, '#ffbe86', 0.62);
      horizon(c, 566, '#070b12', 0.97, 40);
      vignette(c, 0.3);
    },
  },

  // 低调：大片近黑 + 冷调光池，考验 shadows 与噪点观感
  ink: {
    exposure: 1.35,
    grain: 3.2,
    draw(c) {
      diagonal(c, '#0a0f16', '#0f1721', 1.0);
      glow(c, 470, 260, 220, '#5d80ac', 0.34);
      glow(c, 760, 470, 260, '#33506e', 0.16);
      horizon(c, 655, '#050608', 0.9, 70);
      vignette(c, 0.36);
    },
  },

  // 肤色带：考验 saturation 与肤色保护
  skin: {
    exposure: 1.4,
    grain: 2.6,
    draw(c) {
      diagonal(c, '#241c18', '#0b0908', 1.25);
      glow(c, 430, 240, 280, '#6b4c39', 0.4);
      softRect(c, 500, 185, 230, 405, '#c69372', 52, 0.97, 0.25);
      softRect(c, 532, 236, 166, 282, '#dcae88', 66, 0.7);
      glow(c, 615, 296, 100, '#ffd9bb', 0.22);
      horizon(c, 700, '#050505', 0.75, 70);
      vignette(c, 0.34);
    },
  },

  // 大面积中间调：考验 saturation / clarity
  moss: {
    exposure: 1.45,
    grain: 2.4,
    draw(c) {
      diagonal(c, '#141f13', '#38502f', 1.45);
      glow(c, 300, 165, 300, '#7f9a5c', 0.32);
      glow(c, 900, 360, 280, '#27381f', 0.38);
      horizon(c, 645, '#0a1008', 0.92, 70);
      vignette(c, 0.26);
    },
  },

  // 色卡：用来"验准"——LUT 与参数是否按预期改变色相/亮度
  chart: {
    exposure: 1.9,
    grain: 0.8,
    draw(c) {
      diagonal(c, '#2c2c2e', '#1b1b1d', 0.2);
      const patches = [
        '#735244', '#c29682', '#627a9d', '#576c43', '#8580b1', '#67bdaa',
        '#d67e2c', '#505ba6', '#c15a63', '#5e3c6c', '#9dbc40', '#e0a32e',
        '#383d96', '#469449', '#af363c', '#e7c71f', '#bb5695', '#0885a1',
        '#f3f3f2', '#c8c8c8', '#a0a0a0', '#7a7a79', '#555555', '#343434',
      ];
      const pw = 120, ph = 120, gap = 14, cols = 6, rows = 4;
      const startX = (W - (cols * pw + (cols - 1) * gap)) / 2;
      const startY = 88;
      patches.forEach((p, i) => {
        const cx = startX + (i % cols) * (pw + gap);
        const cy = startY + Math.floor(i / cols) * (ph + gap);
        softRect(c, cx + 3, cy + 7, pw, ph, '#000000', 12, 0.35);
        softRect(c, cx, cy, pw, ph, p, 4, 1);
      });
      const rampY = startY + rows * (ph + gap) + 14;
      for (let i = 0; i < 16; i++) {
        const v = i / 15;
        const gray =
          '#' + [v, v, v].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
        const x = (W - 16 * 62) / 2 + i * 62;
        softRect(c, x + 2, rampY + 5, 58, 62, '#000000', 8, 0.28);
        softRect(c, x, rampY, 58, 56, gray, 3, 1);
      }
    },
  },
};

mkdirSync(OUT, { recursive: true });

/** @type {Record<string, string>} */
const base64ByKey = {};

for (const [name, scene] of Object.entries(scenes)) {
  const c = canvas();
  scene.draw(c);
  tonemap(c, scene.exposure);
  const png = encodePng(W, H, toSrgb(c, Math.min(scene.grain, BAKED_GRAIN_MAX), name.length * 97));
  const file = join(OUT, `scene-${name}.png`);
  writeFileSync(file, png);
  base64ByKey[name] = png.toString('base64');
  console.log('generated', file, `${Math.round(png.length / 1024)} KB`);
}

const b64Path = join(ROOT, 'src', 'features', 'demo', 'framesB64.ts');
mkdirSync(dirname(b64Path), { recursive: true });
const lines = [
  '// 由 scripts/demo-assets.mjs 生成，请勿手改。',
  '// 用途：演示素材的字节内联进 JS，落盘时不依赖 expo-asset 的路径解析。',
  'export const DEMO_WIDTH = ' + W + ';',
  'export const DEMO_HEIGHT = ' + H + ';',
  '',
  'export const DEMO_B64: Record<string, string> = {',
  ...Object.entries(base64ByKey).map(([key, b64]) => `  ${key}: '${b64}',`),
  '};',
  '',
];
writeFileSync(b64Path, lines.join('\n'));
const totalB64 = Object.values(base64ByKey).reduce((sum, s) => sum + s.length, 0);
console.log(`base64 module: ${b64Path} (${Math.round(totalB64 / 1024)} KB)`);
console.log(`done: ${Object.keys(scenes).length} scenes @ ${W}x${H}`);
