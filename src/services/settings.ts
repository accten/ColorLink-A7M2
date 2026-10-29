import * as SecureStore from 'expo-secure-store';

import { DEFAULT_PREVIEW_SECONDS, normalizePreviewSeconds } from '@/core/capturePreview';
import { DEFAULT_CAPTURE_TARGET, normalizeCaptureTarget } from '@/core/captureTarget';
import { normalizeLongEdge } from '@/core/exportOptions';
import { readTextSafe, settingsFile, writeTextAtomic } from './paths';

/**
 * 设置与密钥。
 * API Key 只进 Android Keystore 支撑的 SecureStore，绝不进 AsyncStorage / 日志 / 构建产物。
 */

const KEY_STORE_ID = 'colorlink.deepseek.apiKey';

export interface Settings {
  /** 导出长边；**0 = 保持原图尺寸**（不缩放） */
  exportLongEdge: number;
  jpegQuality: number;
  /** 拍完在 App 里自动预览几秒（0 = 关闭）；档位见 core/capturePreview */
  previewSeconds: number;
  /** 照片保存位置（相机 0xD222）：仅平板 / 两边都存 / 仅存储卡；见 core/captureTarget */
  captureTarget: number;
  haptics: boolean;
  demoMode: boolean;
  showGrid: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  exportLongEdge: 4000,
  jpegQuality: 92,
  previewSeconds: DEFAULT_PREVIEW_SECONDS,
  captureTarget: DEFAULT_CAPTURE_TARGET,
  haptics: true,
  demoMode: true,
  showGrid: false,
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
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      // 0 是合法值（原图尺寸），其余按 1024..8192 收敛
      exportLongEdge: normalizeLongEdge(parsed.exportLongEdge),
      jpegQuality: clampNumber(parsed.jpegQuality, 60, 100, DEFAULT_SETTINGS.jpegQuality),
      previewSeconds: normalizePreviewSeconds(parsed.previewSeconds),
      captureTarget: normalizeCaptureTarget(parsed.captureTarget),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await writeTextAtomic(settingsFile, JSON.stringify(settings, null, 2));
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

export async function loadApiKey(): Promise<string | null> {
  try {
    const value = await SecureStore.getItemAsync(KEY_STORE_ID);
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

export async function saveApiKey(key: string): Promise<void> {
  await SecureStore.setItemAsync(KEY_STORE_ID, key.trim(), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function clearApiKey(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(KEY_STORE_ID);
  } catch {
    // 忽略：本来就没有
  }
}

/** 只展示尾部 4 位，UI 与日志都用它。 */
export function maskKey(key: string | null): string {
  if (!key) return '未配置';
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 3)}••••${key.slice(-4)}`;
}
