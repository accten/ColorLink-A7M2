import { CameraError, CameraSnapshot, CapturedPhoto, ICameraTransport, IDLE_SNAPSHOT } from './types';

/**
 * USB 真机传输的占位实现。
 *
 * 现状（M0 之前）：仓库还没有接入 `expo-sony-camera` 的原生层，所以这里
 * 返回一个"明确失败"的 transport —— 它会把原因、以及要改哪一行，直接显示给用户，
 * 而不是假装连接成功。
 *
 * 接入方式（M0 通过后）：
 *   1. npm i expo-sony-camera@0.2.1（或 vendor 到 packages/sony-camera 后 file: 引用）
 *   2. 把下面 createUsbTransport 的实现换成 SonyCameraTransport（见 docs/sony-transport.md）
 *   3. 上面的 UI / store / ingest 链路【零改动】—— 这正是抽 ICameraTransport 的目的
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
  return new MissingNativeTransport();
}

/** 供 UI 判断"真机联机是否可用"，决定是否把 USB 按钮置灰。 */
export function isUsbTransportAvailable(): boolean {
  return false;
}
