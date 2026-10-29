import * as SecureStore from 'expo-secure-store';

import { DEFAULT_PROVIDER_ID, findProvider, normalizeAiBaseUrl } from '@/core/aiProvider';
import { DEFAULT_PREVIEW_SECONDS, normalizePreviewSeconds } from '@/core/capturePreview';
import { DEFAULT_CAPTURE_TARGET, normalizeCaptureTarget } from '@/core/captureTarget';
import { DEFAULT_CAPTURE_FORMAT, normalizeCaptureFormat } from '@/core/captureFormat';
import { normalizeLongEdge } from '@/core/exportOptions';
import { readTextSafe, settingsFile, writeTextAtomic } from './paths';

/**
 * 设置与密钥。
 * API Key 只进 Android Keystore 支撑的 SecureStore，绝不进 AsyncStorage / 日志 / 构建产物。
 *
 * 供应商可配置：设置里存「供应商 id + 地址覆盖 + 模型覆盖」，真正发请求前由
 * core/aiProvider 的 effectiveAiConfig() 合成。Key **按供应商分开存**——切回
 * 之前用过的供应商不用重新粘 Key。
 */

const KEY_PREFIX = 'colorlink.ai.key.';
/** v0.1 时只有一个 DeepSeek Key，用这个 id 存的；首次读取时自动迁移 */
const LEGACY_DEEPSEEK_KEY_ID = 'colorlink.deepseek.apiKey';

export interface Settings {
  /** 导出长边；**0 = 保持原图尺寸**（不缩放） */
  exportLongEdge: number;
  jpegQuality: number;
  /** 拍完在 App 里自动预览几秒（0 = 关闭）；档位见 core/capturePreview */
  previewSeconds: number;
  /** 照片保存位置（相机 0xD222）：仅平板 / 两边都存 / 仅存储卡；见 core/captureTarget */
  captureTarget: number;
  /** 画质（相机 0xD253）：JPEG / RAW / JPEG+RAW；见 core/captureFormat */
  captureFormat: number;
  haptics: boolean;
  demoMode: boolean;
  showGrid: boolean;
  /** AI 供应商 id（见 core/aiProvider 的 AI_PROVIDERS） */
  aiProviderId: string;
  /** 请求地址覆盖；空 = 用供应商默认 */
  aiBaseUrl: string;
  /** 模型名覆盖；空 = 用供应商默认 */
  aiModel: string;
}

export const DEFAULT_SETTINGS: Settings = {
  exportLongEdge: 4000,
  jpegQuality: 92,
  previewSeconds: DEFAULT_PREVIEW_SECONDS,
  captureTarget: DEFAULT_CAPTURE_TARGET,
  captureFormat: DEFAULT_CAPTURE_FORMAT,
  haptics: true,
  demoMode: true,
  showGrid: false,
  aiProviderId: DEFAULT_PROVIDER_ID,
  aiBaseUrl: '',
  aiModel: '',
};

export {
  EXPORT_QUALITY_OPTIONS,
  EXPORT_SIZE_OPTIONS,
  exportQualityLabel,
  exportSizeLabel,
  normalizeLongEdge,
} from '@/core/exportOptions';

export async function loadSettings(): Promise<Settings> {
  const raw = readTextSafe(settingsFile);
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const providerId = findProvider(parsed.aiProviderId).id;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      // 0 是合法值（原图尺寸），其余按 1024..8192 收敛
      exportLongEdge: normalizeLongEdge(parsed.exportLongEdge),
      jpegQuality: clampNumber(parsed.jpegQuality, 60, 100, DEFAULT_SETTINGS.jpegQuality),
      previewSeconds: normalizePreviewSeconds(parsed.previewSeconds),
      captureTarget: normalizeCaptureTarget(parsed.captureTarget),
      captureFormat: normalizeCaptureFormat(parsed.captureFormat),
      // 供应商 id 不存在（旧版本 / 手改配置）时回落到默认
      aiProviderId: providerId,
      aiBaseUrl: normalizeAiBaseUrl(parsed.aiBaseUrl),
      aiModel: normalizeModel(parsed.aiModel),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await writeTextAtomic(settingsFile, JSON.stringify(settings, null, 2));
}

function normalizeModel(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, 120);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

export async function isSecureStoreAvailable(): Promise<boolean> {
  try {
    return await SecureStore.isAvailableAsync();
  } catch {
    return false;
  }
}

function keyId(providerId: string): string {
  return `${KEY_PREFIX}${findProvider(providerId).id}`;
}

/** 读某个供应商的 Key；老版本的单个 DeepSeek Key 会自动迁移过来。 */
export async function loadApiKey(providerId: string = DEFAULT_PROVIDER_ID): Promise<string | null> {
  try {
    const id = keyId(providerId);
    const value = await SecureStore.getItemAsync(id);
    if (value && value.trim()) return value.trim();

    if (id === keyId(DEFAULT_PROVIDER_ID)) {
      const legacy = await SecureStore.getItemAsync(LEGACY_DEEPSEEK_KEY_ID);
      if (legacy && legacy.trim()) {
        await SecureStore.setItemAsync(id, legacy.trim(), SECURE_OPTIONS);
        return legacy.trim();
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function saveApiKey(providerId: string, key: string): Promise<void> {
  await SecureStore.setItemAsync(keyId(providerId), key.trim(), SECURE_OPTIONS);
}

export async function clearApiKey(providerId: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(keyId(providerId));
  } catch {
    // 忽略：本来就没有
  }
}

const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/** 只展示尾部 4 位，UI 与日志都用它。 */
export function maskKey(key: string | null): string {
  if (!key) return '未配置';
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 3)}••••${key.slice(-4)}`;
}
