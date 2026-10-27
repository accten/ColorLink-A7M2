import { base64ToBytes } from '@/core/base64';
import { ingestFileName } from '@/core/asset';
import { eventLog } from '@/core/log';
import { DemoFrame } from '@/features/demo/frames';
import { sha256OfFile } from '@/services/ingest';
import { ingestFile } from '@/services/paths';

/**
 * 把演示素材"当作相机回传"落进 ingest/ 并算摘要。
 *
 * 数据来源是内联 base64（见 features/demo/frames.ts 的说明）：
 * release 包里 expo-asset 给不出可读文件路径，直接写字节最稳。
 *
 * 每一步都编号记日志——真机排查时，看事件日志就知道断在解码、写盘还是摘要。
 */

export interface MaterializedAsset {
  uri: string;
  fileName: string;
  bytes: number;
  width: number;
  height: number;
  hash: string;
  capturedAt: number;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

async function persistFrame(frame: DemoFrame, fileName: string, reuseIfExists: boolean): Promise<MaterializedAsset> {
  const started = Date.now();
  const target = ingestFile(fileName);

  // 已存在则复用，避免每次启动都重写
  if (reuseIfExists && target.exists) {
    const existingSize = target.size ?? 0;
    if (existingSize > 0) {
      return {
        uri: target.uri,
        fileName,
        bytes: existingSize,
        width: frame.width,
        height: frame.height,
        hash: await sha256OfFile(target),
        capturedAt: Date.now(),
      };
    }
  }

  let data: Uint8Array;
  try {
    data = base64ToBytes(frame.base64);
  } catch (error) {
    throw new Error(`[1/4] 解码内联素材失败（${frame.key}）：${describeError(error)}`);
  }
  if (!data.length) throw new Error(`[1/4] 内联素材为空（${frame.key}）`);

  try {
    if (target.exists) target.delete();
    await target.write(data);
  } catch (error) {
    throw new Error(`[2/4] 写入 ingest 失败（${fileName}）：${describeError(error)}`);
  }

  const written = target.size ?? 0;
  if (written !== data.length) {
    eventLog.warn('ingest.size.mismatch', { fileName, expected: data.length, actual: written });
  }

  const hash = await sha256OfFile(target);
  if (!hash) eventLog.warn('ingest.hash.missing', { fileName });

  eventLog.info('ingest.materialized', {
    frame: frame.key,
    fileName,
    bytes: data.length,
    ms: Date.now() - started,
  });

  return {
    uri: target.uri,
    fileName,
    bytes: data.length,
    width: frame.width,
    height: frame.height,
    hash,
    capturedAt: Date.now(),
  };
}

/** 一拍一传用：时间戳命名，每次都是一张新照片。 */
export function materializeDemoFrame(frame: DemoFrame, seq: number): Promise<MaterializedAsset> {
  return persistFrame(frame, ingestFileName(new Date(), seq, 'png'), false);
}

/** 首次启动种图库用：文件名稳定（demo_<key>.png），已存在就复用。 */
export function seedDemoFrame(frame: DemoFrame): Promise<MaterializedAsset> {
  return persistFrame(frame, `demo_${frame.key}.png`, true);
}
