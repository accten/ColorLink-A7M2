import * as SecureStore from 'expo-secure-store';

import { readTextSafe, settingsFile, writeTextAtomic } from './paths';

/**
 * 设置与密钥。
 * API Key 只进 Android Keystore 支撑的 SecureStore，绝不进 AsyncStorage / 日志 / 构建产物。
 */

const KEY_STORE_ID = 'colorlink.deepseek.apiKey';

export interface Settings {
  exportLongEdge: number;
  jpegQuality: number;
  haptics: boolean;
  demoMode: boolean;
  showGrid: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  exportLongEdge: 4000,
  jpegQuality: 92,
  haptics: true,
  demoMode: true,
  showGrid: false,
};

export const EXPORT_SIZE_OPTIONS = [2048, 3000, 4000, 6000];

export async function loadSettings(): Promise<Settings> {
  const raw = readTextSafe(settingsFile);
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      exportLongEdge: clampNumber(parsed.exportLongEdge, 1024, 8192, DEFAULT_SETTINGS.exportLongEdge),
      jpegQuality: clampNumber(parsed.jpegQuality, 60, 100, DEFAULT_SETTINGS.jpegQuality),
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
