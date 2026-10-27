import { Ionicons } from '@expo/vector-icons';
import { Canvas, Fill, FilterMode, ImageShader, Shader, type SkImage } from '@shopify/react-native-skia';
import { Image } from 'expo-image';
import { Href, router, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Asset, formatBytes } from '@/core/asset';
import {
  DEFAULT_PARAMS,
  EditParams,
  GROUPS,
  GROUP_PARAMS,
  PARAM_META,
  ParamKey,
  diffParams,
  isNeutral,
} from '@/core/params';
import { Lut3D } from '@/core/lut';
import { eventLog } from '@/core/log';
import { Button, Label, ParamRow, Segmented, T } from '@/design/ui';
import { color, radius, space, typography } from '@/design/tokens';
import { useThrottledCallback } from '@/design/useThrottledCallback';
import {
  computeHistogram,
  decodeImage,
  getGradeEffect,
  lutSkImage,
  makePreviewImage,
  placeholderLutImage,
  uniformsObject,
  type Histogram,
} from '@/services/grading';
import { exportEdited } from '@/services/exportImage';
import { importLutFromPicker, loadLutFromPath } from '@/services/lutStore';
import { requestGrade } from '@/services/aiClient';
import { EditorSession, useAppStore } from '@/state/useAppStore';

type PanelTab = 'adjust' | 'presets' | 'ai';

const AI_SUGGESTIONS = [
  '调成胶片感，偏暖',
  '天空更蓝一点',
  '提亮暗部，压回高光',
  '电影感青橙，压暗四周',
  '清透一点，降饱和',
];

export default function EditorScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const asset = useAppStore((s) => s.assets.find((a) => a.id === id));

  if (!asset) {
    return (
      <View style={styles.missing}>
        <T variant="body">照片不存在或已删除</T>
        <Button title="返回图库" onPress={() => router.back()} variant="secondary" style={{ marginTop: space.lg }} />
      </View>
    );
  }

  return <EditorBody asset={asset} />;
}

