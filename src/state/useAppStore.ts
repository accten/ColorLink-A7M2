import * as Haptics from 'expo-haptics';
import { create } from 'zustand';

import { Asset } from '@/core/asset';
import { EditParams, DEFAULT_PARAMS, withParam } from '@/core/params';
import { BUILTIN_PRESETS, Preset } from '@/core/presets';
import { eventLog } from '@/core/log';
import { CameraMode, CameraSnapshot, CapturedPhoto, ICameraTransport, IDLE_SNAPSHOT } from '@/services/camera/types';
import { DemoCameraTransport } from '@/services/camera/demo';
import { createUsbTransport } from '@/services/camera/usb';
import { assetFromPhoto, deleteAssetFile, findDuplicate, loadAssets, saveAssets, seedDemoAssets } from '@/services/library';
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

  init: () => Promise<void>;
  connectCamera: (mode: CameraMode) => Promise<void>;
  disconnectCamera: () => Promise<void>;
  startLiveView: () => Promise<void>;
  stopLiveView: () => Promise<void>;
  capture: () => Promise<void>;
  refreshAssets: () => Promise<void>;
  deleteAsset: (id: string) => Promise<void>;
  session: (assetId: string) => EditorSession;
  patchParam: (assetId: string, key: keyof EditParams, value: number) => void;
  resetSession: (assetId: string) => void;
  applyPreset: (assetId: string, presetId: string) => void;
  setSessionParams: (assetId: string, params: EditParams) => void;
  setLut: (assetId: string, lut: { path: string; name: string } | null) => void;
  markStatus: (assetId: string, status: Asset['status']) => void;
  notify: (tone: NoticeTone, text: string, action?: Notice['action']) => void;
  dismissNotice: () => void;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  saveKey: (key: string) => Promise<void>;
  removeKey: () => Promise<void>;
}

let transport: ICameraTransport | null = null;
let detachState: (() => void) | null = null;
let detachPhoto: (() => void) | null = null;
let noticeSeq = 0;

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

  /** 一拍一传的落库：摘要去重 → 插到最前 → 持久化 → 轻触觉反馈。 */
  const ingestPhoto = async (photo: CapturedPhoto) => {
    const state = get();
    if (findDuplicate(state.assets, photo.hash)) {
      eventLog.warn('ingest.duplicate', { fileName: photo.fileName });
      return;
    }
    const asset = assetFromPhoto(photo, transport?.mode === 'usb' ? 'camera' : 'demo', state.assets.length + 1);
    const next = [asset, ...state.assets];
    set({ assets: next, lastCaptureAt: Date.now(), receivedCount: state.receivedCount + 1 });
    persist(next);
    haptic('success');
    eventLog.info('ingest.ok', { fileName: asset.fileName, bytes: asset.bytes });
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

    markStatus: (assetId, status) => {
      const state = get();
      const next = state.assets.map((a) => (a.id === assetId ? { ...a, status } : a));
      set({ assets: next });
      persist(next);
    },

    notify,

    dismissNotice: () => set({ notice: null }),

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
