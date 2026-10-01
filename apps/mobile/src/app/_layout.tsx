import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { BoardProvider } from '../use-board';
import { DraftProvider } from '../use-draft';
import { AuthProvider, useAuth } from '../auth';

const crownTheme = {
  ...DarkTheme,
  colors: { ...DarkTheme.colors, background: '#090E0B', card: '#111A14', primary: '#A9F35C', text: '#F3F7F0' },
};

function ProfileRouter(){
  const {profile}=useAuth();
  const navigator=<Stack screenOptions={{headerShown:false}}>
      <Stack.Protected guard={!!profile}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="player/[lineId]" />
        <Stack.Screen name="social/[publicId]" />
        <Stack.Screen name="social/crown/[id]" />
        <Stack.Screen name="owner/board" />
        <Stack.Screen name="owner/research" />
        <Stack.Screen name="owner/learning" />
      </Stack.Protected>
      <Stack.Protected guard={!profile}><Stack.Screen name="sign-in" /></Stack.Protected>
    </Stack>;
  return profile?<BoardProvider><DraftProvider key={profile.publicId} profileId={profile.publicId}>
    {navigator}
  </DraftProvider></BoardProvider>:navigator;
}
export default function RootLayout() {
  return <ThemeProvider value={crownTheme}>
    <StatusBar style="light" />
    <AuthProvider><ProfileRouter /></AuthProvider>
  </ThemeProvider>;
}
