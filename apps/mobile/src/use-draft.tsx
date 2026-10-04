import type { Analysis, PlayableDirection, PropLine } from '@crowniq/contracts';
import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { loadDraft, saveDraft } from './local-store';
import { addLeg, emptyFilters } from './state';
import type { CrownLeg, Filters, LegTip, TipId, ViewMode } from './state';
import { reportMobileFailure } from './diagnostics';
import { useBoard } from './use-board';

type DraftContext={legs:CrownLeg[];filters:Filters;setFilters:(next:Filters)=>void;
  viewMode:ViewMode;setViewMode:(mode:ViewMode)=>void;ready:boolean;
  /**
   * Adds a leg. A hard stop comes back as `error`; tips the user has not accepted (or hidden) come back as `tips` and
   * the leg is not added until they call again with those tips in `accept`.
   */
  add:(line:PropLine,analysis:Analysis|undefined,direction:PlayableDirection,accept?:readonly TipId[])=>
    {error:string|null;tips:LegTip[]};
  remove:(lineId:string)=>void;
  /** Replace every leg at once, e.g. with an auto-built Crown. */
  replace:(next:CrownLeg[])=>void;
  /** Tips the user chose not to see again; hiding one also accepts it from then on. */
  hiddenTips:TipId[];hideTips:(ids:readonly TipId[])=>void;showAllTips:()=>void};
const Context=createContext<DraftContext|null>(null);
export function DraftProvider({children,profileId}:{children:ReactNode;profileId:string}) {
  const [legs,setLegs]=useState<CrownLeg[]>([]);
  const [filters,setFilters]=useState<Filters>(emptyFilters);
  const [viewMode,setViewMode]=useState<ViewMode>('LITE');
  const [hiddenTips,setHiddenTips]=useState<TipId[]>([]);
  const [ready,setReady]=useState(false);
  const {nowMs}=useBoard();
  useEffect(()=>{
    let active=true;
    void loadDraft(profileId).then((draft)=>{if(active){setLegs(draft.legs);setFilters(draft.filters);
      setViewMode(draft.viewMode);setHiddenTips(draft.hiddenTips);setReady(true);}})
      .catch((error:unknown)=>{reportMobileFailure('storage',error);if(active)setReady(true);});
    return ()=>{active=false;};
  },[profileId]);
  useEffect(()=>{if(ready)void saveDraft(profileId,{legs,filters,viewMode,hiddenTips})
    .catch((error:unknown)=>reportMobileFailure('storage',error));},[legs,filters,viewMode,hiddenTips,ready,profileId]);
  return <Context.Provider value={{legs,filters,setFilters,viewMode,setViewMode,ready,hiddenTips,
    add:(line,analysis,direction,accept=[])=>{
      const result=addLeg(legs,line,analysis,direction,nowMs,[...accept,...hiddenTips]);
      if(!result.error&&!result.tips.length)setLegs(result.legs);
      return {error:result.error,tips:result.tips};
    },remove:(lineId)=>setLegs((current)=>current.filter((leg)=>leg.line.id!==lineId)),
    replace:(next)=>setLegs(next),
    hideTips:(ids)=>setHiddenTips((current)=>[...new Set([...current,...ids])]),
    showAllTips:()=>setHiddenTips([])}}>
    {children}
  </Context.Provider>;
}
export function useDraft():DraftContext {
  const context=useContext(Context);
  if(!context)throw new Error('DraftProvider required');
  return context;
}
