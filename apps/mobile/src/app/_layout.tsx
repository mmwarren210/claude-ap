import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { BoardProvider } from '../use-board';
import { DraftProvider } from '../use-draft';
import { AuthProvider, useAuth } from '../auth';
import { colors } from '../theme';
import { SetPassword } from '../components/SetPassword';
import { useAutoUpdate } from '../auto-update';
import { IntroSplash } from '../components/IntroSplash';
import { useState } from 'react';
import { View } from 'react-native';

const crownTheme = {
  ...DarkTheme,
  colors: { ...DarkTheme.colors, background: colors.background, card: colors.surface, primary: colors.mint,
    text: colors.text, border: colors.border },
};

function ProfileRouter(){
  const {profile}=useAuth();
  const navigator=<Stack screenOptions={{headerShown:false}}>
      <Stack.Protected guard={!!profile}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="player/[lineId]" />
        <Stack.Screen name="edge/[lineId]" />
        <Stack.Screen name="tips" />
        <Stack.Screen name="social/[publicId]" />
        <Stack.Screen name="social/crown/[id]" />
        <Stack.Screen name="owner/board" />
        <Stack.Screen name="owner/research" />
        <Stack.Screen name="owner/learning" />
      </Stack.Protected>
      <Stack.Protected guard={!profile}><Stack.Screen name="sign-in" /></Stack.Protected>
    </Stack>;
  // A family member who signed in with the shared code sets their own password before anything else.
  if(profile?.mustChangePassword)return <SetPassword />;
  return profile?<BoardProvider key={profile.publicId}><DraftProvider key={profile.publicId} profileId={profile.publicId}>
    {navigator}
  </DraftProvider></BoardProvider>:navigator;
}
// The opening plays once each time the app opens (not on every screen change).
let introPlayed = false;

export default function RootLayout() {
  useAutoUpdate();
  const [intro, setIntro] = useState(!introPlayed);
  return <ThemeProvider value={crownTheme}>
    <StatusBar style="light" />
    <View style={{ flex: 1 }}>
      <AuthProvider><ProfileRouter /></AuthProvider>
      {intro && <IntroSplash onDone={() => { introPlayed = true; setIntro(false); }} />}
    </View>
  </ThemeProvider>;
}
