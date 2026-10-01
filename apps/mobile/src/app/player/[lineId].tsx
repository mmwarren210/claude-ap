import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { PropLine } from '@crowniq/contracts';
import { LineLadder } from '../../components/LineLadder';
import { Notice, Screen } from '../../components/Screen';
import { palette } from '../../theme';
import { useBoard } from '../../use-board';
import { useDraft } from '../../use-draft';
import { useAuth } from '../../auth';

type TrackedHistory={label:string;recent:{eventDate:string;actual:number|null;grade:string;
  line:number;direction:string}[];internalOutcomeDistribution:{mean:number;median:number}|null};

export default function PlayerDetail() {
  const {request}=useAuth();
  const {lineId}=useLocalSearchParams<{lineId:string}>(),{data,freshness,nowMs}=useBoard();
  const {add,viewMode,setViewMode}=useDraft();
  const [chosen,setChosen]=useState<PropLine|null>(null),[open,setOpen]=useState(false),[notice,setNotice]=useState('');
  const line=chosen ?? data?.board.lines.find((item)=>item.id===lineId);
  const analysis=data?.analyses.find((item)=>item.lineId===line?.id);
  const [savedHistory,setHistory]=useState<{key:string;value:TrackedHistory}|null>(null);
  const historySport=line?.sport,historyPlayerId=line?.playerId,historyMarket=line?.market;
  const historyKey=[historySport,historyPlayerId,historyMarket].join('/');
  const history=savedHistory?.key===historyKey?savedHistory.value:null;
  useEffect(()=>{
    if(viewMode!=='FULL'||!historySport || !historyPlayerId || !historyMarket)return;
    let active=true;
    const url=`/v1/history/${encodeURIComponent(historySport)}/${encodeURIComponent(historyPlayerId)}/${encodeURIComponent(historyMarket)}`;
    void request(url).then((response)=>response.ok?response.json():null)
      .then((value:TrackedHistory|null)=>{if(active && value?.recent?.length)setHistory({key:historyKey,value});})
      .catch(()=>undefined);
    return ()=>{active=false;};
  },[historySport,historyPlayerId,historyMarket,historyKey,request,viewMode]);
  if(!data || !line)return <Screen eyebrow="PLAYER" title="Player detail"><Notice title="Line unavailable" detail="This line is no longer on the saved board." />
    <Pressable onPress={()=>router.back()}><Text style={styles.link}>Back to board</Text></Pressable></Screen>;
  return <><Screen eyebrow={`${line.sport}  /  ${line.league}`} title={line.playerName}>
    <Pressable accessibilityRole="button" onPress={()=>router.back()}><Text style={styles.link}>← Back</Text></Pressable>
    <Notice title={`${line.market} · ${analysis?.direction ?? 'PASS'} ${line.threshold}`}
      detail={`${line.team ?? 'Team unavailable'} vs ${line.opponent ?? 'Opponent unavailable'} · ${new Date(line.eventStartTime).toLocaleString()} · ${line.lineType}`} />
    <Notice title={`GKR ${analysis?.score ?? 'PASS'} · ${analysis?.scoreBand ?? 'PASS'}`}
      detail={`Evidence ${analysis?.evidenceQuality ?? 'NONE'} · ${freshness} board · ${analysis?.dangerZone?'Danger zone':'No danger-zone flag'}`} />
    {Date.parse(line.eventStartTime)<=nowMs
      ? <Notice title="Event started" detail="This line can no longer be added or saved."/>
      : freshness==='SNAPSHOT' && <Notice title="Saved snapshot, not a live quote"
        detail="This event has not started, but the PrizePicks line may have moved or disappeared. Confirm the exact threshold and direction before playing."/>}
    {analysis?.reviewStatus==='SECOND_LOOK' && <Notice title="2ND LOOK"
      detail={`CrownIQ gave this line another research pass after an initial PASS${analysis.secondLook?.initialReasonCode? ` (${analysis.secondLook.initialReasonCode.replaceAll('_',' ').toLowerCase()})`:''}. This is a review flag, not a score bonus—consider checking the context yourself before taking it.`} />}
    <View style={styles.actions}>{viewMode==='FULL' && <Pressable style={styles.button}
      onPress={()=>setOpen(true)}><Text style={styles.link}>Line ladder</Text></Pressable>}
      <Pressable style={styles.button} onPress={()=>{
        if(!analysis || analysis.direction==='PASS'){setNotice('This line is a PASS.');return;}
        setNotice(add(line,analysis,analysis.direction) ?? 'Added to Crown draft.');
      }}><Text style={styles.link}>Add to Crown</Text></Pressable>
      <Pressable style={styles.button} onPress={()=>{
        void request('/v1/me/picks',{method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({lineId:line.id})}).then((response)=>setNotice(response.ok
            ? 'Saved to your profile. See My Picks.':'This line is stale or unavailable. Refresh the Board.'))
          .catch(()=>setNotice('Could not save the pick. Try again online.'));
      }}><Text style={styles.link}>Save pick</Text></Pressable></View>
    {!!notice && <Text accessibilityRole="alert" style={styles.warning}>{notice}</Text>}
    {viewMode==='LITE' && <Pressable style={styles.button} accessibilityRole="button"
      onPress={()=>setViewMode('FULL')}><Text style={styles.link}>View full analysis and line ladder →</Text></Pressable>}
    {viewMode==='FULL' && <>
    <Text style={styles.heading}>GKR breakdown</Text>
    {(analysis?.contextBreakdown ?? []).map((item,index)=><Text key={index} style={styles.detail}>{item.name}: {item.contribution} · {item.explanation}</Text>)}
    <Text style={styles.heading}>Supporting factors</Text>
    {(analysis?.supportingFactors.length?analysis.supportingFactors:['No verified supporting factors available.']).map((item,index)=><Text key={index} style={styles.detail}>• {item}</Text>)}
    <Text style={styles.heading}>Risks</Text>
    {(analysis?.opposingFactors.length?analysis.opposingFactors:['No additional risk factors supplied.']).map((item,index)=><Text key={index} style={styles.detail}>• {item}</Text>)}
    <Text style={styles.heading}>Evidence status</Text>
    <Text style={styles.detail}>{analysis?.evidenceIds.length ?? 0} attributed findings · {analysis?.evidenceExpiresAt ? `expires ${new Date(analysis.evidenceExpiresAt).toLocaleString()}`:'no current expiry'}.</Text>
    <Text style={styles.detail}>Source details are not exposed by this public board response; unavailable values are not inferred.</Text>
    {history && <><Text style={styles.heading}>{history.label}</Text>
      <Text style={styles.detail}>CrownIQ Tracked History · verified graded outcomes only</Text>
      {history.recent.map((item,index)=><Text key={index} style={styles.detail}>
        {item.eventDate} · {item.actual ?? item.grade} · {item.direction} {item.line} · {item.grade}
      </Text>)}
      {history.internalOutcomeDistribution && <Text style={styles.detail}>
        Average {history.internalOutcomeDistribution.mean.toFixed(1)} · Median {history.internalOutcomeDistribution.median.toFixed(1)}
      </Text>}</>}
    </>}
  </Screen>{viewMode==='FULL' && <LineLadder visible={open} onClose={()=>setOpen(false)} data={data} line={line}
    selected={line.id} onSelect={(item)=>{setChosen(item);setOpen(false);}} />}</>;
}
const styles=StyleSheet.create({link:{color:palette.green,fontSize:14,fontWeight:'700'},
  heading:{color:palette.text,fontSize:17,fontWeight:'800',marginTop:14},
  detail:{color:palette.muted,fontSize:13,lineHeight:20},
  actions:{flexDirection:'row',flexWrap:'wrap',gap:10},button:{padding:14,minHeight:44,borderWidth:1,
    borderColor:palette.border,borderRadius:12},warning:{color:palette.danger}});
