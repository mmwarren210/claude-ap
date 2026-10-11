import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { useAuth } from '../auth';
import { colors } from '../theme';

// A member's paid plan (owner, 2026-10-11): the end date in More, and a renewal alert across the app from 3 days before.

export type Paid = { plan: string; label: string; paidAt: string; until: string | null; daysLeft: number | null };

export function usePaidPlan(): Paid | null {
  const { request, profile } = useAuth();
  const [paid, setPaid] = useState<Paid | null>(null);
  const member = !!profile && profile.plan !== 'GUEST' && profile.plan !== 'DEMO';
  useEffect(() => {
    if (!member) return;
    let active = true;
    const load = () => request('/v1/subscription').then(async (response) => response.ok ? (await response.json() as { paid: Paid | null }).paid : null)
      .then((value) => { if (active) setPaid(value); }).catch(() => undefined);
    const first = setTimeout(load, 0), timer = setInterval(load, 60 * 60_000);
    return () => { active = false; clearTimeout(first); clearInterval(timer); };
  }, [member, request]);
  return member ? paid : null;
}

export const endsText = (paid: Paid) => paid.until === null ? `${paid.label} · never ends`
  : `${paid.label} · ends ${new Date(paid.until).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}`
    + (paid.daysLeft !== null ? ` (${paid.daysLeft <= 0 ? 'today' : `${paid.daysLeft} ${paid.daysLeft === 1 ? 'day' : 'days'} left`})` : '');

/** From 3 days before the end: a bar at the top of every tab that opens Subscribe to renew. */
export function RenewalAlert() {
  const paid = usePaidPlan();
  if (!paid || paid.daysLeft === null || paid.daysLeft > 3) return null;
  const when = paid.daysLeft <= 0 ? 'today' : paid.daysLeft === 1 ? 'tomorrow' : `in ${paid.daysLeft} days`;
  return <Pressable accessibilityRole="button" onPress={() => router.push('/subscribe')} style={styles.bar}>
    <Text style={styles.text}>⏳ Your {paid.label.toLowerCase()} plan ends {when}. Renew now so you don’t lose access (allow up to 24 hours for your key) →</Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  bar: { backgroundColor: colors.surface, borderBottomWidth: 1, borderColor: colors.gold, paddingHorizontal: 16, paddingVertical: 10 },
  text: { color: colors.gold, fontWeight: '800', textAlign: 'center' },
});
