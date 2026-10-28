import { NativeModule, requireOptionalNativeModule } from 'expo';

import type {
  SonyCameraModuleEvents,
  SonyConnectOptions,
  SonyDiagnosticsSnapshot,
  SonyFocusResult,
  SonyExposureSnapshot,
  SonyCameraState,
  SonyPhoto,
} from './SonyCamera.types';

declare class SonyCameraNativeModule extends NativeModule<SonyCameraModuleEvents> {
  getState(): SonyCameraState;
  connect(options?: SonyConnectOptions): Promise<SonyCameraState>;
  disconnect(): Promise<SonyCameraState>;
  startLiveView(): Promise<SonyCameraState>;
  stopLiveView(): Promise<SonyCameraState>;
  capturePhoto(): Promise<SonyPhoto>;
  /**
   * Persists the most recent live-view frame without triggering the shutter.
   *
   * This is a preview-resolution still, not a full capture, and it rejects when no frame
   * has arrived yet. It does not emit `onPhotoCaptured`.
   */
  capturePreviewFrame(): Promise<SonyPhoto>;

  /**
   * 监视器上那排只读参数（快门 / 光圈 / ISO / EV / 白平衡 / 电量）。
   *
   * 一次 `0x9209` 属性数组读取后解码；解不出来的项直接缺失，未联机时返回空对象。
   * 轮询它不会打断取景：真正的互斥在原生 transport 的 ioLock 上。
   */
  readExposure(): Promise<SonyExposureSnapshot>;

  /** 诊断：直接发一条 Sony 厂商操作（逆向取图协议用），返回码 + 原始字节 hex */
  probeVendorOp?(operation: number, params?: number[], dataHex?: string): Promise<Record<string, unknown>>;
  /** Android only, and only when the active ScalarWebAPI camera advertises coordinate focus. */
  focusAt?(x: number, y: number, viewWidth: number, viewHeight: number): Promise<SonyFocusResult>;
  getDiagnostics(): SonyDiagnosticsSnapshot;
  clearDiagnostics(): void;
}

export default requireOptionalNativeModule<SonyCameraNativeModule>('SonyCamera');
