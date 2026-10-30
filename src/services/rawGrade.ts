import { File, Paths } from 'expo-file-system';
import SonyCamera, { type SonyRawDecodeResult } from 'expo-sony-camera';

import { Asset } from '@/core/asset';
import { eventLog } from '@/core/log';

import { ensureDirs, exists, previewFile, rawGradeFile, thumbFile } from './paths';
import { previewNameFor, thumbNameFor } from './thumbs';

/**
 * RAW(ARW) → 可调色的全幅图片。
 *
 * 原生侧（LibRaw）解一次 24MP：机身白平衡 + AHD 去马赛克 + sRGB 8bit，输出
 *   raw/<id>.png            全幅，导出时用（和 JPEG 走同一条调色管线）
 *   previews/<id>.jpg       1600px，编辑器秒开
 *   thumbs/<id>.jpg         480px，图库列表
 * 之后这张 RAW 就和普通 JPEG 没区别了：同一套参数、曲线、LUT、导出。
 *
 * 只做一次：`asset.gradeUri` 存在且文件还在就直接返回，绝不重复解（一张要 3~6 秒）。
 */

export interface RawGrade {
  gradeUri: string;
  previewUri: string;
  thumbUri: string;
  width: number;
  height: number;
  ms: number;
}

/** 已经解过、且文件还在？ */
export function existingRawGrade(asset: Pick<Asset, 'id'> & { gradeUri?: string }): string | null {
  if (asset.gradeUri && exists(asset.gradeUri)) return asset.gradeUri;
  try {
    const target = rawGradeFile(`${asset.id}.png`);
    return target.exists ? target.uri : null;
  } catch {
    return null;
  }
}

/** 全幅 PNG 的存在性检查（导出前用）。 */
export function hasRawGrade(asset: Pick<Asset, 'id'> & { gradeUri?: string }): boolean {
  return existingRawGrade(asset) !== null;
}

function plainPath(uri: string): string {
  return uri.startsWith('file://') ? decodeURIComponent(uri.slice('file://'.length)) : uri;
}

function moveInto(sourcePath: string, target: File): string {
  const source = new File(sourcePath);
  if (!source.exists) return target.uri;
  if (target.exists) target.delete();
  source.move(target);
  return target.uri;
}

/**
 * 解码一张 RAW（已有缓存则直接复用）。
 *
 * 失败不抛：返回 null，调用方据此提示"这张 RAW 解不了"，别把整个编辑页搞崩。
 */
export async function ensureRawGrade(asset: Asset): Promise<RawGrade | null> {
  const cached = existingRawGrade(asset);
  if (cached) {
    const sizes = asset.width > 0 && asset.height > 0 ? asset : { width: 0, height: 0 };
    return {
      gradeUri: cached,
      previewUri: asset.previewUri ?? '',
      thumbUri: asset.thumbUri ?? '',
      width: sizes.width,
      height: sizes.height,
      ms: 0,
    };
  }

  if (!SonyCamera?.decodeRaw) {
    eventLog.warn('raw.decode.unsupported', { assetId: asset.id });
    return null;
  }

  const started = Date.now();
  try {
    ensureDirs();
    // 原生把三个文件先写到 cache 里，再逐个挪进正式目录：
    // 中途失败最多留下可清理的缓存文件，不会出现"索引里有、文件是半截"的状态。
    const scratch = `${plainPath(Paths.cache.uri)}/raw-decode`;
    const result: SonyRawDecodeResult = await SonyCamera.decodeRaw(plainPath(asset.uri), scratch, asset.id);
    if (!result?.pngPath) {
      eventLog.warn('raw.decode.empty', { assetId: asset.id });
      return null;
    }

    const gradeUri = moveInto(result.pngPath, rawGradeFile(`${asset.id}.png`));
    const previewUri = result.previewPath
      ? moveInto(result.previewPath, previewFile(previewNameFor(asset.id)))
      : '';
    const thumbUri = result.thumbPath ? moveInto(result.thumbPath, thumbFile(thumbNameFor(asset.id))) : '';

    eventLog.info('raw.decode.ok', {
      assetId: asset.id,
      width: result.width,
      height: result.height,
      bytes: result.bytes,
      decodeMs: result.decodeMs,
      totalMs: result.totalMs,
      wallMs: Date.now() - started,
    });

    return {
      gradeUri,
      previewUri,
      thumbUri,
      width: result.width,
      height: result.height,
      ms: result.totalMs ?? Date.now() - started,
    };
  } catch (error) {
    eventLog.warn('raw.decode.failed', {
      assetId: asset.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** 删掉解码缓存（删图库照片时调用）。原件与派生图由各自的删除逻辑处理。 */
export function deleteRawGrade(assetId: string): void {
  try {
    const target = rawGradeFile(`${assetId}.png`);
    if (target.exists) target.delete();
  } catch {
    // 删不掉就留着，下次启动也不会引用它
  }
}

/** 调色/导出时真正该读哪个文件：RAW 用解出来的 PNG，其余用原图。 */
export function gradeSourceUri(asset: Pick<Asset, 'id' | 'uri'> & { gradeUri?: string; raw?: boolean }): string {
  if (!asset.raw) return asset.uri;
  return existingRawGrade(asset) ?? asset.uri;
}
