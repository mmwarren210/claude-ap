import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Sheet } from './Sheet';
import { palette } from '../theme';
import { useDraft } from '../use-draft';

export function CrownTray() {
  const {legs,remove}=useDraft(),[open,setOpen]=useState(false);
  if(!legs.length)return null;
  return <><Pressable accessibilityRole="button" accessibilityLabel={`Open Crown draft, ${legs.length} legs`}
    style={styles.tray} onPress={()=>setOpen(true)}>
    <Text style={styles.label}>♛  Crown draft · {legs.length} {legs.length===1?'leg':'legs'}</Text>
    <Text style={styles.label}>View ↑</Text>
  </Pressable><Sheet visible={open} title="Crown draft" onClose={()=>setOpen(false)}>
    <Text style={styles.muted}>Saved on this device. Final Crown rules require server validation.</Text>
    {legs.map((leg)=><View key={leg.line.id} style={styles.row}>
      <View style={styles.grow}><Text style={styles.label}>{leg.line.playerName}</Text>
        <Text style={styles.muted}>{leg.line.market} · {leg.direction} {leg.line.threshold} · {leg.line.lineType} · GKR {leg.score}</Text></View>
      <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${leg.line.playerName}`}
        style={styles.button} onPress={()=>remove(leg.line.id)}><Text style={styles.label}>Remove</Text></Pressable>
    </View>)}
    <Pressable accessibilityRole="button" style={styles.button} onPress={()=>{setOpen(false);router.push('/(tabs)/crowns');}}>
      <Text style={styles.label}>Open Crowns →</Text></Pressable>
  </Sheet></>;
}
const styles=StyleSheet.create({tray:{position:'absolute',bottom:62,left:14,right:14,
  backgroundColor:palette.greenDim,borderWidth:1,borderColor:palette.green,borderRadius:16,
  padding:15,flexDirection:'row',justifyContent:'space-between',minHeight:48},
  label:{color:palette.text,fontWeight:'700'},muted:{color:palette.muted,fontSize:12},
  row:{flexDirection:'row',alignItems:'center',gap:12,paddingVertical:8},grow:{flex:1,gap:4},
  button:{borderWidth:1,borderColor:palette.border,padding:12,borderRadius:10,minHeight:44}});
