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
  hslParamKeys,
  isNeutral,
  type GroupKey,
  type HslBandKey,
} from '@/core/params';
import {
  IDENTITY_CURVE_SET,
  defaultCurveSet,
  identityCurve,
  isIdentityCurveSet,
  type CurveChannel,
  type CurvePoint,
  type CurveSet,
} from '@/core/curve';
import { Lut3D } from '@/core/lut';
import { AiConfig, effectiveAiConfig } from '@/core/aiProvider';
import { eventLog } from '@/core/log';
import { Button, Label, ParamRow, Segmented, TabStrip, T } from '@/design/ui';
import { color, radius, space, typography } from '@/design/tokens';
import { useThrottledCallback } from '@/design/useThrottledCallback';
import { CurveEditor } from '@/components/editor/CurveEditor';
import { HslPanel } from '@/components/editor/HslPanel';
import { PANEL_RESIZER_SIZE, PanelResizer } from '@/components/editor/PanelResizer';
import {
  computeHistogram,
  curveSkImage,
  decodeImage,
  getGradeEffect,
  lutSkImage,
  makePreviewImage,
  placeholderCurveImage,
  placeholderLutImage,
  uniformsObject,
  type Histogram,
} from '@/services/grading';
import { exportEdited } from '@/services/exportImage';
import { importLutFromPicker, loadLutFromPath } from '@/services/lutStore';
import { ensureRawGrade, existingRawGrade } from '@/services/rawGrade';
import { requestGrade } from '@/services/aiClient';
import { ensurePreview, existingPreview } from '@/services/thumbs';
import { EditorSession, useAppStore } from '@/state/useAppStore';

type PanelTab = 'adjust' | 'presets' | 'ai';

/** 参数面板默认占长边的比例（竖屏=高度，横屏=宽度） */
const DEFAULT_PANEL_FRACTION = 0.46;
/** 面板最小占比：再小滑块就挤没了 */
const MIN_PANEL_FRACTION = 0.26;
/** 面板最大占比：再大画面就没地方了 */
const MAX_PANEL_FRACTION = 0.78;

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

  // RAW(ARW)：先用 LibRaw 解成全幅 PNG，再进普通调色管线（解码只做一次）
  if (asset.raw) {
    const gradeUri = existingRawGrade(asset);
    if (!gradeUri) return <RawDecodeScreen asset={asset} />;
    // 解过之后编辑器读 previewUri / 导出读 gradeUri，走的是和 JPEG 一样的路径
  }

  return <EditorBody asset={asset} />;
}

/**
 * RAW(ARW) 解码页：进编辑器之前先把原图解成全幅 PNG。
 *
 * 24MP 的 14bit 拜耳数据 → 去马赛克 / 机身白平衡 / sRGB，平板（OPPO Pad 4 Pro）实测约 8 秒，
 * 所以只在第一次打开这张 RAW 时出现，解完立刻进编辑器；之后再点开就是秒进。
 */
