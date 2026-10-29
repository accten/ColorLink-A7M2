import { ImageFormat } from '@shopify/react-native-skia';
import { File } from 'expo-file-system';

import { Asset } from '@/core/asset';
import { eventLog } from '@/core/log';

import { decodeImage, makePreviewImage } from './grading';
import { exists, previewFile, thumbFile } from './paths';

/**
 * 图库缩略图 + 编辑器预览图。
 *
 * 图库直接拿 24MP 原图当缩略图，滑一屏就是几十张全尺寸解码 —— 这是列表卡顿的
 * 主要原因；编辑页打开慢也是同一个原因：原图 4.7MB 读进 JS、解成 6000×4000
 * 的 SkImage（约 96MB），再降采样。
 *
 * 这里在入库后生成两档派生图，**只解码一次**：
 *   - thumbs/   480px，图库列表用
 *   - previews/ 1600px，编辑页用（解码量与文件读取都降一个数量级）
 * 缩略图从预览图再缩一次，所以第二档几乎是白送的。
 */

const THUMB_LONG_EDGE = 480;
const THUMB_QUALITY = 78;
const PREVIEW_LONG_EDGE = 1600;
const PREVIEW_QUALITY = 82;

export interface Derivatives {
  thumbUri: string | null;
  previewUri: string | null;
}

export function thumbNameFor(assetId: string): string {
  return `${assetId}.jpg`;
}

export function previewNameFor(assetId: string): string {
  return `${assetId}.jpg`;
}

/** 编辑页要用的预览图；没有就返回 null（调用方回落到原图）。 */
export function existingPreview(asset: Pick<Asset, 'id'> & { previewUri?: string }): string | null {
  if (asset.previewUri && exists(asset.previewUri)) return asset.previewUri;
  try {
    const target = previewFile(previewNameFor(asset.id));
    return target.exists ? target.uri : null;
  } catch {
    return null;
  }
}

/**
 * 生成（或复用）某张图的两档派生图。
 * 任何一步失败都返回 null 字段，调用方回落到原图 —— 派生图不能成为阻塞项。
 */
export async function ensureDerivatives(asset: Pick<Asset, 'id' | 'uri'>): Promise<Derivatives> {
  const thumbTarget = thumbFile(thumbNameFor(asset.id));
  const previewTarget = previewFile(previewNameFor(asset.id));
  const thumbDone = thumbTarget.exists;
  const previewDone = previewTarget.exists;

  if (thumbDone && previewDone) {
    return { thumbUri: thumbTarget.uri, previewUri: previewTarget.uri };
  }

  const fallback: Derivatives = {
    thumbUri: thumbDone ? thumbTarget.uri : null,
    previewUri: previewDone ? previewTarget.uri : null,
  };

  try {
    const bytes = await new File(asset.uri).bytes();
    const decoded = decodeImage(bytes);
    if (!decoded) return fallback;

    let base = decoded;

    if (!previewDone) {
      const preview = makePreviewImage(decoded, PREVIEW_LONG_EDGE);
      const jpeg = preview.encodeToBytes(ImageFormat.JPEG, PREVIEW_QUALITY);
      if (jpeg?.length) {
        await previewTarget.write(jpeg);
        fallback.previewUri = previewTarget.uri;
        base = preview;
        eventLog.info('preview.ok', { assetId: asset.id, bytes: jpeg.length });
      }
    }

    if (!thumbDone) {
      // 从预览图再缩：预览图已经 ≤1600，几乎无成本
      const thumb = makePreviewImage(base, THUMB_LONG_EDGE);
      const jpeg = thumb.encodeToBytes(ImageFormat.JPEG, THUMB_QUALITY);
      if (jpeg?.length) {
        await thumbTarget.write(jpeg);
        fallback.thumbUri = thumbTarget.uri;
        eventLog.info('thumb.ok', { assetId: asset.id, bytes: jpeg.length });
      }
    }

    return fallback;
  } catch (error) {
    eventLog.warn('derivatives.failed', { assetId: asset.id, error: String(error) });
    return fallback;
  }
}

/** 兼容旧调用：只要缩略图。 */
export async function ensureThumbnail(asset: Asset): Promise<string | null> {
  const current = asset.thumbUri;
  if (current && current !== asset.uri && exists(current)) return current;
  return (await ensureDerivatives(asset)).thumbUri;
}

/** 编辑页需要预览图时调用：命中缓存直接返回，否则现做一份。 */
export async function ensurePreview(
  asset: Pick<Asset, 'id' | 'uri'> & { previewUri?: string },
): Promise<string | null> {
  const cached = existingPreview(asset);
  if (cached) return cached;
  return (await ensureDerivatives(asset)).previewUri;
}

/**
 * 给一批老资产补派生图。
 *
 * 冷启动时只补 `limit` 张（默认 6），避免一次性解码几十张把首屏拖慢；
 * 剩下的会在后续启动或再次进入图库时慢慢补齐。
 */
export async function backfillDerivatives(assets: Asset[], limit = 6): Promise<Asset[]> {
  const pending = assets.filter((asset) => {
    const thumb = asset.thumbUri;
    const thumbMissing = !thumb || thumb === asset.uri || !thumb.includes('/thumbs/') || !exists(thumb);
    const previewMissing = !existingPreview(asset);
    return thumbMissing || previewMissing;
  });
  if (!pending.length) return assets;

  const slice = pending.slice(0, limit);
  const results = new Map<string, Derivatives>();

  for (const asset of slice) {
    const derived = await ensureDerivatives(asset);
    if (derived.thumbUri || derived.previewUri) results.set(asset.id, derived);
  }

  eventLog.info('derivatives.backfill', { pending: pending.length, made: results.size });
  if (!results.size) return assets;

  return assets.map((asset) => {
    const derived = results.get(asset.id);
    if (!derived) return asset;
    return {
      ...asset,
      thumbUri: derived.thumbUri ?? asset.thumbUri,
      previewUri: derived.previewUri ?? asset.previewUri,
    };
  });
}

/** 兼容旧调用：只补缩略图。 */
export async function backfillThumbnails(assets: Asset[], limit = 6): Promise<Asset[]> {
  return backfillDerivatives(assets, limit);
}
