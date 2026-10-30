import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Asset } from '../src/core/asset';
import { IDENTITY_CURVE_SET } from '../src/core/curve';
import { DEFAULT_PARAMS } from '../src/core/params';
import type { EditorSession } from '../src/core/session';

const exportEdited = vi.fn();
const ensureRawGrade = vi.fn();

// batch 会走 Skia 导出，node 环境里没有 Skia；把导出层、LUT 读取、RAW 解码整体替换掉，
// 只验证"哪些资产被送去导出、哪些被跳过、原因是什么"。
vi.mock('../src/services/exportImage', () => ({ exportEdited }));
vi.mock('../src/services/lutStore', () => ({ loadLutFromPath: async () => null }));
vi.mock('../src/services/rawGrade', () => ({ ensureRawGrade, gradeSourceUri: (asset: Asset) => asset.uri }));

const { RAW_DECODE_FAILED, batchExportAssets } = await import('../src/services/batch');

function makeAsset(id: string, fileName: string, raw = false): Asset {
  return {
    id,
    fileName,
    uri: `file:///photos/${fileName}`,
    bytes: 1024,
    width: 6000,
    height: 4000,
    capturedAt: 1_760_000_000_000,
    source: 'camera',
    raw,
  };
}

function makeSession(): EditorSession {
  return { params: DEFAULT_PARAMS, curves: IDENTITY_CURVE_SET, status: 'imported', updatedAt: 0 } as EditorSession;
}

describe('batch export', () => {
  beforeEach(() => {
    exportEdited.mockReset();
    exportEdited.mockResolvedValue(undefined);
    ensureRawGrade.mockReset();
    ensureRawGrade.mockResolvedValue({ gradeUri: 'file:///raw/a2.png', width: 6000, height: 4000, ms: 10 });
  });

  it('RAW 先解码再导出，和 JPEG 一起进同一批', async () => {
    const jpeg = makeAsset('a1', 'DSC00769.JPG');
    const raw = makeAsset('a2', 'DSC00769.ARW', true);
    const progress: string[] = [];

    const result = await batchExportAssets({
      assets: [jpeg, raw],
      getSession: () => makeSession(),
      longEdge: 2048,
      quality: 92,
      toGallery: false,
      onProgress: (done, total, fileName) => progress.push(`${done}/${total} ${fileName}`),
    });

    expect(ensureRawGrade).toHaveBeenCalledTimes(1);
    expect(ensureRawGrade.mock.calls[0][0].id).toBe('a2');
    expect(exportEdited).toHaveBeenCalledTimes(2);
    expect(result.exported).toBe(2);
    expect(result.failed).toEqual([]);
    expect(progress).toEqual(['1/2 DSC00769.JPG', '2/2 DSC00769.ARW']);
  });

  it('RAW 解码失败只跳过那一张，JPEG 照常导出', async () => {
    ensureRawGrade.mockResolvedValueOnce(null);
    const result = await batchExportAssets({
      assets: [makeAsset('a1', 'a.jpg'), makeAsset('a2', 'a.ARW', true)],
      getSession: () => makeSession(),
      longEdge: 2048,
      quality: 92,
      toGallery: false,
    });

    expect(exportEdited).toHaveBeenCalledTimes(1);
    expect(result.exported).toBe(1);
    expect(result.failed).toEqual([{ assetId: 'a2', fileName: 'a.ARW', error: RAW_DECODE_FAILED }]);
  });

  it('JPEG 导出抛错时只影响它自己', async () => {
    exportEdited.mockRejectedValueOnce(new Error('decode returned null'));
    const result = await batchExportAssets({
      assets: [makeAsset('a1', 'a.jpg'), makeAsset('a3', 'b.jpg')],
      getSession: () => makeSession(),
      longEdge: 2048,
      quality: 92,
      toGallery: true,
    });

    expect(result.exported).toBe(1);
    expect(result.succeeded).toEqual(['a3']);
    expect(result.failed[0].error).toBe('decode returned null');
  });
});
