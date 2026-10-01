import { boardResponseSchema } from '@crowniq/contracts';
import type { BoardResponse } from '@crowniq/contracts';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Platform } from 'react-native';
import { loadBoard, saveBoard } from './local-store';
import { freshness } from './state';
import { reportMobileFailure } from './diagnostics';
import { useAuth } from './auth';

type BoardState={status:'loading'|'available'|'unavailable';data:BoardResponse|null;message:string;
  freshness:'LIVE'|'FRESH'|'CACHED'|'SNAPSHOT'|'STALE'|'OFFLINE'|'UNREACHABLE'|'UNAVAILABLE';
  researchStatus:string;gradingStatus:string;refreshing:boolean;nowMs:number;
  /** Free reread of the saved server board. Never spends provider credits. */
  reload:()=>void;
  /** True only after the server answered that it has no board yet. */
  needsBootstrap:boolean;
  /** Paid first-board pull. Call only after the owner confirms the credit cost. */
  bootstrapPull:()=>void};
type OwnerRefreshStatus={job?:{status?:'IDLE'|'RUNNING'|'SUCCEEDED'|'FAILED';error?:string|null}};
const Context=createContext<BoardState|null>(null);
const apiBase=process.env.EXPO_PUBLIC_API_URL?.replace(/\/$/,'');
const sleep=(ms:number)=>new Promise<void>((resolve)=>setTimeout(resolve,ms));

function responseMessage(status:number):string {
  if(status===503)return 'Waiting for the first PrizePicks board.';
  if(status===401)return 'Session expired. Sign out and sign in again.';
  return 'Board refresh failed.';
}

