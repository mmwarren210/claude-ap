import { useEffect, useState } from 'react';
import type { Href } from 'expo-router';
import { router } from 'expo-router';
import { Pressable } from 'react-native';
import { Text } from './Text';
import { useAuth } from '../auth';
import { colors } from '../theme';

/** The server's notice for every member (CROWNIQ_NOTICE), e.g. "Lines are updating"; nothing when there is none. */
export function NoticeBanner() {
  const { request, profile } = useAuth();
  const [message, setMessage] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const signedIn = !!profile;
  useEffect(() => {
    if (!signedIn) return;
    let active = true;
    const load = () => void request('/v1/notice').then(async (response) => response.ok ? await response.json() as { message: string | null; link?: string | null } : null)
      .then((notice) => { if (active) { setMessage(notice?.message ?? null); setLink(notice?.link ?? null); } }).catch(() => undefined);
    load();
    const timer = setInterval(load, 60_000);
    return () => { active = false; clearInterval(timer); };
  }, [request, signedIn]);
  if (!message) return null;
  return <Pressable accessibilityRole={link ? 'link' : undefined} disabled={!link} onPress={() => { if (link) router.push(link as Href); }}
    style={{ backgroundColor: colors.gold ?? '#d4a017', paddingHorizontal: 16, paddingVertical: 8, paddingTop: 40 }}>
    <Text style={{ color: '#111', fontWeight: '800', textAlign: 'center' }}>{message}{link ? '  →' : ''}</Text>
  </Pressable>;
}
