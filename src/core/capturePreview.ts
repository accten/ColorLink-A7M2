/**
 * 拍完预览：照片回传后自动在大屏上展示。
 *
 * 时长做成可选档位而不是任意数字：这是"给摄影师看一眼"的功能，2/3/5/10 秒已经覆盖
 * 「扫一眼构图」到「慢慢看细节」，0 表示关闭。
 * `PERSISTENT`（-1）是「一直」：不自动消失，必须点一下才关——拍完想一直盯着看时用。
 */
export const PREVIEW_SECONDS_OPTIONS = [0, 2, 3, 5, 10, -1] as const;

export const DEFAULT_PREVIEW_SECONDS = 3;

/** 「一直显示」：不自动关闭，轻点才关 */
export const PERSISTENT_PREVIEW = -1;

export function isPersistentPreview(seconds: number): boolean {
  return seconds === PERSISTENT_PREVIEW;
}

/** 把任意输入收敛到合法档位；非法值退回默认值。 */
export function normalizePreviewSeconds(value: unknown): number {
  // Number(null) === 0、Number('') === 0：都是"没设置"，不能当成用户选了「关闭」
  if (value === null || value === undefined || value === '') return DEFAULT_PREVIEW_SECONDS;
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return DEFAULT_PREVIEW_SECONDS;
  if ((PREVIEW_SECONDS_OPTIONS as readonly number[]).includes(num)) return num;
  // 落在中间就归到最近的档位，避免用户手改配置文件后预览直接失效
  let closest: number = DEFAULT_PREVIEW_SECONDS;
  let best = Number.POSITIVE_INFINITY;
  for (const option of PREVIEW_SECONDS_OPTIONS) {
    // 「一直」不是时长，不参与"取最近"
    if (option < 0) continue;
    const distance = Math.abs(option - num);
    if (distance < best) {
      best = distance;
      closest = option;
    }
  }
  return closest;
}

export function previewSecondsLabel(seconds: number): string {
  if (isPersistentPreview(seconds)) return '一直';
  return seconds > 0 ? `${seconds} 秒` : '关闭';
}
