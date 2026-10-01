import { useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, TextInput } from 'react-native';
import { router } from 'expo-router';
import { Notice, Screen } from '../../components/Screen';
import { palette } from '../../theme';
import { useAuth } from '../../auth';
import { useDraft } from '../../use-draft';
import { ViewModeSwitch } from '../../components/ViewModeSwitch';

const helpUrl = 'https://www.ncpgambling.org/help-treatment/about-the-national-problem-gambling-helpline/';

export default function SettingsScreen() {
  const {profile,logout,request,setUsername}=useAuth();
  const {viewMode,setViewMode,ready}=useDraft();
  const [name,setName]=useState(profile?.username??''),[message,setMessage]=useState('');
  const [ownerResearch,setOwnerResearch]=useState(false);
  useEffect(()=>{
    let active=true;
    void request('/v1/owner/research/status').then((response)=>{
      if(active)setOwnerResearch(response.ok);
    }).catch(()=>{if(active)setOwnerResearch(false);});
    return ()=>{active=false;};
  },[profile?.publicId,request]);
  const rename=async()=>{
    try{const response=await request('/v1/social/profile',{method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify({displayName:name.trim()})});
      if(!response.ok)throw new Error('Taken or invalid');
      setUsername(name.trim());setMessage('Display username updated.');}
    catch{setMessage('That username is unavailable. Try a different one.');}
  };
  return <Screen eyebrow="CROWNIQ  /  ACCOUNT" title="Settings">
    <Notice title={profile?.username??'Your profile'}
      detail={`${profile?.email??'Provider sign-in'} · ${profile?.plan??'FREE'} plan · Saved picks are private unless you share a Crown to Social.`} />
    <Text selectable style={styles.note}>Your profile ID: {profile?.publicId}</Text>
    {ownerResearch && <>
      <Pressable accessibilityRole="button"
        accessibilityLabel="Open owner board analysis"
        onPress={()=>router.push('../owner/board')} style={styles.link}>
        <Text style={styles.linkTitle}>Owner Board Analysis →</Text>
        <Text style={styles.linkDetail}>Refresh GKR research against the saved board with 0 Odds API credits.</Text>
      </Pressable>
      <Pressable accessibilityRole="button"
        accessibilityLabel="Open private owner research desk"
        onPress={()=>router.push('/owner/research')} style={styles.link}>
        <Text style={styles.linkTitle}>Owner Research Desk →</Text>
        <Text style={styles.linkDetail}>Private stat-api research and usage. Separate from the public board.</Text>
      </Pressable>
      <Pressable accessibilityRole="button"
        accessibilityLabel="Open owner learning diagnostics"
        onPress={()=>router.push('../owner/learning')} style={styles.link}>
        <Text style={styles.linkTitle}>Owner Learning →</Text>
        <Text style={styles.linkDetail}>Tracked outcome and calibration diagnostics. Read-only; model weights never change automatically.</Text>
      </Pressable>
    </>}
    <Text style={styles.label}>Board view</Text>
    {ready && <ViewModeSwitch value={viewMode} onChange={setViewMode} />}
    <Text style={styles.note}>Lite shows the top qualified lines. Full shows the entire board and detailed analysis. Your choice is saved for this profile on this device.</Text>
    <Text style={styles.label}>Display username</Text>
    <TextInput accessibilityLabel="Display username" autoCapitalize="none" autoCorrect={false}
      value={name} onChangeText={setName} style={styles.input}
      placeholderTextColor={palette.muted} placeholder="Your public username" />
    <Pressable accessibilityRole="button" onPress={()=>void rename()} style={styles.link}>
      <Text style={styles.linkTitle}>Update display username</Text></Pressable>
    {!!message && <Text accessibilityRole="alert" style={styles.note}>{message}</Text>}
    <Pressable accessibilityRole="button" onPress={()=>void logout()} style={styles.link}>
      <Text style={styles.linkTitle}>Sign out</Text></Pressable>
    <Notice title="Play responsibly" detail="CrownIQ analysis is uncertain. No selection is guaranteed. Set limits and take a break when you need one." />
    <Pressable onPress={() => Linking.openURL(helpUrl)} style={styles.link}>
      <Text style={styles.linkTitle}>Get confidential help ↗</Text>
      <Text style={styles.linkDetail}>Call or text 1-800-MY-RESET · National Problem Gambling Helpline</Text>
    </Pressable>
    <Text style={styles.note}>The owner console is separate from this public app.</Text>
  </Screen>;
}

const styles = StyleSheet.create({
  link: { padding: 18, borderColor: palette.green, borderWidth: 1, borderRadius: 18,
    backgroundColor: palette.greenDim, gap: 8 },
  linkTitle: { color: palette.green, fontSize: 16, fontWeight: '800' },
  linkDetail: { color: palette.text, fontSize: 13, lineHeight: 20 },
  note: { color: palette.muted, fontSize: 12, marginTop: 10 },
  label:{color:palette.text,fontSize:14,fontWeight:'700'},
  input:{borderColor:palette.border,borderWidth:1,borderRadius:12,color:palette.text,
    backgroundColor:palette.card,padding:14,minHeight:48},
});
