/**
 * 拍完预览：照片回传后自动在大屏上展示几秒。
 *
 * 时长做成可选档位而不是任意数字：这是"给摄影师看一眼"的功能，2/3/5/10 秒已经覆盖
 * 「扫一眼构图」到「慢慢看细节」，0 表示关闭。数值存在 Settings 里，和导出选项一起持久化。
 */
export const PREVIEW_SECONDS_OPTIONS = [0, 2, 3, 5, 10] as const;

export const DEFAULT_PREVIEW_SECONDS = 3;

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
    const distance = Math.abs(option - num);
    if (distance < best) {
      best = distance;
      closest = option;
    }
  }
  return closest;
}

export function previewSecondsLabel(seconds: number): string {
  return seconds > 0 ? `${seconds} 秒` : '关闭';
}
