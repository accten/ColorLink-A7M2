import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { Href, router } from 'expo-router';
import React, { useCallback } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';

import { formatDay, formatMegapixels } from '@/core/asset';
import { describeParams } from '@/core/params';
import { Label, Screen, T } from '@/design/ui';
import { color, radius, space, typography } from '@/design/tokens';
import { useAppStore } from '@/state/useAppStore';

const COLUMNS = 3;

export default function GalleryScreen() {
  const assets = useAppStore((s) => s.assets);
  const sessions = useAppStore((s) => s.sessions);
  const remove = useAppStore((s) => s.deleteAsset);

  const openAsset = useCallback((id: string) => {
    router.push(`/editor/${id}` as Href);
  }, []);

  const askDelete = useCallback(
    (id: string, fileName: string) => {
      Alert.alert('删除这张照片？', `${fileName}\n只删手机上的副本，相机内的文件不受影响。`, [
        { text: '取消', style: 'cancel' },
        { text: '删除', style: 'destructive', onPress: () => void remove(id) },
      ]);
    },
    [remove],
  );

  return (
    <Screen scroll>
      <View style={styles.header}>
        <View>
          <Label>本地图库</Label>
          <T variant="title" style={{ marginTop: 6 }}>
            {assets.length} 张
          </T>
        </View>
        <T variant="monoMuted">{assets.length ? formatDay(assets[0].capturedAt) : '—'}</T>
      </View>

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
            const edited = session && describeParams(session.params) !== '原图';
            return (
              <Pressable
                key={asset.id}
                onPress={() => openAsset(asset.id)}
                onLongPress={() => askDelete(asset.id, asset.fileName)}
                delayLongPress={420}
                style={({ pressed }) => [styles.cell, pressed && { opacity: 0.72 }]}
              >
                <Image
                  source={{ uri: asset.thumbUri ?? asset.uri }}
                  style={styles.image}
                  contentFit="cover"
                  transition={140}
                  recyclingKey={asset.id}
                />
                <View style={styles.cellFooter}>
                  <T variant="mono" style={styles.cellMono} numberOfLines={1}>
                    {formatMegapixels(asset.width, asset.height)}
                  </T>
                  {edited ? <View style={styles.editedDot} /> : null}
                </View>
              </Pressable>
            );
          })}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingTop: space.lg,
    paddingBottom: space.xl,
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
  cellFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 5,
  },
  cellMono: { ...typography.monoMuted, fontSize: 10 },
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
});
