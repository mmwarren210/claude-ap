import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Notice, Screen } from '../../components/Screen';
import { useAuth } from '../../auth';
import { palette } from '../../theme';

type ModelRow={
  modelVersion:string;picks:number;wins:number;losses:number;pushes:number;hitRate:number|null;
  averageLineScore:number|null;averageDataConfidence:number|null;
  projectionMAE:number|null;projectionBias:number|null;projectionSamples:number;
};
type FactorRow={
  modelVersion:string;factor:string;samples:number;wins:number;losses:number;
  averageContributionWins:number|null;averageContributionLosses:number|null;
};
type Learning={
  source:'CROWNIQ_TRACKED_OUTCOMES';tracked:number;pending:number;graded:number;dnpVoid:number;
  models:ModelRow[];factorDiagnostics:FactorRow[];
  autoGrading:{enabled:boolean;automaticResolution:boolean;mappingConfigured:boolean;
    mappingStatus:'MISSING'|'VALID'|'INVALID';pendingEligible:number;manualMappedPending:number;
    autoResolvePending:number;source:'nflverse';markets:string[];
    worker:{running:boolean;scheduled:boolean;intervalMs:number|null;lastStartedAt:string|null;
      lastFinishedAt:string|null;nextRunAt:string|null;lastResult:{graded:number;pending:number}|null;
      lastError:string|null}|null};
};

async function read<T>(response:Response):Promise<T>{
  const body=await response.json().catch(()=>({})) as T & {code?:string};
  if(!response.ok)throw new Error(body.code??'Learning diagnostics unavailable.');
  return body;
}
const n=(value:number|null,digits=2)=>value===null?'—':value.toFixed(digits);
const pct=(value:number|null)=>value===null?'—':`${(value*100).toFixed(1)}%`;

