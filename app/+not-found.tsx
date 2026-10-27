import { Link, Stack } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { Button, T } from '@/design/ui';
import { color, space } from '@/design/tokens';

export default function NotFoundScreen() {
  return (
    <>
      <Stack.Screen options={{ title: '页面不存在' }} />
      <View style={styles.container}>
        <T variant="title">这里什么都没有</T>
        <T variant="monoMuted" style={{ marginTop: space.sm, textAlign: 'center' }}>
          可能是照片已被删除，或者链接过期了。
        </T>
        <Link href="/" asChild>
          <Button title="回到相机" onPress={() => {}} variant="secondary" style={{ marginTop: space.xl }} />
        </Link>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    backgroundColor: color.bg,
  },
});
