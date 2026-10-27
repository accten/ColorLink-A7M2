import { describe, expect, it } from 'vitest';

import { connectSucceeded, isConnectedPhase, isPendingState, shouldWaitForState } from '../src/services/camera/connect-rules';

/**
 * 这几条规则来自真机 bug：没有相机接入时 expo-sony-camera 的 connect() 正常返回
 * `disconnected`，旧代码把它当成成功，界面显示"相机已连接"但取景全黑。
 */
describe('camera connect rules', () => {
  it('只有 ready/live 算已连接', () => {
    expect(isConnectedPhase('ready')).toBe(true);
    expect(isConnectedPhase('live')).toBe(true);
    expect(isConnectedPhase('idle')).toBe(false);
    expect(isConnectedPhase('connecting')).toBe(false);
    expect(isConnectedPhase('error')).toBe(false);
  });

  it('disconnected 不算成功，也不该继续等', () => {
    expect(connectSucceeded('disconnected')).toBe(false);
    expect(isPendingState('disconnected')).toBe(false);
    expect(shouldWaitForState('disconnected')).toBe(false);
  });

  it('ready / streaming 直接算成功', () => {
    expect(connectSucceeded('ready')).toBe(true);
    expect(connectSucceeded('streaming')).toBe(true);
  });

  it('握手中间态要继续等', () => {
    for (const state of ['discovering', 'candidate_found', 'permission_required', 'connecting', 'authenticating', 'reconnecting'] as const) {
      expect(isPendingState(state)).toBe(true);
      expect(shouldWaitForState(state)).toBe(true);
      expect(connectSucceeded(state)).toBe(false);
    }
  });

  it('unsupported / error 不等待、不成功', () => {
    expect(shouldWaitForState('unsupported')).toBe(false);
    expect(shouldWaitForState('error')).toBe(false);
    expect(connectSucceeded('error')).toBe(false);
  });
});