export default function OwnerLearningScreen(){
  const {request}=useAuth();
  const [access,setAccess]=useState<'CHECKING'|'ALLOWED'|'DENIED'>('CHECKING');
  const [learning,setLearning]=useState<Learning|null>(null);
  const [error,setError]=useState('');
  useEffect(()=>{
    let active=true;
    void request('/v1/owner/history/learning').then(async(response)=>{
      if(!active)return;
      if(response.status===404){setAccess('DENIED');return;}
      try{const data=await read<Learning>(response);
        if(active){setLearning(data);setAccess('ALLOWED');setError('');}}
      catch(cause){if(active){setAccess('ALLOWED');
        setError(cause instanceof Error?cause.message:'Learning diagnostics unavailable.');}}
    }).catch((cause:unknown)=>{if(active){setAccess('ALLOWED');
      setError(cause instanceof Error?cause.message:'Learning diagnostics unavailable.');}});
    return()=>{active=false;};
  },[request]);

  return <Screen eyebrow="CROWNIQ  /  OWNER ONLY" title="Learning">
    <Pressable accessibilityRole="button"
      onPress={()=>router.canGoBack()?router.back():router.replace('/(tabs)/more')}>
      <Text style={styles.back}>← Back to Settings</Text>
    </Pressable>
    {access==='CHECKING'&&<ActivityIndicator color={palette.green}/>}
    {access==='DENIED'&&<Notice title="Private area"
      detail="Learning diagnostics are only available to the owner profile configured on the server."/>}
    {access==='ALLOWED'&&<>
      <Notice title="Verified outcomes only"
        detail="This page summarizes tracked results for calibration review. It does not change GKR weights, promote model versions, or treat Data Confidence as hit probability."/>
      {learning&&<View style={styles.card}>
        <Text style={styles.heading}>CALIBRATION DATA</Text>
        <Text style={styles.row}>Tracked decisions: {learning.tracked.toLocaleString()}</Text>
        <Text style={styles.row}>Pending results: {learning.pending.toLocaleString()}</Text>
        <Text style={styles.row}>Verified graded: {learning.graded.toLocaleString()}</Text>
        <Text style={styles.row}>DNP / void: {learning.dnpVoid.toLocaleString()}</Text>
      </View>}
      {learning&&<View style={styles.card}>
        <Text style={styles.heading}>NFL AUTO-GRADING</Text>
        <Text style={styles.row}>Worker: {learning.autoGrading.enabled?'ON':'OFF'}</Text>
        <Text style={styles.row}>Exact auto resolver: {learning.autoGrading.automaticResolution?'AVAILABLE':'OFF'}</Text>
        <Text style={styles.row}>Manual mapping override: {learning.autoGrading.mappingStatus}</Text>
        <Text style={styles.row}>Pending eligible: {learning.autoGrading.pendingEligible.toLocaleString()}</Text>
        <Text style={styles.row}>Manual-mapped pending: {learning.autoGrading.manualMappedPending.toLocaleString()}</Text>
        <Text style={styles.row}>Auto-resolve pending: {learning.autoGrading.autoResolvePending.toLocaleString()}</Text>
        {learning.autoGrading.worker&&<>
          <Text style={styles.row}>Scheduler: {learning.autoGrading.worker.scheduled?'ACTIVE':'STOPPED'}
            {learning.autoGrading.worker.running?' · CHECKING NOW':''}</Text>
          <Text style={styles.row}>Last check: {learning.autoGrading.worker.lastFinishedAt
            ? new Date(learning.autoGrading.worker.lastFinishedAt).toLocaleString():'Not run yet'}</Text>
          <Text style={styles.row}>Last result: {learning.autoGrading.worker.lastResult
            ? `graded ${learning.autoGrading.worker.lastResult.graded} · pending ${learning.autoGrading.worker.lastResult.pending}`
            : '—'}</Text>
          <Text style={styles.row}>Next check: {learning.autoGrading.worker.nextRunAt
            ? new Date(learning.autoGrading.worker.nextRunAt).toLocaleString():'—'}</Text>
          {!!learning.autoGrading.worker.lastError&&
            <Text style={styles.error}>Last grading error: {learning.autoGrading.worker.lastError}</Text>}
        </>}
        <Text style={styles.hint}>{learning.autoGrading.markets.join(' · ')}</Text>
      </View>}
      {learning?.graded===0&&<Notice title="No graded calibration sample yet"
        detail="Keep current model weights unchanged. CrownIQ has tracked decisions, but no verified WIN / LOSS / PUSH outcomes are available for learning diagnostics yet."/>}
      {!!learning?.models.length&&<View style={styles.section}>
        <Text style={styles.heading}>MODEL RESULTS</Text>
        {learning.models.map((model)=><View key={model.modelVersion} style={styles.card}>
          <Text style={styles.model}>{model.modelVersion}</Text>
          <Text style={styles.row}>Sample: {model.picks} · W {model.wins} · L {model.losses} · P {model.pushes}</Text>
          <Text style={styles.row}>Hit rate: {pct(model.hitRate)} · Avg line score: {n(model.averageLineScore)}</Text>
          <Text style={styles.row}>Avg data confidence: {n(model.averageDataConfidence,1)}%</Text>
          <Text style={styles.row}>Projection MAE: {n(model.projectionMAE)} · Bias: {n(model.projectionBias)} · n={model.projectionSamples}</Text>
        </View>)}
      </View>}
      {!!learning?.factorDiagnostics.length&&<View style={styles.section}>
        <Text style={styles.heading}>FACTOR DIAGNOSTICS</Text>
        <Text style={styles.hint}>Descriptive only. Differences do not automatically change factor weights.</Text>
        {learning.factorDiagnostics.slice(0,20).map((factor)=><View
          key={`${factor.modelVersion}:${factor.factor}`} style={styles.card}>
          <Text style={styles.model}>{factor.factor}</Text>
          <Text style={styles.hint}>{factor.modelVersion}</Text>
          <Text style={styles.row}>Samples: {factor.samples} · W {factor.wins} · L {factor.losses}</Text>
          <Text style={styles.row}>Avg contribution W: {n(factor.averageContributionWins)} · L: {n(factor.averageContributionLosses)}</Text>
        </View>)}
      </View>}
      {!!error&&<Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    </>}
  </Screen>;
}

const styles=StyleSheet.create({
  back:{color:palette.green,fontSize:14,fontWeight:'700',minHeight:36},
  section:{gap:10},
  card:{backgroundColor:palette.card,borderColor:palette.border,borderWidth:1,
    borderRadius:16,padding:16,gap:6},
  heading:{color:palette.green,fontSize:11,fontWeight:'900',letterSpacing:1.2},
  model:{color:palette.text,fontSize:14,fontWeight:'800'},
  row:{color:palette.text,fontSize:13,lineHeight:19},
  hint:{color:palette.muted,fontSize:11,lineHeight:17},
  error:{color:palette.danger,fontSize:13,lineHeight:19},
});
