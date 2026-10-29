import { File } from 'expo-file-system';
import SonyCamera, {
  type SonyCameraState,
  type SonyCameraStateName,
  type SonyExposureSnapshot,
  type SonyPhoto,
} from 'expo-sony-camera';

import { ingestFileName } from '@/core/asset';
import { eventLog } from '@/core/log';
import { sha256OfFile } from '@/services/ingest';
import { ingestFile } from '@/services/paths';

import { connectSucceeded, isConnectedPhase, shouldWaitForState } from './connect-rules';
import { CameraError, CameraSnapshot, CapturedPhoto, ICameraTransport, IDLE_SNAPSHOT } from './types';

/** 握手超时：PTP2 开会话 + 读设备属性，慢的时候几秒；超过这个时间就认为连不上 */
const CONNECT_TIMEOUT_MS = 15000;

/** 同一张照片的双重通知（原生事件 + 调用返回值）在这个窗口内只入库一次 */
const PHOTO_DEDUPE_WINDOW_MS = 15000;

/**
 * 模块原生的状态负载。
 *
 * `liveViewSupported` 是这一版原生代码新加的字段：较早的机身（实测 ILCE-7M2）
 * PTP2 方言里没有 Sony 的取景属性，但我们补了「会话照常保留，只关掉取景」的处理，
 * 于是需要在 JS 侧知道"取景不可用但相机是连着的"。
 */
type SonyStatePayload = SonyCameraState & {
  liveViewSupported?: boolean;
  fps?: number;
  exposure?: SonyExposureSnapshot;
};

/**
 * 真机 USB 联机（PTP2），基于 expo-sony-camera 原生模块。
 *
 * 模块职责边界：
 *  - 原生模块负责 PTP 会话、取景帧、快门、相机侧照片回传（它自己处理 USB 权限）
 *  - 这一层只做三件事：把模块状态翻译成我们的 CameraSnapshot、把照片落进 ingest/、
 *    把错误整理成可读文案
 *
 * 取景帧不进 JS：`SonyCameraView` 直接在原生层显示，JS 只收状态事件。
 */

let seq = 0;
const nextSeq = () => (seq = (seq % 999) + 1);

const PHASE_BY_STATE: Record<SonyCameraStateName, CameraSnapshot['phase']> = {
  unsupported: 'error',
  disconnected: 'idle',
  discovering: 'connecting',
  candidate_found: 'connecting',
  permission_required: 'connecting',
  joining_network: 'connecting',
  connecting: 'connecting',
  authenticating: 'connecting',
  ready: 'ready',
  streaming: 'live',
  capturing: 'live',
  recording: 'live',
  transferring: 'live',
  reconnecting: 'connecting',
  error: 'error',
};

function describeError(state: SonyCameraState): CameraError {
  const hints = [
    '确认相机 USB 连接模式为「PC 遥控」',
    '使用支持数据传输的 OTG 线与转接头',
    'A7M2 固件需为最新版本',
  ];
  const diagnostics = state.diagnostics?.filter(Boolean) ?? [];
  return {
    code: state.state === 'unsupported' ? 'E_NATIVE_NOT_LINKED' : 'E_HANDSHAKE',
    message: state.message ?? '相机连接失败',
    hints: diagnostics.length ? [...diagnostics.slice(-2), ...hints.slice(0, 1)] : hints,
  };
}

export class SonyCameraTransport implements ICameraTransport {
  readonly mode = 'usb' as const;

  private snap: CameraSnapshot = { ...IDLE_SNAPSHOT, mode: 'usb' };
  private readonly stateListeners = new Set<(s: CameraSnapshot) => void>();
  private readonly photoListeners = new Set<(p: CapturedPhoto) => void>();
  private readonly disposers: (() => void)[] = [];

  /** 上一次记进事件日志的状态：帧率每秒推一次，不能跟着它刷日志 */
  private lastLoggedState?: string;
  private lastLoggedMessage?: string;
  private lastLoggedModel?: string;

