import * as Haptics from 'expo-haptics';
import { create } from 'zustand';

import { Asset, isDuplicateCapture } from '@/core/asset';
import { findProvider } from '@/core/aiProvider';
import { CurveSet, cloneCurveSet } from '@/core/curve';
import { EditParams, ParamKey, DEFAULT_PARAMS, withParam } from '@/core/params';
import { BUILTIN_PRESETS, Preset } from '@/core/presets';
import {
  EditorSession,
  cloneSession,
  defaultEditorSession,
  gradeOf,
} from '@/core/session';
import { eventLog } from '@/core/log';
import { CameraMode, CameraSnapshot, CapturedPhoto, ICameraTransport, IDLE_SNAPSHOT } from '@/services/camera/types';
import { DemoCameraTransport } from '@/services/camera/demo';
import { adoptThumbnail, backfillDerivatives, ensureDerivatives } from '@/services/thumbs';
import { createUsbTransport } from '@/services/camera/usb';
import { assetFromPhoto, deleteAssetFile, loadAssets, saveAssets, seedDemoAssets } from '@/services/library';
import { loadSessions, scheduleSaveSessions, flushSessionsNow } from '@/services/sessionStore';
import {
  DEFAULT_SETTINGS,
  Settings,
  clearApiKey,
  loadApiKey,
  loadSettings,
  saveApiKey,
  saveSettings,
} from '@/services/settings';

export type { EditorSession } from '@/core/session';

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
  /** 图库里的资产 id：预览上的「编辑」要跳进对应编辑器 */
  assetId: string;
  uri: string;
  thumbUri?: string;
  fileName: string;
  bytes: number;
  width: number;
  height: number;
  /** 入库时间（预览的「详情」要显示拍摄时间） */
  capturedAt: number;
  /** 展示时长（秒）：>0 到点自动关，0 不看，-1 一直显示；由设置决定 */
  seconds: number;
}

/** 「复制调色」的剪贴板：参数 + 曲线 + LUT 引用（批量粘贴用） */
export interface GradeClipboard {
  params: EditParams;
  curves: CurveSet;
  lutPath: string | null;
  lutName: string | null;
  sourceName: string;
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
  clipboard: GradeClipboard | null;

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
  /** 批量删除（图库多选） */
  deleteAssets: (ids: string[]) => Promise<void>;
  session: (assetId: string) => EditorSession;
  patchParam: (assetId: string, key: keyof EditParams, value: number) => void;
  resetSession: (assetId: string) => void;
  applyPreset: (assetId: string, presetId: string) => void;
  setSessionParams: (assetId: string, params: EditParams) => void;
  setLut: (assetId: string, lut: { path: string; name: string } | null) => void;
  /** 色调曲线 */
  setCurves: (assetId: string, curves: CurveSet) => void;
  /** 撤销/重做用：整份会话快照回填 */
  restoreSession: (assetId: string, snapshot: EditorSession) => void;
  /** 只重置某一组参数（人像修图时最常用的粒度） */
  resetParams: (assetId: string, keys: readonly ParamKey[]) => void;
  /** 批量套预设（图库多选） */
  batchApplyPreset: (ids: string[], presetId: string) => void;
  /** 批量重置（图库多选） */
  batchResetSessions: (ids: string[]) => void;
  /** 复制某张图的调色到剪贴板 */
  copyGrade: (assetId: string) => void;
  /** 把剪贴板里的调色粘贴到一批图上 */
  pasteGrade: (ids: string[]) => void;
  markStatus: (assetId: string, status: Asset['status']) => void;
  /** 批量改状态（批量导出后一次性落盘，避免 N 次写索引） */
  markStatuses: (ids: string[], status: Asset['status']) => void;
  /** RAW 解码完成后挂上全幅 PNG / 预览 / 缩略图与真实尺寸 */
  attachRawGrade: (
    assetId: string,
    grade: { gradeUri: string; previewUri?: string; thumbUri?: string; width?: number; height?: number },
  ) => void;
  notify: (tone: NoticeTone, text: string, action?: Notice['action']) => void;
  dismissNotice: () => void;
  dismissCapturePreview: () => void;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  saveKey: (key: string) => Promise<void>;
  removeKey: () => Promise<void>;
  /** 立刻把待写的编辑会话落盘（切后台 / 导出前） */
  flushSessions: () => Promise<void>;
}

