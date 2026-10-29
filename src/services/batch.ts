import { Asset } from '@/core/asset';
import { eventLog } from '@/core/log';
import { EditorSession } from '@/core/session';

import { exportEdited } from './exportImage';
import { loadLutFromPath } from './lutStore';

/**
 * 批量导出（图库多选）。
 *
 * 一张一张串行跑：导出是「解码 24MP → GPU 调色 → 编码 → 写文件」，并发跑两张
 * 就会在低端机上把内存打满。串行还能给出"3/12"这种可信的进度。
 *
 * 单张失败不影响后面的图：失败原因收集起来一次性汇报，而不是第一张出错就整体中断。
 */

export interface BatchExportOptions {
  assets: Asset[];
  getSession: (assetId: string) => EditorSession;
  longEdge: number;
  quality: number;
  toGallery: boolean;
  onProgress?: (done: number, total: number, fileName: string) => void;
  isCancelled?: () => boolean;
}

export interface BatchFailure {
  assetId: string;
  fileName: string;
  error: string;
}

export interface BatchExportResult {
  exported: number;
  succeeded: string[];
  failed: BatchFailure[];
  cancelled: boolean;
}

export async function batchExportAssets(options: BatchExportOptions): Promise<BatchExportResult> {
  const { assets, getSession, longEdge, quality, toGallery, onProgress, isCancelled } = options;
  const total = assets.length;
  const failed: BatchFailure[] = [];
  const succeeded: string[] = [];
  let cancelled = false;
  const started = Date.now();

  for (const [index, asset] of assets.entries()) {
    if (isCancelled?.()) {
      cancelled = true;
      break;
    }

    const session = getSession(asset.id);
    try {
      const lut = session.lutPath ? await loadLutFromPath(session.lutPath) : null;
      await exportEdited({
        asset,
        params: session.params,
        curves: session.curves,
        lut,
        longEdge,
        quality,
        toGallery,
      });
      succeeded.push(asset.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ assetId: asset.id, fileName: asset.fileName, error: message });
      eventLog.warn('batch.export.failed', { fileName: asset.fileName, error: message });
    }

    onProgress?.(index + 1, total, asset.fileName);
  }

  eventLog.info('batch.export.done', {
    total,
    exported: succeeded.length,
    failed: failed.length,
    cancelled,
    ms: Date.now() - started,
    toGallery,
  });

  return { exported: succeeded.length, succeeded, failed, cancelled };
}
