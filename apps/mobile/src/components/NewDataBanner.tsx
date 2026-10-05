import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../auth';
import { colors, radius } from '../theme';
import { Icon } from './ui/Icon';

// When a new GKR play or a new Scout read lands while the app is open, a banner says so; tapping it reloads.

export function NewDataBanner() {
  const { request, demo, profile } = useAuth();
  const insets = useSafeAreaInsets();
  const seen = useRef<string | null>(null);
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    if (demo || !profile) return;
    let active = true;
    const check = () => void request('/v1/data-version').then(async (response) => {
      if (!response.ok || !active) return;
      const { version } = await response.json() as { version: string };
      if (seen.current === null) seen.current = version;
      else if (version !== seen.current) setFresh(true);
    }).catch(() => undefined);
    check();
    const timer = setInterval(check, 60_000);
    return () => { active = false; clearInterval(timer); };
  }, [request, demo, profile]);
  if (!fresh) return null;
  const refresh = () => {
    if (Platform.OS === 'web' && typeof window !== 'undefined') { window.location.reload(); return; }
    seen.current = null; setFresh(false);
  };
  return <Pressable accessibilityRole="button" accessibilityLabel="New data available. Refresh" onPress={refresh}
    style={[styles.banner, { top: insets.top + 8 }]}>
    <Icon name="refresh" size={18} color={colors.mintInk} />
    <Text style={styles.text}>New picks and Scout reads are in · Tap to refresh</Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  banner: { position: 'absolute', left: 16, right: 16, zIndex: 50, flexDirection: 'row', alignItems: 'center', gap: 8,
    justifyContent: 'center', backgroundColor: colors.mint, borderRadius: radius.pill, paddingVertical: 10, paddingHorizontal: 16,
    shadowColor: colors.mint, shadowOpacity: 0.6, shadowRadius: 14, shadowOffset: { width: 0, height: 0 }, elevation: 6 },
  text: { color: colors.mintInk, fontSize: 14, fontWeight: '900' },
});