function EditorBody({ asset }: { asset: Asset }) {
  const insets = useSafeAreaInsets();
  const { width: winW, height: winH } = useWindowDimensions();

  const session = useAppStore((s) => s.sessions[asset.id]);
  const patchParam = useAppStore((s) => s.patchParam);
  const resetSession = useAppStore((s) => s.resetSession);
  const applyPreset = useAppStore((s) => s.applyPreset);
  const setLut = useAppStore((s) => s.setLut);
  const setSessionParams = useAppStore((s) => s.setSessionParams);
  const restoreSession = useAppStore((s) => s.restoreSession);
  const resetParams = useAppStore((s) => s.resetParams);
  const markStatus = useAppStore((s) => s.markStatus);
  const settings = useAppStore((s) => s.settings);
  const apiKey = useAppStore((s) => s.apiKey);
  const notify = useAppStore((s) => s.notify);

  const params: EditParams = session?.params ?? DEFAULT_PARAMS;

  // 拖动滑块时节流写 store：画面仍跟手，但重渲染次数降一个量级
  const patchParamThrottled = useThrottledCallback((key: ParamKey, value: number) => {
    patchParam(asset.id, key, value);
  }, 40);

  const [tab, setTab] = useState<PanelTab>('adjust');
  const [group, setGroup] = useState<(typeof GROUPS)[number]['key']>('light');
  const [image, setImage] = useState<SkImage | null>(null);
  const [loadingImage, setLoadingImage] = useState(true);
  const [imageError, setImageError] = useState<string | null>(null);
  const [lut, setLutState] = useState<Lut3D | null>(null);
  const [comparing, setComparing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [histogram, setHistogram] = useState<Histogram | null>(null);

  /** 撤销/重做：只在"一次操作结束"（松手、应用预设、换 LUT）时入栈 */
  const historyRef = useRef<EditorSession[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  /** 只用于渲染按钮可用状态：ref 不能参与渲染 */
  const [historyLength, setHistoryLength] = useState(0);

  const effect = getGradeEffect();
  const activeLut = session?.lutPath ? lut : null;
  const lutImage = useMemo(() => lutSkImage(activeLut), [activeLut]);
  const placeholder = useMemo(() => placeholderLutImage(), []);
  /**
   * LUT 纹理的像素尺寸。ImageShader 的 rect 必须等于纹理尺寸（1 canvas 单位 = 1 像素），
   * 否则 shader 里 lut.eval(px) 的取样坐标会整体错位 —— 典型症状是"套了 LUT 但画面几乎不变"。
   */
  const lutRect = useMemo(() => {
    const size = activeLut?.size ?? 2;
    return { x: 0, y: 0, width: size, height: size * size };
  }, [activeLut]);

  /* ---------- 载入原图（与导出同一条解码路径，保证一致） ---------- */
  useEffect(() => {
    let alive = true;
    // 同步 setState 会造成连锁渲染：这里只在异步回调里改状态，
    // 初始的 "加载中/无错误" 由 useState 初值负责。
    (async () => {
      try {
        const { File } = await import('expo-file-system');
        const bytes = await new File(asset.uri).bytes();
        const decoded = decodeImage(bytes);
        if (!alive) return;
        if (!decoded) throw new Error('解码失败');
        // 预览只用降采样副本：24MP 原图整张进 GPU 纹理在低端机上会直接 OOM
        const preview = makePreviewImage(decoded);
        setImage(preview);
        setHistogram(computeHistogram(preview));
        setImageError(null);
      } catch (error) {
        if (!alive) return;
        setImageError(error instanceof Error ? error.message : String(error));
      } finally {
        if (alive) setLoadingImage(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [asset.uri]);

  /* ---------- 载入会话里的 LUT ---------- */
  useEffect(() => {
    let alive = true;
    if (!session?.lutPath) return;
    void loadLutFromPath(session.lutPath).then((loaded) => {
      if (alive) setLutState(loaded);
    });
    return () => {
      alive = false;
    };
  }, [session?.lutPath]);

  /* ---------- 预览区域尺寸：按原图比例放进可用空间 ---------- */
  const panelHeight = Math.min(winH * 0.46, 380);
  const stageHeight = Math.max(160, winH - insets.top - insets.bottom - panelHeight - 96);
  const frame = useMemo(() => {
    const imgW = image?.width() ?? asset.width;
    const imgH = image?.height() ?? asset.height;
    const scale = Math.min(winW / Math.max(imgW, 1), stageHeight / Math.max(imgH, 1));
    return { width: Math.max(1, imgW * scale), height: Math.max(1, imgH * scale) };
  }, [image, asset.width, asset.height, winW, stageHeight]);

  const uniforms = useMemo(
    () => uniformsObject(params, frame.width, frame.height, activeLut?.size ?? 2, Boolean(activeLut)),
    [params, frame.width, frame.height, activeLut],
  );

  /* ---------- 撤销 / 重做 ---------- */
  const currentSnapshot: EditorSession = useMemo(
    () => ({
      params,
      presetId: session?.presetId ?? null,
      lutPath: session?.lutPath ?? null,
      lutName: session?.lutName ?? null,
    }),
    [params, session?.presetId, session?.lutPath, session?.lutName],
  );

  const commitHistory = useCallback(() => {
    const entries = historyRef.current.slice(0, historyIndex + 1);
    const last = entries[entries.length - 1];
    if (last && JSON.stringify(last) === JSON.stringify(currentSnapshot)) return;
    entries.push(currentSnapshot);
    if (entries.length > 40) entries.shift();
    historyRef.current = entries;
    setHistoryLength(entries.length);
    setHistoryIndex(entries.length - 1);
  }, [currentSnapshot, historyIndex]);

  const undo = useCallback(() => {
    if (historyIndex <= 0) return;
    const nextIndex = historyIndex - 1;
    const target = historyRef.current[nextIndex];
    if (!target) return;
    setHistoryIndex(nextIndex);
    restoreSession(asset.id, target);
  }, [asset.id, historyIndex, restoreSession]);

  const redo = useCallback(() => {
    const target = historyRef.current[historyIndex + 1];
    if (!target) return;
    setHistoryIndex(historyIndex + 1);
    restoreSession(asset.id, target);
  }, [asset.id, historyIndex, restoreSession]);

  // 首次进入把当前状态作为历史第 0 项
  useEffect(() => {
    if (historyRef.current.length > 0) return;
    historyRef.current = [currentSnapshot];
    setHistoryLength(1);
    setHistoryIndex(0);
  }, [currentSnapshot]);

  /* ---------- 保存 / 导出 ---------- */
  const handleSave = useCallback(
    async (toGallery: boolean) => {
      if (saving) return;
      setSaving(true);
      try {
        const result = await exportEdited({
          asset,
          params,
          lut: activeLut,
          longEdge: settings.exportLongEdge,
          quality: settings.jpegQuality,
          toGallery,
        });
        markStatus(asset.id, toGallery && result.savedToGallery ? 'exported' : 'edited');

        const size = formatBytes(result.bytes);
        const suffix = result.mode === 'original' ? '，原图直出未重编码' : '';
        if (!toGallery) {
          notify('ok', `已保存：${result.fileName}（${size}${suffix}）`);
        } else if (result.savedToGallery) {
          notify('ok', `已保存并写入相册：${result.fileName}（${size}${suffix}）`);
        } else {
          // 本地已保存成功、只是相册失败：必须如实说，不能让人以为存进相册了
          notify('warn', `已保存到 App 目录，但写入相册失败：${result.galleryError ?? '未知原因'}`);
        }

        if (!result.originalIntact) {
          notify('warn', '原图摘要发生变化（不应发生），已记录日志，请导出日志反馈');
          eventLog.error('export.original.changed', { assetId: asset.id });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        eventLog.error('export.failed', { error: message });
        notify('danger', `保存失败：${message}`);
      } finally {
        setSaving(false);
      }
    },
    [asset, activeLut, markStatus, notify, params, saving, settings.exportLongEdge, settings.jpegQuality],
  );

  const pickLut = useCallback(async () => {
    const result = await importLutFromPicker();
    if (!result.ok) {
      if (!result.canceled) notify('danger', result.reason);
      return;
    }
    setLut(asset.id, { path: result.path, name: result.name });
    setLutState(result.lut);
    notify('ok', `已应用 ${result.name} · ${result.summary}`);
  }, [asset.id, notify, setLut]);

  const dirty = !isNeutral(params);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* 顶部工具条 */}
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={22} color={color.text} />
        </Pressable>
        <View style={{ flex: 1, paddingHorizontal: space.sm }}>
          <T variant="mono" numberOfLines={1}>
            {asset.fileName}
          </T>
          <T variant="monoMuted" numberOfLines={1} style={{ marginTop: 2 }}>
            {asset.width}×{asset.height} · {formatBytes(asset.bytes)}
            {activeLut ? ` · ${session?.lutName ?? 'LUT'}` : ''}
          </T>
        </View>
        <Pressable
          onPress={undo}
          disabled={historyIndex <= 0}
          hitSlop={10}
          style={[styles.iconBtn, historyIndex <= 0 && { opacity: 0.3 }]}
        >
          <Ionicons name="arrow-undo-outline" size={19} color={color.text} />
        </Pressable>
        <Pressable
          onPress={redo}
          disabled={historyIndex >= historyLength - 1}
          hitSlop={10}
          style={[styles.iconBtn, historyIndex >= historyLength - 1 && { opacity: 0.3 }]}
        >
          <Ionicons name="arrow-redo-outline" size={19} color={color.text} />
        </Pressable>
        <Pressable
          onPress={() => void handleSave(false)}
          disabled={saving}
          hitSlop={12}
          style={[styles.saveBtn, saving && { opacity: 0.5 }]}
        >
          {saving ? <ActivityIndicator size="small" color={color.accentInk} /> : <Ionicons name="checkmark" size={17} color={color.accentInk} />}
          <T variant="body" style={{ color: color.accentInk, fontSize: 13, fontWeight: '700', marginLeft: 4 }}>
            保存
          </T>
        </Pressable>
      </View>

      {/* 画面 */}
      <View style={[styles.stage, { height: stageHeight }]}>
        {image && effect ? (
          <Canvas style={{ width: frame.width, height: frame.height }}>
            <Fill>
              <Shader source={effect} uniforms={uniforms}>
                <ImageShader
                  image={image}
                  fit="fill"
                  rect={{ x: 0, y: 0, width: frame.width, height: frame.height }}
                  tx="clamp"
                  ty="clamp"
                  sampling={{ filter: FilterMode.Linear }}
                />
                <ImageShader
                  image={activeLut ? lutImage : placeholder}
                  fit="fill"
                  rect={lutRect}
                  tx="clamp"
                  ty="clamp"
                  sampling={{ filter: FilterMode.Nearest }}
                />
              </Shader>
            </Fill>
          </Canvas>
        ) : null}

        {loadingImage ? (
          <View style={styles.stageOverlay}>
            <ActivityIndicator color={color.textMuted} />
          </View>
        ) : null}

        {imageError ? (
          <View style={styles.stageOverlay}>
            <T variant="monoMuted">图片加载失败：{imageError}</T>
          </View>
        ) : null}

        {comparing ? (
          <Image source={{ uri: asset.uri }} style={StyleSheet.absoluteFill} contentFit="contain" />
        ) : null}

        <HistogramOverlay histogram={histogram} />

        <Pressable
          onPressIn={() => setComparing(true)}
          onPressOut={() => setComparing(false)}
          style={styles.compareBtn}
          hitSlop={8}
        >
          <Ionicons name="git-compare-outline" size={14} color={color.text} />
          <T variant="mono" style={{ fontSize: 10.5, marginLeft: 5 }}>
            {comparing ? '原图' : '按住对比'}
          </T>
        </Pressable>
      </View>

      {/* 底部面板 */}
      <View style={[styles.panel, { height: panelHeight, paddingBottom: Math.max(insets.bottom, space.sm) }]}>
        <Segmented
          value={tab}
          onChange={(v) => setTab(v as PanelTab)}
          options={[
            { value: 'adjust', label: '调色' },
            { value: 'presets', label: '预设' },
            { value: 'ai', label: 'AI' },
          ]}
        />

        {tab === 'adjust' ? (
          <AdjustPanel
            params={params}
            group={group}
            setGroup={setGroup}
            patchParam={patchParamThrottled}
            onCommit={commitHistory}
            onResetGroup={() => {
              resetParams(asset.id, GROUP_PARAMS[group]);
              commitHistory();
            }}
            onResetParam={(key) => {
              resetParams(asset.id, [key]);
              commitHistory();
            }}
          />
        ) : null}

        {tab === 'presets' ? (
          <PresetsPanel
            activeId={session?.presetId ?? null}
            onApply={(presetId) => {
              applyPreset(asset.id, presetId);
              commitHistory();
            }}
            onPickLut={() => void pickLut()}
            lutName={session?.lutName ?? null}
            onClearLut={() => {
              setLut(asset.id, null);
              setLutState(null);
            }}
          />
        ) : null}

        {tab === 'ai' ? (
          <AiPanel
            asset={asset}
            params={params}
            apiKey={apiKey}
            onApply={(next) => setSessionParams(asset.id, next)}
            onGoSettings={() => router.push('/(tabs)/settings' as Href)}
            notify={notify}
          />
        ) : null}

        {/* 面板底部操作条 */}
        <View style={styles.actionRow}>
          <Button
            title="重置"
            onPress={() => {
              resetSession(asset.id);
              commitHistory();
            }}
            variant="ghost"
            disabled={!dirty && !activeLut}
            style={{ flex: 1 }}
          />
          <Button
            title="保存到相册"
            onPress={() => void handleSave(true)}
            variant="primary"
            loading={saving}
            style={{ flex: 2 }}
            icon="download-outline"
          />
        </View>
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------ */

function AdjustPanel({
  params,
  group,
  setGroup,
  patchParam,
  onCommit,
  onResetGroup,
  onResetParam,
}: {
  params: EditParams;
  group: (typeof GROUPS)[number]['key'];
  setGroup: (g: (typeof GROUPS)[number]['key']) => void;
  patchParam: (key: ParamKey, value: number) => void;
  onCommit: () => void;
  onResetGroup: () => void;
  onResetParam: (key: ParamKey) => void;
}) {
  return (
    <View style={{ flex: 1, marginTop: space.md }}>
      <Segmented value={group} onChange={(v) => setGroup(v as typeof group)} options={GROUPS.map((g) => ({ value: g.key, label: g.label }))} />
      <View style={styles.groupBar}>
        <T variant="monoMuted">{GROUP_PARAMS[group].length} 项</T>
        <Pressable onPress={onResetGroup} hitSlop={8}>
          <T variant="monoMuted" style={{ color: color.textMuted }}>
            重置本组
          </T>
        </Pressable>
      </View>
      <ScrollView style={{ flex: 1, marginTop: space.xs }} showsVerticalScrollIndicator={false}>
        {GROUP_PARAMS[group].map((key) => (
          <ParamRow
            key={key}
            label={PARAM_META[key].label}
            value={params[key]}
            min={PARAM_META[key].min}
            max={PARAM_META[key].max}
            step={PARAM_META[key].step}
            onChange={(v) => patchParam(key, v)}
            onCommit={onCommit}
            onReset={() => onResetParam(key)}
          />
        ))}
        <T variant="monoMuted" style={{ marginTop: space.sm }}>
          {PARAM_META[GROUP_PARAMS[group][0]].hint}
        </T>
        <View style={{ height: space.lg }} />
      </ScrollView>
    </View>
  );
}

function PresetsPanel({
  activeId,
  onApply,
  onPickLut,
  onClearLut,
  lutName,
}: {
  activeId: string | null;
  onApply: (id: string) => void;
  onPickLut: () => void;
  onClearLut: () => void;
  lutName: string | null;
}) {
  const presets = useAppStore((s) => s.presets);
  return (
    <ScrollView style={{ flex: 1, marginTop: space.md }} showsVerticalScrollIndicator={false}>
      <View style={styles.presetGrid}>
        {presets.map((preset) => {
          const active = preset.id === activeId;
          return (
            <Pressable
              key={preset.id}
              onPress={() => onApply(preset.id)}
              style={[styles.presetCard, active && styles.presetCardActive]}
            >
              <T variant="body" style={{ fontSize: 14, fontWeight: '600' }}>
                {preset.name}
              </T>
              <T variant="monoMuted" style={{ marginTop: 3 }} numberOfLines={2}>
                {preset.description}
              </T>
            </Pressable>
          );
        })}
      </View>

      <View style={{ marginTop: space.lg }}>
        <Label>3D LUT</Label>
        <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.sm }}>
          <Button title={lutName ? '更换 LUT' : '导入 .cube'} onPress={onPickLut} variant="secondary" style={{ flex: 1 }} icon="color-filter-outline" />
          {lutName ? <Button title="移除" onPress={onClearLut} variant="ghost" style={{ flex: 1 }} /> : null}
        </View>
        <T variant="monoMuted" style={{ marginTop: space.sm }}>
          {lutName ?? '支持 3D .cube（17/32/33/64）；导入后会按 LUT 浓度与原图混合。'}
        </T>
      </View>
      <View style={{ height: space.lg }} />
    </ScrollView>
  );
}

function AiPanel({
  asset,
  params,
  apiKey,
  onApply,
  onGoSettings,
  notify,
}: {
  asset: Asset;
  params: EditParams;
  apiKey: string | null;
  onApply: (params: EditParams) => void;
  onGoSettings: () => void;
  notify: (tone: 'ok' | 'warn' | 'danger', text: string) => void;
}) {
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ before: EditParams; after: EditParams; latencyMs: number } | null>(null);
  const historyRef = useRef<{ instruction: string; params: EditParams }[]>([]);

  const run = useCallback(
    async (text: string) => {
      const prompt = text.trim();
      if (!prompt || busy) return;
      if (!apiKey) {
        notify('warn', '先在设置里填写 DeepSeek API Key');
        return;
      }
      setBusy(true);
      try {
        const outcome = await requestGrade({
          apiKey,
          imageUri: asset.uri,
          instruction: prompt,
          currentParams: params,
          history: historyRef.current,
        });
        if (!outcome.ok || !outcome.params) {
          notify('danger', outcome.reason ?? 'AI 调色失败');
          return;
        }
        onApply(outcome.params);
        historyRef.current = [...historyRef.current, { instruction: prompt, params: outcome.params }].slice(-5);
        setResult({ before: params, after: outcome.params, latencyMs: outcome.latencyMs });
        notify('ok', `已应用 AI 参数（${(outcome.latencyMs / 1000).toFixed(1)}s）`);
      } finally {
        setBusy(false);
      }
    },
    [apiKey, asset.uri, busy, notify, onApply, params],
  );

  const diff = result ? diffParams(result.before, result.after) : [];

  return (
    <View style={{ flex: 1, marginTop: space.md }}>
      {!apiKey ? (
        <Pressable onPress={onGoSettings} style={styles.aiBanner}>
          <Ionicons name="key-outline" size={15} color={color.warn} />
          <T variant="monoMuted" style={{ flex: 1 }}>
            未配置 API Key，AI 调色不可用。点这里去设置。
          </T>
        </Pressable>
      ) : null}

      <View style={styles.aiInputRow}>
        <TextInput
          value={instruction}
          onChangeText={setInstruction}
          placeholder="例如：调成胶片感，偏暖"
          placeholderTextColor={color.textFaint}
          style={styles.aiInput}
          editable={!busy}
          onSubmitEditing={() => void run(instruction)}
          returnKeyType="send"
        />
        <Button
          title={busy ? '…' : '应用'}
          onPress={() => void run(instruction)}
          variant="primary"
          loading={busy}
          style={{ width: 76 }}
        />
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: space.sm, maxHeight: 34 }}>
        {AI_SUGGESTIONS.map((s) => (
          <Pressable key={s} onPress={() => setInstruction(s)} style={styles.chip}>
            <T variant="monoMuted" style={{ fontSize: 11 }}>
              {s}
            </T>
          </Pressable>
        ))}
      </ScrollView>

      <ScrollView style={{ flex: 1, marginTop: space.sm }} showsVerticalScrollIndicator={false}>
        {diff.length ? (
          <>
            <Label>本次变化 · {(result!.latencyMs / 1000).toFixed(1)}s</Label>
            <View style={{ marginTop: space.sm }}>
              {diff.map((d) => (
                <View key={d.key} style={styles.diffRow}>
                  <T variant="body" style={{ fontSize: 13, flex: 1 }}>
                    {d.label}
                  </T>
                  <T variant="monoMuted">{d.from}</T>
                  <Ionicons name="arrow-forward" size={12} color={color.textFaint} style={{ marginHorizontal: 8 }} />
                  <T variant="mono">{d.to}</T>
                </View>
              ))}
            </View>
          </>
        ) : (
          <T variant="monoMuted">
            用一句自然语言描述目标，DeepSeek 会返回结构化参数并在本地实时应用。原图不会被上传到除 DeepSeek 以外的服务。
          </T>
        )}
        <View style={{ height: space.lg }} />
      </ScrollView>
    </View>
  );
}

function HistogramOverlay({ histogram }: { histogram: Histogram | null }) {
  if (!histogram || histogram.sampled === 0) return null;
  return (
    <View style={styles.histogram} pointerEvents="none">
      {histogram.luma.map((value, index) => (
        <View
          key={index}
          style={[
            styles.histogramBar,
            { height: Math.max(1, value * 30), opacity: 0.22 + value * 0.6 },
          ]}
        />
      ))}
    </View>
  );
}
const styles = StyleSheet.create({
  histogram: {
    position: 'absolute',
    left: space.md,
    bottom: space.md,
    width: 96,
    height: 32,
    flexDirection: 'row',
    alignItems: 'flex-end',
    opacity: 0.85,
  },
  histogramBar: { flex: 1, backgroundColor: color.text, borderRadius: 0.5 },
  groupBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: space.sm,
  },
  root: { flex: 1, backgroundColor: color.bg },
  missing: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: color.bg },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
  },
  iconBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: color.accent,
    paddingHorizontal: space.md,
    height: 34,
    borderRadius: radius.pill,
  },
  stage: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#000' },
  stageOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  compareBtn: {
    position: 'absolute',
    right: space.md,
    bottom: space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(12,14,16,0.78)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairlineStrong,
    paddingHorizontal: space.sm,
    paddingVertical: 5,
    borderRadius: radius.pill,
  },
  panel: {
    backgroundColor: color.bgElev,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairline,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
  },
  actionRow: { flexDirection: 'row', gap: space.sm, paddingTop: space.sm },
  presetGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  presetCard: {
    width: '31.5%',
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
  },
  presetCardActive: { borderColor: color.accent, backgroundColor: 'rgba(232,223,207,0.08)' },
  aiBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    padding: space.sm,
    borderRadius: radius.sm,
    backgroundColor: 'rgba(224,192,123,0.08)',
    marginBottom: space.sm,
  },
  aiInputRow: { flexDirection: 'row', gap: space.sm },
  aiInput: {
    flex: 1,
    ...typography.body,
    backgroundColor: color.surface,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairlineStrong,
    paddingHorizontal: space.md,
    fontSize: 13.5,
  },
  chip: {
    paddingHorizontal: space.md,
    height: 30,
    justifyContent: 'center',
    borderRadius: radius.pill,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
    marginRight: space.sm,
  },
  diffRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 7, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.hairline },
});
