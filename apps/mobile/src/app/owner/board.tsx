import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Notice, Screen } from '../../components/Screen';
import { useAuth } from '../../auth';
import { useBoard } from '../../use-board';
import { palette } from '../../theme';

type Diagnostics={
  boardFetchedAt:string;builtAt:string;lineCount:number;rankedCount:number;evidenceCount:number;
  research:string;providerRefreshCost:0;
  evidenceFreshness?:{total:number;active:number;expired:number};
  startupRecovery?:{status:string;evidenceAdded:number;oddsCreditsUsed:0;error:string|null};
  secondLook?:{attempted:number;upgraded:number;stillPass:number;evidenceAdded:number};
  freshContext?:{evidenceCount:number};
  modelSupport?:{supported:number;unsupported:number;approved:number;unapproved:number};
  lineTypes?:{
    counts:{REGULAR:number;GOBLIN:number;DEMON:number;UNKNOWN_ALTERNATE:number};
    multiplierCoverage:{linesWithMultiplier:number;unknownWithMultiplier:number};
    unknownReasons:{NO_REGULAR_REFERENCE:number;AMBIGUOUS_REGULAR_REFERENCE:number;
      EQUAL_TO_REGULAR:number;UNSUPPORTED_SHAPE:number;CLASSIFIABLE:number};
    unknownByMarket:{sport:string;market:string;count:number}[];
  };
  reasonCounts?:Record<string,number>;
};
type ReanalyzeResult={
  builtAt:string;lineCount:number;rankedCount:number;research:string;evidenceCount:number;
  oddsCreditsUsed:0;tracked:number;trackingStatus:string;
  secondLook?:{attempted:number;upgraded:number;stillPass:number;evidenceAdded:number};
  freshContext?:{evidenceCount:number};
};
type PullStatus={refreshStage:string;job:{status:'IDLE'|'RUNNING'|'SUCCEEDED'|'FAILED';
  startedAt:string|null;finishedAt:string|null;error:string|null;
  trackingStatus:string;counts:{saved:number;qualified:number;exposed:number}}};
const pullStages=['provider','normalize','research','persist','publish','complete'] as const;
function pullStageLabel(stage:string){
  return ({provider:'Fetching PrizePicks lines',normalize:'Checking line data',
    research:'Building research and rankings',persist:'Saving snapshot',
    publish:'Publishing the board',complete:'Complete'} as Record<string,string>)[stage]
    ??'Starting provider pull';
}

async function json<T>(response:Response):Promise<T>{
  const body=await response.json().catch(()=>({})) as T & {code?:string;message?:string};
  if(!response.ok)throw new Error(body.message??body.code??'Owner board request failed.');
  return body;
}

