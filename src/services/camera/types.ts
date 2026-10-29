/** 相机传输层契约：R1(expo-sony-camera) / 演示 / 未来的 gphoto2 都实现它。 */

export type CameraMode = 'demo' | 'usb';

export type CameraPhase = 'idle' | 'connecting' | 'ready' | 'live' | 'error';

export type CameraErrorCode =
  | 'E_NO_PERMISSION'
  | 'E_NO_PTP_INTERFACE'
  | 'E_HANDSHAKE'
  | 'E_LIVEVIEW_NOT_READY'
  | 'E_CAPTURE_TIMEOUT'
  | 'E_STILL_TRANSFER_UNSUPPORTED'
  | 'E_TRANSFER_TRUNCATED'
  | 'E_BUSY_OTHER_APP'
  | 'E_NATIVE_NOT_LINKED'
  | 'E_UNKNOWN';

export interface CameraError {
  code: CameraErrorCode;
  message: string;
  hints: string[];
}

export interface CameraInfo {
  model: string;
  firmware: string;
  mode: CameraMode;
  serial?: string;
}

export interface CameraCaps {
  liveView: boolean;
  stillCapture: boolean;
  imageTransfer: boolean;
  deviceProps: boolean;
}

export interface CameraSnapshot {
  phase: CameraPhase;
  mode: CameraMode;
  info?: CameraInfo;
  caps?: CameraCaps;
  error?: CameraError;
  fps?: number;
  frameSize?: { width: number; height: number };
  battery?: number | null;
  mediaRemaining?: number | null;
  /**
   * 只读曝光参数（监看页展示用）。
   *
   * A7M2 的属性只能从 `0x9209` 的属性数组里读（它不支持标准的 0x1014），
   * 取不到就留空，UI 显示 '—'。
   */
  exposure?: {
    shutter?: string;
    aperture?: string;
    iso?: string;
    ev?: string;
    wb?: string;
  };
}

export interface CapturedPhoto {
  uri: string;
  fileName: string;
  bytes: number;
  width: number;
  height: number;
  capturedAt: number;
  /** 原图摘要，用于一拍一传的去重（同一张不会入库两次） */
  hash: string;
}

export interface ICameraTransport {
  readonly mode: CameraMode;
  connect(): Promise<CameraSnapshot>;
  disconnect(): Promise<void>;
  startLiveView(): Promise<void>;
  stopLiveView(): Promise<void>;
  capture(): Promise<{ ok: boolean; error?: CameraError }>;
  /**
   * 刷新只读曝光参数。
   *
   * 可选：只有真机传输实现得了（演示模式、未来的 Wi-Fi 传输可以不做）。
   * 实现方必须保证失败时安静返回，绝不因此打断取景。
   */
  refreshExposure?(): Promise<void>;
  /**
   * 照片保存位置（相机端 `0xD222`）。
   *
   * 可选：只有真机传输实现得了。值见 `core/captureTarget`；
   * 实现方要保证"未联机时只记住值、联机后应用"。
   */
  setCaptureTarget?(value: number): Promise<void>;
  /** 画质（相机端 0xD253）：1 = RAW，2 = RAW+JPEG，3 = JPEG；返回机身是否接受 */
  setCaptureFormat?(value: number): Promise<boolean>;
  snapshot(): CameraSnapshot;
  subscribe(listener: (snapshot: CameraSnapshot) => void): () => void;
  onPhoto(listener: (photo: CapturedPhoto) => void): () => void;
  /** 演示模式用来告诉 UI 该渲染哪几帧；真机返回空数组 */
  liveFrames(): number[];
}

export const IDLE_SNAPSHOT: CameraSnapshot = {
  phase: 'idle',
  mode: 'demo',
  battery: null,
  mediaRemaining: null,
};

export function errorMessage(error: CameraError): string {
  return `${error.message}${error.hints[0] ? `\n建议：${error.hints[0]}` : ''}`;
}
