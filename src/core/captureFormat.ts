/**
 * 画质（相机 `0xD253 CompressionSetting`，UINT8）。
 *
 * 取值来自 libgphoto2 的 `sony_300_compression` 表 —— "Sony 300" 就是 SDIO 扩展协议
 * `0x012C`，也正是我们和机身协商的那一版：
 *
 *   1 = RAW，2 = RAW+JPEG，3 = JPEG
 *
 * 注意 ILCE-7M2 的属性数组里并没有列出 D253，写入大概率被拒（`0x200A`）。
 * 所以这一项记得留"相机不支持"的出口：写失败就提示去相机菜单里改，不能假装成功。
 */
export const CAPTURE_FORMAT_JPEG = 3;
export const CAPTURE_FORMAT_RAW = 1;
export const CAPTURE_FORMAT_JPEG_RAW = 2;

export interface CaptureFormatOption {
  value: number;
  label: string;
  hint: string;
}

export const CAPTURE_FORMAT_OPTIONS: readonly CaptureFormatOption[] = [
  {
    value: CAPTURE_FORMAT_JPEG,
    label: 'JPEG',
    hint: '只回 JPEG。调色、预览、导出全都能用，回传最快。',
  },
  {
    value: CAPTURE_FORMAT_RAW,
    label: 'RAW',
    hint: '只回 RAW(ARW)。目前无法调色，会被跳过——除非你只要相机里的原始文件。',
  },
  {
    value: CAPTURE_FORMAT_JPEG_RAW,
    label: 'JPEG+RAW',
    hint: '机身同时出两种：我们只取 JPEG，每次开拍前要多读走一张 24MB 的 RAW（约 1.2 秒）。',
  },
] as const;

export const DEFAULT_CAPTURE_FORMAT = CAPTURE_FORMAT_JPEG;

export function normalizeCaptureFormat(value: unknown): number {
  if (value === null || value === undefined || value === '') return DEFAULT_CAPTURE_FORMAT;
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return DEFAULT_CAPTURE_FORMAT;
  return CAPTURE_FORMAT_OPTIONS.some((option) => option.value === num) ? num : DEFAULT_CAPTURE_FORMAT;
}

export function captureFormatLabel(value: number): string {
  return CAPTURE_FORMAT_OPTIONS.find((option) => option.value === value)?.label ?? 'JPEG';
}
