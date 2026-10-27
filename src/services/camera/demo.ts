import { Asset as ExpoAsset } from 'expo-asset';
import { File } from 'expo-file-system';

import { ingestFileName } from '@/core/asset';
import { eventLog } from '@/core/log';
import { DEMO_FRAMES, DemoFrame } from '@/features/demo/frames';
import { sha256OfFile } from '@/services/ingest';
import { ingestFile } from '@/services/paths';

import { CameraError, CameraSnapshot, CapturedPhoto, ICameraTransport, IDLE_SNAPSHOT } from './types';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let seq = 0;
function nextSeq(): number {
  seq = (seq % 999) + 1;
  return seq;
}

/**
 * 演示相机：把 demo 素材当作"相机回传的 JPEG"走完整 ingest 链路。
 *
 * 为什么值得认真做：M0 还没在真机上跑通时，这就是唯一能验证
 * "一拍一传 → 去重 → 缩略图 → 调色 → 导出"的方法；而且它走的是同一套
 * DemoCameraTransport / ICameraTransport 接口，接真机时上层不用改。
 */
export class DemoCameraTransport implements ICameraTransport {
  readonly mode = 'demo' as const;

  private snap: CameraSnapshot = { ...IDLE_SNAPSHOT, mode: 'demo' };
  private readonly stateListeners = new Set<(s: CameraSnapshot) => void>();
  private readonly photoListeners = new Set<(p: CapturedPhoto) => void>();
  private captureCursor = 0;

  snapshot(): CameraSnapshot {
    return this.snap;
  }

  subscribe(listener: (s: CameraSnapshot) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.snap);
    return () => this.stateListeners.delete(listener);
  }

  onPhoto(listener: (p: CapturedPhoto) => void): () => void {
    this.photoListeners.add(listener);
    return () => this.photoListeners.delete(listener);
  }

  liveFrames(): number[] {
    return DEMO_FRAMES.map((f) => f.module);
  }

  private update(patch: Partial<CameraSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const listener of this.stateListeners) listener(this.snap);
  }

  async connect(): Promise<CameraSnapshot> {
    this.update({ phase: 'connecting', error: undefined });
    await delay(460);
    this.update({
      phase: 'ready',
      info: { model: 'ILCE-7M2', firmware: 'demo 3.10', mode: 'demo' },
      caps: { liveView: true, stillCapture: true, imageTransfer: true, deviceProps: true },
      battery: 78,
      mediaRemaining: 214,
      error: undefined,
    });
    eventLog.info('camera.connect', { mode: 'demo' });
    return this.snap;
  }

  async disconnect(): Promise<void> {
    this.update({ ...IDLE_SNAPSHOT, mode: 'demo' });
    eventLog.info('camera.disconnect', { mode: 'demo' });
  }

  async startLiveView(): Promise<void> {
    if (this.snap.phase !== 'ready' && this.snap.phase !== 'live') {
      throw Object.assign(new Error('相机未连接'), { code: 'E_HANDSHAKE' });
    }
    this.update({ phase: 'live', fps: 14, frameSize: { width: 1200, height: 800 } });
    eventLog.info('liveview.start', { mode: 'demo' });
  }

  async stopLiveView(): Promise<void> {
    this.update({ phase: 'ready', fps: undefined });
    eventLog.info('liveview.stop', { mode: 'demo' });
  }

  async capture(): Promise<{ ok: boolean; error?: CameraError }> {
    if (this.snap.phase !== 'ready' && this.snap.phase !== 'live') {
      return {
        ok: false,
        error: { code: 'E_HANDSHAKE', message: '相机未连接', hints: ['先点"连接相机"'] },
      };
    }
    const frame = DEMO_FRAMES[this.captureCursor % DEMO_FRAMES.length];
    this.captureCursor += 1;
    try {
      const photo = await materialize(frame);
      for (const listener of this.photoListeners) listener(photo);
      eventLog.info('camera.capture', { fileName: photo.fileName, bytes: photo.bytes });
      return { ok: true };
    } catch (error) {
      eventLog.error('camera.capture.failed', { error: String(error) });
      return {
        ok: false,
        error: {
          code: 'E_UNKNOWN',
          message: '演示素材写入失败',
          hints: ['检查 App 存储空间', '重启应用后重试'],
        },
      };
    }
  }
}

/** 把 bundle 里的素材"当作"相机回传：复制进 ingest/ 并算摘要。 */
async function materialize(frame: DemoFrame): Promise<CapturedPhoto> {
  const bundled = ExpoAsset.fromModule(frame.module);
  await bundled.downloadAsync();
  const source = new File(bundled.localUri ?? bundled.uri);

  const fileName = ingestFileName(new Date(), nextSeq(), 'png');
  const target = ingestFile(fileName);
  if (target.exists) target.delete();
  await source.copy(target);

  const hash = await sha256OfFile(target);
  return {
    uri: target.uri,
    fileName,
    bytes: target.size ?? 0,
    width: frame.width,
    height: frame.height,
    capturedAt: Date.now(),
    hash,
  };
}