let transport: ICameraTransport | null = null;
let detachState: (() => void) | null = null;
let detachPhoto: (() => void) | null = null;
let noticeSeq = 0;
let previewSeq = 0;
/** 上次刷新曝光参数的时刻：监看页每帧都会问，太密对相机没意义 */
let lastExposureRefreshAt = 0;
const EXPOSURE_REFRESH_INTERVAL_MS = 1_500;

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

  /** 会话的唯一写入口：内存立即生效，磁盘防抖合并写。 */
  const commitSessions = (sessions: Record<string, EditorSession>) => {
    set({ sessions });
    scheduleSaveSessions(sessions);
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

    // 拍完自动预览：0 表示用户关掉了，就直接进相册；负数（一直）也走这里。
    // RAW 不弹预览：RAW+JPEG 时同一张会先来 JPEG（已经预览过），RAW 紧跟其后；
    // 而 ARW 是 TIFF，预览浮层渲染不了，弹出来只会闪一下黑屏。
    const previewSeconds = state.settings.previewSeconds;
    if (previewSeconds !== 0 && !asset.raw) {
      set({
        capturePreview: {
          id: ++previewSeq,
          assetId: asset.id,
          uri: asset.uri,
          thumbUri: asset.thumbUri,
          fileName: asset.fileName,
          bytes: asset.bytes,
          width: asset.width,
          height: asset.height,
          capturedAt: asset.capturedAt,
          seconds: previewSeconds,
        },
      });
      eventLog.info('preview.shown', { fileName: asset.fileName, seconds: previewSeconds });
    }

    // 缩略图 + 编辑预览图在后台补：不阻塞入库，也不影响快门手感。
    // 预览开着的时候先等它放完 —— 派生图要 Skia 整张解一次 24MP，
    // 和预览那张图抢解码只会让预览更晚出来。
    const derivativeTask = () => {
      // RAW：Skia 解不了 TIFF，缩略图由原生从 ARW 内嵌预览解好交过来，这里只把它收进 thumbs/。
      if (asset.raw) {
        const source = photo.thumbUri;
        if (!source) return;
        void adoptThumbnail(asset.id, source).then((thumbUri) => {
          if (!thumbUri) return;
          const current = get().assets;
          if (!current.some((item) => item.id === asset.id)) return;
          const patched = current.map((item) => (item.id === asset.id ? { ...item, thumbUri } : item));
          set({ assets: patched });
          persist(patched);
        });
        return;
      }
      void ensureDerivatives(asset).then((derived) => {
        if (!derived.thumbUri && !derived.previewUri) return;
        const current = get().assets;
        if (!current.some((item) => item.id === asset.id)) return;
        const patched = current.map((item) =>
          item.id === asset.id
            ? {
                ...item,
                thumbUri: derived.thumbUri ?? item.thumbUri,
                previewUri: derived.previewUri ?? item.previewUri,
              }
            : item,
        );
        set({ assets: patched });
        persist(patched);
      });
    };
    if (previewSeconds > 0) setTimeout(derivativeTask, previewSeconds * 1000 + 200);
    else if (previewSeconds < 0) setTimeout(derivativeTask, 3_000); // 「一直」：3 秒后照常补派生图
    else derivativeTask();
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
      // 联机成功后把「照片保存位置」和「画质」应用到相机（未联机时原生侧只记值）
      if (next.setCaptureTarget) {
        void next.setCaptureTarget(get().settings.captureTarget).catch(() => {});
      }
      if (next.setCaptureFormat) {
        void next.setCaptureFormat(get().settings.captureFormat).catch(() => {});
      }
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
    clipboard: null,

    init: async () => {
      try {
        const settings = await loadSettings();
        // Key 按供应商分开存；这里读的是设置里当前选中的那家
        const apiKey = await loadApiKey(settings.aiProviderId);
        set({ settings, apiKey });

        set({ libraryBusy: true });
        let assets = await loadAssets();
        if (!assets.length) {
          assets = await seedDemoAssets();
        }
        // 编辑会话跟着资产一起恢复：批量编辑完退出 App 再进来，调整还在
        const sessions = await loadSessions(new Set(assets.map((asset) => asset.id)));
        set({ assets, sessions, libraryBusy: false });
        eventLog.info('app.ready', { assets: assets.length, sessions: Object.keys(sessions).length, demo: settings.demoMode });

        // 冷启动补一批派生图（只补前几张，别抢首屏时间）
        void backfillDerivatives(assets, 6).then((patched) => {
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
      await get().deleteAssets([id]);
    },

    deleteAssets: async (ids) => {
      const state = get();
      const wanted = new Set(ids);
      const targets = state.assets.filter((asset) => wanted.has(asset.id));
      if (!targets.length) return;

      for (const asset of targets) {
        await deleteAssetFile(asset);
      }

      const next = state.assets.filter((asset) => !wanted.has(asset.id));
      const sessions = { ...state.sessions };
      for (const id of wanted) delete sessions[id];
      set({ assets: next, sessions });
      persist(next);
      scheduleSaveSessions(sessions);
      eventLog.info('library.delete', { count: targets.length });
      notify('ok', `已从手机删除 ${targets.length} 张，相机内文件不受影响`);
    },

    session: (assetId) => {
      return get().sessions[assetId] ?? defaultEditorSession();
    },

    patchParam: (assetId, key, value) => {
      const state = get();
      const current = state.sessions[assetId] ?? defaultEditorSession();
      const params = withParam(current.params, key, value);
      commitSessions({ ...state.sessions, [assetId]: { ...current, params, presetId: null } });
    },

    resetSession: (assetId) => {
      const state = get();
      commitSessions({ ...state.sessions, [assetId]: defaultEditorSession() });
      haptic('light');
    },

    applyPreset: (assetId, presetId) => {
      const preset = get().presets.find((p) => p.id === presetId);
      if (!preset) return;
      const state = get();
      const current = state.sessions[assetId] ?? defaultEditorSession();
      commitSessions({
        ...state.sessions,
        [assetId]: { ...current, params: { ...preset.params }, presetId },
      });
      haptic('light');
    },

    setSessionParams: (assetId, params) => {
      const state = get();
      const current = state.sessions[assetId] ?? defaultEditorSession();
      commitSessions({ ...state.sessions, [assetId]: { ...current, params, presetId: null } });
    },

    setLut: (assetId, lut) => {
      const state = get();
      const current = state.sessions[assetId] ?? defaultEditorSession();
      commitSessions({
        ...state.sessions,
        [assetId]: { ...current, lutPath: lut?.path ?? null, lutName: lut?.name ?? null },
      });
    },

    setCurves: (assetId, curves) => {
      const state = get();
      const current = state.sessions[assetId] ?? defaultEditorSession();
      commitSessions({ ...state.sessions, [assetId]: { ...current, curves, presetId: null } });
    },

    restoreSession: (assetId, snapshot) => {
      const state = get();
      commitSessions({ ...state.sessions, [assetId]: cloneSession(snapshot) });
    },

    resetParams: (assetId, keys) => {
      const state = get();
      const current = state.sessions[assetId] ?? defaultEditorSession();
      let params = current.params;
      for (const key of keys) params = withParam(params, key, DEFAULT_PARAMS[key]);
      commitSessions({ ...state.sessions, [assetId]: { ...current, params, presetId: null } });
      haptic('light');
    },

    batchApplyPreset: (ids, presetId) => {
      const preset = get().presets.find((p) => p.id === presetId);
      if (!preset || !ids.length) return;
      const state = get();
      const sessions = { ...state.sessions };
      for (const id of ids) {
        const current = sessions[id] ?? defaultEditorSession();
        // 预设只覆盖参数，保留每张图自己的曲线与 LUT —— 批量套色不该抹掉单独修过的东西
        sessions[id] = { ...current, params: { ...preset.params }, presetId };
      }
      commitSessions(sessions);
      haptic('success');
      eventLog.info('batch.preset', { count: ids.length, presetId });
    },

    batchResetSessions: (ids) => {
      if (!ids.length) return;
      const state = get();
      const sessions = { ...state.sessions };
      for (const id of ids) delete sessions[id];
      commitSessions(sessions);
      haptic('light');
    },

    copyGrade: (assetId) => {
      const state = get();
      const session = state.sessions[assetId] ?? defaultEditorSession();
      const asset = state.assets.find((item) => item.id === assetId);
      const grade = gradeOf(session);
      set({
        clipboard: {
          ...grade,
          sourceName: asset?.fileName ?? '上一张',
        },
      });
      notify('ok', `已复制调色：${asset?.fileName ?? '当前照片'}`);
    },

    pasteGrade: (ids) => {
      const clipboard = get().clipboard;
      if (!clipboard) {
        notify('warn', '剪贴板是空的：先在编辑器里「复制调色」');
        return;
      }
      if (!ids.length) return;
      const state = get();
      const sessions = { ...state.sessions };
      for (const id of ids) {
        const current = sessions[id] ?? defaultEditorSession();
        sessions[id] = {
          ...current,
          params: { ...clipboard.params },
          curves: cloneCurveSet(clipboard.curves),
          lutPath: clipboard.lutPath,
          lutName: clipboard.lutName,
          presetId: null,
        };
      }
      commitSessions(sessions);
      haptic('success');
      eventLog.info('batch.paste', { count: ids.length });
      notify('ok', `已把「${clipboard.sourceName}」的调色粘贴到 ${ids.length} 张`);
    },

    markStatus: (assetId, status) => {
      const state = get();
      const next = state.assets.map((a) => (a.id === assetId ? { ...a, status } : a));
      set({ assets: next });
      persist(next);
    },

    markStatuses: (ids, status) => {
      if (!ids.length) return;
      const wanted = new Set(ids);
      const state = get();
      const next = state.assets.map((a) => (wanted.has(a.id) ? { ...a, status } : a));
      set({ assets: next });
      persist(next);
    },

    attachRawGrade: (assetId, grade) => {
      const state = get();
      if (!state.assets.some((a) => a.id === assetId)) return;
      const next = state.assets.map((asset) =>
        asset.id === assetId
          ? {
              ...asset,
              gradeUri: grade.gradeUri,
              previewUri: grade.previewUri ?? asset.previewUri,
              thumbUri: grade.thumbUri ?? asset.thumbUri,
              width: grade.width && grade.width > 0 ? grade.width : asset.width,
              height: grade.height && grade.height > 0 ? grade.height : asset.height,
            }
          : asset,
      );
      set({ assets: next });
      persist(next);
    },

    notify,

    dismissNotice: () => set({ notice: null }),

    dismissCapturePreview: () => set({ capturePreview: null }),

    updateSettings: async (patch) => {
      const previous = get().settings;
      const next = { ...previous, ...patch };
      set({ settings: next });
      await saveSettings(next);

      // 切换供应商：Key 按供应商分开存，换一家就换一把
      if (patch.aiProviderId !== undefined && next.aiProviderId !== previous.aiProviderId) {
        const key = await loadApiKey(next.aiProviderId);
        set({ apiKey: key });
      }

      // 「照片保存位置」改了要立刻写给相机，否则要等下次联机才生效
      if (patch.captureTarget !== undefined && transport?.setCaptureTarget) {
        void transport.setCaptureTarget(next.captureTarget).catch(() => {});
      }
      // 画质同理；机身不支持时就地提示，别让用户以为改成功了
      if (patch.captureFormat !== undefined && transport?.setCaptureFormat) {
        void transport
          .setCaptureFormat(next.captureFormat)
          .then((supported) => {
            if (!supported) {
              notify('warn', '这台机身不支持通过 USB 改画质，请在相机菜单里改');
            }
          })
          .catch(() => {});
      }
    },

    saveKey: async (key) => {
      const trimmed = key.trim();
      if (!trimmed) {
        notify('warn', 'Key 不能为空');
        return;
      }
      const providerId = get().settings.aiProviderId;
      await saveApiKey(providerId, trimmed);
      set({ apiKey: trimmed });
      notify('ok', `${findProvider(providerId).name} 的 Key 已存入系统安全存储`);
      eventLog.info('settings.key.saved', { provider: providerId });
    },

    removeKey: async () => {
      const providerId = get().settings.aiProviderId;
      await clearApiKey(providerId);
      set({ apiKey: null });
      notify('ok', `已清除 ${findProvider(providerId).name} 的 Key`);
      eventLog.info('settings.key.cleared', { provider: providerId });
    },

    flushSessions: async () => {
      await flushSessionsNow();
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
