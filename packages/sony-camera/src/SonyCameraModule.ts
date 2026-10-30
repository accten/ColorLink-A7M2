import { NativeModule, requireOptionalNativeModule } from 'expo';

import type {
  SonyCameraModuleEvents,
  SonyConnectOptions,
  SonyDiagnosticsSnapshot,
  SonyFocusResult,
  SonyExposureSnapshot,
  SonyCameraState,
  SonyPhoto,
  SonyRawDecodeResult,
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

  /**
   * 照片保存位置：写相机 `0xD222`。
   *
   * 合法值只有 1 / 17 / 16（相机自己的枚举），含义按机型略有差异，见 `core/captureTarget`。
   * 已联机时立刻生效，未联机时只记住值、下次联机时应用。
   */
  setCaptureTarget?(value: number): Promise<SonyCameraState>;

  /**
   * 画质：写相机 0xD253（1 = RAW，2 = RAW+JPEG，3 = JPEG）。
   *
   * 返回 supported 表示机身是否接受；老机身（ILCE-7M2）没有这条属性，
   * 会返回 false，这时应提示用户去相机菜单里改。
   */
  setCaptureFormat?(value: number): Promise<{ supported?: boolean; value?: number }>;
  /** Android only, and only when the active ScalarWebAPI camera advertises coordinate focus. */
  focusAt?(x: number, y: number, viewWidth: number, viewHeight: number): Promise<SonyFocusResult>;

  /**
   * RAW(ARW) 解码：LibRaw 把原图解成 8bit sRGB 全幅 PNG，并缩出 1600px 预览与 480px 缩略图。
   *
   * 不需要相机连接 —— 已经传回本机的 ARW 随时可以解。24MP 大约 3~6 秒，
   * 调用方应缓存结果，只解一次。
   */
  decodeRaw?(rawPath: string, outDir: string, baseName: string): Promise<SonyRawDecodeResult>;

  getDiagnostics(): SonyDiagnosticsSnapshot;
  clearDiagnostics(): void;
}

export default requireOptionalNativeModule<SonyCameraNativeModule>('SonyCamera');
