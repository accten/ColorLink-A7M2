import { File } from 'expo-file-system';
import { Asset as MediaAsset, requestPermissionsAsync } from 'expo-media-library';

import { Asset, exportFileName, uniqueFileName } from '@/core/asset';
import { Lut3D } from '@/core/lut';
import { EditParams } from '@/core/params';
import { eventLog } from '@/core/log';

import { decodeImage, fitWithin, renderGradedJpeg } from './grading';
import { sha256OfFile } from './ingest';
import { editedFile } from './paths';

export interface ExportResult {
  uri: string;
  fileName: string;
  width: number;
  height: number;
  bytes: number;
  outputHash: string;
  /** 导出后重新校验原图摘要：必须和入库时一致（FR-07 / TC-10） */
  originalIntact: boolean;
  savedToGallery: boolean;
  /** 写入相册失败时的原因（本地文件仍然已保存） */
  galleryError: string | null;
}

export interface ExportOptions {
  asset: Asset;
  params: EditParams;
  lut?: Lut3D | null;
  longEdge?: number;
  quality?: number;
  toGallery?: boolean;
}

/**
 * 导出调色结果。
 *
 * 硬约束（对应需求 FR-07）：
 *  - 原图只读：只读它的字节，不写回；导出后重新算原图摘要并和入库值比对；
 *  - 输出另存：写到 edited/，命名 原名_edited_时间戳.jpg；
 *  - 质量 ≥90（默认 92）；
 *  - 相册导出走 MediaStore，失败不影响本地文件。
 */
export async function exportEdited(options: ExportOptions): Promise<ExportResult> {
  const { asset, params } = options;
  const longEdge = options.longEdge ?? 4000;
  const quality = options.quality ?? 92;

  const source = new File(asset.uri);
  if (!source.exists) throw new Error('原图不存在，可能已被删除');

  const bytes = await source.bytes();
  const image = decodeImage(bytes);
  if (!image) throw new Error('原图解码失败（不是有效的 JPEG/PNG）');

  const target = fitWithin(asset.width || image.width(), asset.height || image.height(), longEdge);

  const started = Date.now();
  const jpeg = renderGradedJpeg({
    image,
    params,
    lut: options.lut ?? null,
    width: target.width,
    height: target.height,
    quality,
  });

  const fileName = uniqueFileName(exportFileName(asset.fileName, new Date()), (candidate) =>
    editedFile(candidate).exists,
  );
  const output = editedFile(fileName);
  if (output.exists) output.delete();
  await output.write(jpeg);

  const outputHash = await sha256OfFile(output);
  const originalHash = await sha256OfFile(source);
  const originalIntact = !originalHash || !asset.originalHash || originalHash === asset.originalHash;

  let savedToGallery = false;
  let galleryError: string | null = null;

  if (options.toGallery) {
    // 先直接写：Android 10+ 走 MediaStore 本来就不需要读权限，
    // 只有真正被拒时才申请/提示。之前"先 requestPermission 再写"的写法在
    // Android 17 上会直接拿到 denied，于是静默跳过，用户以为存进相册了。
    try {
      await MediaAsset.create(output.uri);
      savedToGallery = true;
    } catch (directError) {
      try {
        const permission = await requestPermissionsAsync(true);
        if (!permission.granted) throw new Error('相册权限被拒绝');
        await MediaAsset.create(output.uri);
        savedToGallery = true;
      } catch (error) {
        galleryError = error instanceof Error ? error.message : String(error);
        eventLog.warn('export.gallery.failed', {
          direct: String(directError),
          reason: galleryError,
        });
      }
    }
  }

  eventLog.info('export.ok', {
    fileName,
    bytes: jpeg.length,
    width: target.width,
    height: target.height,
    ms: Date.now() - started,
    originalIntact,
    savedToGallery,
    galleryError,
  });

  return {
    uri: output.uri,
    fileName,
    width: target.width,
    height: target.height,
    bytes: jpeg.length,
    outputHash,
    originalIntact,
    savedToGallery,
    galleryError,
  };
}
