import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { Notice, Screen } from '../../components/Screen';
import { palette } from '../../theme';
import { useAuth } from '../../auth';

type Profile={publicId:string;displayName:string;wins:number;losses:number;pushes:number;
  graded:number;hitRate:number|null;following:boolean};
type Crown={publicCrownId:string;createdAt:string;legs:{playerName:string}[]};
export default function PublicProfile(){
  const {request}=useAuth();
  const {publicId}=useLocalSearchParams<{publicId:string}>();
  const [profile,setProfile]=useState<Profile|null>(null),[crowns,setCrowns]=useState<Crown[]>([]),
    [message,setMessage]=useState('Loading public profile…');
  useEffect(()=>{
    if(!publicId)return;
    let active=true;
    void Promise.all([request(`/v1/social/user/${encodeURIComponent(publicId)}`),
      request(`/v1/social/user/${encodeURIComponent(publicId)}/crowns?limit=20`)])
      .then(async([p,c])=>{if(!p.ok||!c.ok)throw new Error('Profile unavailable.');
        return Promise.all([p.json(),c.json()]);})
      .then(([p,c])=>{if(active){setProfile(p);setCrowns(c.crowns??[]);setMessage('');}})
      .catch(()=>{if(active)setMessage('Profile unavailable.');});
    return ()=>{active=false;};
  },[publicId,request]);
  const toggle=async()=>{
    if(!profile)return;
    try {const response=await request(`/v1/social/follow/${encodeURIComponent(publicId)}`,
      {method:profile.following?'DELETE':'POST'});
      if(!response.ok){setMessage('Follow requires a signed-in CrownIQ account.');return;}
      setProfile({...profile,following:!profile.following});setMessage('');
    }catch{setMessage('Could not update following.');}
  };
  return <Screen eyebrow="CROWNIQ  /  PUBLIC PROFILE" title={profile?.displayName??'Profile'}>
    <Pressable onPress={()=>router.back()}><Text style={styles.link}>← Social</Text></Pressable>
    {profile ? <><Notice title={`${profile.wins}–${profile.losses}–${profile.pushes}`}
      detail={`${profile.hitRate===null?'—':`${(profile.hitRate*100).toFixed(1)}%`} hit rate · ${profile.graded} graded public selections`} />
      <Pressable style={styles.button} onPress={()=>void toggle()}><Text style={styles.link}>
        {profile.following?'Unfollow':'Follow'}</Text></Pressable>
      <Text style={styles.heading}>Recent public Crowns</Text>
      {crowns.length===0 && <Text style={styles.note}>No public Crowns to show.</Text>}
      {crowns.map((crown)=><Pressable key={crown.publicCrownId} style={styles.button}
        onPress={()=>router.push({pathname:'/social/crown/[id]',params:{id:crown.publicCrownId}})}>
        <Text style={styles.link}>{crown.legs.length} legs · {crown.legs.map((leg)=>leg.playerName).join(', ')} →</Text>
      </Pressable>)}</> : <Notice title="Profile unavailable" detail={message} />}
    {!!message && profile && <Text accessibilityRole="alert" style={styles.note}>{message}</Text>}
  </Screen>;
}
const styles=StyleSheet.create({button:{padding:15,borderWidth:1,borderColor:palette.border,
  borderRadius:14,backgroundColor:palette.card,minHeight:48},link:{color:palette.green,fontWeight:'700'},
  heading:{color:palette.text,fontSize:20,fontWeight:'800',marginTop:12},note:{color:palette.muted,fontSize:13}});
