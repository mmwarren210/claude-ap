import { Tabs } from 'expo-router';
import type { ColorValue } from 'react-native';
import type { IconName } from '../../components/ui/Icon';
import { Icon } from '../../components/ui/Icon';
import { colors } from '../../theme';
import { useDraft } from '../../use-draft';
import { useIsOwner } from '../../use-owner';

function TabIcon({ name, active, color, focused }: { name: IconName; active: IconName; color: ColorValue;
  focused: boolean }) {
  return <Icon name={focused ? active : name} size={24} color={String(color)} />;
}
const icon = (name: IconName, active: IconName) => function tabIcon({ color, focused }: { color: ColorValue;
  focused: boolean }) { return <TabIcon name={name} active={active} color={color} focused={focused} />; };

export default function TabLayout() {
  const { legs } = useDraft();
  const owner = useIsOwner();
  return <Tabs screenOptions={{ headerShown: false, tabBarActiveTintColor: colors.mint,
    tabBarInactiveTintColor: colors.textMuted,
    tabBarStyle: { backgroundColor: colors.background, borderTopColor: colors.border },
    tabBarLabelStyle: { fontSize: 10, fontWeight: '700' },
    tabBarBadgeStyle: { backgroundColor: colors.mint, color: colors.mintInk, fontWeight: '900', fontSize: 11 } }}>
    <Tabs.Screen name="index" options={{ title: 'Board', tabBarIcon: icon('view-grid-outline', 'view-grid') }} />
    <Tabs.Screen name="top-picks" options={{ title: 'Top Picks', tabBarIcon: icon('star-outline', 'star') }} />
    <Tabs.Screen name="crown" options={{ title: 'Crown', tabBarIcon: icon('crown-outline', 'crown'),
      tabBarBadge: legs.length ? legs.length : undefined }} />
    <Tabs.Screen name="edge" options={{ title: 'Edge', tabBarIcon: icon('diamond-outline', 'diamond') }} />
    <Tabs.Screen name="results" options={{ title: 'Results', tabBarIcon: icon('chart-bar', 'chart-bar') }} />
    {/* Tips is owner-only for now; everyone else keeps the Social tab. */}
    <Tabs.Screen name="tips" options={{ href: owner ? undefined : null, title: 'Tips', tabBarIcon: icon('lightbulb-outline', 'lightbulb') }} />
    <Tabs.Screen name="social" options={{ href: owner ? null : undefined, title: 'Social', tabBarIcon: icon('account-group-outline', 'account-group') }} />
    <Tabs.Screen name="more" options={{ title: 'More', tabBarIcon: icon('menu', 'menu') }} />
  </Tabs>;
}
