import type { Analysis, PlayableDirection, PropLine } from '@crowniq/contracts';
import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { loadDraft, saveDraft } from './local-store';
import { addLeg, emptyFilters } from './state';
import type { CrownLeg, Filters, ViewMode } from './state';
import { reportMobileFailure } from './diagnostics';
import { useBoard } from './use-board';

type DraftContext={legs:CrownLeg[];filters:Filters;setFilters:(next:Filters)=>void;
  viewMode:ViewMode;setViewMode:(mode:ViewMode)=>void;ready:boolean;
  add:(line:PropLine,analysis:Analysis,direction:PlayableDirection)=>string|null;
  remove:(lineId:string)=>void};
const Context=createContext<DraftContext|null>(null);
export function DraftProvider({children,profileId}:{children:ReactNode;profileId:string}) {
  const [legs,setLegs]=useState<CrownLeg[]>([]);
  const [filters,setFilters]=useState<Filters>(emptyFilters);
  const [viewMode,setViewMode]=useState<ViewMode>('LITE');
  const [ready,setReady]=useState(false);
  const {nowMs}=useBoard();
  useEffect(()=>{
    let active=true;
    void loadDraft(profileId).then((draft)=>{if(active){setLegs(draft.legs);setFilters(draft.filters);
      setViewMode(draft.viewMode);setReady(true);}})
      .catch((error:unknown)=>{reportMobileFailure('storage',error);if(active)setReady(true);});
    return ()=>{active=false;};
  },[profileId]);
  useEffect(()=>{if(ready)void saveDraft(profileId,{legs,filters,viewMode})
    .catch((error:unknown)=>reportMobileFailure('storage',error));},[legs,filters,viewMode,ready,profileId]);
  return <Context.Provider value={{legs,filters,setFilters,viewMode,setViewMode,ready,
    add:(line,analysis,direction)=>{
      const result=addLeg(legs,line,analysis,direction,nowMs);
      if(!result.error)setLegs(result.legs);
      return result.error;
    },remove:(lineId)=>setLegs((current)=>current.filter((leg)=>leg.line.id!==lineId))}}>
    {children}
  </Context.Provider>;
}
export function useDraft():DraftContext {
  const context=useContext(Context);
  if(!context)throw new Error('DraftProvider required');
  return context;
}
