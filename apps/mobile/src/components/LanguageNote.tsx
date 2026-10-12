import { useEffect } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { Text } from './Text';
import { useAuth } from '../auth';
import { dismissLanguagePrompt, getLanguage, languageWasChosen, setLanguage, useLanguage, useLanguagePrompt } from '../i18n';
import type { Language } from '../i18n';
import { colors } from '../theme';

// The language's first-run note and account sync (owner, 2026-10-12). A phone in Spanish opens CrownIQ in Spanish and is
// told once that it can be changed in More › Language. A signed-in account keeps its choice, so another phone opens in it.

/** Saves the language on the account (quietly; the device keeps it either way). */
export async function saveLanguage(request: (path: string, init?: RequestInit) => Promise<Response>, language: Language) {
  await request('/v1/me/language', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ language }) }).catch(() => undefined);
}

export function LanguageNote({ hidden = false }: { hidden?: boolean }) {
  const language = useLanguage(), prompt = useLanguagePrompt();
  const { profile, request, demo } = useAuth();
  // On sign-in: a device that hasn't chosen takes the account's language; a device that has chosen tells the account.
  useEffect(() => {
    if (!profile || demo) return;
    let active = true;
    void request('/v1/me/language').then(async (response) => {
      if (!active || !response.ok) return;
      const saved = (await response.json() as { language: Language | null }).language;
      if (saved && !languageWasChosen()) setLanguage(saved);
      else if (languageWasChosen() && saved !== getLanguage()) void saveLanguage(request, getLanguage());
    }).catch(() => undefined);
    return () => { active = false; };
  }, [profile, demo, request]);
  const open = !hidden && prompt && language === 'es';
  // Written in both languages on purpose: it is the way out for someone who doesn't read Spanish.
  return <Modal visible={open} transparent animationType="fade" onRequestClose={dismissLanguagePrompt}>
    <View style={styles.backdrop}>
      <View style={styles.card}>
        <Text style={styles.title}>CrownIQ está en español</Text>
        <Text style={styles.body}>Tu teléfono está en español, así que CrownIQ también. Puedes cambiar el idioma cuando quieras en Más › Idioma.</Text>
        <Text style={styles.english}>Your phone is set to Spanish. You can switch to English any time in More › Language.</Text>
        <Pressable accessibilityRole="button" style={styles.primary} onPress={dismissLanguagePrompt}><Text style={styles.primaryText}>Entendido</Text></Pressable>
        <Pressable accessibilityRole="button" style={styles.secondary} onPress={() => { setLanguage('en'); if (profile && !demo) void saveLanguage(request, 'en'); }}>
          <Text style={styles.secondaryText}>Use English</Text></Pressable>
      </View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 16, borderWidth: 1, gap: 10, maxWidth: 420, padding: 20, width: '100%' },
  title: { color: colors.text, fontSize: 20, fontWeight: '800' },
  body: { color: colors.text, fontSize: 15, lineHeight: 21 },
  english: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  primary: { alignItems: 'center', backgroundColor: colors.mint, borderRadius: 999, marginTop: 6, paddingVertical: 12 },
  primaryText: { color: colors.mintInk, fontSize: 15, fontWeight: '800' },
  secondary: { alignItems: 'center', paddingVertical: 8 },
  secondaryText: { color: colors.mint, fontSize: 14, fontWeight: '700' },
});
