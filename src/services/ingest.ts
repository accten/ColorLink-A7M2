import { File } from 'expo-file-system';

import { eventLog } from '@/core/log';

/**
 * 文件读写小工具。
 *
 * 全部走 expo-file-system v58 的新 API（File/Directory 类）：
 *  - 摘要用原生 digest（不在 JS 里读 8~12MB 的图）
 *  - base64 用 File.base64()
 *  - 二进制写入用 Uint8Array
 */

/** 把 digest 结果规范成稳定的键（hex 优先，非 hex 时退化为原串）。 */
export function normalizeDigest(raw: string | null | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(trimmed)) return trimmed;
  return trimmed;
}

export async function sha256OfFile(file: File): Promise<string> {
  try {
    const digest = await file.digest('SHA-256');
    return normalizeDigest(digest);
  } catch (error) {
    eventLog.warn('hash.failed', { error: String(error) });
    return '';
  }
}

export async function writeBytes(file: File, bytes: Uint8Array): Promise<void> {
  if (file.exists) file.delete();
  await file.write(bytes);
}

export async function readBase64(uri: string): Promise<string> {
  return new File(uri).base64();
}

export async function readDataUrl(uri: string, mime = 'image/jpeg'): Promise<string> {
  const base64 = await readBase64(uri);
  return `data:${mime};base64,${base64}`;
}

export function uriToMime(uri: string): string {
  const lower = uri.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

export function sizeOf(uri: string): number {
  try {
    const file = new File(uri);
    return file.exists ? (file.size ?? 0) : 0;
  } catch {
    return 0;
  }
}
