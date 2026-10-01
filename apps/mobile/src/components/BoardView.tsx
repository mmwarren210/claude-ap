import type { PropLine } from '@crowniq/contracts';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FilterSheet } from './FilterSheet';
import { LineLadder } from './LineLadder';
import { ViewModeSwitch } from './ViewModeSwitch';
import { Notice } from './Screen';
import { palette } from '../theme';
import { useBoard } from '../use-board';
import { useDraft } from '../use-draft';
import { boardLinesForMode } from '../state';
import { useAuth } from '../auth';

const gradingLabel=(status:string)=>({
  NFL_AUTO_GRADING:'NFL auto grading',
  AWAITING_VERIFIED_RESULTS:'Awaiting verified results',
  TRACKING_UNCONFIGURED:'Tracking unavailable',
} as Record<string,string>)[status]??status.replaceAll('_',' ').toLowerCase();

export default function BoardView() {
  const {request}=useAuth();
  const {status,data,message,freshness,researchStatus,gradingStatus,refreshing,nowMs,retry}=useBoard();
  const {filters,setFilters,viewMode,setViewMode,ready,add}=useDraft();
  const [filterOpen,setFilterOpen]=useState(false),[ladder,setLadder]=useState<PropLine|null>(null);
  const [chosen,setChosen]=useState<Record<string,string>>({}),[notice,setNotice]=useState('');
  const lines=useMemo(()=>data&&ready?boardLinesForMode(data,filters,viewMode,nowMs):[],
    [data,filters,viewMode,ready,nowMs]);
  const analyses=useMemo(()=>new Map(data?.analyses.map((item)=>[item.lineId,item])),[data]);
  const ranks=useMemo(()=>new Map(data?.rankedLineIds.map((id,index)=>[id,index+1])),[data]);
  const lineById=useMemo(()=>new Map(data?.board.lines.map((item)=>[item.id,item])),[data]);
  const selected=(line:PropLine)=>viewMode==='LITE'||!chosen[line.id]
    ? line : lineById.get(chosen[line.id])??line;
  return <SafeAreaView style={styles.safe} edges={['top']}>
    <FlatList data={lines} keyExtractor={(line)=>line.id}
      initialNumToRender={12} maxToRenderPerBatch={16} windowSize={7}
      renderItem={({item})=>{
        const line=selected(item),analysis=analyses.get(line.id);
        return <View style={styles.card}>
          <Text style={styles.sport}>{viewMode==='LITE'?`Board #${ranks.get(line.id)??'—'} · `:''}{line.league} · {line.lineType}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={`View ${line.playerName} details`}
            style={styles.tap} onPress={()=>router.push({pathname:'/player/[lineId]',params:{lineId:line.id}})}>
            {analysis?.reviewStatus==='SECOND_LOOK' && <Text style={styles.secondLook}>2ND LOOK · re-checked after initial PASS</Text>}
            <Text style={styles.player}>{line.playerName}</Text>
            <Text style={styles.market}>{line.market} · {line.eventName}</Text>
            <Text style={styles.direction}>{analysis?.direction ?? 'PASS'} {line.threshold} · {analysis?.score==null?'Not graded':`GKR ${analysis.score}`} · {analysis?.scoreBand ?? 'PASS'}</Text>
            <Text style={styles.market}>{analysis?.dangerZone?'Danger zone · ':''}Evidence {analysis?.evidenceQuality ?? 'NONE'}</Text>
          </Pressable>
          <View style={styles.actions}>
            {viewMode==='FULL' && <Pressable style={styles.action} accessibilityRole="button"
              onPress={()=>setLadder(line)}><Text style={styles.actionText}>Line ladder</Text></Pressable>}
            <Pressable style={styles.action} accessibilityRole="button" onPress={()=>{
              if(!analysis || analysis.direction==='PASS') {setNotice('This line is a PASS and cannot enter the Crown draft.');return;}
              setNotice(add(line,analysis,analysis.direction) ?? 'Added to Crown draft.');
            }}><Text style={styles.actionText}>Add to Crown</Text></Pressable>
            <Pressable style={styles.action} accessibilityRole="button" onPress={()=>{
              void request('/v1/me/picks',{method:'POST',headers:{'content-type':'application/json'},
                body:JSON.stringify({lineId:line.id})}).then((response)=>setNotice(response.ok
                  ? 'Saved to your profile. See My Picks.':'The line is unavailable or stale. Refresh the Board.'))
                .catch(()=>setNotice('Could not save the pick. Try again online.'));
            }}><Text style={styles.actionText}>Save pick</Text></Pressable>
          </View>
        </View>;
      }} contentContainerStyle={styles.content}
      ListHeaderComponent={<View style={styles.header}>
        <Text style={styles.eyebrow}>CROWNIQ  /  BOARD</Text><Text style={styles.title}>The Board</Text>
        {ready && <><ViewModeSwitch value={viewMode} onChange={setViewMode} />
          <Text style={styles.meta}>{viewMode==='LITE'
            ? `Top ${lines.length} qualified ${lines.length===1?'line':'lines'} · sport and market filters`
            : `${lines.length} saved lines · full filters and line ladders`}</Text></>}
        <Text style={[styles.meta,['STALE','UNREACHABLE','OFFLINE'].includes(freshness) && styles.warning]}>{freshness} · {data ? `Lines captured ${new Date(data.board.fetchedAt).toLocaleString()}` : message}</Text>
        {freshness==='SNAPSHOT' && <Text style={styles.snapshot}>Upcoming events remain viewable. These are saved lines, not live quotes—confirm the exact line and direction in PrizePicks before playing.</Text>}
        {viewMode==='FULL' && <Text style={styles.meta}>Research: {researchStatus} · Grading: {gradingLabel(gradingStatus)}</Text>}
        {message && data && <Text style={styles.warning}>{message} Showing last saved board.</Text>}
        <View style={styles.actions}><Pressable style={styles.action} onPress={()=>setFilterOpen(true)}><Text style={styles.actionText}>Filters</Text></Pressable>
          <Pressable style={styles.action} onPress={retry} disabled={refreshing}><Text style={styles.actionText}>{refreshing?'Building board…':'Refresh board'}</Text></Pressable></View>
        {!!notice && <Text accessibilityRole="alert" style={styles.warning}>{notice}</Text>}
      </View>}
      ListEmptyComponent={<Notice title={!ready||status==='loading'?'Loading board':data&&viewMode==='LITE'?
        'No qualified plays yet':data?'No matching lines':'Board unavailable'}
        detail={!ready?'Loading your saved view.':status==='loading'?'Looking for the latest saved board.':
          data&&viewMode==='LITE'?'The current board has no qualified ranked lines for these filters. Full shows every line, including PASS.':
            data?'Reset filters or try another sport.':message} />}
    />
    {data && <>{filterOpen && <FilterSheet visible={filterOpen} onClose={()=>setFilterOpen(false)}
      mode={viewMode} data={data} value={filters} onApply={setFilters} />}
      {viewMode==='FULL' && ladder && <LineLadder visible={!!ladder} onClose={()=>setLadder(null)} data={data}
        line={ladder} selected={selected(ladder).id} onSelect={(next)=>{
          setChosen((current)=>({...current,[ladder.id]:next.id}));setLadder(null);
        }} />}</>}
  </SafeAreaView>;
}
const styles=StyleSheet.create({safe:{flex:1,backgroundColor:palette.background},
  content:{padding:20,paddingBottom:110,gap:12},header:{gap:12,marginBottom:8},
  eyebrow:{color:palette.green,fontSize:11,fontWeight:'800',letterSpacing:2.2},
  title:{color:palette.text,fontSize:32,fontWeight:'800'},meta:{color:palette.muted,fontSize:12},
  warning:{color:palette.danger,fontSize:12},
  snapshot:{color:palette.muted,fontSize:12,lineHeight:18},card:{backgroundColor:palette.card,
    borderWidth:1,borderColor:palette.border,borderRadius:18,padding:16,gap:8},
  tap:{gap:5,minHeight:72},sport:{color:palette.green,fontSize:11,fontWeight:'800'},
  player:{color:palette.text,fontSize:18,fontWeight:'700'},market:{color:palette.muted,fontSize:12},
  direction:{color:palette.text,fontSize:13,fontWeight:'700'},
  secondLook:{alignSelf:'flex-start',color:palette.green,backgroundColor:palette.greenDim,
    borderWidth:1,borderColor:palette.border,borderRadius:999,paddingHorizontal:9,paddingVertical:4,
    fontSize:10,fontWeight:'800',letterSpacing:1},
  actions:{flexDirection:'row',flexWrap:'wrap',gap:8},
  action:{padding:12,borderWidth:1,borderColor:palette.border,borderRadius:12,minHeight:44},
  actionText:{color:palette.green,fontWeight:'700',fontSize:12}});