function RawDecodeScreen({ asset }: { asset: Asset }) {
  const insets = useSafeAreaInsets();
  const attachRawGrade = useAppStore((s) => s.attachRawGrade);
  const notify = useAppStore((s) => s.notify);
  const [phase, setPhase] = useState<'idle' | 'working' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

  const start = useCallback(async () => {
    if (startedRef.current) return;
    startedRef.current = true;
    setPhase('working');
    setError(null);
    const grade = await ensureRawGrade(asset);
    if (!grade) {
      startedRef.current = false;
      setPhase('failed');
      setError('解码失败。ARW 原文件还在，可以重试，或者把画质改成 JPEG+RAW 用 JPEG 那张修。');
      notify('danger', 'RAW 解码失败');
      return;
    }
    attachRawGrade(asset.id, grade);
    notify('ok', `RAW 已解码 ${grade.width}×${grade.height}，用时 ${(grade.ms / 1000).toFixed(1)} 秒`);
  }, [asset, attachRawGrade, notify]);

  // 进来就自动开始：用户点的是"编辑这张"，不该再点一次"开始解码"。
  // 用 setTimeout 而不是直接调用：状态更新放到下一轮，避免 effect 里同步 setState。
  useEffect(() => {
    const timer = setTimeout(() => void start(), 0);
    return () => clearTimeout(timer);
  }, [start]);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={22} color={color.text} />
        </Pressable>
        <View style={{ flex: 1, paddingHorizontal: space.sm }}>
          <T variant="mono" numberOfLines={1}>
            {asset.fileName}
          </T>
          <T variant="monoMuted" numberOfLines={1} style={{ marginTop: 2 }}>
            RAW(ARW) · {formatBytes(asset.bytes)} · {asset.width > 1000 ? `${asset.width}×${asset.height}` : '解码中'}
          </T>
        </View>
      </View>
      <View style={styles.stageRaw}>
        <Image
          source={{ uri: asset.thumbUri ?? asset.uri }}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
        />
      </View>
      <View style={{ padding: space.lg, gap: space.sm }}>
        {phase === 'failed' ? (
          <>
            <T variant="body" style={{ color: color.danger }}>
              这张 RAW 解不出来
            </T>
            <T variant="monoMuted">{error}</T>
            <Button
              title="重试解码"
              onPress={() => void start()}
              variant="secondary"
              style={{ marginTop: space.sm }}
            />
          </>
        ) : (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
              <ActivityIndicator color={color.accent} />
              <T variant="body">正在解码 RAW 原图…</T>
            </View>
            <T variant="monoMuted">
              正在用 LibRaw 解 {asset.fileName}：去马赛克 + 机身白平衡 + sRGB，全幅一次解码。
              24MP 大约 8 秒，只做一次，之后这张就是秒开的普通可调色照片。
            </T>
          </>
        )}
      </View>
    </View>
  );
}

