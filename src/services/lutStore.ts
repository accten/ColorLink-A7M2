import { File } from 'expo-file-system';

import { Lut3D, describeLut, parseCube } from '@/core/lut';
import { eventLog } from '@/core/log';

import { lutFile, lutsDir, ensureDirs } from './paths';

/**
 * LUT 导入与缓存。
 *
 * `.cube` 是纯文本，直接读进来解析；解析通过后再复制进 luts/ 并记住路径。
 * 这里不做"偷偷截断/猜格式"的容错 —— 坏文件就把原因还给用户（TC-07）。
 */

export type ImportResult =
  | { ok: true; path: string; name: string; lut: Lut3D; summary: string }
  | { ok: false; reason: string; canceled?: boolean };

const cache = new Map<string, Lut3D>();

function sanitize(name: string): string {
  return name.replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').slice(0, 80) || 'look.cube';
}

export async function importLutFromPicker(): Promise<ImportResult> {
  ensureDirs();
  try {
    const picked = await File.pickFileAsync({
      mimeTypes: ['application/octet-stream', 'text/plain', '*/*'],
    });

    if (picked.canceled || !picked.result) {
      return { ok: false, reason: '已取消', canceled: true };
    }

    const pickedFile = Array.isArray(picked.result) ? picked.result[0] : picked.result;
    if (!pickedFile) return { ok: false, reason: '未选择文件', canceled: true };

    const text = await pickedFile.text();
    const parsed = parseCube(text);
    if (!parsed.ok) {
      eventLog.warn('lut.parse.failed', { reason: parsed.reason });
      return { ok: false, reason: parsed.reason };
    }

    const name = sanitize(pickedFile.name ?? 'look.cube');
    const finalName = name.toLowerCase().endsWith('.cube') ? name : `${name}.cube`;
    const target = lutFile(finalName);
    if (target.exists) target.delete();
    await pickedFile.copy(target);

    cache.set(target.uri, parsed.lut);
    const summary = describeLut(parsed.lut);
    eventLog.info('lut.imported', { name: finalName, size: parsed.lut.size });
    return { ok: true, path: target.uri, name: finalName, lut: parsed.lut, summary };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    eventLog.error('lut.import.failed', { reason });
    return { ok: false, reason: `导入失败：${reason}` };
  }
}

export async function loadLutFromPath(path: string): Promise<Lut3D | null> {
  const cached = cache.get(path);
  if (cached) return cached;

  try {
    const file = new File(path);
    if (!file.exists) return null;
    const parsed = parseCube(await file.text());
    if (!parsed.ok) {
      eventLog.warn('lut.reload.failed', { path, reason: parsed.reason });
      return null;
    }
    cache.set(path, parsed.lut);
    return parsed.lut;
  } catch (error) {
    eventLog.warn('lut.reload.error', { path, error: String(error) });
    return null;
  }
}

export function listImportedLuts(): { name: string; path: string }[] {
  ensureDirs();
  try {
    return lutsDir
      .list()
      .filter((entry): entry is File => entry instanceof File)
      .filter((f) => f.name.toLowerCase().endsWith('.cube'))
      .map((f) => ({ name: f.name, path: f.uri }));
  } catch {
    return [];
  }
}
