import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { boardResponseSchema } from '@crowniq/contracts';
import { Notice, Screen } from '../../../components/Screen';
import { palette } from '../../../theme';
import { useTipFlow } from '../../../components/TipSheet';
import { useAuth } from '../../../auth';

type Preview={legs:{shared:{playerName:string;market:string;threshold:number;
  direction:string;lineType:string};status:'AVAILABLE'|'CHANGED_OR_UNAVAILABLE';
  currentOptions:{lineId:string;threshold:number;lineType:string}[]}[]};
type Crown={createdAt:string;legs:{playerName:string;market:string;exactLine:number;
  direction:string;lineType:string;lineScore:number;grade:string}[]};
export default function PublicCrown(){
  const {request}=useAuth();
  const {id}=useLocalSearchParams<{id:string}>();
  const [crown,setCrown]=useState<Crown|null>(null),[preview,setPreview]=useState<Preview|null>(null),
    [message,setMessage]=useState('Loading public Crown…');
  const tips=useTipFlow(setMessage);
  useEffect(()=>{
    if(!id)return;
    let active=true;
    void Promise.all([request(`/v1/social/crowns/${encodeURIComponent(id)}`),
      request(`/v1/social/crowns/${encodeURIComponent(id)}/import-preview`)])
      .then(async([c,p])=>{if(!c.ok)throw new Error('Crown unavailable.');
        return [await c.json(),p.ok?await p.json():null] as const;})
      .then(([c,p])=>{if(active){setCrown(c);setPreview(p);setMessage('');}})
      .catch(()=>{if(active)setMessage('Public Crown unavailable.');});
    return ()=>{active=false;};
  },[id,request]);
  const addCurrent=async(index:number)=>{
    if(!id)return;
    try {
      // Check both the server's current board and its import preview at tap time.
      // A line visible when this screen opened may have since moved.
      const [currentPreview,currentBoard]=await Promise.all([
        request(`/v1/social/crowns/${encodeURIComponent(id)}/import-preview`),
        request('/v1/board')]);
      if(!currentPreview.ok || !currentBoard.ok)throw new Error('The current board is unavailable. Try again later.');
      const newest:Preview=await currentPreview.json(),data=boardResponseSchema.parse(await currentBoard.json());
      setPreview(newest);
      const leg=newest.legs[index];
      if(!leg || leg.status!=='AVAILABLE'){
        setMessage('Original line no longer available. Choose a current line on the Board.');return;
      }
      const option=leg.currentOptions.find((item)=>item.threshold===leg.shared.threshold &&
        item.lineType===leg.shared.lineType);
      const line=data.board.lines.find((item)=>item.id===option?.lineId),
        analysis=data.analyses.find((item)=>item.lineId===line?.id);
      if(!line || !analysis || analysis.direction!==leg.shared.direction || analysis.direction==='PASS'){
        setMessage('Current GKR decision changed. Check the Board.');return;
      }
      tips.attempt(line,analysis,analysis.direction,'Added the exact current line to your Crown draft.');
    }catch(error){setMessage(error instanceof Error?error.message:'Cannot check the current line.');}
  };
  return <Screen eyebrow="CROWNIQ  /  PUBLIC CROWN" title="Shared Crown">
    <Pressable onPress={()=>router.back()}><Text style={styles.link}>← Back</Text></Pressable>
    {!crown && <Notice title="Public Crown" detail={message} />}
    {crown && <><Text style={styles.note}>Shared {new Date(crown.createdAt).toLocaleString()}. Original lines are preserved.</Text>
      {crown.legs.map((leg,index)=><View key={index} style={styles.card}>
        <Text style={styles.title}>{leg.playerName} · {leg.market}</Text>
        <Text style={styles.note}>Shared: {leg.direction} {leg.exactLine} · {leg.lineType} · GKR {leg.lineScore} · {leg.grade}</Text>
        {preview?.legs[index] && <Text style={styles.note}>Current: {preview.legs[index].status==='AVAILABLE'?'Exact line available':
          `Original line unavailable. Other lines: ${preview.legs[index].currentOptions.map((item)=>`${item.threshold} ${item.lineType}`).join(', ') || 'none'}`}</Text>}
        <Pressable style={styles.button} onPress={()=>void addCurrent(index)}><Text style={styles.link}>Add exact line to my Crown</Text></Pressable>
      </View>)}
      <Text style={styles.note}>Each leg must still pass current GKR and Crown draft checks. Changed lines are never substituted.</Text>
    </>}
    {!!message && crown && <Text accessibilityRole="alert" style={styles.note}>{message}</Text>}
    {tips.sheet}
  </Screen>;
}
const styles=StyleSheet.create({card:{backgroundColor:palette.card,borderColor:palette.border,
  borderWidth:1,borderRadius:16,padding:16,gap:9},title:{color:palette.text,fontWeight:'800',fontSize:16},
  note:{color:palette.muted,fontSize:13,lineHeight:19},link:{color:palette.green,fontWeight:'700'},
  button:{borderWidth:1,borderColor:palette.green,borderRadius:10,padding:12,minHeight:44}});
