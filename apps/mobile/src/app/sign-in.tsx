import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Screen } from '../components/Screen';
import { palette } from '../theme';
import { useAuth } from '../auth';

export default function SignIn(){
  const {login,register}=useAuth();
  const [creating,setCreating]=useState(true),[username,setUsername]=useState(''),
    [email,setEmail]=useState(''),[password,setPassword]=useState(''),
    [busy,setBusy]=useState(false),[error,setError]=useState('');
  const submit=async()=>{
    setBusy(true);setError('');
    try{if(creating)await register(username.trim(),email.trim(),password);
      else await login(email.trim(),password);}
    catch(failure){setError(failure instanceof Error?failure.message:'Could not sign in.');}
    finally{setBusy(false);}
  };
  return <Screen eyebrow="CROWNIQ  /  YOUR ACCOUNT" title={creating?'Create your profile':'Welcome back'}>
    <Text style={styles.detail}>Your display name, saved picks and private Crowns belong to your profile.
      No invitation code is required.</Text>
    {creating && <View><Text style={styles.label}>Display username</Text>
      <TextInput accessibilityLabel="Display username" autoCapitalize="none" autoCorrect={false}
        autoComplete="username-new" value={username} onChangeText={setUsername}
        placeholder="Choose a username" placeholderTextColor={palette.muted} style={styles.input} /></View>}
    <View><Text style={styles.label}>Email</Text><TextInput accessibilityLabel="Email"
      autoCapitalize="none" autoCorrect={false} autoComplete="email" keyboardType="email-address"
      value={email} onChangeText={setEmail} placeholder="you@example.com"
      placeholderTextColor={palette.muted} style={styles.input} /></View>
    <View><Text style={styles.label}>Password</Text><TextInput accessibilityLabel="Password"
      secureTextEntry autoComplete={creating?'new-password':'current-password'}
      value={password} onChangeText={setPassword} placeholder={creating?'At least 12 characters':'Your password'}
      placeholderTextColor={palette.muted} style={styles.input} /></View>
    {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    <Pressable accessibilityRole="button" disabled={busy} onPress={()=>void submit()}
      style={[styles.button,busy&&styles.disabled]}>
      {busy?<ActivityIndicator color={palette.background}/>:<Text style={styles.buttonText}>
        {creating?'Create profile':'Sign in'}</Text>}
    </Pressable>
    <Pressable accessibilityRole="button" onPress={()=>{setCreating(!creating);setError('');}}
      style={styles.switch}><Text style={styles.switchText}>
      {creating?'Already have a profile? Sign in':'New to CrownIQ? Create a profile'}</Text></Pressable>
    <Text style={styles.note}>Google and Apple sign-in will appear after their provider credentials and native modules are configured.</Text>
  </Screen>;
}
const styles=StyleSheet.create({detail:{color:palette.muted,fontSize:15,lineHeight:23,marginBottom:12},
  label:{color:palette.text,fontWeight:'700',marginBottom:8,fontSize:14},
  input:{backgroundColor:palette.card,borderColor:palette.border,borderWidth:1,borderRadius:14,
    color:palette.text,fontSize:16,padding:16,minHeight:52},error:{color:palette.danger,fontSize:14},
  button:{backgroundColor:palette.green,borderRadius:14,minHeight:52,alignItems:'center',
    justifyContent:'center',marginTop:10},disabled:{opacity:0.6},
  buttonText:{color:palette.background,fontSize:16,fontWeight:'800'},
  switch:{minHeight:44,justifyContent:'center',alignItems:'center'},
  switchText:{color:palette.green,fontWeight:'700'},note:{color:palette.muted,fontSize:12,lineHeight:19}});
