import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { StyleSheet } from 'react-native';

import { color, radius, typography } from '@/design/tokens';

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: color.text,
        tabBarInactiveTintColor: color.textFaint,
        tabBarStyle: styles.bar,
        tabBarLabelStyle: styles.label,
        tabBarItemStyle: styles.item,
        tabBarBackground: undefined,
        sceneStyle: { backgroundColor: color.bg },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: '相机',
          tabBarIcon: ({ color: c, focused }) => (
            <Ionicons name={focused ? 'aperture' : 'aperture-outline'} size={21} color={String(c)} />
          ),
        }}
      />
      <Tabs.Screen
        name="gallery"
        options={{
          title: '图库',
          tabBarIcon: ({ color: c, focused }) => (
            <Ionicons name={focused ? 'grid' : 'grid-outline'} size={19} color={String(c)} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: '设置',
          tabBarIcon: ({ color: c, focused }) => (
            <Ionicons name={focused ? 'options' : 'options-outline'} size={20} color={String(c)} />
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: 'rgba(8,9,10,0.94)',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairline,
    height: 58,
    paddingTop: 6,
    paddingBottom: 6,
    elevation: 0,
  },
  label: {
    ...typography.label,
    fontSize: 9.5,
    letterSpacing: 1.1,
    textTransform: 'none',
    marginTop: 2,
  } as never,
  item: {
    borderRadius: radius.sm,
  },
});
