import { useFocusEffect, router } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Notice, Screen } from '../../components/Screen';
import { useAuth } from '../../auth';
import { palette } from '../../theme';

type Pick={id:string;playerName:string;market:string;sport:string;threshold:number;
  direction:string;lineType:string;lineScore:number;result:string;actual:number|null};
type Crown={id:string;savedAt:string;legs:{playerName:string;market:string;threshold:number;
  direction:string;score:number;grade:string}[]};
export default function PicksScreen(){
  const {request}=useAuth();
  const [picks,setPicks]=useState<Pick[]>([]),[crowns,setCrowns]=useState<Crown[]>([]),
    [busy,setBusy]=useState(true),[notice,setNotice]=useState('');
  const refresh=useCallback(async()=>{
    setBusy(true);
    try{const responses=await Promise.all([request('/v1/me/picks?limit=50'),
      request('/v1/me/crowns')]);
      if(responses.some((item)=>!item.ok))throw new Error('Could not load saved picks.');
      const [selected,saved]=await Promise.all(responses.map((item)=>item.json())) as
        [{picks:Pick[]},{crowns:Crown[]}];
      setPicks(selected.picks);setCrowns(saved.crowns);setNotice('');
    }catch{setNotice('Could not reach your saved picks. Reconnect and try again.');}
    finally{setBusy(false);}
  },[request]);
  useFocusEffect(useCallback(()=>{void refresh();},[refresh]));
  const remove=async(path:string)=>{
    try{const response=await request(path,{method:'DELETE'});
      if(!response.ok)throw new Error('Remove failed');await refresh();}
    catch{setNotice('Could not remove that saved item. Try again.');}
  };
  return <Screen eyebrow="CROWNIQ  /  YOUR RECORD" title="My Picks">
    <Text style={styles.note}>Saved privately to your profile. Your Crown draft stays on this device until you save it here.</Text>
    <Pressable accessibilityRole="button" onPress={()=>void refresh()} style={styles.action}>
      <Text style={styles.link}>Refresh saved picks</Text></Pressable>
    {!!notice && <Text accessibilityRole="alert" style={styles.warning}>{notice}</Text>}
    {busy && <Notice title="Loading your picks" detail="Retrieving your private record." />}
    {!busy && !picks.length && !crowns.length && !notice &&
      <Notice title="No saved selections yet" detail="Tap Save pick on the Board, or save a validated Crown from the Crowns tab." />}
    {picks.length>0 && <Text style={styles.heading}>Selections</Text>}
    {picks.map((pick)=><View key={pick.id} style={styles.card}>
      <Text style={styles.title}>{pick.playerName} · {pick.market}</Text>
      <Text style={styles.note}>{pick.sport} · {pick.direction} {pick.threshold} · {pick.lineType} · GKR {pick.lineScore}</Text>
      <Text style={styles.note}>{pick.result}{pick.actual!==null?` · Actual ${pick.actual}`:''}</Text>
      <Pressable accessibilityRole="button" onPress={()=>void remove(`/v1/me/picks/${pick.id}`)}>
        <Text style={styles.link}>Remove from My Picks</Text></Pressable>
    </View>)}
    {crowns.length>0 && <Text style={styles.heading}>Saved private Crowns</Text>}
    {crowns.map((crown)=><View key={crown.id} style={styles.card}>
      <Text style={styles.title}>{crown.legs.length}-leg Crown · {new Date(crown.savedAt).toLocaleDateString()}</Text>
      {crown.legs.map((leg,index)=><Text key={index} style={styles.note}>
        {leg.playerName} · {leg.market} {leg.direction} {leg.threshold} · GKR {leg.score} · {leg.grade}
      </Text>)}
      <Pressable accessibilityRole="button" onPress={()=>void remove(`/v1/me/crowns/${crown.id}`)}>
        <Text style={styles.link}>Remove private Crown</Text></Pressable>
    </View>)}
    <Pressable accessibilityRole="button" onPress={()=>router.push('/(tabs)/more')}>
      <Text style={styles.link}>Profile settings →</Text></Pressable>
  </Screen>;
}
const styles=StyleSheet.create({card:{backgroundColor:palette.card,borderColor:palette.border,
  borderWidth:1,borderRadius:16,padding:16,gap:9},title:{color:palette.text,fontSize:16,fontWeight:'800'},
  note:{color:palette.muted,fontSize:13,lineHeight:19},heading:{color:palette.text,fontSize:19,fontWeight:'800'},
  link:{color:palette.green,fontWeight:'700'},warning:{color:palette.danger},
  action:{padding:12,borderColor:palette.border,borderWidth:1,borderRadius:12,minHeight:44}});
