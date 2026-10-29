/** 资产模型与命名规则（纯逻辑）。 */

export type AssetStatus = 'ingested' | 'edited' | 'exported';
export type AssetSource = 'demo' | 'camera' | 'import';

export interface Asset {
  id: string;
  /** 展示用文件名（含扩展名） */
  fileName: string;
  /** App 私有目录里的绝对 uri */
  uri: string;
  /** 缩略图 uri（可缺省，缺省时直接用原图） */
  thumbUri?: string;
  /** 编辑预览图 uri（1600px，可缺省；缺省时编辑器回落到原图） */
  previewUri?: string;
  capturedAt: number;
  width: number;
  height: number;
  /** 原图 SHA-256，用于去重与"原图未被修改"的验收 */
  originalHash: string;
  bytes: number;
  status: AssetStatus;
  source: AssetSource;
  cameraFileName?: string;
}

const pad = (v: number, len = 2) => String(v).padStart(len, '0');

/** 时间戳文件名前缀：20261029_143012 */
export function stamp(date: Date): string {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** 一拍一传的落盘名：20261029_143012_004.jpg（序号保证不覆盖） */
export function ingestFileName(date: Date, seq: number, ext = 'jpg'): string {
  return `${stamp(date)}_${pad(seq, 3)}.${ext.replace(/^\./, '')}`;
}

/**
 * 导出名：原文件名_edited_时间戳.jpg
 * 需求 FR-07 的命名规则，保留原名便于回溯。
 *
 * 扩展名固定 .jpg：调色结果一律编码为 JPEG，源图是 PNG 时也不能沿用 .png，
 * 否则会出现"扩展名与内容不符"的文件。
 */
export function exportFileName(originalName: string, date: Date): string {
  const dot = originalName.lastIndexOf('.');
  const base = dot > 0 ? originalName.slice(0, dot) : originalName;
  return `${base}_edited_${stamp(date)}.jpg`;
}

export function newAssetId(date: Date, seq: number): string {
  return `${date.getTime().toString(36)}-${pad(seq, 3)}`;
}

/**
 * 同一秒内导出两张时，文件名会撞车。这里按 `-2`、`-3` 递增到第一个空位，
 * 保证"绝不覆盖已有输出"（FR-07 的硬约束）。
 */
export function uniqueFileName(name: string, exists: (candidate: string) => boolean): string {
  if (!exists(name)) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}${ext}`;
    if (!exists(candidate)) return candidate;
  }
  return `${base}-${Date.now()}${ext}`;
}

/** 按摘要查重：一拍一传的"不重"就靠它，纯函数便于单测。 */
export function findAssetByHash(assets: readonly Asset[], hash: string): Asset | undefined {
  if (!hash) return undefined;
  return assets.find((a) => a.originalHash === hash);
}

/**
 * 是否应当把这次"拍摄"当作重复丢弃。
 *
 * 去重是为了避免同一张相机文件被导入两次；但**演示模式下每次快门就是一张新照片**，
 * 像素与示例图相同（SHA-256 相同），若也走去重，连按快门会一张都进不了图库
 * —— 真机上正是这么暴露的（日志里 ingest.duplicate 连刷）。
 */
export function isDuplicateCapture(
  mode: 'demo' | 'usb',
  assets: readonly Asset[],
  hash: string,
): boolean {
  if (mode === 'demo') return false;
  return findAssetByHash(assets, hash) !== undefined;
}

export function formatBytes(bytes: number | undefined | null): string {
  if (!bytes || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatClock(at: number): string {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatDay(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 从 uri 取末段文件名（兼容 file:// 与 content://）。 */
export function fileNameFromUri(uri: string): string {
  const clean = uri.split('?')[0];
  const parts = clean.split('/');
  return decodeURIComponent(parts[parts.length - 1] ?? 'photo.jpg');
}

/** 拍摄尺寸摘要：6000 × 4000 */
export function formatDimensions(width: number, height: number): string {
  return `${width} × ${height}`;
}

/** 千分位像素数：24.0 MP */
export function formatMegapixels(width: number, height: number): string {
  const mp = (width * height) / 1_000_000;
  return `${mp.toFixed(1)} MP`;
}