function EditorBody({ asset }: { asset: Asset }) {
  const insets = useSafeAreaInsets();
  const { width: winW, height: winH } = useWindowDimensions();

  const session = useAppStore((s) => s.sessions[asset.id]);
  const patchParam = useAppStore((s) => s.patchParam);
  const resetSession = useAppStore((s) => s.resetSession);
  const applyPreset = useAppStore((s) => s.applyPreset);
  const setLut = useAppStore((s) => s.setLut);
  const setCurves = useAppStore((s) => s.setCurves);
  const setSessionParams = useAppStore((s) => s.setSessionParams);
  const restoreSession = useAppStore((s) => s.restoreSession);
  const resetParams = useAppStore((s) => s.resetParams);
  const markStatus = useAppStore((s) => s.markStatus);
  const copyGrade = useAppStore((s) => s.copyGrade);
  const pasteGrade = useAppStore((s) => s.pasteGrade);
  const clipboard = useAppStore((s) => s.clipboard);
  const settings = useAppStore((s) => s.settings);
  const apiKey = useAppStore((s) => s.apiKey);
  const notify = useAppStore((s) => s.notify);

  const params: EditParams = session?.params ?? DEFAULT_PARAMS;
  const curves: CurveSet = session?.curves ?? IDENTITY_CURVE_SET;

  // 拖动滑块时节流写 store：画面仍跟手，但重渲染次数降一个量级
  const patchParamThrottled = useThrottledCallback((key: ParamKey, value: number) => {
    patchParam(asset.id, key, value);
  }, 40);

  const [tab, setTab] = useState<PanelTab>('adjust');
  const [group, setGroup] = useState<GroupKey>('light');
  const [curveChannel, setCurveChannel] = useState<CurveChannel>('rgb');
  const [image, setImage] = useState<SkImage | null>(null);
  const [loadingImage, setLoadingImage] = useState(true);
  const [imageError, setImageError] = useState<string | null>(null);
  const [lut, setLutState] = useState<Lut3D | null>(null);
  const [comparing, setComparing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [histogram, setHistogram] = useState<Histogram | null>(null);
  /** 预览图文件路径（按住对比时用它，避免再解一次 24MP 原图） */
  const [previewSource, setPreviewSource] = useState<string | null>(null);

  /** 撤销/重做：只在"一次操作结束"（松手、应用预设、换 LUT）时入栈 */
  const historyRef = useRef<EditorSession[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  /** 只用于渲染按钮可用状态：ref 不能参与渲染 */
  const [historyLength, setHistoryLength] = useState(0);

  const effect = getGradeEffect();
  const activeLut = session?.lutPath ? lut : null;
  const lutImage = useMemo(() => lutSkImage(activeLut), [activeLut]);
  const placeholder = useMemo(() => placeholderLutImage(), []);
  const curveImage = useMemo(() => curveSkImage(curves), [curves]);
  const curvePlaceholder = useMemo(() => placeholderCurveImage(), []);
  /**
   * LUT 纹理的像素尺寸。ImageShader 的 rect 必须等于纹理尺寸（1 canvas 单位 = 1 像素），
   * 否则 shader 里 lut.eval(px) 的取样坐标会整体错位 —— 典型症状是"套了 LUT 但画面几乎不变"。
   */
  const lutRect = useMemo(() => {
    const size = activeLut?.size ?? 2;
    return { x: 0, y: 0, width: size, height: size * size };
  }, [activeLut]);

  /* ---------- 载入预览图（编辑页秒开的关键） ---------- */
  useEffect(() => {
    let alive = true;
    const assetId = asset.id;
    const assetUri = asset.uri;
    const assetPreviewUri = asset.previewUri;
    // 同步 setState 会造成连锁渲染：这里只在异步回调里改状态，
    // 初始的 "加载中/无错误" 由 useState 初值负责。
    (async () => {
      try {
        const { File } = await import('expo-file-system');
        // 优先用入库时生成的 1600px 预览图：文件小、解码量小，
        // 24MP 原图只在导出时重新解一次（与导出走不同路径，互不影响）。
        const cached = existingPreview({ id: assetId, previewUri: assetPreviewUri });
        const uri =
          cached ?? (await ensurePreview({ id: assetId, uri: assetUri, previewUri: assetPreviewUri })) ?? assetUri;
        const bytes = await new File(uri).bytes();
        const decoded = decodeImage(bytes);
        if (!alive) return;
        if (!decoded) throw new Error('解码失败');
        // 没有预览图时（老数据第一次打开）才在线降采样，下一次就命中缓存了
        const preview = uri === assetUri ? makePreviewImage(decoded) : decoded;
        setImage(preview);
        setPreviewSource(uri);
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
  }, [asset.id, asset.previewUri, asset.uri]);

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
  // 参数面板可拖动调整大小：存成"占长边的比例"，竖屏是高度占比、横屏是宽度占比，
  // 旋转屏幕后不用重新拖。0.26 / 0.78 是夹取范围（再小放不下滑块，再大把画面挤没）。
  const isLandscape = winW > winH;
  const [panelFraction, setPanelFraction] = useState(DEFAULT_PANEL_FRACTION);
  const longSide = isLandscape ? winW : winH;
  const panelSize = Math.min(
    longSide * MAX_PANEL_FRACTION,
    Math.max(longSide * MIN_PANEL_FRACTION, longSide * panelFraction),
  );
  const stageHeight = Math.max(
    140,
    winH - insets.top - insets.bottom - (isLandscape ? PANEL_RESIZER_SIZE : panelSize) - 96,
  );
  const stageWidth = isLandscape ? Math.max(160, winW - panelSize - PANEL_RESIZER_SIZE) : winW;
  /** 曲线画布高度跟着面板走：小屏上别把「保存到相册」挤出可视区 */
  const curveHeight = Math.max(
    92,
    Math.min(138, (isLandscape ? Math.min(panelSize * 0.9, winH * 0.5) : panelSize) - 210),
  );
  const frame = useMemo(() => {
    const imgW = image?.width() ?? asset.width;
    const imgH = image?.height() ?? asset.height;
    const scale = Math.min(stageWidth / Math.max(imgW, 1), stageHeight / Math.max(imgH, 1));
    return { width: Math.max(1, imgW * scale), height: Math.max(1, imgH * scale) };
  }, [image, asset.width, asset.height, stageWidth, stageHeight]);



  const curvesActive = useMemo(() => !isIdentityCurveSet(curves), [curves]);

  const uniforms = useMemo(
    () =>
      uniformsObject(
        params,
        frame.width,
        frame.height,
        activeLut?.size ?? 2,
        Boolean(activeLut),
        curvesActive,
      ),
    [params, frame.width, frame.height, activeLut, curvesActive],
  );

  /* ---------- 撤销 / 重做 ---------- */
  /**
   * 入栈时不要用渲染闭包里的 params —— 那是"上一次渲染"的快照。
   * 直接读 store：applyPreset / pasteGrade 这类"先改状态再提交"的动作，
   * 同步读到的才是操作后的结果（否则按一次预设，撤销栈里少了这一步）。
   */
  const commitHistory = useCallback(() => {
    const latest = useAppStore.getState().sessions[asset.id];
    const snapshot: EditorSession = latest
      ? {
          params: { ...latest.params },
          curves: latest.curves,
          presetId: latest.presetId,
          lutPath: latest.lutPath,
          lutName: latest.lutName,
        }
      : { params: { ...DEFAULT_PARAMS }, curves: IDENTITY_CURVE_SET, presetId: 'original', lutPath: null, lutName: null };

    const entries = historyRef.current.slice(0, historyIndex + 1);
    const last = entries[entries.length - 1];
    if (last && JSON.stringify(last) === JSON.stringify(snapshot)) return;
    entries.push(snapshot);
    if (entries.length > 40) entries.shift();
    historyRef.current = entries;
    setHistoryLength(entries.length);
    setHistoryIndex(entries.length - 1);
  }, [asset.id, historyIndex]);

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
    commitHistory();
  }, [commitHistory]);

  /* ---------- 保存 / 导出 ---------- */
  const handleSave = useCallback(
    async (toGallery: boolean) => {
      if (saving) return;
      setSaving(true);
      try {
        const result = await exportEdited({
          asset,
          params,
          curves,
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
    [asset, activeLut, curves, markStatus, notify, params, saving, settings.exportLongEdge, settings.jpegQuality],
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

  /** 曲线拖动：与滑杆同一套节流，40ms 写一次 store */
  const handleCurveChange = useThrottledCallback((points: CurvePoint[]) => {
    const current = useAppStore.getState().sessions[asset.id]?.curves ?? IDENTITY_CURVE_SET;
    setCurves(asset.id, { ...current, [curveChannel]: points });
  }, 40);

  /** 松手时用最终控制点再写一次（节流可能丢掉最后一帧），然后入历史栈 */
  const commitCurve = useCallback(
    (points: CurvePoint[]) => {
      const current = useAppStore.getState().sessions[asset.id]?.curves ?? IDENTITY_CURVE_SET;
      setCurves(asset.id, { ...current, [curveChannel]: points });
      commitHistory();
    },
    [asset.id, commitHistory, curveChannel, setCurves],
  );

  /** 滑杆松手：先写最终值（不受节流影响），再入历史栈 */
  const commitParam = useCallback(
    (key: ParamKey, value: number) => {
      patchParam(asset.id, key, value);
      commitHistory();
    },
    [asset.id, commitHistory, patchParam],
  );

  const resetCurveChannel = useCallback(() => {
    setCurves(asset.id, { ...curves, [curveChannel]: identityCurve() });
    commitHistory();
  }, [asset.id, commitHistory, curveChannel, curves, setCurves]);

  const resetGroup = useCallback(() => {
    if (group === 'curve') setCurves(asset.id, defaultCurveSet());
    else resetParams(asset.id, GROUP_PARAMS[group]);
    commitHistory();
  }, [asset.id, commitHistory, group, resetParams, setCurves]);

  const resetHslBand = useCallback(
    (band: HslBandKey) => {
      resetParams(asset.id, hslParamKeys(band));
      commitHistory();
    },
    [asset.id, commitHistory, resetParams],
  );

  const dirty = !isNeutral(params) || !isIdentityCurveSet(curves) || Boolean(activeLut);
  /** 当前 AI 配置（供应商 + 地址 + 模型），设置页随时可改 */
  const aiConfig = useMemo(() => effectiveAiConfig(settings), [settings]);

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

      {/* 画面 + 参数面板：竖屏上下排（分隔条在中间），横屏左右排（分隔条在中间） */}
      <View style={[styles.body, isLandscape && styles.bodyLandscape]}>
        <View style={[styles.stage, isLandscape ? { width: stageWidth } : { height: stageHeight }]}>
        {/* 预览图解码前先铺缩略图：点进编辑器的第一帧就不是黑的 */}
        {!image && !imageError ? (
          <Image
            source={{ uri: asset.thumbUri ?? asset.uri }}
            style={{ width: frame.width, height: frame.height, opacity: 0.45 }}
            contentFit="cover"
          />
        ) : null}

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
                <ImageShader
                  image={curveImage ?? curvePlaceholder}
                  fit="fill"
                  rect={{ x: 0, y: 0, width: 256, height: 1 }}
                  tx="clamp"
                  ty="clamp"
                  sampling={{ filter: FilterMode.Linear }}
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
          <Image source={{ uri: previewSource ?? asset.uri }} style={StyleSheet.absoluteFill} contentFit="contain" />
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

        {/* 拖动分隔条：竖屏上下拖，横屏左右拖，改面板大小 */}
        <PanelResizer
          vertical={isLandscape}
          fraction={panelFraction}
          longSide={longSide}
          min={MIN_PANEL_FRACTION}
          max={MAX_PANEL_FRACTION}
          onChange={setPanelFraction}
        />

        {/* 参数面板 */}
        <View
          style={[
            styles.panel,
            isLandscape ? { width: panelSize } : { height: panelSize },
            { paddingBottom: Math.max(insets.bottom, space.sm) },
          ]}
        >
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
            curves={curves}
            group={group}
            setGroup={setGroup}
            curveChannel={curveChannel}
            setCurveChannel={setCurveChannel}
            curveHeight={curveHeight}
            patchParam={patchParamThrottled}
            onPatchCommit={commitParam}
            onCurveChange={handleCurveChange}
            onCurveCommit={commitCurve}
            onResetGroup={resetGroup}
            onResetParam={(key) => {
              resetParams(asset.id, [key]);
              commitHistory();
            }}
            onResetBand={resetHslBand}
            onResetCurve={resetCurveChannel}
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
            onCopyGrade={() => {
              copyGrade(asset.id);
            }}
            onPasteGrade={() => {
              pasteGrade([asset.id]);
              commitHistory();
            }}
            clipboardName={clipboard?.sourceName ?? null}
          />
        ) : null}

        {tab === 'ai' ? (
          <AiPanel
            config={aiConfig}
            imageUri={previewSource ?? asset.uri}
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
    </View>
  );
}

/* ------------------------------------------------------------------ */

function AdjustPanel({
  params,
  curves,
  group,
  setGroup,
  curveChannel,
  setCurveChannel,
  curveHeight,
  patchParam,
  onPatchCommit,
  onCurveChange,
  onCurveCommit,
  onResetGroup,
  onResetParam,
  onResetBand,
  onResetCurve,
}: {
  params: EditParams;
  curves: CurveSet;
  group: GroupKey;
  setGroup: (g: GroupKey) => void;
  curveChannel: CurveChannel;
  setCurveChannel: (channel: CurveChannel) => void;
  curveHeight: number;
  patchParam: (key: ParamKey, value: number) => void;
  onPatchCommit: (key: ParamKey, value: number) => void;
  onCurveChange: (points: CurvePoint[]) => void;
  onCurveCommit: (points: CurvePoint[]) => void;
  onResetGroup: () => void;
  onResetParam: (key: ParamKey) => void;
  onResetBand: (band: HslBandKey) => void;
  onResetCurve: () => void;
}) {
  const keys = GROUP_PARAMS[group];
  return (
    <View style={{ flex: 1, marginTop: space.sm }}>
      <TabStrip value={group} onChange={setGroup} options={GROUPS.map((g) => ({ value: g.key, label: g.label }))} />

      {group === 'hsl' ? (
        <HslPanel params={params} onPatch={patchParam} onPatchCommit={onPatchCommit} onResetBand={onResetBand} />
      ) : group === 'curve' ? (
        <View style={{ flex: 1, marginTop: space.md }}>
          <Segmented
            value={curveChannel}
            onChange={(value) => setCurveChannel(value as CurveChannel)}
            options={[
              { value: 'rgb', label: 'RGB' },
              { value: 'r', label: 'R' },
              { value: 'g', label: 'G' },
              { value: 'b', label: 'B' },
            ]}
          />
          <View style={{ marginTop: space.md }}>
            <CurveEditor
              points={curves[curveChannel]}
              height={curveHeight}
              onChange={onCurveChange}
              onCommit={onCurveCommit}
            />
          </View>
          <View style={styles.groupBar}>
            <T variant="monoMuted">拖点调整 · 点空白处加点</T>
            <Pressable onPress={onResetCurve} hitSlop={8}>
              <T variant="monoMuted" style={{ color: color.textMuted }}>
                重置
              </T>
            </Pressable>
          </View>
        </View>
      ) : (
        <>
          <View style={styles.groupBar}>
            <T variant="monoMuted">{keys.length} 项</T>
            <Pressable onPress={onResetGroup} hitSlop={8}>
              <T variant="monoMuted" style={{ color: color.textMuted }}>
                重置本组
              </T>
            </Pressable>
          </View>
          <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
            {keys.map((key) => (
              <ParamRow
                key={key}
                label={PARAM_META[key].label}
                value={params[key]}
                min={PARAM_META[key].min}
                max={PARAM_META[key].max}
                step={PARAM_META[key].step}
                onChange={(v) => patchParam(key, v)}
                onCommit={(v) => onPatchCommit(key, v)}
                onReset={() => onResetParam(key)}
              />
            ))}
            <T variant="monoMuted" style={{ marginTop: space.sm }}>
              {PARAM_META[keys[0]].hint} · 点右侧数值可直接输入，长按归零
            </T>
            <View style={{ height: space.lg }} />
          </ScrollView>
        </>
      )}
    </View>
  );
}

function PresetsPanel({
  activeId,
  onApply,
  onPickLut,
  onClearLut,
  lutName,
  onCopyGrade,
  onPasteGrade,
  clipboardName,
}: {
  activeId: string | null;
  onApply: (id: string) => void;
  onPickLut: () => void;
  onClearLut: () => void;
  lutName: string | null;
  onCopyGrade: () => void;
  onPasteGrade: () => void;
  clipboardName: string | null;
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

      <View style={{ marginTop: space.lg }}>
        <Label>批量与复用</Label>
        <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.sm }}>
          <Button title="复制调色" onPress={onCopyGrade} variant="secondary" style={{ flex: 1 }} icon="copy-outline" />
          <Button
            title="粘贴调色"
            onPress={onPasteGrade}
            variant="secondary"
            disabled={!clipboardName}
            style={{ flex: 1 }}
            icon="clipboard-outline"
          />
        </View>
        <T variant="monoMuted" style={{ marginTop: space.sm }}>
          {clipboardName
            ? `剪贴板：${clipboardName}（图库多选后可批量粘贴）`
            : '复制这套调色后，可粘贴到本张或图库里多选的一批照片'}
        </T>
      </View>
      <View style={{ height: space.lg }} />
    </ScrollView>
  );
}

function AiPanel({
  config,
  imageUri,
  params,
  apiKey,
  onApply,
  onGoSettings,
  notify,
}: {
  config: AiConfig;
  imageUri: string;
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

  /** 配置不全或缺 Key 时的原因（空串 = 可以发请求） */
  const blocked = config.missing
    ? config.missing
    : config.requiresKey && !apiKey
      ? `缺少 ${config.providerName} 的 API Key`
      : '';

  const run = useCallback(
    async (text: string) => {
      const prompt = text.trim();
      if (!prompt || busy) return;
      if (blocked) {
        notify('warn', `${blocked}（设置 → AI 调色）`);
        return;
      }
      setBusy(true);
      try {
        const outcome = await requestGrade({
          config,
          apiKey,
          imageUri,
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
        notify('ok', `已应用 AI 参数（${(outcome.latencyMs / 1000).toFixed(1)}s · ${config.providerName}）`);
      } finally {
        setBusy(false);
      }
    },
    [apiKey, blocked, busy, config, imageUri, notify, onApply, params],
  );

  const diff = result ? diffParams(result.before, result.after) : [];

  return (
    <View style={{ flex: 1, marginTop: space.md }}>
      {blocked ? (
        <Pressable onPress={onGoSettings} style={styles.aiBanner}>
          <Ionicons name="key-outline" size={15} color={color.warn} />
          <T variant="monoMuted" style={{ flex: 1 }}>
            {blocked}，AI 调色不可用。点这里去设置。
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
            用一句自然语言描述目标，{config.providerName} 会返回结构化参数并在本地实时应用。
            图片只发送给你配置的供应商（{config.model}），不会上传到其它服务。
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
    marginTop: space.xs,
    marginBottom: space.xs,
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
  // RAW 只读页：画面占满剩余空间，说明文字固定在下半部分
  stageRaw: { flex: 1, backgroundColor: '#000' },
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
  // 画面 + 面板的容器：竖屏上下、横屏左右
  body: { flex: 1, flexDirection: 'column' },
  bodyLandscape: { flexDirection: 'row' },

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
