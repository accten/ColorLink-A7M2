/**
 * 3D LUT 解析与打包（纯逻辑）。
 *
 * 支持：
 *  - Adobe/Resolve 的 `.cube`（1D 与 3D；1D 直接拒绝，避免套出错色）
 *  - 结果打包成 2D 纹理交给 SkSL：宽 = size，高 = size * size，
 *    像素 (x=r 索引, y=b*size+g 索引)。这个布局必须和 shader 里的
 *    uv 计算逐字对齐，否则就是"套了 LUT 但画面没变化"的经典 bug。
 */

export interface Lut3D {
  size: number;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  /** 长度 size^3 * 3，索引 ((b*size + g)*size + r)*3，值域 0..1 */
  data: Float32Array;
}

export interface PackedLut {
  width: number;
  height: number;
  /** RGBA8，长度 width*height*4；第 4 通道固定 255 */
  pixels: Uint8Array;
}

export type ParseResult = { ok: true; lut: Lut3D } | { ok: false; reason: string };

const CUBE_MAX_BYTES = 64 * 1024 * 1024;

export function parseCube(text: string): ParseResult {
  if (!text || text.length > CUBE_MAX_BYTES) {
    return { ok: false, reason: '文件为空或过大（>64MB）' };
  }

  let size = 0;
  let is1D = false;
  const domainMin: [number, number, number] = [0, 0, 0];
  const domainMax: [number, number, number] = [1, 1, 1];
  const triplets: number[] = [];

  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const upper = line.toUpperCase();
    if (upper.startsWith('TITLE')) continue;
    if (upper.startsWith('LUT_3D_SIZE')) {
      size = Number.parseInt(line.split(/\s+/)[1] ?? '', 10);
      continue;
    }
    if (upper.startsWith('LUT_1D_SIZE')) {
      is1D = true;
      continue;
    }
    if (upper.startsWith('DOMAIN_MIN')) {
      const parts = line.split(/\s+/).slice(1).map(Number);
      if (parts.length === 3 && parts.every(Number.isFinite)) domainMin.splice(0, 3, ...(parts as [number, number, number]));
      continue;
    }
    if (upper.startsWith('DOMAIN_MAX')) {
      const parts = line.split(/\s+/).slice(1).map(Number);
      if (parts.length === 3 && parts.every(Number.isFinite)) domainMax.splice(0, 3, ...(parts as [number, number, number]));
      continue;
    }
    if (/^[A-Z_]/.test(upper)) continue; // 其它元数据行

    const nums = line.split(/\s+/).map(Number);
    if (nums.length < 3) return { ok: false, reason: '数据行格式错误，应为 "R G B"' };
    if (!nums.slice(0, 3).every(Number.isFinite)) return { ok: false, reason: '数据行包含非数字' };
    triplets.push(nums[0], nums[1], nums[2]);
  }

  if (is1D) return { ok: false, reason: '不支持 1D LUT，请导出 3D（.cube 且含 LUT_3D_SIZE）' };
  if (!size) return { ok: false, reason: '缺少 LUT_3D_SIZE，无法确定色彩立方体维度' };
  if (size < 2 || size > 64) return { ok: false, reason: `LUT_3D_SIZE=${size} 超出支持范围（2..64）` };

  const expected = size * size * size * 3;
  if (triplets.length !== expected) {
    return {
      ok: false,
      reason: `数据量与 LUT_3D_SIZE 不匹配：期望 ${expected} 个数值，实际 ${triplets.length}`,
    };
  }

  return {
    ok: true,
    lut: { size, domainMin, domainMax, data: Float32Array.from(triplets, (v) => Math.min(1, Math.max(0, v))) },
  };
}

/**
 * `.cube` 的行序是 r 变化最快，然后 g，最后 b —— 与我们的索引一致。
 * 打包时把 b 放进"行块"，g 放进块内行，r 放进列，正好对上 shader 的
 * uv = ((r*(n-1)+0.5)/n, (b*n + g*(n-1) + 0.5)/(n*n))。
 */
export function packLut(lut: Lut3D): PackedLut {
  const n = lut.size;
  const width = n;
  const height = n * n;
  const pixels = new Uint8Array(width * height * 4);

  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      const y = b * n + g;
      for (let r = 0; r < n; r++) {
        const src = ((b * n + g) * n + r) * 3;
        const dst = (y * width + r) * 4;
        pixels[dst] = toByte(lut.data[src]);
        pixels[dst + 1] = toByte(lut.data[src + 1]);
        pixels[dst + 2] = toByte(lut.data[src + 2]);
        pixels[dst + 3] = 255;
      }
    }
  }

  return { width, height, pixels };
}

function toByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

/** 三线性取样（CPU 版）。shader 用 GPU 版；这里用于单测与"LUT 预览小图"。 */
export function sampleLut(lut: Lut3D, r: number, g: number, b: number): [number, number, number] {
  const n = lut.size;
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const fx = clamp01(r) * (n - 1);
  const fy = clamp01(g) * (n - 1);
  const fz = clamp01(b) * (n - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const z0 = Math.floor(fz);
  const x1 = Math.min(n - 1, x0 + 1);
  const y1 = Math.min(n - 1, y0 + 1);
  const z1 = Math.min(n - 1, z0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const tz = fz - z0;

  const at = (x: number, y: number, z: number, c: number) => lut.data[((z * n + y) * n + x) * 3 + c];

  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const c00 = at(x0, y0, z0, c) * (1 - tx) + at(x1, y0, z0, c) * tx;
    const c10 = at(x0, y1, z0, c) * (1 - tx) + at(x1, y1, z0, c) * tx;
    const c01 = at(x0, y0, z1, c) * (1 - tx) + at(x1, y0, z1, c) * tx;
    const c11 = at(x0, y1, z1, c) * (1 - tx) + at(x1, y1, z1, c) * tx;
    const c0 = c00 * (1 - ty) + c10 * ty;
    const c1 = c01 * (1 - ty) + c11 * ty;
    out[c] = c0 * (1 - tz) + c1 * tz;
  }
  return out;
}

/** 生成一张恒等 LUT，测试与"无 LUT 占位纹理"都能用。 */
export function identityLut(size = 2): Lut3D {
  const data = new Float32Array(size * size * size * 3);
  let i = 0;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        data[i++] = r / (size - 1);
        data[i++] = g / (size - 1);
        data[i++] = b / (size - 1);
      }
    }
  }
  return { size, domainMin: [0, 0, 0], domainMax: [1, 1, 1], data };
}

/** 解析结果的可读摘要（LUT 列表 / 导入成功的 toast）。 */
export function describeLut(lut: Lut3D): string {
  return `${lut.size}³ · ${(lut.data.length / 3).toLocaleString()} 采样`;
}
