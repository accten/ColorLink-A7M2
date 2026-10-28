import { ImageFormat } from '@shopify/react-native-skia';
import { File } from 'expo-file-system';

import { Asset } from '@/core/asset';
import { eventLog } from '@/core/log';

import { decodeImage, makePreviewImage } from './grading';
import { exists, thumbFile } from './paths';

/**
 * 缩略图。
 *
 * 图库里直接拿 24MP 原图当缩略图，滑一屏就是几十张全尺寸解码 —— 这是列表卡顿的
 * 主要原因。这里在入库后（以及首次启动时补做一批）生成 480px 的 JPEG 缩略图，
 * 列表只用它，原图只在编辑/导出时用。
 */

const THUMB_LONG_EDGE = 480;
const THUMB_QUALITY = 78;

export function thumbNameFor(assetId: string): string {
  return `${assetId}.jpg`;
}

/** 生成（或复用）某张图的缩略图，返回 uri；失败返回 null 由调用方回落到原图。 */
export async function ensureThumbnail(asset: Asset): Promise<string | null> {
  const current = asset.thumbUri;
  if (current && current !== asset.uri && exists(current)) return current;

  try {
    const target = thumbFile(thumbNameFor(asset.id));
    if (target.exists) return target.uri;

    const bytes = await new File(asset.uri).bytes();
    const decoded = decodeImage(bytes);
    if (!decoded) return null;
    const thumb = makePreviewImage(decoded, THUMB_LONG_EDGE);
    const jpeg = thumb.encodeToBytes(ImageFormat.JPEG, THUMB_QUALITY);
    if (!jpeg?.length) return null;
    await target.write(jpeg);
    eventLog.info('thumb.ok', { assetId: asset.id, bytes: jpeg.length });
    return target.uri;
  } catch (error) {
    eventLog.warn('thumb.failed', { assetId: asset.id, error: String(error) });
    return null;
  }
}

/**
 * 给一批老资产补缩略图。
 *
 * 冷启动时只补 `limit` 张（默认 6），避免一次性解码几十张把首屏拖慢；
 * 剩下的会在后续启动或再次进入图库时慢慢补齐。
 */
export async function backfillThumbnails(
  assets: Asset[],
  limit = 6,
): Promise<Asset[]> {
  // 注意：旧数据里的 thumbUri 可能指向一个已经不存在的旧路径，
  // 只按"是否等于原图"筛选会把这些永远漏掉，所以还要检查文件是否真的在。
  const pending = assets.filter((asset) => {
    if (!asset.thumbUri) return true;
    if (asset.thumbUri === asset.uri) return true;
    return !exists(asset.thumbUri);
  });
  if (!pending.length) return assets;

  const slice = pending.slice(0, limit);
  const results = new Map<string, string>();

  for (const asset of slice) {
    const uri = await ensureThumbnail(asset);
    if (uri) results.set(asset.id, uri);
  }

  eventLog.info('thumb.backfill', { pending: pending.length, made: results.size });
  if (!results.size) return assets;
  return assets.map((asset) => {
    const uri = results.get(asset.id);
    return uri ? { ...asset, thumbUri: uri } : asset;
  });
}
