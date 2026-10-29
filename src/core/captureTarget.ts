/**
 * 照片保存位置（相机 `0xD222 拍摄目标`）。
 *
 * 机身的合法枚举只有三个数字（读属性数组得到 form 枚举 [1, 17, 16]），含义是
 * "拍完存哪儿"：只交给主机（平板）/ 两边都存 / 只存存储卡。
 *
 * 为什么要做成设置项：联机时如果只交给主机，相机的回放里就找不到这些照片；
 * 想同时留一份在卡里，就需要写另一个枚举值。哪种值对应哪种行为由机型决定，
 * 所以这里只给出候选值，真机确认后在 README/设置页说明。
 */
export interface CaptureTargetOption {
  /** 写进 `0xD222` 的值 */
  value: number;
  /** 设置页上的短标签 */
  label: string;
  /** 一句话解释 */
  hint: string;
}

export const CAPTURE_TARGET_OPTIONS: readonly CaptureTargetOption[] = [
  {
    value: 17,
    label: '仅平板',
    hint: '出厂默认。照片直接回传到 App，相机存储卡里不留（回放里看不到）。',
  },
  {
    value: 1,
    label: '两边都存',
    hint: '回传到 App，同时在相机存储卡里留一份。机身支持时才会真的两边都有。',
  },
  {
    value: 16,
    label: '仅存储卡',
    hint: '只写相机存储卡。这种模式下 App 可能取不到照片，一般不建议。',
  },
] as const;

/**
 * 实测结论（ILCE-7M2 + OPPO Pad 4 Pro，v0.1.8）：三个值都不写卡。
 *
 * 相机对每个写入都回 `0x2001`（接受），但照片仍然只进内存缓存交给主机，
 * 说明"PC 遥控时不落卡"是这代机身固件的行为，不是这个属性控制的。
 * 保留这一项是为了支持 "PC + 存储卡" 的机身，文案里已经写明"部分机型有效"。
 */
export const CAPTURE_TARGET_VERIFIED_NOTE =
  '实测 ILCE-7M2 三个值都不写卡（PC 遥控模式下的固件行为）';

export const DEFAULT_CAPTURE_TARGET = 17;

export function normalizeCaptureTarget(value: unknown): number {
  if (value === null || value === undefined || value === '') return DEFAULT_CAPTURE_TARGET;
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return DEFAULT_CAPTURE_TARGET;
  return CAPTURE_TARGET_OPTIONS.some((option) => option.value === num) ? num : DEFAULT_CAPTURE_TARGET;
}

export function captureTargetLabel(value: number): string {
  return CAPTURE_TARGET_OPTIONS.find((option) => option.value === value)?.label ?? '仅平板';
}
