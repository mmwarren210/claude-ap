import { Tabs } from 'expo-router';
import { Text } from 'react-native';
import type { ColorValue } from 'react-native';
import { CrownTray } from '../../components/CrownTray';

function Icon({ glyph, color }: { glyph: string; color: ColorValue }) {
  return <Text style={{ color, fontSize: 22, fontWeight: '700' }}>{glyph}</Text>;
}

export default function TabLayout() {
  return <><Tabs screenOptions={{ headerShown: false, tabBarActiveTintColor: '#A9F35C',
    tabBarInactiveTintColor: '#788879', tabBarStyle: { backgroundColor: '#101812', borderTopColor: '#25352A' },
    tabBarLabelStyle: { fontSize: 10, fontWeight: '700' } }}>
    <Tabs.Screen name="index" options={{ title: 'Board', tabBarIcon: ({ color }) => <Icon glyph="▣" color={color} /> }} />
    <Tabs.Screen name="edge" options={{ title: 'Edge', tabBarIcon: ({ color }) => <Icon glyph="◆" color={color} /> }} />
    <Tabs.Screen name="rankings" options={{ title: 'Rankings', tabBarIcon: ({ color }) => <Icon glyph="▥" color={color} /> }} />
    <Tabs.Screen name="crowns" options={{ title: 'Crowns', tabBarIcon: ({ color }) => <Icon glyph="♛" color={color} /> }} />
    <Tabs.Screen name="social" options={{ title: 'Social', tabBarIcon: ({ color }) => <Icon glyph="◉" color={color} /> }} />
    <Tabs.Screen name="picks" options={{ title: 'My Picks', tabBarIcon: ({ color }) => <Icon glyph="✓" color={color} /> }} />
    <Tabs.Screen name="settings" options={{ href:null,title:'Settings' }} />
  </Tabs><CrownTray /></>;
}
