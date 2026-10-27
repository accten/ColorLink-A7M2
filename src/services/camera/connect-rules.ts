import type { CameraSnapshot } from './types';

/**
 * 连接判定规则（纯函数，便于测试；不含任何原生模块引用）。
 *
 * 踩过的坑：expo-sony-camera 的 `connect()` 在「没有相机接入」时**不会 reject**，
 * 而是立刻返回 `disconnected` + 一句 message。如果直接把它当成成功，界面会显示
 * 「相机已连接」，随后取景是黑的、快门按下去才报错 —— 用户完全不知道问题在哪。
 *
 * 所以只认 `ready` / `live` 为成功；`connecting` 一族要等状态事件；其余一律失败。
 */

/** 模块状态名（与 expo-sony-camera 的 SonyCameraStateName 一致） */
export type SonyStateName =
  | 'unsupported'
  | 'disconnected'
  | 'discovering'
  | 'candidate_found'
  | 'permission_required'
  | 'joining_network'
  | 'connecting'
  | 'authenticating'
  | 'ready'
  | 'streaming'
  | 'capturing'
  | 'recording'
  | 'transferring'
  | 'reconnecting'
  | 'error';

/** 还在进行中：值得等状态事件 */
const PENDING_STATES: readonly SonyStateName[] = [
  'discovering',
  'candidate_found',
  'permission_required',
  'joining_network',
  'connecting',
  'authenticating',
  'reconnecting',
];

/** 已经是「连上了」的终态 */
export function isConnectedPhase(phase: CameraSnapshot['phase']): boolean {
  return phase === 'ready' || phase === 'live';
}

/** 还需要继续等 */
export function isPendingState(state: SonyStateName): boolean {
  return PENDING_STATES.includes(state);
}

/** connect() 返回后是否可以认为成功 */
export function connectSucceeded(state: SonyStateName): boolean {
  return state === 'ready' || state === 'streaming' || state === 'capturing' || state === 'recording' || state === 'transferring';
}

/**
 * connect() 返回后是否还需要等状态事件。
 * 没有相机接入时模块直接给 disconnected —— 这不是「等待中」，要立刻报错。
 */
export function shouldWaitForState(state: SonyStateName): boolean {
  return isPendingState(state);
}
