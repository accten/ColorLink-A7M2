import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  HSL_BANDS,
  PARAM_META,
  hslParamKeys,
  type EditParams,
  type HslBandKey,
  type ParamKey,
} from '@/core/params';
import { ParamRow, T } from '@/design/ui';
import { color, radius, space, typography } from '@/design/tokens';

/**
 * HSL 八色带面板。
 *
 * 24 个滑块不可能一次全铺出来（那正是"不完整但也没法用"的典型），所以先选色带
 * 再给该色带的 色相/饱和/明度 三条。色带按钮用真实色相做点，滑到哪一条一眼可见。
 */
export function HslPanel({
  params,
  onPatch,
  onPatchCommit,
  onResetBand,
}: {
  params: EditParams;
  onPatch: (key: ParamKey, value: number) => void;
  onPatchCommit: (key: ParamKey, value: number) => void;
  onResetBand: (band: HslBandKey) => void;
}) {
  const [band, setBand] = useState<HslBandKey>('red');
  const keys = hslParamKeys(band);
  const active = HSL_BANDS.find((item) => item.key === band);

  return (
    <View style={{ flex: 1, marginTop: space.sm }}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.bandStrip}
      >
        {HSL_BANDS.map((item) => {
          const selected = item.key === band;
          const touched = hslParamKeys(item.key).some((key) => params[key] !== 0);
          return (
            <Pressable
              key={item.key}
              onPress={() => setBand(item.key)}
              style={[styles.band, selected && styles.bandActive]}
              accessibilityRole="button"
              accessibilityState={{ selected }}
            >
              <View style={[styles.swatch, { backgroundColor: item.swatch }]} />
              <Text style={[styles.bandLabel, selected && { color: color.text }]}>{item.label}</Text>
              {touched ? <View style={[styles.touchedDot, { backgroundColor: item.swatch }]} /> : null}
            </Pressable>
          );
        })}
      </ScrollView>

      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
        {keys.map((key) => (
          <ParamRow
            key={key}
            label={PARAM_META[key].label}
            value={params[key]}
            min={PARAM_META[key].min}
            max={PARAM_META[key].max}
            step={PARAM_META[key].step}
            onChange={(value) => onPatch(key, value)}
            onCommit={(value) => onPatchCommit(key, value)}
            onReset={() => onPatchCommit(key, 0)}
          />
        ))}
        <View style={styles.bandFooter}>
          <T variant="monoMuted">只影响{active?.label ?? ''}色区，按色相角平滑过渡</T>
          <Pressable onPress={() => onResetBand(band)} hitSlop={8}>
            <T variant="monoMuted" style={{ color: color.textMuted }}>
              重置本带
            </T>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  bandStrip: { gap: 6, paddingRight: space.lg, paddingVertical: 2 },
  band: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 30,
    paddingHorizontal: space.sm + 2,
    borderRadius: radius.pill,
    backgroundColor: color.bgElev,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
  },
  bandActive: { backgroundColor: color.surfaceHi, borderColor: color.hairlineStrong },
  swatch: { width: 9, height: 9, borderRadius: 5 },
  bandLabel: { ...typography.monoMuted, fontSize: 11.5 },
  touchedDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    marginLeft: 1,
    opacity: 0.9,
  },
  bandFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: space.md,
  },
});
