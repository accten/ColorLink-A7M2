import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { NoticeHost } from '@/components/NoticeHost';
import { color } from '@/design/tokens';
import { useAppStore } from '@/state/useAppStore';

export { ErrorBoundary } from 'expo-router';

export const unstable_settings = {
  anchor: '(tabs)',
};

SplashScreen.preventAutoHideAsync().catch(() => {
  // 忽略：热重载时可能已经隐藏
});

const theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: color.bg,
    card: color.bg,
    text: color.text,
    border: color.hairline,
    primary: color.accent,
    notification: color.accent,
  },
};

export default function RootLayout() {
  const ready = useAppStore((s) => s.ready);
  const init = useAppStore((s) => s.init);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => {});
  }, [ready]);

  return (
    <SafeAreaProvider>
      <ThemeProvider value={theme}>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: color.bg },
            animation: 'fade',
          }}
        >
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="live" options={{ animation: 'fade', presentation: 'fullScreenModal' }} />
          <Stack.Screen name="editor/[id]" options={{ animation: 'slide_from_right' }} />
        </Stack>
        <NoticeHost />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
