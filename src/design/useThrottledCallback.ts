import { useCallback, useEffect, useRef } from 'react';

/**
 * 节流回调：拖动滑块时每次移动都会触发，直接把每帧都写进 store 会让
 * 编辑器整棵树（含 Skia canvas）按帧重渲染。这里限制到每 `intervalMs` 最多一次。
 *
 * 注意别在渲染期间读 `lastRef.current` —— 只在回调体内部读，符合 React 的 ref 规则。
 */
export function useThrottledCallback<Args extends unknown[]>(
  fn: (...args: Args) => void,
  intervalMs = 40,
): (...args: Args) => void {
  const lastRef = useRef(0);
  const fnRef = useRef(fn);

  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  return useCallback(
    (...args: Args) => {
      const now = Date.now();
      if (now - lastRef.current < intervalMs) return;
      lastRef.current = now;
      fnRef.current(...args);
    },
    [intervalMs],
  );
}
