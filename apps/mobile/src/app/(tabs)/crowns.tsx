import { Share, Pressable, StyleSheet, Text } from 'react-native';
import { useState } from 'react';
import { Notice, Screen } from '../../components/Screen';
import { useDraft } from '../../use-draft';
import { shareCrown } from '../../state';
import { palette } from '../../theme';
import { useAuth } from '../../auth';

export default function CrownsScreen() {
  const {request}=useAuth();
  const {legs,remove}=useDraft();
  const [message,setMessage]=useState('');
  const savePrivate=async()=>{
    try{const response=await request('/v1/me/crowns',{method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({lineIds:legs.map((leg)=>leg.line.id)})});
      setMessage(response.ok?'Saved privately to your profile. View it in My Picks.':
        'Could not validate this Crown. Refresh the Board and check its current lines.');
    }catch{setMessage('Could not save this Crown. Your device draft remains available.');}
  };
  const shareToSocial=async()=>{
    try {const response=await request('/v1/social/crowns',
      {method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({lineIds:legs.map((leg)=>leg.line.id)})});
      setMessage(response.ok?'Shared to Social.':'Social sharing requires a signed-in account and current valid lines.');
    }catch{setMessage('Unable to reach Social. Your Crown draft is still private.');}
  };
  return <Screen eyebrow="CROWNIQ  /  BUILDER" title="Crowns">
    <Notice title={`${legs.length} draft ${legs.length===1?'leg':'legs'}`}
      detail="This draft is private to your profile on this device. Save it to your profile after server validation to access it on other devices." />
    {legs.map((leg)=><Pressable key={leg.line.id} style={styles.leg} accessibilityRole="button"
      onPress={()=>remove(leg.line.id)} accessibilityLabel={`Remove ${leg.line.playerName}`}>
      <Text style={styles.name}>{leg.line.playerName} · {leg.line.market}</Text>
      <Text style={styles.detail}>{leg.direction} {leg.line.threshold} · {leg.line.lineType} · GKR {leg.score} · Remove</Text>
    </Pressable>)}
    {!!legs.length && <Pressable style={styles.leg} onPress={()=>void Share.share({message:shareCrown(legs)})}>
      <Text style={styles.name}>Share Crown draft</Text></Pressable>}
    {legs.length>=2 && <Pressable style={styles.leg} onPress={()=>void savePrivate()}>
      <Text style={styles.name}>Save private Crown</Text></Pressable>}
    {legs.length>=2 && <Pressable style={styles.leg} onPress={()=>void shareToSocial()}>
      <Text style={styles.name}>Share to Social (public)</Text></Pressable>}
    {!!message && <Text accessibilityRole="alert" style={styles.detail}>{message}</Text>}
  </Screen>;
}
const styles=StyleSheet.create({leg:{padding:16,borderWidth:1,borderColor:palette.border,
  backgroundColor:palette.card,borderRadius:16,minHeight:56,gap:6},
  name:{color:palette.text,fontWeight:'700'},detail:{color:palette.muted,fontSize:12}});
