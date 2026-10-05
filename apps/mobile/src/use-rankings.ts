import { rankingsResponseSchema } from '@crowniq/contracts';
import type { RankingsResponse } from '@crowniq/contracts';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { applyBetaRankings } from './beta';
import { useModel } from './use-model';
import { useAuth } from './auth';
import { useBoard } from './use-board';
import { reportMobileFailure } from './diagnostics';

type RankingsState={status:'loading'|'available'|'unavailable';data:RankingsResponse|null;message:string};

export function useRankings():RankingsState & {retry:()=>void} {
  const {request}=useAuth();
  const {data:board}=useBoard();
  const [attempt,setAttempt]=useState(0);
  const [focused,setFocused]=useState(false);
  const requestKey=JSON.stringify([board?.builtAt??null,attempt]);
  const [state,setState]=useState<RankingsState & {requestKey:string}>({status:'loading',data:null,message:'',requestKey:''});
  useFocusEffect(useCallback(()=>{
    setFocused(true);setAttempt((value)=>value+1);
    const timer=setInterval(()=>setAttempt((value)=>value+1),60_000);
    return ()=>{setFocused(false);clearInterval(timer);};
  },[]));
  useEffect(()=>{
    if(!focused)return;
    let active=true;const controller=new AbortController();
    void (async()=>{
      try{
        const response=await request('/v1/rankings',{signal:controller.signal});
        if(!active)return;
        if(!response.ok){
          setState({status:'unavailable',data:null,requestKey,
            message:response.status===503?'Rankings are waiting for a board.':'Could not load rankings.'});
          return;
        }
        const data=rankingsResponseSchema.parse(await response.json());
        if(active)setState({status:'available',data,message:'',requestKey});
      }catch(error){
        if(!active||controller.signal.aborted)return;
        reportMobileFailure('rankings',error);
        setState({status:'unavailable',data:null,requestKey,
          message:error instanceof Error?error.message:'Could not load rankings.'});
      }
    })();
    // Refresh saved analysis only. Focus, reanalysis and expiry never pull odds.
    return ()=>{active=false;controller.abort();};
  },[request,requestKey,focused]);
  const visible=state.requestKey===requestKey?state:{status:'loading' as const,data:null,message:''};
  // GKR Beta re-ranks Top Picks by Beta's scores.
  const {model,beta}=useModel(board?.builtAt??null);
  const data=useMemo(()=>visible.data&&model==='BETA'&&beta?applyBetaRankings(visible.data,beta):visible.data,[visible.data,model,beta]);
  return {status:visible.status,data,message:visible.message,
    retry:()=>setAttempt((value)=>value+1)};
}
