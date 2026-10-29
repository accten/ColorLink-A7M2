import { Directory, File, Paths } from 'expo-file-system';

/**
 * App 私有目录布局（对应实现方案 4.7）：
 *
 *   <document>/colorlink/
 *   ├── ingest/     原图（只读，永不修改）
 *   ├── edited/     调色输出
 *   ├── thumbs/     480px 列表缩略图
 *   ├── previews/   1600px 编辑预览图（编辑器秒开用）
 *   ├── luts/       导入的 .cube
 *   ├── presets/    预设 JSON
 *   ├── logs/       日志导出
 *   ├── index.json  资产索引
 *   └── sessions.json 编辑会话（参数 + 曲线 + LUT）
 */

export const rootDir = new Directory(Paths.document, 'colorlink');
export const ingestDir = new Directory(rootDir, 'ingest');
export const editedDir = new Directory(rootDir, 'edited');
export const thumbsDir = new Directory(rootDir, 'thumbs');
export const previewsDir = new Directory(rootDir, 'previews');
export const lutsDir = new Directory(rootDir, 'luts');
export const presetsDir = new Directory(rootDir, 'presets');
export const logsDir = new Directory(rootDir, 'logs');

export const indexFile = new File(rootDir, 'index.json');
export const settingsFile = new File(rootDir, 'settings.json');
export const presetsFile = new File(rootDir, 'presets.json');
export const sessionsFile = new File(rootDir, 'sessions.json');

const ALL_DIRS = [rootDir, ingestDir, editedDir, thumbsDir, previewsDir, lutsDir, presetsDir, logsDir];

let prepared = false;

/** 幂等：每次冷启动、每次写文件前都可以安全调用。 */
export function ensureDirs(): void {
  if (prepared) return;
  for (const dir of ALL_DIRS) {
    if (!dir.exists) {
      dir.create({ intermediates: true, idempotent: true });
    }
  }
  prepared = true;
}

export function ingestFile(name: string): File {
  ensureDirs();
  return new File(ingestDir, name);
}

export function thumbFile(name: string): File {
  ensureDirs();
  return new File(thumbsDir, name);
}

export function previewFile(name: string): File {
  ensureDirs();
  return new File(previewsDir, name);
}

export function editedFile(name: string): File {
  ensureDirs();
  return new File(editedDir, name);
}

export function lutFile(name: string): File {
  ensureDirs();
  return new File(lutsDir, name);
}

export function logFile(name: string): File {
  ensureDirs();
  return new File(logsDir, name);
}

export function fileFromUri(uri: string): File {
  return new File(uri);
}

export function exists(uri: string): boolean {
  try {
    return new File(uri).exists;
  } catch {
    return false;
  }
}

/** 读取文本文件；不存在或损坏时返回 null，调用方负责兜底。 */
export function readTextSafe(file: File): string | null {
  try {
    if (!file.exists) return null;
    return file.textSync();
  } catch {
    return null;
  }
}

/** 原子写：先写 .tmp 再改名，避免进程被杀时留下半截 JSON。 */
export async function writeTextAtomic(file: File, text: string): Promise<void> {
  ensureDirs();
  const tmp = new File(file.parentDirectory, `${file.name}.tmp`);
  await tmp.write(text);
  if (file.exists) file.delete();
  tmp.move(file);
}
