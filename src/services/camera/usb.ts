import { CameraError, CameraSnapshot, CapturedPhoto, ICameraTransport, IDLE_SNAPSHOT } from './types';
import { SonyCameraTransport, sonyModuleAvailable } from './sony';

/**
 * USB 真机传输的入口。
 *
 * - 装了 `expo-sony-camera`（原生模块）时 → SonyCameraTransport，走真实 PTP2
 * - 否则 → MissingNativeTransport：明确失败并告诉用户要做什么，而不是假装连上
 *
 * 这一层是唯一需要知道"底层用哪个库"的地方，上层（store / 页面）只认 ICameraTransport。
 */

const NOT_LINKED: CameraError = {
  code: 'E_NATIVE_NOT_LINKED',
  message: '原生相机模块未接入',
  hints: [
    '当前构建没有链接 expo-sony-camera，USB 联机不可用',
    '先用演示模式走通全流程；真机联机见 docs/sony-transport.md',
  ],
};

export class MissingNativeTransport implements ICameraTransport {
  readonly mode = 'usb' as const;

  private snap: CameraSnapshot = { ...IDLE_SNAPSHOT, mode: 'usb' };

  snapshot(): CameraSnapshot {
    return this.snap;
  }

  subscribe(listener: (s: CameraSnapshot) => void): () => void {
    listener(this.snap);
    return () => {};
  }

  onPhoto(_listener: (p: CapturedPhoto) => void): () => void {
    return () => {};
  }

  liveFrames(): number[] {
    return [];
  }

  async connect(): Promise<CameraSnapshot> {
    this.snap = { phase: 'error', mode: 'usb', error: NOT_LINKED };
    return this.snap;
  }

  async disconnect(): Promise<void> {
    this.snap = { ...IDLE_SNAPSHOT, mode: 'usb' };
  }

  async startLiveView(): Promise<void> {
    throw new Error(NOT_LINKED.message);
  }

  async stopLiveView(): Promise<void> {}

  async capture(): Promise<{ ok: boolean; error?: CameraError }> {
    return { ok: false, error: NOT_LINKED };
  }
}

export function createUsbTransport(): ICameraTransport {
  return sonyModuleAvailable() ? new SonyCameraTransport() : new MissingNativeTransport();
}

/** 供 UI 判断"真机联机是否可用"，决定是否把 USB 按钮置灰。 */
export function isUsbTransportAvailable(): boolean {
  return sonyModuleAvailable();
}
