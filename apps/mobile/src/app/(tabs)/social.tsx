import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { Notice, Screen } from '../../components/Screen';
import { palette } from '../../theme';
import { useAuth } from '../../auth';

type User={publicId:string;displayName:string;wins:number;losses:number;pushes:number;
  graded:number;hitRate:number|null};
type Crown={publicCrownId:string;ownerPublicId:string;createdAt:string;legs:{playerName:string;
  market:string;direction:string;exactLine:number}[]};
export default function SocialScreen(){
  const {request}=useAuth();
  const [users,setUsers]=useState<User[]>([]),[crowns,setCrowns]=useState<Crown[]>([]),
    [following,setFollowing]=useState<Crown[]>([]),[status,setStatus]=useState('Loading public profiles…');
  useFocusEffect(useCallback(()=>{
    let active=true;
    void Promise.all([request('/v1/social/top-users'),request('/v1/social/recent-crowns'),
      request('/v1/social/following-crowns')])
      .then(async([top,recent,followed])=>{
        if(!top.ok || !recent.ok || !followed.ok)throw new Error('Social is unavailable. Try again later.');
        return Promise.all([top.json(),recent.json(),followed.json()]);
      }).then(([top,recent,followed])=>{if(active){setUsers(top.users??[]);setCrowns(recent.crowns??[]);
        setFollowing(followed.crowns??[]);
        setStatus('Public Crowns are private until their owners share them.');}})
      .catch((error:unknown)=>{if(active)setStatus(error instanceof Error?error.message:'Social unavailable.');});
    return ()=>{active=false;};
  },[request]));
  return <Screen eyebrow="CROWNIQ  /  COMMUNITY" title="Social">
    <Text style={styles.heading}>Following</Text>
    {following.length===0 && <Text style={styles.note}>Follow a user to see their newest public Crowns here.</Text>}
    {following.map((crown)=><Pressable key={`follow-${crown.publicCrownId}`} style={styles.card}
      accessibilityRole="button" onPress={()=>router.push({pathname:'/social/crown/[id]',params:{id:crown.publicCrownId}})}>
      <Text style={styles.name}>{crown.legs.length} legs · {new Date(crown.createdAt).toLocaleDateString()}</Text>
      <Text style={styles.note}>{crown.legs.map((leg)=>leg.playerName).join(' · ')}</Text>
      <Text style={styles.link}>Inspect followed Crown →</Text>
    </Pressable>)}
    <Text style={styles.heading}>Top 10 users</Text>
    <Text style={styles.note}>At least 20 graded public selections. Ranked by wins, then hit rate, then graded count.</Text>
    {users.length===0 && <Notice title="No qualifying users yet" detail={status} />}
    {users.map((user,index)=><Pressable key={user.publicId} style={styles.card}
      accessibilityRole="button" onPress={()=>router.push({pathname:'/social/[publicId]',params:{publicId:user.publicId}})}>
      <Text style={styles.name}>#{index+1}  {user.displayName}</Text>
      <Text style={styles.note}>{user.wins}–{user.losses}–{user.pushes} · {user.hitRate===null?'—':`${(user.hitRate*100).toFixed(1)}%`} hit rate · {user.graded} graded</Text>
      <Text style={styles.link}>View public Crowns →</Text>
    </Pressable>)}
    <Text style={styles.heading}>Recent public Crowns</Text>
    {crowns.length===0 && <Text style={styles.note}>No Crowns shared yet.</Text>}
    {crowns.map((crown)=><Pressable key={crown.publicCrownId} style={styles.card}
      accessibilityRole="button" onPress={()=>router.push({pathname:'/social/crown/[id]',params:{id:crown.publicCrownId}})}>
      <Text style={styles.name}>{crown.legs.length} legs · {new Date(crown.createdAt).toLocaleDateString()}</Text>
      <Text style={styles.note}>{crown.legs.map((leg)=>leg.playerName).join(' · ')}</Text>
      <Text style={styles.link}>Inspect Crown →</Text>
    </Pressable>)}
  </Screen>;
}
const styles=StyleSheet.create({card:{backgroundColor:palette.card,borderWidth:1,
  borderColor:palette.border,borderRadius:16,padding:16,gap:7,minHeight:60},
  name:{color:palette.text,fontSize:17,fontWeight:'800'},note:{color:palette.muted,fontSize:12,lineHeight:18},
  link:{color:palette.green,fontWeight:'700'},heading:{color:palette.text,fontSize:20,fontWeight:'800',marginTop:12}});
