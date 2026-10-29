import * as Haptics from 'expo-haptics';
import { create } from 'zustand';

import { Asset, isDuplicateCapture } from '@/core/asset';
import { EditParams, DEFAULT_PARAMS, ParamKey, withParam } from '@/core/params';
import { BUILTIN_PRESETS, Preset } from '@/core/presets';
import { eventLog } from '@/core/log';
import { CameraMode, CameraSnapshot, CapturedPhoto, ICameraTransport, IDLE_SNAPSHOT } from '@/services/camera/types';
import { DemoCameraTransport } from '@/services/camera/demo';
import { backfillThumbnails, ensureThumbnail } from '@/services/thumbs';
import { createUsbTransport } from '@/services/camera/usb';
import { assetFromPhoto, deleteAssetFile, loadAssets, saveAssets, seedDemoAssets } from '@/services/library';
import {
  DEFAULT_SETTINGS,
  Settings,
  clearApiKey,
  loadApiKey,
  loadSettings,
  saveApiKey,
  saveSettings,
} from '@/services/settings';

export type NoticeTone = 'ok' | 'warn' | 'danger';

export interface Notice {
  id: number;
  tone: NoticeTone;
  text: string;
  action?: { label: string; run: () => void };
}

/**
 * 拍完预览的状态：只放渲染需要的最小字段。
 * 不放整条 Asset（虽然它是纯数据），是为了让组件不依赖资产列表还能活着 ——
 * 预览期间用户可能在相册里删照片，预览不该跟着黑屏。
 */
export interface CapturePreview {
  id: number;
  uri: string;
  thumbUri?: string;
  fileName: string;
  bytes: number;
  width: number;
  height: number;
  /** 展示时长（秒）；由设置决定，预览过程中不再变 */
  seconds: number;
}

export interface EditorSession {
  params: EditParams;
  presetId: string | null;
  lutPath: string | null;
  lutName: string | null;
}

interface AppState {
  ready: boolean;
  camera: CameraSnapshot;
  cameraBusy: boolean;
  capturing: boolean;
  assets: Asset[];
  libraryBusy: boolean;
  sessions: Record<string, EditorSession>;
  presets: Preset[];
  settings: Settings;
  apiKey: string | null;
  notice: Notice | null;
  lastCaptureAt: number | null;
  receivedCount: number;
  /** 刚回传的照片；非空时根布局上浮一层全屏预览 */
  capturePreview: CapturePreview | null;

  init: () => Promise<void>;
  connectCamera: (mode: CameraMode) => Promise<void>;
  disconnectCamera: () => Promise<void>;
  startLiveView: () => Promise<void>;
  stopLiveView: () => Promise<void>;
  /** 刷新监看页的只读曝光参数（内部节流；传输层或页面不做时是空操作） */
  refreshExposure: () => Promise<void>;
  capture: () => Promise<void>;
  refreshAssets: () => Promise<void>;
  deleteAsset: (id: string) => Promise<void>;
  session: (assetId: string) => EditorSession;
  patchParam: (assetId: string, key: keyof EditParams, value: number) => void;
  resetSession: (assetId: string) => void;
  applyPreset: (assetId: string, presetId: string) => void;
  setSessionParams: (assetId: string, params: EditParams) => void;
  setLut: (assetId: string, lut: { path: string; name: string } | null) => void;
  /** 撤销/重做用：整份会话快照回填 */
  restoreSession: (assetId: string, snapshot: EditorSession) => void;
  /** 只重置某一组参数（人像修图时最常用的粒度） */
  resetParams: (assetId: string, keys: readonly ParamKey[]) => void;
  markStatus: (assetId: string, status: Asset['status']) => void;
  notify: (tone: NoticeTone, text: string, action?: Notice['action']) => void;
  dismissNotice: () => void;
  dismissCapturePreview: () => void;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  saveKey: (key: string) => Promise<void>;
  removeKey: () => Promise<void>;
}