  /** 原生缓存 URI → 最近一次入库时间，用于把"同一次快门的两条通知"合并成一条 */
  private readonly recentPhotoUris = new Map<string, number>();

  constructor() {
    const native = SonyCamera;
    if (!native) return;

    const bind = <T,>(event: 'onStateChanged' | 'onDeviceAttached' | 'onPhotoCaptured', handler: (payload: T) => void) => {
      try {
        const subscription = native.addListener(event, handler as never);
        this.disposers.push(() => subscription?.remove?.());
      } catch (error) {
        eventLog.warn('camera.listener.failed', { event, error: String(error) });
      }
    };

    bind<SonyCameraState>('onStateChanged', (state) => this.applyState(state as SonyStatePayload));
    bind<SonyCameraState>('onDeviceAttached', (state) => this.applyState(state as SonyStatePayload));
    bind<SonyPhoto>('onPhotoCaptured', (photo) => {
      void this.handlePhoto(photo).catch((error) =>
        eventLog.error('camera.photo.failed', { error: String(error) }),
      );
    });

    try {
      this.applyState(native.getState());
    } catch (error) {
      eventLog.warn('camera.state.failed', { error: String(error) });
    }
  }

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
    return [];
  }

  private requireModule() {
    if (!SonyCamera) throw new Error('原生相机模块未加载（需要 development build）');
    return SonyCamera;
  }

  private applyState(state: SonyStatePayload): void {
    const phase = PHASE_BY_STATE[state.state] ?? 'connecting';
    const features = (state.device?.capabilities?.features ?? {}) as Record<string, unknown>;

    this.snap = {
      ...this.snap,
      phase,
      info: state.device
        ? {
            model: state.device.model,
            firmware: state.device.firmware ?? state.device.productName ?? '—',
            mode: 'usb',
          }
        : this.snap.info,
      caps: state.device
        ? {
            // 取景能力以「原生实测」为准：DeviceInfo 里没有 D221 的机身（实测 ILCE-7M2）仍能用
            // GetObject(0xFFFFC002) 拿到 10fps 的取景帧；liveViewSupported 只在取景真失败时才是 false。
            liveView: state.liveViewSupported !== false,
            stillCapture: Boolean(features.stillCapture ?? true),
            imageTransfer: Boolean(features.imageTransfer ?? true),
            deviceProps: Boolean(features.properties ?? false),
          }
        : this.snap.caps,
      // 原生每秒推一次真实帧率（取景在原生层，JS 看不到帧本身）
      fps: typeof state.fps === 'number' ? Math.round(state.fps * 10) / 10 : this.snap.fps,
      // 只读参数：取景时由原生的帧线程顺手读，非取景时由 refreshExposure() 轮询
      exposure: state.exposure
        ? {
            shutter: state.exposure.shutterSpeed,
            aperture: state.exposure.aperture,
            iso: state.exposure.iso,
            ev: state.exposure.exposureCompensation,
            wb: state.exposure.whiteBalance,
          }
        : this.snap.exposure,
      battery:
        typeof state.exposure?.batteryPercent === 'number'
          ? state.exposure.batteryPercent
          : this.snap.battery,
      error: phase === 'error' ? describeError(state) : undefined,
    };

    // 帧率每秒都会推一次状态，别让它把事件日志刷满：只有"看得见的"变化才记
    const changed =
      state.state !== this.lastLoggedState ||
      state.message !== this.lastLoggedMessage ||
      state.device?.model !== this.lastLoggedModel;
    if (changed) {
      this.lastLoggedState = state.state;
      this.lastLoggedMessage = state.message;
      this.lastLoggedModel = state.device?.model;
      eventLog.info('camera.state', {
        state: state.state,
        phase,
        model: state.device?.model,
        message: state.message,
      });
    }

    for (const listener of this.stateListeners) listener(this.snap);
  }

  async connect(): Promise<CameraSnapshot> {
    const native = this.requireModule();
    eventLog.info('camera.connect', { mode: 'usb' });
    const state = await native.connect({
      preferredTransport: 'usb',
      preferredProtocol: 'sony_camera_control_ptp2',
    });
    this.applyState(state);

    // 模块在「没有相机接入」时也会正常返回 disconnected，必须自己判定失败，
    // 否则界面会显示已连接、取景全黑（真机踩到过）。
    if (!connectSucceeded(state.state) && shouldWaitForState(state.state)) {
      await this.waitForSettled(CONNECT_TIMEOUT_MS);
    }

    if (!isConnectedPhase(this.snap.phase)) {
      const failure = this.snap.error ?? describeError(state);
      this.snap = { ...this.snap, phase: 'error', error: failure };
      for (const listener of this.stateListeners) listener(this.snap);
      eventLog.error('camera.connect.failed', { state: state.state, message: failure.message });
      throw new Error(failure.message);
    }

    return this.snap;
  }

  /** 等状态事件把连接推进到终态（或超时）。 */
  private waitForSettled(timeoutMs: number): Promise<void> {
    const settled = (phase: CameraSnapshot['phase']) =>
      phase === 'ready' || phase === 'live' || phase === 'error' || phase === 'idle';
    if (settled(this.snap.phase)) return Promise.resolve();

    return new Promise((resolve) => {
      let finished = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe: (() => void) | undefined;

      const finish = () => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        unsubscribe?.();
        resolve();
      };

      unsubscribe = this.subscribe((snapshot) => {
        if (settled(snapshot.phase)) finish();
      });
      timer = setTimeout(finish, timeoutMs);
      if (settled(this.snap.phase)) finish();
    });
  }

  async disconnect(): Promise<void> {
    const native = SonyCamera;
    if (native) {
      try {
        this.applyState(await native.disconnect());
      } catch (error) {
        eventLog.warn('camera.disconnect.failed', { error: String(error) });
      }
    }
    this.snap = { ...IDLE_SNAPSHOT, mode: 'usb' };
    for (const dispose of this.disposers.splice(0)) dispose();
    for (const listener of this.stateListeners) listener(this.snap);
  }

  /**
   * 刷新监看页那排只读参数。
   *
   * 全部来自原生一次 `0x9209`：这台机身不支持标准的 0x1014，逐条读会把 USB 链路打死。
   * 失败必须安静：监看中每秒都在调，任何一次失败都不该影响取景或快门。
   */
  async refreshExposure(): Promise<void> {
    const native = SonyCamera;
    if (!native?.readExposure) return;
    if (!isConnectedPhase(this.snap.phase)) return;
    try {
      const raw = await native.readExposure();
      const exposure = {
        shutter: raw.shutterSpeed,
        aperture: raw.aperture,
        iso: raw.iso,
        ev: raw.exposureCompensation,
        wb: raw.whiteBalance,
      };
      const battery = typeof raw.batteryPercent === 'number' ? raw.batteryPercent : this.snap.battery ?? null;
      const changed =
        exposure.shutter !== this.snap.exposure?.shutter ||
        exposure.aperture !== this.snap.exposure?.aperture ||
        exposure.iso !== this.snap.exposure?.iso ||
        exposure.ev !== this.snap.exposure?.ev ||
        exposure.wb !== this.snap.exposure?.wb ||
        battery !== this.snap.battery;
      if (!changed) return;
      this.snap = { ...this.snap, exposure, battery };
      for (const listener of this.stateListeners) listener(this.snap);
    } catch (error) {
      eventLog.warn('camera.exposure.failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  async startLiveView(): Promise<void> {
    const state = await this.requireModule().startLiveView();
    this.applyState(state);
  }

  async stopLiveView(): Promise<void> {
    const state = await this.requireModule().stopLiveView();
    this.applyState(state);
  }

  async capture(): Promise<{ ok: boolean; error?: CameraError }> {
    try {
      const photo = await this.requireModule().capturePhoto();
      this.applyState({ ...this.requireModule().getState() });
      await this.handlePhoto(photo);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      eventLog.error('camera.capture.failed', { error: message });

      // 机身不支持 PTP 回传：快门确实按下去了，照片在卡里。这不该报成"快门失败"。
      if (message.includes('CAPTURE_UNSUPPORTED')) {
        return {
          ok: false,
          error: {
            code: 'E_STILL_TRANSFER_UNSUPPORTED',
            message: '该机型不支持 USB 照片回传（快门已触发，照片在相机存储卡里）',
            hints: ['用读卡器或相机 Wi-Fi 把照片传到手机', '远程快门与联机状态仍然可用'],
          },
        };
      }

      // 机身回的是 RAW(ARW)：Transmission 没问题，是我们的调色管线还不吃 ARW。
      if (message.includes('RAW_CAPTURE')) {
        return {
          ok: false,
          error: {
            code: 'E_STILL_TRANSFER_UNSUPPORTED',
            message: '相机回传的是 RAW(ARW)，目前还只能处理 JPEG',
            hints: ['把相机画质改成 JPEG 或 RAW+JPEG 后重拍', 'RAW 文件仍在相机存储卡里'],
          },
        };
      }

      return {
        ok: false,
        error: {
          code: 'E_CAPTURE_TIMEOUT',
          message: `快门失败：${message}`,
          hints: ['确认相机在拍照模式且存储卡可写', '重新插拔后重试'],
        },
      };
    }
  }

  /** 模块给的可能是 file:// 或 content://，统一读字节后写进 ingest/（保证后续导出可读）。 */
  private async handlePhoto(photo: SonyPhoto): Promise<CapturedPhoto | null> {
    if (!photo?.uri) return null;
    // 同一张照片会走两条路到达这里：原生 `onPhotoCaptured` 事件，以及 capturePhoto() 的
    // 返回值。两边都入库会写两份文件、图库出现重复（真机实测：一次快门出现 _001/_002）。
    // 按原生缓存 URI 去重，窗口取 15 秒。
    const now = Date.now();
    const previous = this.recentPhotoUris.get(photo.uri);
    if (previous != null && now - previous < PHOTO_DEDUPE_WINDOW_MS) return null;
    this.recentPhotoUris.set(photo.uri, now);
    for (const [uri, at] of this.recentPhotoUris) {
      if (now - at > PHOTO_DEDUPE_WINDOW_MS) this.recentPhotoUris.delete(uri);
    }
    const fileName = ingestFileName(new Date(), nextSeq(), 'jpg');
    const target = ingestFile(fileName);

    try {
      const data = await new File(photo.uri).bytes();
      if (!data?.length) throw new Error('照片字节为空');
      if (target.exists) target.delete();
      await target.write(data);
      const hash = await sha256OfFile(target);
      const captured: CapturedPhoto = {
        uri: target.uri,
        fileName,
        bytes: data.length,
        width: photo.width,
        height: photo.height,
        capturedAt: Date.now(),
        hash,
      };
      eventLog.info('camera.photo.saved', { fileName, bytes: captured.bytes, width: photo.width, height: photo.height });
      for (const listener of this.photoListeners) listener(captured);
      return captured;
    } catch (error) {
      // 读取失败时退回模块给的原始 URI，至少让它进图库（导出时再报具体原因）
      const message = error instanceof Error ? error.message : String(error);
      eventLog.warn('camera.photo.copy.failed', { uri: photo.uri, error: message });
      const fallback: CapturedPhoto = {
        uri: photo.uri,
        fileName: photo.fileName || fileName,
        bytes: 0,
        width: photo.width,
        height: photo.height,
        capturedAt: Date.now(),
        hash: '',
      };
      for (const listener of this.photoListeners) listener(fallback);
      return fallback;
    }
  }
}

export function sonyModuleAvailable(): boolean {
  return SonyCamera != null;
}
