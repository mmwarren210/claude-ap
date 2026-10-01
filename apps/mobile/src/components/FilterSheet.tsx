import type { BoardResponse } from '@crowniq/contracts';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { palette } from '../theme';
import { emptyFilters } from '../state';
import type { Filters, ViewMode } from '../state';
import { Sheet } from './Sheet';

export function FilterSheet({visible,onClose,data,value,onApply,mode}:{visible:boolean;onClose:()=>void;
  data:BoardResponse;value:Filters;onApply:(next:Filters)=>void;mode:ViewMode}) {
  const [draft,setDraft]=useState(value);
  const basic:{key:keyof Filters;label:string;options:string[]}[]=[
    {key:'sport',label:'Sport',options:[...new Set(data.board.lines.map((line)=>line.sport))]},
    {key:'market',label:'Market',options:[...new Set(data.board.lines.filter((line)=>
      draft.sport==='ALL'||line.sport===draft.sport).map((line)=>line.market))]},
  ];
  const kinds:{key:keyof Filters;label:string;options:string[]}[]=mode==='LITE'?basic:[...basic,
    {key:'direction',label:'Direction',options:['MORE','LESS','PASS']},
    {key:'grade',label:'Grade',options:['CROWN_ELITE','CROWN_STRONG','PLAYABLE','LEAN','WEAK','PASS']},
    {key:'lineType',label:'Line type',options:['REGULAR','GOBLIN','DEMON']},
    {key:'evidence',label:'Evidence',options:['HIGH','MEDIUM','LOW','NONE']},
    {key:'date',label:'Event date',options:[...new Set(data.board.lines.map((line)=>line.eventStartTime.slice(0,10)))]},
  ];
  return <Sheet visible={visible} title={mode==='LITE'?'Lite filters':'Full filters'} onClose={onClose}>
    {kinds.map(({key,label,options})=><View key={key} style={styles.group}>
      <Text style={styles.heading}>{label}</Text><View style={styles.options}>
        {['ALL',...options].map((option)=><Pressable key={option} accessibilityRole="button"
          accessibilityState={{selected:draft[key]===option}} onPress={()=>setDraft((current)=>({...current,
            [key]:option,...(key==='sport'?{market:'ALL'}:{})}))}
          style={[styles.chip,draft[key]===option && styles.active]}>
          <Text style={styles.text}>{option.replaceAll('_',' ')}</Text></Pressable>)}
      </View></View>)}
    <View style={styles.options}><Pressable style={styles.action} onPress={()=>
      setDraft((current)=>mode==='LITE'?{...current,sport:'ALL',market:'ALL'}:emptyFilters)}>
      <Text style={styles.text}>Reset</Text></Pressable>
      <Pressable style={[styles.action,styles.active]} onPress={()=>{onApply(draft);onClose();}}>
        <Text style={styles.text}>Apply</Text></Pressable></View>
  </Sheet>;
}
const styles=StyleSheet.create({group:{gap:8},heading:{color:palette.text,fontSize:15,fontWeight:'700'},
  options:{flexDirection:'row',flexWrap:'wrap',gap:8},chip:{padding:10,borderWidth:1,
    borderColor:palette.border,borderRadius:12,minHeight:44,justifyContent:'center'},
  active:{borderColor:palette.green,backgroundColor:palette.greenDim},
  text:{color:palette.text,fontSize:12,fontWeight:'600'},action:{padding:14,borderWidth:1,
    borderColor:palette.border,borderRadius:12,minHeight:44}});
