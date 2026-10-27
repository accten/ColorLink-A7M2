import { File } from 'expo-file-system';

import { Asset, findAssetByHash, newAssetId } from '@/core/asset';
import { eventLog } from '@/core/log';
import { DEMO_FRAMES } from '@/features/demo/frames';
import { CapturedPhoto } from '@/services/camera/types';
import { seedDemoFrame } from '@/services/demoAssets';

import { ensureDirs, indexFile, readTextSafe, writeTextAtomic } from './paths';

/**
 * 图库索引（JSON 持久化）。
 *
 * 为什么先不用 SQLite：MVP 的照片量级在几百张，JSON 足够；而 index.json 的
 * 读写被封装在 loadAssets/saveAssets 两个函数里，之后换成 expo-sqlite 时
 * 上层（store / 页面）零改动。
 */

interface IndexPayload {
  version: number;
  assets: Asset[];
  savedAt: number;
}

const VERSION = 1;

export async function loadAssets(): Promise<Asset[]> {
  ensureDirs();
  const raw = readTextSafe(indexFile);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as Partial<IndexPayload>;
    const list = Array.isArray(parsed.assets) ? parsed.assets : [];
    const valid = list.filter((item): item is Asset => {
      if (!item || typeof item !== 'object') return false;
      if (typeof item.uri !== 'string' || typeof item.id !== 'string') return false;
      try {
        return new File(item.uri).exists;
      } catch {
        return false;
      }
    });
    if (valid.length !== list.length) {
      eventLog.warn('library.pruned', { removed: list.length - valid.length });
    }
    return valid.sort((a, b) => b.capturedAt - a.capturedAt);
  } catch (error) {
    eventLog.error('library.parse.failed', { error: String(error) });
    return [];
  }
}

export async function saveAssets(assets: Asset[]): Promise<void> {
  const payload: IndexPayload = { version: VERSION, assets, savedAt: Date.now() };
  await writeTextAtomic(indexFile, JSON.stringify(payload));
}

export function assetFromPhoto(photo: CapturedPhoto, source: Asset['source'], seq = 1): Asset {
  return {
    id: newAssetId(new Date(photo.capturedAt), seq),
    fileName: photo.fileName,
    uri: photo.uri,
    thumbUri: photo.uri,
    capturedAt: photo.capturedAt,
    width: photo.width,
    height: photo.height,
    originalHash: photo.hash,
    bytes: photo.bytes,
    status: 'ingested',
    source,
  };
}

/**
 * 首次启动的演示图库：把 6 张 demo 图复制进 ingest/ 并入库。
 * 幂等：同名文件已存在且摘要一致就跳过，不会越点越多。
 */
export async function seedDemoAssets(): Promise<Asset[]> {
  ensureDirs();
  const existing = await loadAssets();
  const knownHashes = new Set(existing.map((a) => a.originalHash));
  const created: Asset[] = [];
  const now = Date.now();

  for (let i = 0; i < DEMO_FRAMES.length; i++) {
    const frame = DEMO_FRAMES[i];

    try {
      // 稳定文件名 + 已存在则复用；落盘细节（expo-asset → bytes → write）统一在 demoAssets
      const materialized = await seedDemoFrame(frame);
      if (!materialized.hash) {
        eventLog.warn('library.seed.nohash', { frame: frame.key });
        continue;
      }
      if (knownHashes.has(materialized.hash)) continue;
      knownHashes.add(materialized.hash);

      created.push({
        id: newAssetId(new Date(now - i * 60_000), i + 1),
        fileName: materialized.fileName,
        uri: materialized.uri,
        thumbUri: materialized.uri,
        capturedAt: now - i * 60_000,
        width: frame.width,
        height: frame.height,
        originalHash: materialized.hash,
        bytes: materialized.bytes,
        status: 'ingested',
        source: 'demo',
        cameraFileName: `DEMO_${frame.key.toUpperCase()}.PNG`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      eventLog.error('library.seed.failed', { frame: frame.key, error: message });
    }
  }

  if (!created.length) return existing;
  const merged = [...created, ...existing].sort((a, b) => b.capturedAt - a.capturedAt);
  await saveAssets(merged);
  eventLog.info('library.seeded', { added: created.length, total: merged.length });
  return merged;
}

export async function deleteAssetFile(asset: Asset): Promise<void> {
  try {
    const file = new File(asset.uri);
    if (file.exists) file.delete();
  } catch (error) {
    eventLog.warn('library.delete.failed', { uri: asset.uri, error: String(error) });
  }
}

export function findDuplicate(assets: Asset[], hash: string): Asset | undefined {
  return findAssetByHash(assets, hash);
}
