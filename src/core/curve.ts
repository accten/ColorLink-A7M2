/**
 * 色调曲线（纯逻辑）。
 *
 * 曲线不是"参数"——它没法用几个标量描述，所以单独存成控制点，烘成一张
 * 256×1 的 RGBA 纹理交给 SKSL 采样：
 *   R/G/B 三个通道存「主曲线(所有通道) → 单通道曲线」的**复合结果**，
 *   于是 shader 每个像素只需要 3 次取样（各通道一次），不用在主曲线与
 *   单通道曲线之间来回两趟。
 *
 * 插值用 Fritsch–Carlson 单调三次 Hermite：曲线不会在控制点之间过冲出
 * "反转"的色带 —— 线性插值会让暗部出现折线感，普通 Catmull-Rom 会过冲。
 */

export interface CurvePoint {
  /** 输入亮度 0..1，端点固定为 0 与 1 */
  x: number;
  /** 输出亮度 0..1 */
  y: number;
}

export type CurveChannel = 'rgb' | 'r' | 'g' | 'b';

export interface CurveSet {
  /** 主曲线（RGB 一起） */
  rgb: CurvePoint[];
  r: CurvePoint[];
  g: CurvePoint[];
  b: CurvePoint[];
}

export const CURVE_CHANNELS: CurveChannel[] = ['rgb', 'r', 'g', 'b'];

/** 一条曲线最多 10 个控制点（含两端），再多手指也点不准 */
export const MAX_CURVE_POINTS = 10;

export const CURVE_TABLE_SIZE = 256;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function identityCurve(): CurvePoint[] {
  return [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ];
}

export function defaultCurveSet(): CurveSet {
  return { rgb: identityCurve(), r: identityCurve(), g: identityCurve(), b: identityCurve() };
}

export function cloneCurve(points: readonly CurvePoint[]): CurvePoint[] {
  return points.map((p) => ({ x: p.x, y: p.y }));
}

export function cloneCurveSet(set: CurveSet): CurveSet {
  return { rgb: cloneCurve(set.rgb), r: cloneCurve(set.r), g: cloneCurve(set.g), b: cloneCurve(set.b) };
}

export function isIdentityCurve(points: readonly CurvePoint[]): boolean {
  return points.length === 2 && points[0].x === 0 && points[0].y === 0 && points[1].x === 1 && points[1].y === 1;
}

export function isIdentityCurveSet(set: CurveSet): boolean {
  return CURVE_CHANNELS.every((channel) => isIdentityCurve(set[channel]));
}

export function curveSetEquals(a: CurveSet, b: CurveSet): boolean {
  return CURVE_CHANNELS.every((channel) => {
    const left = a[channel];
    const right = b[channel];
    if (left.length !== right.length) return false;
    return left.every((point, index) => point.x === right[index].x && point.y === right[index].y);
  });
}

/** 曲线控制点排序 + 端点校正，返回新数组。 */
export function normalizeCurve(points: readonly CurvePoint[]): CurvePoint[] {
  const cleaned = points
    .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
    .map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) }))
    .sort((a, b) => a.x - b.x)
    .slice(0, MAX_CURVE_POINTS);

  if (cleaned.length < 2) return identityCurve();

  // 端点必须落在 0 / 1，否则取样区间会有空洞
  cleaned[0] = { x: 0, y: cleaned[0].y };
  cleaned[cleaned.length - 1] = { x: 1, y: cleaned[cleaned.length - 1].y };

  // 去掉重合的 x（相邻两点 x 太近会让插值斜率爆炸）
  const result: CurvePoint[] = [];
  for (const point of cleaned) {
    const last = result[result.length - 1];
    if (last && point.x - last.x < 1e-4) {
      result[result.length - 1] = point;
      continue;
    }
    result.push(point);
  }
  if (result.length < 2) return identityCurve();
  result[0] = { x: 0, y: result[0].y };
  result[result.length - 1] = { x: 1, y: result[result.length - 1].y };
  return result;
}

/** 单调三次 Hermite 在 x 处的取值（x 会被夹到 0..1）。 */
export function evaluateCurve(points: readonly CurvePoint[], x: number): number {
  if (!points.length) return clamp01(x);
  if (points.length === 1) return points[0].y;

  const px = clamp01(x);
  const n = points.length;

  // 落在端点上
  if (px <= points[0].x) return points[0].y;
  if (px >= points[n - 1].x) return points[n - 1].y;

  // 找到 px 所在的区间
  let index = 0;
  for (let i = 0; i < n - 1; i++) {
    if (px >= points[i].x && px <= points[i + 1].x) {
      index = i;
      break;
    }
  }

  const h = points[index + 1].x - points[index].x;
  if (h <= 0) return points[index + 1].y;

  const t = (px - points[index].x) / h;
  const m0 = tangent(points, index);
  const m1 = tangent(points, index + 1);

  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;

  const y = h00 * points[index].y + h10 * h * m0 + h01 * points[index + 1].y + h11 * h * m1;
  return clamp01(y);
}

