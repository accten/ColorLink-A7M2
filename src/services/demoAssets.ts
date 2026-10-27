import { Asset as ExpoAsset } from 'expo-asset';
import { File } from 'expo-file-system';

import { ingestFileName } from '@/core/asset';
import { eventLog } from '@/core/log';
import { DemoFrame } from '@/features/demo/frames';
import { sha256OfFile } from '@/services/ingest';
import { ingestFile } from '@/services/paths';

/**
 * 把打包进 APK 的演示素材"当作相机回传"，落进 ingest/ 并算摘要。
 *
 * 之前这段逻辑在 camera/demo.ts 与 library.ts 各写了一遍，两处都要处理
 * expo-asset → File 的边界，出问题时又都只留一句 "seed.failed"，真机上根本没法定位。
 * 现在合成一份，并且**每一步都编号记日志**：取不到本地路径 / 读不到字节 / 写盘失败 / 摘要失败，
 * 一眼就能看出断在哪。
 *
 * 另一个改动：不用 `File.copy()`（它假设源是普通文件路径），改成显式 bytes() → write()，
 * 对 APK 内嵌资源更稳。
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

  // 已存在且可信：直接复用，避免每次启动都重写 6MB
  if (reuseIfExists && target.exists) {
    const existingSize = target.size ?? 0;
    if (existingSize > 0) {
      const hash = await sha256OfFile(target);
      return {
        uri: target.uri,
        fileName,
        bytes: existingSize,
        width: frame.width,
        height: frame.height,
        hash,
        capturedAt: Date.now(),
      };
    }
  }

  let asset: ExpoAsset;
  try {
    asset = ExpoAsset.fromModule(frame.module);
  } catch (error) {
    throw new Error(`[1/5] Asset.fromModule 失败：${describeError(error)}`);
  }

  try {
    await asset.downloadAsync();
  } catch (error) {
    throw new Error(`[2/5] asset.downloadAsync 失败：${describeError(error)}`);
  }

  const localUri = asset.localUri ?? asset.uri;
  if (!localUri) throw new Error(`[3/5] 资源没有本地路径（${frame.key}）`);

  let data: Uint8Array;
  try {
    const source = new File(localUri);
    if (!source.exists) throw new Error(`文件不存在：${localUri}`);
    data = await source.bytes();
  } catch (error) {
    throw new Error(`[3/5] 读取资源失败（${localUri}）：${describeError(error)}`);
  }
  if (!data || data.length === 0) throw new Error(`[3/5] 资源字节为空（${localUri}）`);

  try {
    if (target.exists) target.delete();
    await target.write(data);
  } catch (error) {
    throw new Error(`[4/5] 写入 ingest 失败（${fileName}）：${describeError(error)}`);
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
