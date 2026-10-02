import { createHash } from 'node:crypto';
import { evidenceSchema } from '@crowniq/contracts';
import type { Evidence } from '@crowniq/contracts';
import type { ResearchAdapter, ResearchHealth, ResearchTarget } from '@crowniq/engine';

type JsonObject=Record<string,unknown>;
type League='nba'|'wnba';
type RosterPlayer={id:string;name:string;photoUrl:string};
type Team={id:string;nickname:string;rosterUrl:string};

const ESPN_BASE='https://site.api.espn.com/apis/site/v2/sports/basketball';
const LEAGUES:Readonly<Record<string,League>>={NBA:'nba',WNBA:'wnba'};
const TEAMS_TTL=12*3600_000,ROSTER_TTL=30*60_000,EVIDENCE_TTL=30*60_000;

const object=(value:unknown):JsonObject|null=>
  value&&typeof value==='object'&&!Array.isArray(value)?value as JsonObject:null;
const array=(value:unknown):unknown[]=>Array.isArray(value)?value:[];
const string=(value:unknown)=>typeof value==='string'?value.trim():typeof value==='number'?String(value):'';
const normalize=(value:string)=>value.normalize('NFKD').replace(/[̀-ͯ]/g,'')
  .toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim().replace(/\s+(jr|sr|ii|iii|iv)$/,'');
const hash=(value:string)=>createHash('sha256').update(value).digest('hex').slice(0,24);

/**
 * Team and headshot for NBA and WNBA players from ESPN's public team rosters.
 * A player is matched only inside the two teams of their game, so shared names never cross teams,
 * and the team reported is always one of the event's own sides. Emits identity evidence only,
 * which the engine keeps out of scoring.
 */
export class BasketballIdentityResearch implements ResearchAdapter{
  readonly id='espn-basketball-identity-v1';
  private cache=new Map<string,{until:number;value:unknown}>();
  private health:ResearchHealth={status:'OK',targets:0,searches:0,cacheHits:0,skipped:0,
    failures:0,noSources:0,lastRunAt:null};

  constructor(private readonly fetchFn:typeof fetch=fetch,private readonly clock:()=>Date=()=>new Date()){}
  getHealth(){return this.health;}
  supports(target:ResearchTarget):boolean{
    return !!LEAGUES[target.sport]&&!!target.homeTeam&&!!target.awayTeam&&
      Date.parse(target.eventStartTime)>this.clock().getTime();
  }

  private async json(url:string,ttlMs:number,counters:{searches:number;cacheHits:number}):Promise<unknown>{
    const now=this.clock().getTime(),cached=this.cache.get(url);
    if(cached&&cached.until>now){counters.cacheHits++;return cached.value;}
    counters.searches++;
    const response=await this.fetchFn(url,{signal:AbortSignal.timeout(15_000)});
    if(!response.ok)throw new Error('BASKETBALL_IDENTITY_SOURCE_UNAVAILABLE');
    const value=await response.json() as unknown;
    this.cache.set(url,{until:now+ttlMs,value});
    return value;
  }

  private async teams(league:League,counters:{searches:number;cacheHits:number}):Promise<Team[]>{
    const root=object(await this.json(`${ESPN_BASE}/${league}/teams`,TEAMS_TTL,counters));
    const leagues=array(object(array(root?.sports)[0])?.leagues);
    return array(object(leagues[0])?.teams).flatMap((entry)=>{
      const team=object(object(entry)?.team);
      const id=string(team?.id),nickname=string(team?.name);
      return id&&nickname?[{id,nickname,rosterUrl:`${ESPN_BASE}/${league}/teams/${encodeURIComponent(id)}/roster`}]:[];
    });
  }

  private async roster(league:League,team:Team,counters:{searches:number;cacheHits:number}):Promise<RosterPlayer[]>{
    const root=object(await this.json(team.rosterUrl,ROSTER_TTL,counters));
    // Basketball rosters are a flat list; grouped lists ({items:[...]}) are flattened too.
    const athletes=array(root?.athletes).flatMap((entry)=>{
      const items=object(entry)?.items;return Array.isArray(items)?items:[entry];
    });
    return athletes.flatMap((entry)=>{
      const athlete=object(entry);const id=string(athlete?.id);
      const name=string(athlete?.fullName)||string(athlete?.displayName);
      if(!id||!name)return [];
      const href=string(object(athlete?.headshot)?.href);
      return [{id,name,photoUrl:href.startsWith('https://')?href
        :`https://a.espncdn.com/i/headshots/${league}/players/full/${encodeURIComponent(id)}.png`}];
    });
  }

  private evidence(target:ResearchTarget,kind:string,finding:string,sourceUrl:string,now:Date):Evidence{
    return evidenceSchema.parse({id:'identity:'+hash(JSON.stringify([target.eventId,target.playerId,kind,
      Math.floor(now.getTime()/EVIDENCE_TTL)])),entityType:'PLAYER',entityId:target.playerId,
      eventId:target.eventId,market:null,kind,finding,sourceName:'ESPN public team rosters',sourceUrl,
      sourceType:'PUBLIC',retrievedAt:now.toISOString(),expiresAt:new Date(Math.min(
        Date.parse(target.eventStartTime),now.getTime()+EVIDENCE_TTL)).toISOString(),
      quality:'MEDIUM',confidence:.8,numeric:{value:1}});
  }

  async research(targets:readonly ResearchTarget[]):Promise<readonly Evidence[]>{
    const now=this.clock(),counters={searches:0,cacheHits:0};
    const eligible=targets.filter((target)=>this.supports(target));
    // Identity is per player and game, not per market.
    const players=[...new Map(eligible.map((target)=>[target.eventId+'|'+target.playerId,target])).values()];
    const out:Evidence[]=[];let failures=0,unmatched=0;
    const byLeague=new Map<League,ResearchTarget[]>();
    for(const target of players){const league=LEAGUES[target.sport];byLeague.set(league,[...(byLeague.get(league)??[]),target]);}
    for(const [league,group] of byLeague){
      let teams:Team[];
      try{teams=await this.teams(league,counters);}catch{failures+=group.length;continue;}
      // Match odds-feed team names ("Los Angeles Clippers") to ESPN teams ("LA Clippers") by nickname.
      const teamFor=(side:string)=>teams.find((team)=>normalize(side).endsWith(' '+normalize(team.nickname)))??null;
      for(const target of group){
        const sides=[target.homeTeam!,target.awayTeam!];
        const matches:{side:string;player:RosterPlayer;rosterUrl:string}[]=[];
        try{
          for(const side of sides){
            const team=teamFor(side);if(!team)continue;
            for(const player of await this.roster(league,team,counters))
              if(normalize(player.name)===normalize(target.playerName))matches.push({side,player,rosterUrl:team.rosterUrl});
          }
        }catch{failures++;continue;}
        if(matches.length!==1){unmatched++;continue;}
        const [match]=matches;
        out.push(this.evidence(target,'identity:team',match.side,match.rosterUrl,now),
          this.evidence(target,'identity:photo','Player headshot',match.player.photoUrl,now));
      }
    }
    this.health={status:failures?out.length?'PARTIAL':'FAILED':'OK',targets:eligible.length,
      searches:counters.searches,cacheHits:counters.cacheHits,skipped:targets.length-eligible.length,
      failures,noSources:unmatched,lastRunAt:now.toISOString()};
    return out;
  }
}
