/* eslint-disable react-hooks/refs, react-hooks/preserve-manual-memoization --
 * PanResponder 是命令式 API：手势进行中重建 responder 会让后续 move 事件继续走旧闭包，
 * 所以 responder 必须只创建一次，并从一个可变的 ref 读取"最新"的曲线与回调。
 * React Compiler 的这几条规则针对的是渲染期读写 ref 的写法，这里是事件回调期，属于误报。
 * （本项目未开启 React Compiler，useMemo 的手术刀语义仍然成立。）
 */
import { Canvas, Path, Skia } from '@shopify/react-native-skia';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, View } from 'react-native';

import {
  MAX_CURVE_POINTS,
  evaluateCurve,
  insertCurvePoint,
  moveCurvePoint,
  nearestCurvePoint,
  type CurvePoint,
} from '@/core/curve';
import { color, radius } from '@/design/tokens';

/**
 * 色调曲线编辑器。
 *
 * 交互与 Lightroom 一致：拖动控制点、点空白处加点、端点只能上下移动、
 * 中间点只能在邻居之间移动 —— 这两条约束都在 core/curve.ts 的纯函数里，
 * 组件只负责坐标换算。
 *
 * 曲线本身用 Skia 画（和预览同一个渲染器，颜色不会两套）。
 */

const CURVE_SAMPLES = 64;

export function CurveEditor({
  points,
  height = 148,
  onChange,
  onCommit,
}: {
  points: CurvePoint[];
  height?: number;
  onChange: (points: CurvePoint[]) => void;
  onCommit: (points: CurvePoint[]) => void;
}) {
  const [width, setWidth] = useState(1);
  const pointsRef = useRef(points);
  const dragRef = useRef(-1);
  const lastPointsRef = useRef<CurvePoint[] | null>(null);
  const handlersRef = useRef({ onChange, onCommit, width: 1, height });

  // 渲染之后同步最新值，事件回调里再读 —— 不参与渲染，不会造成撕裂
  useEffect(() => {
    pointsRef.current = points;
    handlersRef.current = { onChange, onCommit, width, height };
  }, [points, onChange, onCommit, width, height]);

  const horizontal = useMemo(() => {
    const builder = Skia.PathBuilder.Make();
    for (let i = 1; i < 4; i += 1) {
      const x = (width * i) / 4;
      builder.moveTo(x, 0);
      builder.lineTo(x, height);
      const y = (height * i) / 4;
      builder.moveTo(0, y);
      builder.lineTo(width, y);
    }
    return builder.detach();
  }, [width, height]);

  const diagonal = useMemo(() => {
    const builder = Skia.PathBuilder.Make();
    builder.moveTo(0, height);
    builder.lineTo(width, 0);
    return builder.detach();
  }, [width, height]);

  const curvePath = useMemo(() => {
    const builder = Skia.PathBuilder.Make();
    for (let i = 0; i <= CURVE_SAMPLES; i += 1) {
      const x = i / CURVE_SAMPLES;
      const y = evaluateCurve(points, x);
      const px = x * width;
      const py = (1 - y) * height;
      if (i === 0) builder.moveTo(px, py);
      else builder.lineTo(px, py);
    }
    return builder.detach();
  }, [points, width, height]);

  const dots = useMemo(() => {
    const builder = Skia.PathBuilder.Make();
    for (const point of points) {
      builder.addCircle(point.x * width, (1 - point.y) * height, 4.5);
    }
    return builder.detach();
  }, [points, width, height]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event) => {
          const { width: w, height: h } = handlersRef.current;
          const x = Math.min(1, Math.max(0, event.nativeEvent.locationX / w));
          const y = Math.min(1, Math.max(0, 1 - event.nativeEvent.locationY / h));
          const hit = nearestCurvePoint(pointsRef.current, x, y);
          if (hit >= 0) {
            dragRef.current = hit;
            return;
          }
          if (pointsRef.current.length >= MAX_CURVE_POINTS) {
            dragRef.current = -1;
            return;
          }
          const inserted = insertCurvePoint(pointsRef.current, x, y);
          // 插入后按 x 找到新点（normalizeCurve 可能微调坐标）
          let index = -1;
          let best = 0.05;
          inserted.forEach((point, i) => {
            const distance = Math.abs(point.x - x);
            if (distance < best) {
              best = distance;
              index = i;
            }
          });
          dragRef.current = index;
          lastPointsRef.current = inserted;
          handlersRef.current.onChange(inserted);
        },
        onPanResponderMove: (event) => {
          if (dragRef.current < 0) return;
          const { width: w, height: h } = handlersRef.current;
          const x = Math.min(1, Math.max(0, event.nativeEvent.locationX / w));
          const y = Math.min(1, Math.max(0, 1 - event.nativeEvent.locationY / h));
          const next = moveCurvePoint(pointsRef.current, dragRef.current, x, y);
          lastPointsRef.current = next;
          handlersRef.current.onChange(next);
        },
        onPanResponderRelease: () => {
          dragRef.current = -1;
          const finalPoints = lastPointsRef.current ?? pointsRef.current;
          lastPointsRef.current = null;
          handlersRef.current.onCommit(finalPoints);
        },
        onPanResponderTerminate: () => {
          dragRef.current = -1;
          const finalPoints = lastPointsRef.current ?? pointsRef.current;
          lastPointsRef.current = null;
          handlersRef.current.onCommit(finalPoints);
        },
      }),
    [],
  );

  return (
    <View
      style={[styles.frame, { height }]}
      onLayout={(event) => setWidth(Math.max(1, event.nativeEvent.layout.width))}
    >
      <Canvas style={{ width, height }}>
        <Path path={horizontal} style="stroke" strokeWidth={1} color={color.hairline} />
        <Path path={diagonal} style="stroke" strokeWidth={1} color={color.hairline} />
        <Path path={curvePath} style="stroke" strokeWidth={2} color={color.accent} />
        <Path path={dots} style="fill" color={color.text} />
      </Canvas>
      <View style={StyleSheet.absoluteFill} {...responder.panHandlers} />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    width: '100%',
    borderRadius: radius.md,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairlineStrong,
    overflow: 'hidden',
  },
});