/**
 * Fritsch–Carlson 切线：先取相邻割线的平均，再做保单调修正。
 * 这里是 O(n) 重算（n ≤ 10），够快，也省掉了缓存一致性问题。
 */
function tangent(points: readonly CurvePoint[], i: number): number {
  const n = points.length;
  if (n < 2) return 1;
  if (i === 0) return slope(points, 0);
  if (i === n - 1) return slope(points, n - 2);

  const dPrev = slope(points, i - 1);
  const dNext = slope(points, i);
  if (dPrev === 0 || dNext === 0) return 0;
  // 异号割线（局部极值）→ 切线取 0，避免过冲
  if (Math.sign(dPrev) !== Math.sign(dNext)) return 0;
  return (dPrev + dNext) / 2;
}

function slope(points: readonly CurvePoint[], i: number): number {
  const h = points[i + 1].x - points[i].x;
  if (h <= 0) return 0;
  return (points[i + 1].y - points[i].y) / h;
}

/**
 * 把一组曲线烘成 256×1 RGBA（R/G/B = 复合结果，A = 255）。
 * 复合顺序：主曲线 → 单通道曲线，与 shader 里的采样一致。
 */
export function buildCurveTable(set: CurveSet): Uint8Array {
  const pixels = new Uint8Array(CURVE_TABLE_SIZE * 4);
  for (let i = 0; i < CURVE_TABLE_SIZE; i++) {
    const x = i / (CURVE_TABLE_SIZE - 1);
    const master = evaluateCurve(set.rgb, x);
    const r = evaluateCurve(set.r, master);
    const g = evaluateCurve(set.g, master);
    const b = evaluateCurve(set.b, master);
    const offset = i * 4;
    pixels[offset] = toByte(r);
    pixels[offset + 1] = toByte(g);
    pixels[offset + 2] = toByte(b);
    pixels[offset + 3] = 255;
  }
  return pixels;
}

function toByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

export function identityCurveTable(): Uint8Array {
  return buildCurveTable(defaultCurveSet());
}

/** 持久化 / 外部输入的安全网：任何不认识的结构都退回恒等曲线。 */
export function normalizeCurveSet(input: unknown): CurveSet {
  const fallback = defaultCurveSet();
  if (!input || typeof input !== 'object') return fallback;
  const record = input as Record<string, unknown>;
  const parsed = (channel: CurveChannel): CurvePoint[] => {
    const raw = record[channel];
    if (!Array.isArray(raw)) return identityCurve();
    const points = raw
      .filter((item): item is CurvePoint => Boolean(item) && typeof item === 'object')
      .map((item) => ({ x: Number((item as CurvePoint).x), y: Number((item as CurvePoint).y) }));
    return normalizeCurve(points);
  };
  return { rgb: parsed('rgb'), r: parsed('r'), g: parsed('g'), b: parsed('b') };
}

/** 一份共享的恒等曲线（只读用；任何写入路径都会先 clone）。 */
export const IDENTITY_CURVE_SET: CurveSet = defaultCurveSet();

/** 曲线编辑器的增点：在 x 处插入，y 取当前曲线值。 */
export function insertCurvePoint(points: readonly CurvePoint[], x: number, y: number): CurvePoint[] {
  if (points.length >= MAX_CURVE_POINTS) return cloneCurve(points);
  const point = { x: clamp01(x), y: clamp01(y) };
  const next = cloneCurve(points);
  // 两端点之间才能插
  if (point.x <= 0.001 || point.x >= 0.999) return next;
  const index = next.findIndex((p) => p.x > point.x);
  if (index <= 0) return next;
  next.splice(index, 0, point);
  return normalizeCurve(next);
}

/** 删除控制点（端点不可删）。 */
export function removeCurvePoint(points: readonly CurvePoint[], index: number): CurvePoint[] {
  if (index <= 0 || index >= points.length - 1) return cloneCurve(points);
  const next = cloneCurve(points);
  next.splice(index, 1);
  return normalizeCurve(next);
}

/**
 * 移动控制点：端点只能上下移动，中间点可以在相邻两点之间左右移动。
 * 返回新数组（不可变更新，方便 React / zustand 比较）。
 */
export function moveCurvePoint(
  points: readonly CurvePoint[],
  index: number,
  x: number,
  y: number,
): CurvePoint[] {
  if (index < 0 || index >= points.length) return cloneCurve(points);
  const next = cloneCurve(points);
  const isFirst = index === 0;
  const isLast = index === points.length - 1;

  next[index] = {
    x: isFirst ? 0 : isLast ? 1 : Math.min(next[index + 1].x - 0.002, Math.max(next[index - 1].x + 0.002, clamp01(x))),
    y: clamp01(y),
  };
  return next;
}

/** 离 (x, y) 最近的控制点下标；超过阈值返回 -1。阈值按 0..1 归一化。 */
export function nearestCurvePoint(points: readonly CurvePoint[], x: number, y: number, maxDistance = 0.09): number {
  let best = -1;
  let bestDistance = maxDistance;
  points.forEach((point, index) => {
    const distance = Math.hypot(point.x - x, point.y - y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}
