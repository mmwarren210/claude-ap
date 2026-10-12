import { Tabs } from 'expo-router';
import type { ColorValue } from 'react-native';
import type { IconName } from '../../components/ui/Icon';
import { Icon } from '../../components/ui/Icon';
import { colors } from '../../theme';
import { useDraft } from '../../use-draft';
import { useGkrPlusAccess } from '../../use-gkr-plus';
import { View } from 'react-native';
import { NoticeBanner } from '../../components/NoticeBanner';
import { TrialPollCard } from '../../components/TrialPoll';
import { RenewalAlert } from '../../components/PlanStatus';
import { CreateLoginAlert } from '../../components/CreateLogin';
import { t, useLanguage } from '../../i18n';

function TabIcon({ name, active, color, focused }: { name: IconName; active: IconName; color: ColorValue;
  focused: boolean }) {
  return <Icon name={focused ? active : name} size={24} color={String(color)} />;
}
const icon = (name: IconName, active: IconName) => function tabIcon({ color, focused }: { color: ColorValue;
  focused: boolean }) { return <TabIcon name={name} active={active} color={color} focused={focused} />; };

const SHORT_ES: Readonly<Record<string, string>> = { Board: 'Líneas', 'Top Picks': 'Top', Vetted: 'Verif.', Results: 'Récord' };

export default function TabLayout() {
  const { legs } = useDraft();
  const gkrPlus = useGkrPlusAccess();
  // Tab names follow the chosen language (short Spanish names so they fit under the icons).
  const language = useLanguage();
  const tab = (english: string) => language === 'es' ? SHORT_ES[english] ?? t(english, language) : english;
  return <View style={{ flex: 1 }}><NoticeBanner /><TrialPollCard /><RenewalAlert /><CreateLoginAlert /><Tabs screenOptions={{ headerShown: false, tabBarActiveTintColor: colors.mint,
    tabBarInactiveTintColor: colors.textMuted,
    tabBarStyle: { backgroundColor: colors.background, borderTopColor: colors.border },
    tabBarLabelStyle: { fontSize: 10, fontWeight: '700' },
    tabBarBadgeStyle: { backgroundColor: colors.mint, color: colors.mintInk, fontWeight: '900', fontSize: 11 } }}>
    <Tabs.Screen name="index" options={{ title: tab('Board'), tabBarIcon: icon('view-grid-outline', 'view-grid') }} />
    <Tabs.Screen name="top-picks" options={{ title: tab('Top Picks'), tabBarIcon: icon('star-outline', 'star') }} />
    <Tabs.Screen name="vetted" options={{ title: tab('Vetted'), tabBarIcon: icon('check-decagram-outline', 'check-decagram') }} />
    <Tabs.Screen name="crown" options={{ title: tab('Crown'), tabBarIcon: icon('crown-outline', 'crown'),
      tabBarBadge: legs.length ? legs.length : undefined }} />
    <Tabs.Screen name="edge" options={{ title: tab('Edge'), tabBarIcon: icon('diamond-outline', 'diamond') }} />
    <Tabs.Screen name="results" options={{ title: tab('Results'), tabBarIcon: icon('chart-bar', 'chart-bar') }} />
    {/* GKR+ (Edge + history + GKR): the owner's test model, also for accounts unlocked in More › Secrets. */}
    <Tabs.Screen name="gkr-plus" options={{ href: gkrPlus ? undefined : null, title: tab('GKR+'), tabBarIcon: icon('flask-outline', 'flask') }} />
    {/* The Tips tab was folded into Vetted (owner, 2026-10-11): screenshots are submitted there by everyone. */}
    <Tabs.Screen name="social" options={{ title: tab('Social'), tabBarIcon: icon('account-group-outline', 'account-group') }} />
    <Tabs.Screen name="more" options={{ title: tab('More'), tabBarIcon: icon('menu', 'menu') }} />
  </Tabs></View>;
}
