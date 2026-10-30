import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { Href, router, useFocusEffect } from 'expo-router';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { formatDay, formatMegapixels } from '@/core/asset';
import { describeSession, isSessionNeutral } from '@/core/session';
import { Label, Sheet, T } from '@/design/ui';
import { color, radius, space, typography } from '@/design/tokens';
import { batchExportAssets } from '@/services/batch';
import { useAppStore } from '@/state/useAppStore';

const COLUMNS = 3;

/**
 * 图库（含批量编辑）。
 *
 * 批量编辑的入口是长按任意一张：进入多选，然后底部操作条给出
 * 预设 / 粘贴调色 / 重置 / 导出 / 删除。选择"粘贴调色"是为了配合编辑器里的
 * 「复制调色」——先调好一张，再把同一套参数铺给一整批。
 */
export default function GalleryScreen() {
  const insets = useSafeAreaInsets();
  const assets = useAppStore((s) => s.assets);
  const sessions = useAppStore((s) => s.sessions);
  const presets = useAppStore((s) => s.presets);
  const clipboard = useAppStore((s) => s.clipboard);
  const settings = useAppStore((s) => s.settings);

  const batchApplyPreset = useAppStore((s) => s.batchApplyPreset);
  const batchResetSessions = useAppStore((s) => s.batchResetSessions);
  const pasteGrade = useAppStore((s) => s.pasteGrade);
  const deleteAssets = useAppStore((s) => s.deleteAssets);
  const markStatuses = useAppStore((s) => s.markStatuses);
  const notify = useAppStore((s) => s.notify);
  const flushSessions = useAppStore((s) => s.flushSessions);

  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [sheet, setSheet] = useState<'preset' | 'export' | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  const cancelRef = useRef(false);

  const selectedIds = useMemo(() => assets.filter((asset) => selected.has(asset.id)).map((a) => a.id), [assets, selected]);
  const selectedCount = selectedIds.length;
  const allSelected = assets.length > 0 && selectedCount === assets.length;
  const busy = progress !== null;

  const openAsset = useCallback((id: string) => {
    router.push(`/editor/${id}` as Href);
  }, []);

  const toggle = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const enterSelection = useCallback(
    (id: string) => {
      setSelecting(true);
      setSelected((current) => {
        const next = new Set(current);
        next.add(id);
        return next;
      });
    },
    [],
  );

  const exitSelection = useCallback(() => {
    setSelecting(false);
    setSelected(new Set());
    setSheet(null);
  }, []);

  const toggleAll = useCallback(() => {
    setSelected(allSelected ? new Set() : new Set(assets.map((asset) => asset.id)));
  }, [allSelected, assets]);

  // 离开图库时退出多选：tab 页状态会被保留，否则切回来还是"已选 2 张"，
  // 用户很容易在下一次误操作里把这两张一起删/批量导出。
  useFocusEffect(
    useCallback(() => {
      return () => {
        setSelecting(false);
        setSelected(new Set());
        setSheet(null);
      };
    }, []),
  );

  const handlePreset = useCallback(
    (presetId: string) => {
      batchApplyPreset(selectedIds, presetId);
      const preset = presets.find((p) => p.id === presetId);
      notify('ok', `已把「${preset?.name ?? presetId}」应用到 ${selectedCount} 张`);
      setSheet(null);
    },
    [batchApplyPreset, notify, presets, selectedCount, selectedIds],
  );

  const handlePaste = useCallback(() => {
    pasteGrade(selectedIds);
    setSheet(null);
  }, [pasteGrade, selectedIds]);

  const handleReset = useCallback(() => {
    batchResetSessions(selectedIds);
    notify('ok', `已还原 ${selectedCount} 张的编辑（原图不变）`);
  }, [batchResetSessions, notify, selectedCount, selectedIds]);

  const handleDelete = useCallback(() => {
    Alert.alert('删除这些照片？', `共 ${selectedCount} 张。只删手机上的副本，相机内的文件不受影响。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          void deleteAssets(selectedIds).then(() => exitSelection());
        },
      },
    ]);
  }, [deleteAssets, exitSelection, selectedCount, selectedIds]);

  const runExport = useCallback(
    async (toGallery: boolean) => {
      if (busy || !selectedCount) return;
      const targets = assets.filter((asset) => selected.has(asset.id));
      cancelRef.current = false;
      setProgress({ done: 0, total: targets.length, current: '' });

      try {
        // 导出前把会话落盘：万一过程中进程被杀，编辑状态不会丢
        await flushSessions();
        const result = await batchExportAssets({
          assets: targets,
          getSession: (id) => useAppStore.getState().session(id),
          longEdge: settings.exportLongEdge,
          quality: settings.jpegQuality,
          toGallery,
          onProgress: (done, total, current) => setProgress({ done, total, current }),
          isCancelled: () => cancelRef.current,
        });

        markStatuses(result.succeeded, toGallery ? 'exported' : 'edited');

        if (result.cancelled) {
          notify('warn', `已取消：成功导出 ${result.exported} 张`);
        } else if (result.failed.length) {
          notify('warn', `成功 ${result.exported} 张，失败 ${result.failed.length} 张：${result.failed[0].error}`);
        } else if (toGallery) {
          notify('ok', `已导出 ${result.exported} 张到相册`);
        } else {
          notify('ok', `已导出 ${result.exported} 张到 App 目录`);
        }

        setSheet(null);
        exitSelection();
      } catch (error) {
        notify('danger', `批量导出失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setProgress(null);
      }
    },
    [assets, busy, exitSelection, flushSessions, markStatuses, notify, selected, selectedCount, settings.jpegQuality, settings.exportLongEdge],
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Label>{selecting ? '批量编辑' : '本地图库'}</Label>
          <T variant="title" style={{ marginTop: 6 }}>
            {selecting ? `已选 ${selectedCount} 张` : `${assets.length} 张`}
          </T>
        </View>
        {selecting ? (
          <View style={styles.headerActions}>
            <Pressable onPress={toggleAll} hitSlop={8}>
              <T variant="monoMuted" style={{ color: color.textMuted }}>
                {allSelected ? '取消全选' : '全选'}
              </T>
            </Pressable>
            <Pressable onPress={exitSelection} hitSlop={8} style={styles.doneBtn}>
              <T variant="mono" style={{ fontSize: 12 }}>
                完成
              </T>
            </Pressable>
          </View>
        ) : (
          <View style={styles.headerActions}>
            <T variant="monoMuted">{assets.length ? formatDay(assets[0].capturedAt) : '—'}</T>
            {assets.length ? (
              <Pressable
                onPress={() => setSelecting(true)}
                hitSlop={8}
                style={styles.selectBtn}
                accessibilityRole="button"
                accessibilityLabel="选择照片"
              >
                <Ionicons name="checkmark-circle-outline" size={14} color={color.text} />
                <Text style={styles.selectLabel}>选择</Text>
              </Pressable>
            ) : null}
          </View>
        )}
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: selecting ? 116 : space.huge }}
        showsVerticalScrollIndicator={false}
      >
        {assets.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="images-outline" size={22} color={color.textFaint} />
            <T variant="bodyMuted" style={{ marginTop: space.md }}>
              还没有照片
            </T>
            <T variant="monoMuted" style={{ marginTop: 4, textAlign: 'center' }}>
              连上相机拍一张，或先进入演示模式
            </T>
          </View>
        ) : (
          <View style={styles.grid}>
            {assets.map((asset) => {
              const session = sessions[asset.id];
              const edited = session ? !isSessionNeutral(session) : false;
              const summary = session ? describeSession(session) : '';
              const isSelected = selected.has(asset.id);
              return (
                <Pressable
                  key={asset.id}
                  onPress={() => (selecting ? toggle(asset.id) : openAsset(asset.id))}
                  onLongPress={() => (selecting ? toggle(asset.id) : enterSelection(asset.id))}
                  delayLongPress={380}
                  style={({ pressed }) => [styles.cell, pressed && { opacity: 0.72 }]}
                >
                  <View>
                    <Image
                      source={{ uri: asset.thumbUri ?? asset.uri }}
                      style={styles.image}
                      contentFit="cover"
                      transition={140}
                      recyclingKey={asset.id}
                    />
                    {asset.raw ? (
                      <View style={styles.rawTag} pointerEvents="none">
                        <T variant="mono" style={styles.rawTagText}>
                          RAW
                        </T>
                      </View>
                    ) : null}
                    {selecting ? (
                      <View style={[styles.check, isSelected && styles.checkActive]}>
                        {isSelected ? <Ionicons name="checkmark" size={13} color={color.accentInk} /> : null}
                      </View>
                    ) : null}
                    {selecting && !isSelected ? <View style={styles.dim} pointerEvents="none" /> : null}
                  </View>
                  <View style={styles.cellFooter}>
                    {edited && summary ? (
                      <T variant="mono" style={[styles.cellMono, styles.cellSummary]} numberOfLines={1}>
                        {summary}
                      </T>
                    ) : (
                      // RAW 的宽高来自内嵌预览（1616×1080），标兆像素会误导，只标格式
                      <T variant="mono" style={styles.cellMono} numberOfLines={1}>
                        {asset.raw ? 'ARW' : formatMegapixels(asset.width, asset.height)}
                      </T>
                    )}
                    {asset.raw && edited && summary ? (
                      <T variant="mono" style={[styles.cellMono, styles.cellRaw]} numberOfLines={1}>
                        ARW
                      </T>
                    ) : null}
                    {edited ? <View style={styles.editedDot} /> : null}
                  </View>
                </Pressable>
              );
            })}
          </View>
        )}
      </ScrollView>

      {selecting ? (
        <View style={[styles.batchBar, { paddingBottom: Math.max(insets.bottom, space.sm) }]}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.batchActions}
          >
            <BatchAction icon="color-filter-outline" label="预设" disabled={!selectedCount || busy} onPress={() => setSheet('preset')} />
            <BatchAction
              icon="clipboard-outline"
              label="粘贴调色"
              disabled={!selectedCount || busy || !clipboard}
              onPress={handlePaste}
            />
            <BatchAction icon="arrow-undo-outline" label="重置" disabled={!selectedCount || busy} onPress={handleReset} />
            <BatchAction icon="download-outline" label="导出" disabled={!selectedCount || busy} onPress={() => setSheet('export')} />
            <BatchAction icon="trash-outline" label="删除" tone="danger" disabled={!selectedCount || busy} onPress={handleDelete} />
          </ScrollView>
          <T variant="monoMuted" style={styles.batchHint}>
            {clipboard ? `剪贴板：${clipboard.sourceName}` : '在编辑器里「复制调色」后，可批量粘贴'}
          </T>
        </View>
      ) : null}

      {/* 预设选择 */}
      <Sheet visible={sheet === 'preset'} onClose={() => setSheet(null)} title={`应用预设到 ${selectedCount} 张`}>
        <ScrollView style={{ maxHeight: 420 }} showsVerticalScrollIndicator={false}>
          {presets.map((preset) => (
            <Pressable
              key={preset.id}
              onPress={() => handlePreset(preset.id)}
              style={({ pressed }) => [styles.presetRow, pressed && { opacity: 0.6 }]}
            >
              <View style={{ flex: 1 }}>
                <T variant="body" style={{ fontSize: 14, fontWeight: '600' }}>
                  {preset.name}
                </T>
                <T variant="monoMuted" style={{ marginTop: 2 }} numberOfLines={1}>
                  {preset.description}
                </T>
              </View>
              <Ionicons name="chevron-forward" size={15} color={color.textFaint} />
            </Pressable>
          ))}
        </ScrollView>
        <T variant="monoMuted" style={{ marginTop: space.md }}>
          预设只覆盖调色参数；每张图自己的曲线和 LUT 会保留。编辑状态会自动保存。
        </T>
      </Sheet>

      {/* 批量导出 */}
      <Sheet visible={sheet === 'export'} onClose={() => (busy ? undefined : setSheet(null))} title={`导出 ${selectedCount} 张`}>
        <T variant="monoMuted">
          尺寸 {settings.exportLongEdge === 0 ? '原图' : `长边 ${settings.exportLongEdge}`} · 质量 {settings.jpegQuality}
          {'  '}（在设置里调整）
        </T>
        {progress ? (
          <View style={styles.progressBox}>
            <ActivityIndicator color={color.accent} />
            <View style={{ flex: 1, marginLeft: space.md }}>
              <T variant="mono">
                {progress.done}/{progress.total} · {progress.current || '准备中'}
              </T>
              <View style={styles.progressTrack}>
                <View
                  style={[
                    styles.progressFill,
                    { width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` },
                  ]}
                />
              </View>
            </View>
          </View>
        ) : null}
        <View style={{ gap: space.sm, marginTop: space.lg }}>
          <Pressable
            onPress={() => void runExport(true)}
            disabled={busy}
            style={[styles.exportBtn, styles.exportPrimary, busy && { opacity: 0.4 }]}
          >
            <Ionicons name="images-outline" size={16} color={color.accentInk} />
            <Text style={styles.exportPrimaryLabel}>导出并保存到相册</Text>
          </Pressable>
          <Pressable
            onPress={() => void runExport(false)}
            disabled={busy}
            style={[styles.exportBtn, busy && { opacity: 0.4 }]}
          >
            <Ionicons name="folder-outline" size={16} color={color.text} />
            <Text style={styles.exportLabel}>只存到 App 目录</Text>
          </Pressable>
          {progress ? (
            <Pressable
              onPress={() => {
                cancelRef.current = true;
              }}
              style={styles.cancelBtn}
            >
              <Text style={{ color: color.danger, fontSize: 13, fontWeight: '600' }}>取消剩余</Text>
            </Pressable>
          ) : null}
        </View>
      </Sheet>
    </View>
  );
}

function BatchAction({
  icon,
  label,
  onPress,
  disabled,
  tone = 'normal',
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: 'normal' | 'danger';
}) {
  const tint = tone === 'danger' ? color.danger : color.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.batchAction, disabled && { opacity: 0.3 }, pressed && { opacity: 0.6 }]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Ionicons name={icon} size={17} color={tint} />
      <Text style={[styles.batchLabel, { color: tint }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingHorizontal: space.xl,
    paddingTop: space.lg,
    paddingBottom: space.lg,
  },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingBottom: 4 },
  selectBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 30,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
  },
  selectLabel: { color: color.text, fontSize: 12, fontWeight: '600' },
  doneBtn: {
    height: 30,
    paddingHorizontal: space.md,
    justifyContent: 'center',
    borderRadius: radius.pill,
    backgroundColor: color.accent,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -1.5,
  },
  cell: {
    width: `${100 / COLUMNS}%`,
    padding: 1.5,
  },
  image: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: radius.xs,
    backgroundColor: color.surface,
  },
  dim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: radius.xs,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  check: {
    position: 'absolute',
    top: 5,
    right: 5,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(8,9,10,0.55)',
    borderWidth: 1.2,
    borderColor: 'rgba(255,255,255,0.72)',
  },
  checkActive: {
    backgroundColor: color.accent,
    borderColor: color.accent,
  },
  cellFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 5,
  },
  cellMono: { ...typography.monoMuted, fontSize: 10 },
  cellSummary: { flex: 1, marginRight: 4 },
  rawTag: {
    position: 'absolute',
    left: 6,
    top: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.xs,
    backgroundColor: 'rgba(10,11,12,0.72)',
  },
  rawTagText: { fontSize: 9.5, letterSpacing: 0.6, color: color.accent },
  cellRaw: { marginLeft: 'auto', color: color.textFaint },
  editedDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: color.accent,
    marginRight: 2,
  },
  empty: {
    alignItems: 'center',
    paddingVertical: space.huge * 1.6,
  },
  batchBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(10,11,13,0.97)',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairline,
    paddingTop: space.sm,
  },
  batchActions: { gap: space.sm, paddingHorizontal: space.lg },
  batchAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 38,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
  },
  batchLabel: { fontSize: 12.5, fontWeight: '600' },
  batchHint: { paddingHorizontal: space.lg, paddingTop: 6, fontSize: 10 },
  presetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
  },
  progressBox: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: space.lg,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: color.surface,
  },
  progressTrack: {
    height: 3,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.1)',
    marginTop: 7,
    overflow: 'hidden',
  },
  progressFill: { height: 3, backgroundColor: color.accent },
  exportBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 48,
    borderRadius: radius.md,
    backgroundColor: color.surfaceHi,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
  },
  exportPrimary: { backgroundColor: color.accent, borderColor: color.accent },
  exportLabel: { color: color.text, fontSize: 14, fontWeight: '600' },
  exportPrimaryLabel: { color: color.accentInk, fontSize: 14, fontWeight: '700' },
  cancelBtn: { alignItems: 'center', paddingVertical: space.sm },
});
