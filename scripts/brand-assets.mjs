/**
 * 生成 App 品牌素材（图标 / 启动图 / 自适应图标 / favicon）。
 * 极简标记：细环 + 一个暖色光点（"联机 + 调色"的最小语义），近黑底。
 *
 * 运行：node scripts/brand-assets.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets', 'images');

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
};
function encodePng(w, h, rgb) {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0;
    rgb.copy(raw, y * stride + 1, y * w * 3, (y + 1) * w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
};
const hex = (h) => [
  parseInt(h.slice(1, 3), 16) / 255,
  parseInt(h.slice(3, 5), 16) / 255,
  parseInt(h.slice(5, 7), 16) / 255,
];

/**
 * @param {number} size
 * @param {{bg:string, ring:string, dot:string, mono?:boolean}} theme
 */
function drawMark(size, theme) {
  const buf = new Float32Array(size * size * 3);
  const bg = hex(theme.mono ? '#000000' : theme.bg);
  for (let i = 0; i < buf.length; i += 3) {
    buf[i] = bg[0];
    buf[i + 1] = bg[1];
    buf[i + 2] = bg[2];
  }

  const cx = size * 0.5;
  const cy = size * 0.5;
  const radius = size * 0.255;
  const thickness = size * 0.028;
  const ring = hex(theme.ring);
  const dot = hex(theme.dot);
  const dotAngle = -0.62; // 右上
  const dotX = cx + Math.cos(dotAngle) * radius;
  const dotY = cy + Math.sin(dotAngle) * radius;
  const dotR = size * 0.056;
  const gapHalfAngle = 0.26;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 3;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.hypot(dx, dy);

      // 环（带抗锯齿），并在右上留一个缺口，避免"甜甜圈"的廉价感
      const band = 1 - smooth(thickness * 0.5, thickness * 0.5 + 1.2, Math.abs(dist - radius));
      let angle = Math.atan2(dy, dx);
      let delta = Math.abs(((angle - dotAngle + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      const gapMask = smooth(gapHalfAngle, gapHalfAngle + 0.12, Math.abs(Math.PI - delta));
      const ringAlpha = band * gapMask;

      // 光点（柔边）
      const dotAlpha = 1 - smooth(dotR * 0.9, dotR, Math.hypot(dx - (dotX - cx), dy - (dotY - cy)));

      const r = ring[0] * ringAlpha * (1 - dotAlpha) + dot[0] * dotAlpha;
      const g = ring[1] * ringAlpha * (1 - dotAlpha) + dot[1] * dotAlpha;
      const b = ring[2] * ringAlpha * (1 - dotAlpha) + dot[2] * dotAlpha;
      const a = Math.min(1, ringAlpha * (1 - dotAlpha) + dotAlpha);

      buf[i] = buf[i] * (1 - a) + r * a * 1;
      buf[i + 1] = buf[i + 1] * (1 - a) + g * a;
      buf[i + 2] = buf[i + 2] * (1 - a) + b * a;
    }
  }

  const out = Buffer.alloc(size * size * 3);
  for (let i = 0; i < buf.length; i++) out[i] = Math.round(clamp01(buf[i]) * 255);
  return out;
}

mkdirSync(OUT, { recursive: true });

const dark = { bg: '#08090A', ring: '#EDE7DA', dot: '#E3B27C' };
const mono = { bg: '#000000', ring: '#FFFFFF', dot: '#FFFFFF', mono: true };

const jobs = [
  { file: 'icon.png', size: 1024, theme: dark },
  { file: 'splash-icon.png', size: 512, theme: dark },
  { file: 'android-icon-foreground.png', size: 1024, theme: dark },
  { file: 'android-icon-monochrome.png', size: 1024, theme: mono },
  { file: 'favicon.png', size: 64, theme: dark },
];

for (const job of jobs) {
  writeFileSync(join(OUT, job.file), encodePng(job.size, job.size, drawMark(job.size, job.theme)));
  console.log('generated', job.file, `${job.size}x${job.size}`);
}