export function BoardProvider({children}:{children:ReactNode}) {
  const {request}=useAuth();
  const [data,setData]=useState<BoardResponse|null>(null);
  const [status,setStatus]=useState<BoardState['status']>(apiBase?'loading':'unavailable');
  const [message,setMessage]=useState(apiBase?'':'The CrownIQ API address is not configured.');
  const [researchStatus,setResearchStatus]=useState('Unavailable');
  const [gradingStatus,setGradingStatus]=useState('Unavailable');
  const [reachable,setReachable]=useState(true);
  const [offline,setOffline]=useState(()=>typeof navigator!=='undefined' && navigator.onLine===false);
  const [clock,setClock]=useState(()=>Date.now());
  const [attempt,setAttempt]=useState(0);
  const [refreshing,setRefreshing]=useState(false);
  const [needsBootstrap,setNeedsBootstrap]=useState(false);

  useEffect(()=>{
    const timer=setInterval(()=>setClock(Date.now()),60_000);
    return ()=>clearInterval(timer);
  },[]);
  useEffect(()=>{
    if(Platform.OS!=='web' || typeof window==='undefined')return;
    const update=()=>setOffline(navigator.onLine===false);
    window.addEventListener('online',update);window.addEventListener('offline',update);
    return ()=>{window.removeEventListener('online',update);window.removeEventListener('offline',update);};
  },[]);
  useEffect(()=>{
    let active=true;
    void loadBoard().then((cached)=>{if(active && cached){setData((current)=>current ?? cached);setStatus('available');}})
      .catch((error:unknown)=>reportMobileFailure('storage',error));
    return ()=>{active=false;};
  },[]);
  useEffect(()=>{
    let active=true;
    if(!apiBase)return;
    const controller=new AbortController();
    void (async()=>{
      try{
        const response=await request('/v1/board',{signal:controller.signal});
        if(!active)return;
        // Any HTTP response proves the API is reachable. A 503 means the board is
        // unavailable, not that the phone cannot reach CrownIQ.
        setReachable(true);
        if(!response.ok){
          setNeedsBootstrap(response.status===503);
          setStatus((previous)=>previous==='available'?'available':'unavailable');
          setMessage(responseMessage(response.status));
          return;
        }
        const board=boardResponseSchema.parse(await response.json());
        if(!active)return;
        setData(board);setStatus('available');setMessage('');setNeedsBootstrap(false);
        void saveBoard(board).catch((error:unknown)=>reportMobileFailure('storage',error));
        try{
          const summaryResponse=await request('/v1/board/summary',{signal:controller.signal});
          if(!active || !summaryResponse.ok)return;
          const summary=await summaryResponse.json() as {researchStatus?:string;gradingStatus?:string};
          setResearchStatus(summary.researchStatus??'Unavailable');
          setGradingStatus(summary.gradingStatus??'Unavailable');
        }catch{ /* Board data is still valid if the optional summary fails. */ }
      }catch(error){
        if(!active || controller.signal.aborted)return;
        reportMobileFailure('board',error);
        setReachable(false);setStatus((previous)=>previous==='available'?'available':'unavailable');
        setMessage(error instanceof Error ? error.message : 'Server unreachable.');
      }
    })();
    return ()=>{active=false;controller.abort();};
  },[attempt,request]);

  const reload=useCallback(()=>{
    setStatus((previous)=>previous==='available'?'available':'loading');setAttempt((n)=>n+1);
  },[]);
  const pulling=useRef(false);
  const bootstrapPull=useCallback(()=>{
    if(pulling.current)return;
    pulling.current=true;setRefreshing(true);setReachable(true);
    setMessage('Starting the first PrizePicks board pull…');
    const settle=(text:string)=>{setStatus((previous)=>previous==='available'?'available':'unavailable');
      setMessage(text);};
    void (async()=>{
      try{
        // The server refuses this route once any board exists, so it can never repeat a pull.
        const start=await request('/v1/owner/board/bootstrap',{method:'POST',
          headers:{'content-type':'application/json'},
          body:JSON.stringify({acknowledgeProviderCost:true})});
        setReachable(true);
        if(start.status===409){setNeedsBootstrap(false);reload();setMessage('');return;}
        if(start.status===404){settle('Waiting for the first PrizePicks board. The signed-in owner must publish it.');return;}
        if(start.status===503){settle('PrizePicks provider is not configured on this CrownIQ server.');return;}
        if(start.status===428){settle('Provider pull confirmation was rejected.');return;}
        if(!start.ok){settle('Could not start the PrizePicks board pull.');return;}
        setMessage('Building the PrizePicks board. This can take a few minutes…');
        for(let poll=0;poll<150;poll++){
          await sleep(2000);
          const boardResponse=await request('/v1/board');
          setReachable(true);
          if(boardResponse.ok){
            const board=boardResponseSchema.parse(await boardResponse.json());
            setData(board);setStatus('available');setMessage('');setNeedsBootstrap(false);
            void saveBoard(board).catch((error:unknown)=>reportMobileFailure('storage',error));
            return;
          }
          if(boardResponse.status===401){settle('Session expired. Sign out and sign in again.');return;}
          const ownerStatus=await request('/v1/owner/board/status');
          if(ownerStatus.ok){
            const payload=await ownerStatus.json() as OwnerRefreshStatus;
            if(payload.job?.status==='FAILED'){
              settle('PrizePicks board pull failed'+(payload.job.error?': '+payload.job.error:'.'));return;
            }
          }
        }
        settle('The PrizePicks board is still building. Check back in a moment.');
      }catch(error){
        reportMobileFailure('board',error);
        setReachable(false);settle(error instanceof Error?error.message:'Server unreachable.');
      }finally{pulling.current=false;setRefreshing(false);}
    })();
  },[request,reload]);

  return <Context.Provider value={{status:data?'available':status,data,message,
    researchStatus,gradingStatus,refreshing,nowMs:clock,
    freshness:freshness(data,reachable,clock,offline),reload,needsBootstrap,bootstrapPull}}>
    {children}
  </Context.Provider>;
}
export function useBoard():BoardState {
  const state=useContext(Context);
  if(!state)throw new Error('BoardProvider required');
  return state;
}
