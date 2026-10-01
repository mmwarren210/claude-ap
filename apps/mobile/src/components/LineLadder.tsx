import type { Analysis, BoardResponse, PropLine } from '@crowniq/contracts';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { palette } from '../theme';
import { Sheet } from './Sheet';

export function ladderFor(data:BoardResponse,line:PropLine) {
  const analyses=new Map(data.analyses.map((item)=>[item.lineId,item]));
  return data.board.lines.filter((item)=>item.eventId===line.eventId &&
    item.playerId===line.playerId && item.market===line.market)
    .sort((a,b)=>a.threshold-b.threshold).map((item)=>({line:item,
      analysis:analyses.get(item.id) ?? null}));
}
export function LineLadder({visible,onClose,data,line,selected,onSelect}:{visible:boolean;
  onClose:()=>void;data:BoardResponse;line:PropLine;selected:string;
  onSelect:(line:PropLine,analysis:Analysis|null)=>void}) {
  return <Sheet visible={visible} title="Choose a line" onClose={onClose}>
    <Text style={styles.note}>{line.playerName} · {line.market}. Each threshold is graded separately.</Text>
    {ladderFor(data,line).map(({line:item,analysis})=><Pressable key={item.id}
      accessibilityRole="button" accessibilityLabel={`${item.lineType} ${item.threshold}, ${analysis?.direction ?? 'PASS'}, score ${analysis?.score ?? 'unavailable'}`}
      onPress={()=>onSelect(item,analysis)} style={[styles.row,selected===item.id && styles.selected]}>
      <View><Text style={styles.title}>{item.threshold} · {item.lineType}</Text>
        <Text style={styles.note}>{analysis?.direction ?? 'PASS'} · {analysis?.scoreBand ?? 'PASS'} · {analysis?.evidenceQuality ?? 'NONE'} evidence</Text>
        {analysis?.reviewStatus==='SECOND_LOOK' && <Text style={styles.secondLook}>2ND LOOK</Text>}</View>
      <Text style={styles.score}>{analysis?.score===null || analysis?.score===undefined ? 'PASS' : `GKR ${analysis.score}`}</Text>
      {analysis?.dangerZone && <Text style={styles.danger}>Danger zone</Text>}
    </Pressable>)}
  </Sheet>;
}
const styles=StyleSheet.create({row:{backgroundColor:palette.background,borderColor:palette.border,
  borderWidth:1,borderRadius:14,padding:14,gap:6,minHeight:64},
  selected:{borderColor:palette.green},title:{color:palette.text,fontSize:16,fontWeight:'700'},
  note:{color:palette.muted,fontSize:12},
  secondLook:{color:palette.green,fontSize:10,fontWeight:'800',letterSpacing:1},
  score:{color:palette.green,fontWeight:'800'},
  danger:{color:palette.danger,fontSize:12}});
