import { useCallback, useEffect, useState } from 'react';
import { router } from 'expo-router';
import { ActivityIndicator, Platform, Pressable, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { File, Paths } from 'expo-file-system';
import { Notice, Screen } from '../../components/Screen';
import { useAuth } from '../../auth';
import { palette } from '../../theme';

type Sport='NFL'|'NBA'|'MLB'|'PGA';
type Player={id:number;name:string;teamId:number|null};
type Status={configured:boolean;todayRows?:number;dailyLimit?:number;
  quotaUsed?:number|null;quotaRemaining?:number|null;publicBoardImpact:'NONE';
  notebook?:{watched:number;saved:number;autoRefreshMinutes:number;running:boolean;
    lastRunAt:string|null;lastRunError:string|null}|null};
type Search={players:Player[];partial:boolean;retrievedAt:string;sourceUrl:string};
type Detail={sport:Sport;player:Player;table:string;sourceUrl:string;retrievedAt:string;
  nextFromId:number|null;sampleOnly:boolean;officialStatusConfirmed:false;
  rows:{gameId:number|null;tournamentId:number|null;metrics:Record<string,number>}[]};
type Entry={key:string;sport:Sport;playerId:number;table:string;playerName:string;
  watching:boolean;notes:string;independentSources:string[];reviewed:boolean;
  lastSuccessfulAt:string|null;lastError:string|null;detail:Detail|null};
type Notebook={version:1;entries:Entry[];exportedAt:string};
const sports:Sport[]=['NFL','NBA','MLB','PGA'];
const messages:Record<string,string>={
  STAT_API_UNCONFIGURED:'Your stat-api key has not been added to the CrownIQ server.',
  STAT_API_QUOTA_EXHAUSTED:'Your stat-api monthly record quota is exhausted.',
  STAT_API_BUDGET_EXHAUSTED:'Today’s private research record limit has been reached.',
  STAT_API_UNREACHABLE:'Stat-api could not be reached. Try again later.',
  STAT_API_KEY_REJECTED:'The server’s stat-api key was rejected.',
  STAT_API_PLAYER_NOT_FOUND:'That player is no longer available from this source.',
  STAT_API_UNAVAILABLE:'Research is unavailable right now. Try again later.',
  RESEARCH_WATCHLIST_FULL:'The private watchlist is full. Keep up to 100 player tables.',
  INVALID_RESEARCH_ANNOTATIONS:'The edited file needs valid notes and HTTPS source links.',
  UNKNOWN_RESEARCH_ITEM:'An edited file referenced a player that is not in this notebook.',
  STALE_RESEARCH_ANNOTATION:'Newer research has arrived. Open the latest file before marking it reviewed.',
};
async function read<T>(response:Response):Promise<T>{
  const body=await response.json().catch(()=>({})) as T & {code?:string};
  if(!response.ok)throw new Error(messages[body.code??'']??'Research could not be loaded.');
  return body;
}
function sampleLabel(key:string){return key.replace(/_/g,' ').replace(/\b\w/g,(letter)=>letter.toUpperCase());}

export default function OwnerResearchScreen(){
  const {request}=useAuth();
  const [access,setAccess]=useState<'CHECKING'|'ALLOWED'|'DENIED'>('CHECKING');
  const [status,setStatus]=useState<Status|null>(null);
  const [sport,setSport]=useState<Sport>('NFL');
  const [name,setName]=useState('');
  const [search,setSearch]=useState<Search|null>(null);
  const [selected,setSelected]=useState<Player|null>(null);
  const [detail,setDetail]=useState<Detail|null>(null);
  const [pitcher,setPitcher]=useState(false);
  const [season,setSeason]=useState(false);
  const [notebook,setNotebook]=useState<Notebook|null>(null);
  const [editing,setEditing]=useState<string|null>(null);
  const [notes,setNotes]=useState('');
  const [sourceLinks,setSourceLinks]=useState('');
  const [reviewed,setReviewed]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const refreshStatus=useCallback(async()=>{
    const response=await request('/v1/owner/research/status');
    if(!response.ok){setAccess('DENIED');return null;}
    const next=await read<Status>(response);setStatus(next);setAccess('ALLOWED');return next;
  },[request]);
  const loadNotebook=useCallback(async()=>{
    const response=await request('/v1/owner/research/notebook');
    if(response.ok)setNotebook(await read<Notebook>(response));
  },[request]);
  useEffect(()=>{
    let mounted=true;
    void request('/v1/owner/research/status').then(async(response)=>{
      if(!mounted)return;
      if(!response.ok){setAccess('DENIED');return;}
      setStatus(await read<Status>(response));setAccess('ALLOWED');
      void loadNotebook().catch(()=>undefined);
    }).catch(()=>{if(mounted)setAccess('DENIED');});
    return ()=>{mounted=false;};
  },[request,loadNotebook]);
  useEffect(()=>{
    if(!status?.notebook?.running)return;
    const timer=setInterval(()=>{void refreshStatus().then(()=>loadNotebook()).catch(()=>undefined);},15_000);
    return ()=>clearInterval(timer);
  },[status?.notebook?.running,refreshStatus,loadNotebook]);
  const chooseSport=(next:Sport)=>{
    setSport(next);setName('');setSearch(null);setSelected(null);setDetail(null);setError('');
    setPitcher(false);setSeason(false);
  };
  const lookup=async()=>{
    if(!status?.configured || busy || name.trim().length<2)return;
    setBusy(true);setError('');setSelected(null);setDetail(null);
    try{const found=await read<Search>(await request(`/v1/owner/research/search?sport=${sport}&q=${encodeURIComponent(name.trim())}`));
      setSearch(found);await refreshStatus();}
    catch(cause){setError((cause as Error).message);}
    finally{setBusy(false);}
  };
  const tableFor=(next:Sport,asPitcher=pitcher,asSeason=season)=>next==='MLB'
    ? asPitcher?'game_player_pitching_stats':'game_player_batter_stats'
    : next==='PGA'?asSeason?'player_season_stats':'player_rounds':'game_player_stats';
  const inspect=async(item:Player,asPitcher=pitcher,asSeason=season)=>{
    if(busy)return;
    setBusy(true);setError('');setSelected(item);setDetail(null);
    const table=tableFor(sport,asPitcher,asSeason);
    try{const data=await read<Detail>(await request(`/v1/owner/research/player/${sport}/${item.id}?table=${table}`));
      setDetail(data);await refreshStatus();}
    catch(cause){setError((cause as Error).message);}
    finally{setBusy(false);}
  };
  const watch=async()=>{
    if(!selected||!detail||busy)return;
    setBusy(true);setError('');
    try{await read(await request('/v1/owner/research/watch',{method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify({sport,playerId:selected.id,table:detail.table})}));
      await loadNotebook();await refreshStatus();}
    catch(cause){setError((cause as Error).message);}finally{setBusy(false);}
  };
  const refreshWatched=async()=>{
    setError('');try{await read(await request('/v1/owner/research/refresh',{method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify({acknowledgeRecords:true})}));
      await refreshStatus();}
    catch(cause){setError((cause as Error).message);}
  };
  const saveNotes=async()=>{
    if(!editing)return;
    const links=sourceLinks.split('\n').map((line)=>line.trim()).filter(Boolean);
    setBusy(true);setError('');
    try{await read(await request('/v1/owner/research/import',{method:'PUT',
      headers:{'content-type':'application/json'},body:JSON.stringify({version:1,
        entries:[{key:editing,notes,independentSources:links,reviewed,
          lastSuccessfulAt:notebook?.entries.find((item)=>item.key===editing)?.lastSuccessfulAt??null}]})}));
      await loadNotebook();setEditing(null);}
    catch(cause){setError((cause as Error).message);}finally{setBusy(false);}
  };
  const exportFile=async()=>{
    setError('');try{
      const snapshot=await read<Notebook>(await request('/v1/owner/research/export'));
      const contents=JSON.stringify(snapshot,null,2);
      if(Platform.OS==='web'){
        const url=URL.createObjectURL(new Blob([contents],{type:'application/json'}));
        const link=document.createElement('a');link.href=url;link.download='crowniq-owner-research.json';
        document.body.appendChild(link);link.click();link.remove();
        setTimeout(()=>URL.revokeObjectURL(url),60_000);
      }else if(Platform.OS==='ios'){
        const file=new File(Paths.cache,`crowniq-owner-research-${Date.now()}.json`);
        file.create();file.write(contents);
        try{await Share.share({url:file.uri});}finally{file.delete();}
      }else setError('File download is available on the CrownIQ web app. Your notes still save here.');
    }catch(cause){setError((cause as Error).message);}
  };
  const importFile=async()=>{
    setError('');try{
      let contents:string;
      if(Platform.OS==='web'){
        const input=document.createElement('input');input.type='file';input.accept='.json,application/json';
        const file=await new Promise<globalThis.File|null>((resolve)=>{
          input.onchange=()=>resolve(input.files?.[0]??null);
          input.addEventListener('cancel',()=>resolve(null),{once:true});input.click();});
        if(!file)return;contents=await file.text();
      }else{
        const picked=await File.pickFileAsync({mimeTypes:['application/json']});
        if(picked.canceled)return;
        const file=picked.result;contents=await file.text();
      }
      if(contents.length>1_000_000)throw new Error('That file is too large.');
      await read(await request('/v1/owner/research/import',{method:'PUT',
        headers:{'content-type':'application/json'},body:contents}));
      await loadNotebook();
    }catch(cause){setError((cause as Error).message);}
  };
  return <Screen eyebrow="CROWNIQ  /  OWNER ONLY" title="Research Desk">
    <Pressable accessibilityRole="button" onPress={()=>router.canGoBack()?router.back():router.replace('/(tabs)/settings')}>
      <Text style={styles.back}>← Back to Settings</Text>
    </Pressable>
    {access==='CHECKING' && <ActivityIndicator color={palette.green} />}
    {access==='DENIED' && <Notice title="Private area" detail="This desk is only available to the owner profile configured on the server." />}
    {access==='ALLOWED' && <>
      <Notice title="Your private research"
        detail="Find supporting context for your own review. Nothing here enters public GKR scores, rankings, tracked results, or the user board." />
      {!status?.configured && <Notice title="Set up your key" detail="Add STAT_API_KEY to the CrownIQ server environment. The key never goes in your phone or Expo." />}
      <View style={styles.usage}>
        <Text style={styles.usageTitle}>STAT-API PRO · USAGE</Text>
        <Text style={styles.body}>Records returned today: {status?.todayRows??'—'} / {status?.dailyLimit??'—'}</Text>
        <Text style={styles.body}>Monthly remaining: {status?.quotaRemaining??'Not reported yet'}</Text>
        <Text style={styles.hint}>A search may fetch roster rows once; repeat searches use a temporary cache. Your provider’s dashboard has the monthly total.</Text>
        <Text style={styles.body}>Watched: {status?.notebook?.watched??0} · Auto refresh every {status?.notebook?.autoRefreshMinutes??'—'} min</Text>
        {status?.notebook?.lastRunAt&&<Text style={styles.hint}>Last refresh: {new Date(status.notebook.lastRunAt).toLocaleString()} · {status.notebook.lastRunError??'Complete'}</Text>}
      </View>
      <Text style={styles.label}>Sport</Text>
      <View style={styles.sports}>{sports.map((value)=><Pressable key={value} accessibilityRole="button"
        accessibilityState={{selected:value===sport}} onPress={()=>chooseSport(value)}
        style={[styles.sport,value===sport&&styles.activeSport]}>
        <Text style={[styles.sportText,value===sport&&styles.activeSportText]}>{value}</Text>
      </Pressable>)}</View>
      <Text style={styles.label}>Find a player</Text>
      <TextInput accessibilityLabel="Search player name" autoCorrect={false} value={name}
        onChangeText={setName} placeholder={`Search active ${sport} players`}
        placeholderTextColor={palette.muted} style={styles.input} />
      <Pressable accessibilityRole="button" disabled={busy||!status?.configured||name.trim().length<2}
        onPress={()=>void lookup()} style={[styles.action,(!status?.configured||busy)&&styles.disabled]}>
        <Text style={styles.actionText}>{busy?'Looking up…':'Look up player'}</Text>
      </Pressable>
      {sport==='MLB'&&<View style={styles.sports}>
        <Pressable accessibilityRole="button" accessibilityState={{selected:!pitcher}}
          onPress={()=>{setPitcher(false);if(selected)void inspect(selected,false);}} style={[styles.sport,!pitcher&&styles.activeSport]}>
          <Text style={[styles.sportText,!pitcher&&styles.activeSportText]}>Batting</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityState={{selected:pitcher}}
          onPress={()=>{setPitcher(true);if(selected)void inspect(selected,true);}} style={[styles.sport,pitcher&&styles.activeSport]}>
          <Text style={[styles.sportText,pitcher&&styles.activeSportText]}>Pitching</Text>
        </Pressable>
      </View>}
      {sport==='PGA'&&<View style={styles.sports}>
        <Pressable accessibilityRole="button" accessibilityState={{selected:!season}}
          onPress={()=>{setSeason(false);if(selected)void inspect(selected,pitcher,false);}} style={[styles.sport,!season&&styles.activeSport]}>
          <Text style={[styles.sportText,!season&&styles.activeSportText]}>Rounds</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityState={{selected:season}}
          onPress={()=>{setSeason(true);if(selected)void inspect(selected,pitcher,true);}} style={[styles.sport,season&&styles.activeSport]}>
          <Text style={[styles.sportText,season&&styles.activeSportText]}>Season</Text>
        </Pressable>
      </View>}
      {!!error&&<Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
      {search&&<View style={styles.results}>
        <Text style={styles.label}>Matching players {search.partial?'· partial roster sample':''}</Text>
        {search.players.length===0&&<Text style={styles.body}>No matching active player in the available rows. No player was guessed.</Text>}
        {search.players.map((item)=><Pressable key={item.id} accessibilityRole="button"
          accessibilityLabel={`Inspect ${item.name}, stat-api player ${item.id}`} disabled={busy}
          onPress={()=>void inspect(item)} style={styles.player}>
          <Text style={styles.playerName}>{item.name}</Text>
          <Text style={styles.hint}>Stat-api ID {item.id} · team ID {item.teamId??'unknown'} →</Text>
        </Pressable>)}
        <Text selectable style={styles.source}>Source: {search.sourceUrl}</Text>
      </View>}
      {selected&&detail&&<View style={styles.results}>
        <Text style={styles.label}>{detail.player.name} · {detail.sport}</Text>
        <Text style={styles.hint}>Stat-api ID {detail.player.id}. Match this player to your board before drawing conclusions.</Text>
        <Text style={styles.hint}>Returned game rows (up to 40). This sample is not verified L10 or a projection.</Text>
        {detail.rows.length===0&&<Text style={styles.body}>No game rows returned for this player and table.</Text>}
        {detail.rows.map((row,index)=><View key={`${row.gameId??row.tournamentId??'unknown'}-${index}`} style={styles.game}>
          <Text style={styles.gameTitle}>{sport==='PGA'?'Tournament':'Game'} ID {row.tournamentId??row.gameId??'unknown'}</Text>
          <Text style={styles.body}>{Object.entries(row.metrics).map(([key,value])=>`${sampleLabel(key)}: ${value}`).join(' · ')||'No mapped stats in this row'}</Text>
        </View>)}
        {detail.nextFromId!==null&&<Text style={styles.hint}>More rows exist at this source. This view only shows the returned sample.</Text>}
        <Text style={styles.hint}>Retrieved {new Date(detail.retrievedAt).toLocaleString()} · Status and starter role require official confirmation.</Text>
        <Text selectable style={styles.source}>Source: {detail.sourceUrl}</Text>
        <Pressable accessibilityRole="button" disabled={busy} onPress={()=>void watch()} style={styles.action}>
          <Text style={styles.actionText}>Watch and auto refresh this player table</Text>
        </Pressable>
      </View>}
      {notebook&&<View style={styles.results}>
        <Text style={styles.label}>Your private research file · {notebook.entries.length} saved</Text>
        <Text style={styles.hint}>Only watched player tables refresh automatically. The file stores source snapshots and your separate notes; neither changes public GKR scores.</Text>
        <Pressable accessibilityRole="button" disabled={status?.notebook?.running||!status?.notebook?.watched}
          onPress={()=>void refreshWatched()} style={[styles.action,status?.notebook?.running&&styles.disabled]}>
          <Text style={styles.actionText}>{status?.notebook?.running?'Refreshing watched players…':'Refresh private research now (uses records)'}</Text>
        </Pressable>
        <View style={styles.sports}>
          <Pressable accessibilityRole="button" onPress={()=>void exportFile()} style={styles.sport}>
            <Text style={styles.sportText}>Export JSON file</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={()=>void importFile()} style={styles.sport}>
            <Text style={styles.sportText}>Import edited notes</Text>
          </Pressable>
        </View>
        <Text style={styles.hint}>Save the export privately. Import accepts edits to notes, review flags, and independent source links; it never replaces original stat rows.</Text>
        {notebook.entries.map((item)=><View key={item.key} style={styles.game}>
          <Text style={styles.playerName}>{item.playerName} · {item.sport} · {item.table}</Text>
          <Text style={styles.hint}>{item.watching?'Auto refresh on':'Archived'} · {item.reviewed?'Reviewed':'Needs review'} · {item.lastSuccessfulAt?new Date(item.lastSuccessfulAt).toLocaleString():'No snapshot'}{item.lastError?` · ${item.lastError}`:''}</Text>
          {editing===item.key?<>
            <TextInput accessibilityLabel="Private research notes" multiline value={notes} onChangeText={setNotes}
              placeholder="Your review notes" placeholderTextColor={palette.muted} style={styles.notesInput} />
            <TextInput accessibilityLabel="Independent source links, one per line" multiline value={sourceLinks}
              onChangeText={setSourceLinks} placeholder="HTTPS sources, one per line"
              placeholderTextColor={palette.muted} style={styles.notesInput} />
            <Pressable accessibilityRole="button" onPress={()=>setReviewed(!reviewed)}>
              <Text style={styles.back}>{reviewed?'☑ Reviewed':'☐ Mark reviewed'}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" disabled={busy} onPress={()=>void saveNotes()} style={styles.action}>
              <Text style={styles.actionText}>Save private notes</Text>
            </Pressable>
          </>:<View style={styles.sports}>
            <Pressable accessibilityRole="button" onPress={()=>{
              setEditing(item.key);setNotes(item.notes);setSourceLinks(item.independentSources.join('\n'));
              setReviewed(item.reviewed);
            }}><Text style={styles.back}>Edit notes</Text></Pressable>
            {item.watching&&<Pressable accessibilityRole="button" onPress={()=>{
              void request('/v1/owner/research/unwatch',{method:'POST',headers:{'content-type':'application/json'},
                body:JSON.stringify({key:item.key})}).then(read).then(()=>loadNotebook()).then(()=>refreshStatus())
                .catch(()=>setError('Could not stop auto refresh.'));
            }}><Text style={styles.back}>Stop watching</Text></Pressable>}
          </View>}
        </View>)}
      </View>}
    </>}
  </Screen>;
}

const styles=StyleSheet.create({
  back:{color:palette.green,fontSize:14,fontWeight:'700',minHeight:36},
  usage:{backgroundColor:palette.card,borderColor:palette.border,borderWidth:1,borderRadius:16,padding:16,gap:7},
  usageTitle:{color:palette.green,fontSize:11,fontWeight:'800',letterSpacing:1.2},
  label:{color:palette.text,fontSize:15,fontWeight:'700'},
  body:{color:palette.text,fontSize:13,lineHeight:19},
  hint:{color:palette.muted,fontSize:12,lineHeight:18},
  sports:{flexDirection:'row',flexWrap:'wrap',gap:9},
  sport:{borderWidth:1,borderColor:palette.border,backgroundColor:palette.card,
    minWidth:65,minHeight:44,borderRadius:12,alignItems:'center',justifyContent:'center',paddingHorizontal:12},
  activeSport:{backgroundColor:palette.green,borderColor:palette.green},
  sportText:{color:palette.text,fontSize:13,fontWeight:'700'},
  activeSportText:{color:palette.background},
  input:{backgroundColor:palette.card,color:palette.text,borderColor:palette.border,
    borderWidth:1,borderRadius:12,minHeight:48,paddingHorizontal:14,fontSize:16},
  notesInput:{backgroundColor:palette.background,color:palette.text,borderColor:palette.border,
    borderWidth:1,borderRadius:12,minHeight:76,padding:12,fontSize:14,textAlignVertical:'top'},
  action:{minHeight:48,backgroundColor:palette.green,borderRadius:12,alignItems:'center',justifyContent:'center'},
  disabled:{opacity:.55},actionText:{color:palette.background,fontSize:14,fontWeight:'800'},
  error:{color:palette.danger,fontSize:13},
  results:{backgroundColor:palette.card,borderColor:palette.border,borderWidth:1,borderRadius:16,
    padding:16,gap:12},
  player:{paddingVertical:12,borderBottomWidth:1,borderColor:palette.border,minHeight:48,gap:5},
  playerName:{color:palette.green,fontSize:15,fontWeight:'700'},
  source:{color:palette.muted,fontSize:11,lineHeight:17},
  game:{borderTopWidth:1,borderColor:palette.border,paddingTop:10,gap:4},
  gameTitle:{color:palette.green,fontSize:12,fontWeight:'700'},
});
