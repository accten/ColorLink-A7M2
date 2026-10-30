/* eslint-disable react-hooks/refs -- PanResponder 的 handler 只在触摸事件里跑，规则无法区分渲染期与事件期 */
import React, { useMemo, useRef } from 'react';
import { PanResponder, StyleSheet, View } from 'react-native';

import { color } from '@/design/tokens';

/**
 * 参数面板的分隔条（可拖动改大小）。
 *
 * 竖屏时是一条横向细条（上下拖改高度），横屏时是一条纵向细条（左右拖改宽度）。
 * 大小用"占长边的比例"表示，父组件按方向换算成像素，旋转屏幕后不用重新拖。
 */
export function PanelResizer({
  vertical,
  fraction,
  longSide,
  min,
  max,
  onChange,
}: {
  /** true = 横屏的纵向分隔条 */
  vertical: boolean;
  fraction: number;
  /** 当前方向下的长边像素（横屏是宽度，竖屏是高度） */
  longSide: number;
  min: number;
  max: number;
  onChange: (fraction: number) => void;
}) {
  const startRef = useRef(fraction);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          startRef.current = fraction;
        },
        onPanResponderMove: (_event, gesture) => {
          // 往"画面那一侧"拖 = 面板变大
          const delta = vertical ? gesture.dx : gesture.dy;
          const next = startRef.current - delta / Math.max(1, longSide);
          onChange(Math.min(max, Math.max(min, next)));
        },
      }),
    [vertical, longSide, min, max, fraction, onChange],
  );

  return (
    <View
      {...pan.panHandlers}
      style={[styles.base, vertical ? styles.vertical : styles.horizontal]}
      accessibilityRole="adjustable"
      accessibilityLabel="拖动调整参数面板大小"
    >
      <View style={[styles.grip, vertical ? styles.gripVertical : styles.gripHorizontal]} />
    </View>
  );
}

/** 分隔条厚度（dp）：也是拖动手势的命中区 */
export const PANEL_RESIZER_SIZE = 22;

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.bgElev,
  },
  horizontal: { height: PANEL_RESIZER_SIZE },
  vertical: {
    width: PANEL_RESIZER_SIZE,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: color.hairline,
  },
  grip: { borderRadius: 2, backgroundColor: color.hairlineStrong },
  gripHorizontal: { width: 44, height: 4 },
  gripVertical: { width: 4, height: 44 },
});