let transport: ICameraTransport | null = null;
let detachState: (() => void) | null = null;
let detachPhoto: (() => void) | null = null;
let noticeSeq = 0;
let previewSeq = 0;
/** 上次刷新曝光参数的时刻：监看页每帧都会问，太密对相机没意义 */
let lastExposureRefreshAt = 0;
const EXPOSURE_REFRESH_INTERVAL_MS = 1_500;

const defaultSession = (): EditorSession => ({
  params: { ...DEFAULT_PARAMS },
  presetId: 'original',
  lutPath: null,
  lutName: null,
});

export const useAppStore = create<AppState>((set, get) => {
  const haptic = (style: 'light' | 'success') => {
    if (!get().settings.haptics) return;
    try {
      if (style === 'success') void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      else void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {
      // 无振动马达的设备忽略
    }
  };

  const notify: AppState['notify'] = (tone, text, action) => {
    set({ notice: { id: ++noticeSeq, tone, text, action } });
  };

  const persist = (assets: Asset[]) => {
    void saveAssets(assets).catch((error) => eventLog.error('library.save.failed', { error: String(error) }));
  };

  /** 一拍一传的落库：摘要去重（仅真机）→ 插到最前 → 持久化 → 轻触觉反馈。 */
  const ingestPhoto = async (photo: CapturedPhoto) => {
    const state = get();
    const mode = transport?.mode ?? 'demo';
    if (isDuplicateCapture(mode, state.assets, photo.hash)) {
      eventLog.warn('ingest.duplicate', { fileName: photo.fileName });
      return;
    }
    const asset = assetFromPhoto(photo, mode === 'usb' ? 'camera' : 'demo', state.assets.length + 1);
    const next = [asset, ...state.assets];
    set({ assets: next, lastCaptureAt: Date.now(), receivedCount: state.receivedCount + 1 });
    persist(next);
    haptic('success');
    eventLog.info('ingest.ok', { fileName: asset.fileName, bytes: asset.bytes, mode });

    // 拍完自动预览：0 秒表示用户关掉了，就直接进相册
    const previewSeconds = state.settings.previewSeconds;
    if (previewSeconds > 0) {
      set({
        capturePreview: {
          id: ++previewSeq,
          uri: asset.uri,
          thumbUri: asset.thumbUri,
          fileName: asset.fileName,
          bytes: asset.bytes,
          width: asset.width,
          height: asset.height,
          seconds: previewSeconds,
        },
      });
      eventLog.info('preview.shown', { fileName: asset.fileName, seconds: previewSeconds });
    }

    // 缩略图在后台补：不阻塞入库，也不影响快门手感。
    // 预览开着的时候先等它放完 —— 缩略图要 Skia 整张解一次 24MP，
    // 和预览那张图抢解码只会让预览更晚出来。
    const thumbTask = () => {
      void ensureThumbnail(asset).then((thumbUri) => {
        if (!thumbUri) return;
        const current = get().assets;
        if (!current.some((item) => item.id === asset.id)) return;
        const withThumb = current.map((item) =>
          item.id === asset.id ? { ...item, thumbUri } : item,
        );
        set({ assets: withThumb });
        persist(withThumb);
      });
    };
    if (previewSeconds > 0) setTimeout(thumbTask, previewSeconds * 1000 + 200);
    else thumbTask();
  };

  const attach = async (mode: CameraMode) => {
    if (transport) {
      detachState?.();
      detachPhoto?.();
      try {
        await transport.disconnect();
      } catch {
        // 忽略断开失败
      }
      transport = null;
    }

    const next: ICameraTransport = mode === 'usb' ? createUsbTransport() : new DemoCameraTransport();
    transport = next;

    detachState = next.subscribe((snapshot) => {
      set({ camera: snapshot, cameraBusy: snapshot.phase === 'connecting' });
    });
    detachPhoto = next.onPhoto((photo) => {
      void ingestPhoto(photo);
    });

    set({ cameraBusy: true, camera: { ...IDLE_SNAPSHOT, mode } });
    try {
      const snapshot = await next.connect();
      set({ camera: snapshot, cameraBusy: false });
      eventLog.info('camera.ready', { mode, model: snapshot.info?.model ?? 'unknown' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      eventLog.error('camera.connect.failed', { mode, error: message });
      set({
        cameraBusy: false,
        camera: {
          phase: 'error',
          mode,
          error: {
            code: 'E_UNKNOWN',
            message: `连接失败：${message}`,
            hints: ['确认 USB 线支持数据传输', '相机 USB 模式设为 PC 遥控', '重新插拔后重试'],
          },
        },
      });
    }
  };

  return {
    ready: false,
    camera: { ...IDLE_SNAPSHOT },
    cameraBusy: false,
    capturing: false,
    assets: [],
    libraryBusy: false,
    sessions: {},
    presets: BUILTIN_PRESETS,
    settings: { ...DEFAULT_SETTINGS },
    apiKey: null,
    notice: null,
    lastCaptureAt: null,
    receivedCount: 0,
    capturePreview: null,

    init: async () => {
      try {
        const [settings, apiKey] = await Promise.all([loadSettings(), loadApiKey()]);
        set({ settings, apiKey });

        set({ libraryBusy: true });
        let assets = await loadAssets();
        if (!assets.length) {
          assets = await seedDemoAssets();
        }
        set({ assets, libraryBusy: false });
        eventLog.info('app.ready', { assets: assets.length, demo: settings.demoMode });

        // 冷启动补一批缩略图（只补前几张，别抢首屏时间）
        void backfillThumbnails(assets, 6).then((patched) => {
          if (patched === assets) return;
          set({ assets: patched });
          void saveAssets(patched).catch((error) =>
            eventLog.error('library.save.failed', { error: String(error) }),
          );
        });

        if (settings.demoMode) {
          await attach('demo');
        }
      } catch (error) {
        eventLog.error('app.init.failed', { error: String(error) });
        set({
          notice: {
            id: ++noticeSeq,
            tone: 'danger',
            text: `初始化失败：${error instanceof Error ? error.message : String(error)}`,
          },
        });
      } finally {
        set({ ready: true, libraryBusy: false });
      }
    },

    connectCamera: async (mode) => {
      await attach(mode);
      const cam = get().camera;
      if (cam.phase === 'ready' || cam.phase === 'live') {
        notify('ok', mode === 'demo' ? '演示相机已连接' : '相机已连接');
      } else if (cam.error) {
        notify('danger', cam.error.message);
      }
    },

    disconnectCamera: async () => {
      await transport?.disconnect();
      detachState?.();
      detachPhoto?.();
      transport = null;
      set({ camera: { ...IDLE_SNAPSHOT, mode: get().camera.mode } });
      eventLog.info('camera.disconnected');
    },

    startLiveView: async () => {
      try {
        await transport?.startLiveView();
        haptic('light');
      } catch (error) {
        notify('danger', `无法开始取景：${error instanceof Error ? error.message : String(error)}`);
      }
    },

    /**
     * 刷新监看页那排只读参数。
     *
     * 传输层自己保证失败安静，这里只做节流：太快没意义（相机属性没变），
     * 也无法确认它是否影响取景。
     */
    refreshExposure: async () => {
      const active = transport;
      if (!active?.refreshExposure) return;
      const now = Date.now();
      if (now - lastExposureRefreshAt < EXPOSURE_REFRESH_INTERVAL_MS) return;
      lastExposureRefreshAt = now;
      await active.refreshExposure();
    },

    stopLiveView: async () => {
      try {
        await transport?.stopLiveView();
      } catch {
        // 忽略
      }
    },

    capture: async () => {
      if (!transport) {
        notify('warn', '相机未连接');
        return;
      }
      set({ capturing: true });
      haptic('light');
      try {
        const result = await transport.capture();
        if (!result.ok && result.error) {
          notify('danger', result.error.message, {
            label: '排查',
            run: () => notify('warn', result.error!.hints.join('；')),
          });
        }
      } catch (error) {
        notify('danger', `快门失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        set({ capturing: false });
      }
    },

    refreshAssets: async () => {
      set({ libraryBusy: true });
      const assets = await loadAssets();
      set({ assets, libraryBusy: false });
    },

    deleteAsset: async (id) => {
      const state = get();
      const asset = state.assets.find((a) => a.id === id);
      if (!asset) return;
      await deleteAssetFile(asset);
      const next = state.assets.filter((a) => a.id !== id);
      const sessions = { ...state.sessions };
      delete sessions[id];
      set({ assets: next, sessions });
      persist(next);
      eventLog.info('library.delete', { fileName: asset.fileName });
      notify('ok', '已从手机删除，相机内文件不受影响');
    },

    session: (assetId) => {
      return get().sessions[assetId] ?? defaultSession();
    },

    patchParam: (assetId, key, value) => {
      const state = get();
      const current = state.sessions[assetId] ?? defaultSession();
      const params = withParam(current.params, key, value);
      set({
        sessions: { ...state.sessions, [assetId]: { ...current, params, presetId: null } },
      });
    },

    resetSession: (assetId) => {
      const state = get();
      set({
        sessions: {
          ...state.sessions,
          [assetId]: { ...defaultSession(), lutPath: null, lutName: null },
        },
      });
      haptic('light');
    },

    applyPreset: (assetId, presetId) => {
      const preset = get().presets.find((p) => p.id === presetId);
      if (!preset) return;
      const state = get();
      set({
        sessions: {
          ...state.sessions,
          [assetId]: {
            ...(state.sessions[assetId] ?? defaultSession()),
            params: { ...preset.params },
            presetId,
          },
        },
      });
      haptic('light');
    },

    setSessionParams: (assetId, params) => {
      const state = get();
      const current = state.sessions[assetId] ?? defaultSession();
      set({ sessions: { ...state.sessions, [assetId]: { ...current, params, presetId: null } } });
    },

    setLut: (assetId, lut) => {
      const state = get();
      const current = state.sessions[assetId] ?? defaultSession();
      set({
        sessions: {
          ...state.sessions,
          [assetId]: { ...current, lutPath: lut?.path ?? null, lutName: lut?.name ?? null },
        },
      });
    },

    restoreSession: (assetId, snapshot) => {
      const state = get();
      set({ sessions: { ...state.sessions, [assetId]: { ...snapshot } } });
    },

    resetParams: (assetId, keys) => {
      const state = get();
      const current = state.sessions[assetId] ?? defaultSession();
      let params = current.params;
      for (const key of keys) params = withParam(params, key, DEFAULT_PARAMS[key]);
      set({
        sessions: { ...state.sessions, [assetId]: { ...current, params, presetId: null } },
      });
      haptic('light');
    },

    markStatus: (assetId, status) => {
      const state = get();
      const next = state.assets.map((a) => (a.id === assetId ? { ...a, status } : a));
      set({ assets: next });
      persist(next);
    },

    notify,

    dismissNotice: () => set({ notice: null }),

    dismissCapturePreview: () => set({ capturePreview: null }),

    updateSettings: async (patch) => {
      const next = { ...get().settings, ...patch };
      set({ settings: next });
      await saveSettings(next);
    },

    saveKey: async (key) => {
      const trimmed = key.trim();
      if (!trimmed) {
        notify('warn', 'Key 不能为空');
        return;
      }
      await saveApiKey(trimmed);
      set({ apiKey: trimmed });
      notify('ok', 'API Key 已存入系统安全存储');
      eventLog.info('settings.key.saved');
    },

    removeKey: async () => {
      await clearApiKey();
      set({ apiKey: null });
      notify('ok', 'API Key 已清除');
      eventLog.info('settings.key.cleared');
    },
  };
});

/** 供取景页拿到当前 transport 的演示帧（真机返回空数组）。 */
export function currentLiveFrames(): number[] {
  return transport?.liveFrames() ?? [];
}

export function currentTransportMode(): CameraMode | null {
  return transport?.mode ?? null;
}