export default function OwnerBoardScreen(){
  const {request}=useAuth();
  const {retry}=useBoard();
  const [diagnostics,setDiagnostics]=useState<Diagnostics|null>(null);
  const [access,setAccess]=useState<'CHECKING'|'ALLOWED'|'DENIED'>('CHECKING');
  const [busy,setBusy]=useState(false);
  const [pullStatus,setPullStatus]=useState<PullStatus|null>(null);
  const [checkingPull,setCheckingPull]=useState(true);
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');

  const load=useCallback(async()=>{
    try{
      const response=await request('/v1/owner/board/diagnostics');
      if(response.status===404){setAccess('DENIED');return;}
      const data=await json<Diagnostics>(response);
      setDiagnostics(data);setAccess('ALLOWED');setError('');
    }catch(cause){
      const text=cause instanceof Error?cause.message:'Board diagnostics unavailable.';
      if(text==='BOARD_UNAVAILABLE'){setAccess('ALLOWED');setDiagnostics(null);setError(text);}
      else {setAccess('ALLOWED');setError(text);}
    }
  },[request]);

  useFocusEffect(useCallback(()=>{
    void load();
    let active=true;
    let previousJob:string|null=null;
    let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      let delay=3000;
      try{
        const status=await json<PullStatus>(await request('/v1/owner/board/status'));
        if(!active)return;
        setPullStatus(status);setCheckingPull(false);
        if(previousJob==='RUNNING' && status.job.status==='SUCCEEDED'){
          setMessage(`PrizePicks snapshot saved · ${status.job.counts.saved.toLocaleString()} lines · ${status.job.counts.qualified} qualified.`);
          retry();void load();
        }
        previousJob=status.job.status;
        delay=status.job.status==='RUNNING'?3000:10000;
      }catch(cause){
        if(!active)return;
        setCheckingPull(false);
        setError(cause instanceof Error?cause.message:'Could not check provider refresh status.');
      }
      if(active)timer=setTimeout(()=>{void poll();},delay);
    };
    void poll();
    return()=>{active=false;clearTimeout(timer);};
  },[request,retry,load]));

  const pulling=pullStatus?.job.status==='RUNNING';

  const pullSnapshot=async()=>{
    if(busy||pulling||checkingPull)return;
    setBusy(true);setError('');setMessage('');
    try{
      const result=await json<{started:boolean;job:PullStatus['job']}>(await request('/v1/owner/board/refresh',{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({acknowledgeProviderCost:true}),
      }));
      setPullStatus({job:result.job,refreshStage:'provider'});
      setMessage(result.started?'Pull started on the server. You can leave this screen; check back for the result.'
        :'A pull is already running on the server. Check back for the result.');
    }catch(cause){
      setError(cause instanceof Error?cause.message:'Provider refresh could not start.');
    }finally{setBusy(false);}
  };

  const reanalyze=async()=>{
    if(busy||pulling)return;
    setBusy(true);setError('');setMessage('');
    try{
      const result=await json<ReanalyzeResult>(await request('/v1/owner/board/reanalyze',{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({acknowledgeResearchCost:true}),
      }));
      const upgrades=result.secondLook?.upgraded??0;
      setMessage(`Analysis refreshed · ${result.rankedCount} primary rankings · ${upgrades} Second Look upgrades · ${result.oddsCreditsUsed} Odds credits.`);
      retry();
      await load();
    }catch(cause){
      setError(cause instanceof Error?cause.message:'Analysis refresh failed.');
    }finally{setBusy(false);}
  };

  const topReasons=Object.entries(diagnostics?.reasonCounts??{}).slice(0,6);
  const stageIndex=pullStages.indexOf(pullStatus?.refreshStage as typeof pullStages[number]);
  const step=Math.min(Math.max(stageIndex+1,1),5);
  return <Screen eyebrow="CROWNIQ  /  OWNER ONLY" title="Board Analysis">
    <Pressable accessibilityRole="button"
      onPress={()=>router.canGoBack()?router.back():router.replace('/(tabs)/settings')}>
      <Text style={styles.back}>← Back to Settings</Text>
    </Pressable>
    {access==='CHECKING'&&<ActivityIndicator color={palette.green}/>}
    {access==='DENIED'&&<Notice title="Private area"
      detail="Board analysis controls are only available to the owner profile configured on the server."/>}
    {access==='ALLOWED'&&<>
      <Notice title="Current PrizePicks snapshot"
        detail="This pull may use Odds API credits. Once started, it continues on the server if you leave or close the app. The prior board stays available if it fails."/>
      <Pressable accessibilityRole="button" disabled={busy||pulling||checkingPull}
        onPress={()=>void pullSnapshot()}
        style={[styles.action,(busy||pulling||checkingPull)&&styles.disabled]}>
        <Text style={styles.actionText}>{pulling?'Pull running on server…':'Pull DFS snapshot (uses Odds credits)'}</Text>
      </Pressable>
      {checkingPull&&<ActivityIndicator color={palette.green}/>}
      {pullStatus?.job.status==='RUNNING'&&<View style={styles.card} accessibilityRole="progressbar"
        accessibilityLabel={`DFS snapshot: ${pullStageLabel(pullStatus.refreshStage)}`}>
        <Text style={styles.heading}>DFS PULL IN PROGRESS · STEP {step} OF 5</Text>
        <Text style={styles.row}>{pullStageLabel(pullStatus.refreshStage)}</Text>
        <View style={styles.track}><View style={[styles.fill,{width:`${step*20}%`}]}/></View>
        <Text style={styles.hint}>Started {pullStatus.job.startedAt?new Date(pullStatus.job.startedAt).toLocaleString():'just now'}. Safe to leave; progress resumes when you return.</Text>
      </View>}
      {pullStatus?.job.status==='SUCCEEDED'&&<Notice title="DFS snapshot complete"
        detail={`${pullStatus.job.counts.saved.toLocaleString()} lines saved · ${pullStatus.job.counts.qualified} qualified · finished ${pullStatus.job.finishedAt?new Date(pullStatus.job.finishedAt).toLocaleString():'recently'}.`}/>}
      {pullStatus?.job.status==='FAILED'&&<Notice title="DFS pull failed"
        detail={`${pullStatus.job.error??'Provider connection failed.'} The prior saved board remains available. You may try another pull.`}/>}
      <Notice title="Research-only refresh"
        detail="Reanalyze uses the saved PrizePicks board. It uses 0 Odds API credits, but configured research providers such as Stat API may consume their own quota."/>
      {diagnostics?<>
        <View style={styles.card}>
          <Text style={styles.heading}>CURRENT SAVED BOARD</Text>
          <Text style={styles.row}>Lines: {diagnostics.lineCount.toLocaleString()}</Text>
          <Text style={styles.row}>Primary rankings: {diagnostics.rankedCount}</Text>
          <Text style={styles.row}>Evidence records: {diagnostics.evidenceCount.toLocaleString()}</Text>
          <Text style={styles.row}>Active evidence: {diagnostics.evidenceFreshness?.active.toLocaleString()??'Unknown'} · Expired: {diagnostics.evidenceFreshness?.expired.toLocaleString()??'Unknown'}</Text>
          <Text style={styles.row}>Research: {diagnostics.research}</Text>
          {diagnostics.startupRecovery&&<Text style={styles.hint}>Internal history recovery: {diagnostics.startupRecovery.status.replace(/_/g,' ')} · {diagnostics.startupRecovery.evidenceAdded.toLocaleString()} evidence records · 0 Odds credits</Text>}
          <Text style={styles.row}>Fresh context: {diagnostics.freshContext?.evidenceCount??0}</Text>
          <Text style={styles.row}>Second Look: {diagnostics.secondLook?.upgraded??0} upgraded / {diagnostics.secondLook?.attempted??0} attempted</Text>
          <Text style={styles.hint}>Board fetched {new Date(diagnostics.boardFetchedAt).toLocaleString()}</Text>
          <Text style={styles.hint}>Analysis built {new Date(diagnostics.builtAt).toLocaleString()}</Text>
        </View>
        {diagnostics.lineTypes&&<View style={styles.card}>
          <Text style={styles.heading}>LINE TYPE HEALTH</Text>
          <Text style={styles.row}>Regular: {diagnostics.lineTypes.counts.REGULAR.toLocaleString()}</Text>
          <Text style={styles.row}>Goblin: {diagnostics.lineTypes.counts.GOBLIN.toLocaleString()}</Text>
          <Text style={styles.row}>Demon: {diagnostics.lineTypes.counts.DEMON.toLocaleString()}</Text>
          <Text style={styles.row}>Unknown alternate: {diagnostics.lineTypes.counts.UNKNOWN_ALTERNATE.toLocaleString()}</Text>
          <Text style={styles.hint}>Provider multiplier metadata: {diagnostics.lineTypes.multiplierCoverage.linesWithMultiplier.toLocaleString()} / {diagnostics.lineCount.toLocaleString()} lines · Unknown alternates with multiplier: {diagnostics.lineTypes.multiplierCoverage.unknownWithMultiplier.toLocaleString()}</Text>
          {diagnostics.lineTypes.counts.UNKNOWN_ALTERNATE>0&&
            <Text style={styles.hint}>No Regular reference: {diagnostics.lineTypes.unknownReasons.NO_REGULAR_REFERENCE.toLocaleString()} · Ambiguous reference: {diagnostics.lineTypes.unknownReasons.AMBIGUOUS_REGULAR_REFERENCE.toLocaleString()} · Unsupported shape: {diagnostics.lineTypes.unknownReasons.UNSUPPORTED_SHAPE.toLocaleString()}</Text>}
          {diagnostics.lineTypes.unknownByMarket.slice(0,8).map((item)=>
            <Text key={`${item.sport}:${item.market}`} style={styles.row}>
              {item.sport} · {item.market.replace(/_/g,' ')} · {item.count.toLocaleString()} unknown
            </Text>)}
          {diagnostics.lineTypes.unknownReasons.CLASSIFIABLE>0&&
            <Text style={styles.error}>Classifier audit found {diagnostics.lineTypes.unknownReasons.CLASSIFIABLE} safely classifiable unknown lines.</Text>}
        </View>}
        {topReasons.length>0&&<View style={styles.card}>
          <Text style={styles.heading}>TOP FINAL REASONS</Text>
          {topReasons.map(([reason,count])=><Text key={reason} style={styles.row}>
            {reason.replace(/_/g,' ')} · {count.toLocaleString()}
          </Text>)}
        </View>}
      </>:<Notice title={error==='BOARD_UNAVAILABLE'?'No saved board':'Diagnostics unavailable'}
        detail={error==='BOARD_UNAVAILABLE'
          ?'There is no server-side board to reanalyze yet. This screen will not trigger a paid provider pull.'
          :'Reload diagnostics to check the saved board before reanalyzing.'}/> }
      <Pressable accessibilityRole="button" disabled={busy} onPress={()=>void load()}>
        <Text style={styles.back}>Reload diagnostics</Text>
      </Pressable>
      <Pressable accessibilityRole="button" disabled={busy||pulling||!diagnostics}
        onPress={()=>void reanalyze()} style={[styles.action,(busy||pulling||!diagnostics)&&styles.disabled]}>
        <Text style={styles.actionText}>{busy?'Reanalyzing saved board…':'Reanalyze saved board (0 Odds credits)'}</Text>
      </Pressable>
      {!!message&&<Text accessibilityRole="alert" style={styles.success}>{message}</Text>}
      {!!error&&error!=='BOARD_UNAVAILABLE'&&<Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    </>}
  </Screen>;
}

const styles=StyleSheet.create({
  back:{color:palette.green,fontSize:14,fontWeight:'700',minHeight:36},
  card:{backgroundColor:palette.card,borderColor:palette.border,borderWidth:1,
    borderRadius:16,padding:16,gap:7},
  heading:{color:palette.green,fontSize:11,fontWeight:'900',letterSpacing:1.2},
  row:{color:palette.text,fontSize:13,lineHeight:19},
  hint:{color:palette.muted,fontSize:11,lineHeight:17},
  action:{minHeight:50,backgroundColor:palette.green,borderRadius:12,
    alignItems:'center',justifyContent:'center',paddingHorizontal:14},
  actionText:{color:palette.background,fontSize:14,fontWeight:'900',textAlign:'center'},
  disabled:{opacity:.5},
  track:{height:8,backgroundColor:palette.border,borderRadius:8,overflow:'hidden'},
  fill:{height:8,backgroundColor:palette.green,borderRadius:8},
  success:{color:palette.green,fontSize:13,lineHeight:19},
  error:{color:palette.danger,fontSize:13,lineHeight:19},
});
