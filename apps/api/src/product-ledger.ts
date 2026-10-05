import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Analysis, BoardResponse, Evidence, PropLine } from '@crowniq/contracts';
import { auditCrown } from '@crowniq/engine';
import type { CorrelationPolicy, CrownSize } from '@crowniq/engine';
import { z } from 'zod';

export const resultFactSchema=z.object({eventId:z.string().min(1),playerId:z.string().min(1),
  market:z.string().min(1),status:z.enum(['FINAL','DNP','VOID']),
  actual:z.number().finite().nullable(),sourceName:z.string().min(1),sourceUrl:z.url(),
  completedAt:z.iso.datetime({offset:true})}).superRefine((value,ctx)=>{
  if((value.status==='FINAL') !== (value.actual!==null)) ctx.addIssue({code:'custom',message:'FINAL requires actual; DNP/VOID cannot have an actual'});
});
export type ResultFact=z.infer<typeof resultFactSchema>;
export type Outcome='PENDING'|'WIN'|'LOSS'|'PUSH'|'DNP'|'VOID';
export interface TrackedDecision {
  trackedPickId:string;playerId:string;playerName:string;sport:string;league:string;
  team:string|null;opponent:string|null;eventId:string;eventStartTime:string;market:string;
  exactLine:number;direction:'MORE'|'LESS';lineType:string;contextScore:number|null;
  dataConfidence?:number|null;lineScore:number;boardRank:number|null;scoreBand:string;dangerZone:boolean;
  thresholdCushion:number|null;evidenceQuality:string;evidenceFreshness:string|null;
  modelVersion:string;researchSnapshotId:string;evidenceSnapshot:Evidence[];
  createdAt:string;providerLineId:string;lineId:string;analysisSnapshot:Analysis;
  lineSnapshot:PropLine;
  grade:Outcome;actualResult:number|null;resultStatus:ResultFact['status']|null;
  gradedAt:string|null;resultSourceName:string|null;resultSourceUrl:string|null;
  /** One decision per game, player, market, line, side, line type and model version. */
  decisionKey?:string;
  /** Later re-analyses of the same decision, oldest first. Append-only; never graded separately. */
  revisions?:DecisionRevision[];
  /** When the pick came from a person's action: the odds snapshot time and its age then. */
  boardFetchedAt?:string;snapshotAgeMinutes?:number;
}
export interface DecisionRevision {recordedAt:string;lineScore:number;contextScore:number|null;
  scoreBand:string;boardRank:number|null;researchSnapshotId:string}
export interface DecisionHistorySink {recordGradedDecision(decision:TrackedDecision):Promise<void>}
export interface PublicProfile {publicId:string;actorKey:string;displayName:string;avatarUrl:string|null;
  socialEnabled:boolean;profileVisible:boolean;isSuspended:boolean;createdAt:string}
export interface PublicCrown {publicCrownId:string;ownerPublicId:string;createdAt:string;
  legs:{trackedPickId:string;playerName:string;market:string;exactLine:number;
    direction:'MORE'|'LESS';lineType:string;lineScore:number;modelVersion:string;
    eventId:string;playerId:string;sport:string}[];unsharedAt:string|null}
export interface Follow {followerPublicId:string;followedPublicId:string;createdAt:string}
type IdentityProvider='GOOGLE'|'APPLE';
interface Account {id:string;username:string;email:string|null;passwordSalt:string|null;
  passwordHash:string|null;identities:{provider:IdentityProvider;subject:string}[];
  createdAt:string;status:'FREE'|'SUSPENDED';
  /** A lifetime family member: signed up with the family code (owner, 2026-10-05). */
  lifetime?:true;
  /** Signed up with the shared family code as the password; must set their own before anything else. */
  mustChangePassword?:true;
  /** A one-time password-reset code the owner issued (stored hashed), until it is used or expires. */
  reset?:{hash:string;expiresAt:string};
  /** A guest-pass account: no username or password, full access until `expiresAt`, kept afterwards for its picks. */
  guest?:{pass:string;deviceHash:string;expiresAt:string}}
/** A shared guest link: up to `maxGuests` devices each get their own account for `days` days. */
export interface GuestPass {code:string;maxGuests:number;days:number}
/**
 * Lifetime family members: never charged and not counted toward the member cap (owner, 2026-10-05: 20 lifetime family
 * members plus 100 members, 120 in all). A family member signs up normally with the family code as the first password
 * (CROWNIQ_FAMILY_CODE, kept in Railway Variables), then sets their own. Accounts made before this rule keep the
 * lifetime status they had.
 */
export const LIFETIME_MEMBERS=20;
const LEGACY_LIFETIME_BEFORE='2026-10-05T03:00:00.000Z';
/** Members allowed besides the lifetime ones. Guests (guest links) and suspended accounts don't take a seat. */
export const DEFAULT_MAX_MEMBERS=100;
/** Seats taken: active, non-guest accounts that are not lifetime members. */
export function membersUsed(accounts:readonly Account[]):number{
  const lifetime=lifetimeIds(accounts);
  return accounts.filter((item)=>!item.guest&&item.status!=='SUSPENDED'&&!lifetime.has(item.id)).length;
}
const lifetimeIds=(accounts:readonly Account[])=>new Set([
  ...accounts.filter((item)=>!item.guest&&item.createdAt<LEGACY_LIFETIME_BEFORE)
    .sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).slice(0,LIFETIME_MEMBERS).map((item)=>item.id),
  ...accounts.filter((item)=>item.lifetime).map((item)=>item.id)]);
const sameSecret=(entered:string,expected:string)=>timingSafeEqual(createHash('sha256').update(entered).digest(),
  createHash('sha256').update(expected).digest());
const planOf=(account:Account,lifetime:ReadonlySet<string>)=>account.status==='SUSPENDED'?'SUSPENDED' as const
  :account.guest?'GUEST' as const:lifetime.has(account.id)?'LIFETIME' as const:'FREE' as const;
const guestExpired=(account:Account,now:Date)=>!!account.guest&&Date.parse(account.guest.expiresAt)<=now.getTime();
interface Session {hash:string;accountId:string;expiresAt:string;createdAt:string}
interface SavedPick {accountId:string;trackedPickId:string;savedAt:string;removedAt:string|null}
interface PrivateCrown {id:string;accountId:string;trackedPickIds:string[];savedAt:string;removedAt:string|null;
  /** A personal Crown's legs, as saved. It holds the user's own calls, so it stays out of GKR's tracked record. */
  personalLegs?:PersonalLeg[];
  /** The pick'em app a personal Crown was built on, when not PrizePicks (Underdog, Pick6). */
  app?:string}
interface PersonalLeg {lineId:string;playerName:string;market:string;threshold:number;direction:'MORE'|'LESS';
  lineType:string;eventStartTime:string;score:number|null;
  /** The line as saved, so results can grade the leg (outside GKR's tracked record). */
  lineSnapshot?:PropLine;grade?:Outcome;actual?:number|null}
interface LegacyData {version:1;decisions:TrackedDecision[];profiles:PublicProfile[];
  crowns:PublicCrown[];follows:Follow[];publicCredits:{publicId:string;trackedPickId:string}[]}
interface Data extends Omit<LegacyData,'version'> {version:2;accounts:Account[];sessions:Session[];
  savedPicks:SavedPick[];privateCrowns:PrivateCrown[]}
const blank=():Data=>({version:2,decisions:[],profiles:[],crowns:[],follows:[],
  publicCredits:[],accounts:[],sessions:[],savedPicks:[],privateCrowns:[]});
const passwordKey=(password:string,salt:string)=>new Promise<Buffer>((resolve,reject)=>
  scrypt(password,Buffer.from(salt,'hex'),64,{N:16384,r:8,p:1},
    (error,key)=>error?reject(error):resolve(key as Buffer)));
const tokenHash=(token:string)=>createHash('sha256').update(token).digest('hex');
const normalizedEmail=(email:string)=>email.trim().toLowerCase();
const normalizedName=(name:string)=>name.trim().toLowerCase();
type EvidenceLookup=readonly Evidence[]|Map<string,Evidence>;
const selectedEvidence=(analysis:Analysis,evidence:EvidenceLookup)=>
  (evidence instanceof Map ? analysis.evidenceIds.flatMap((id)=>{
    const item=evidence.get(id);return item?[item]:[];
  }) : evidence.filter((item)=>analysis.evidenceIds.includes(item.id)))
    .sort((a,b)=>a.id.localeCompare(b.id));
export const decisionKeyOf=(value:{eventId:string;playerId:string;market:string;exactLine:number;
  direction:string;lineType:string;modelVersion:string})=>createHash('sha256').update(JSON.stringify([
  value.eventId,value.playerId,value.market,value.exactLine,value.direction,value.lineType,value.modelVersion]))
  .digest('hex');
const revisionOf=(decision:TrackedDecision):DecisionRevision=>({recordedAt:decision.createdAt,
  lineScore:decision.lineScore,contextScore:decision.contextScore,scoreBand:decision.scoreBand,
  boardRank:decision.boardRank,researchSnapshotId:decision.researchSnapshotId});
const sameRead=(a:DecisionRevision,b:DecisionRevision)=>a.researchSnapshotId===b.researchSnapshotId&&
  a.lineScore===b.lineScore&&a.contextScore===b.contextScore&&a.boardRank===b.boardRank;
/**
 * The ledger's one decision for this candidate's key: the existing one (with the candidate kept as a
 * revision when it reads differently) or the candidate itself, newly added.
 */
function upsertDecision(data:Data,candidate:TrackedDecision):TrackedDecision{
  const key=candidate.decisionKey!;
  const existing=data.decisions.find((item)=>item.decisionKey===key);
  if(!existing){data.decisions.push(candidate);return candidate;}
  if(!existing.boardFetchedAt&&candidate.boardFetchedAt)
    Object.assign(existing,{boardFetchedAt:candidate.boardFetchedAt,snapshotAgeMinutes:candidate.snapshotAgeMinutes});
  const latest=existing.revisions?.at(-1)??revisionOf(existing),next=revisionOf(candidate);
  if(!sameRead(latest,next))existing.revisions=[...existing.revisions??[],next];
  return existing;
}
/**
 * Older ledgers stored a new decision for every re-analysis. Fold each key's copies into its earliest
 * decision, keep the rest as revisions, carry over a grade, and point every reference at the kept id.
 */
function foldDuplicateDecisions(data:Data):boolean{
  let changed=false;
  const groups=new Map<string,TrackedDecision[]>();
  for(const decision of data.decisions){
    if(!decision.decisionKey){decision.decisionKey=decisionKeyOf(decision);changed=true;}
    groups.set(decision.decisionKey,[...groups.get(decision.decisionKey)??[],decision]);
  }
  const renamed=new Map<string,string>(),kept:TrackedDecision[]=[];
  for(const group of groups.values()){
    group.sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
    const [first,...rest]=group;kept.push(first);
    if(!rest.length)continue;
    changed=true;
    const graded=group.find((item)=>item.grade!=='PENDING');
    if(first.grade==='PENDING'&&graded)Object.assign(first,{grade:graded.grade,actualResult:graded.actualResult,
      resultStatus:graded.resultStatus,gradedAt:graded.gradedAt,resultSourceName:graded.resultSourceName,
      resultSourceUrl:graded.resultSourceUrl});
    for(const duplicate of rest){
      renamed.set(duplicate.trackedPickId,first.trackedPickId);
      const latest=first.revisions?.at(-1)??revisionOf(first),next=revisionOf(duplicate);
      if(!sameRead(latest,next))first.revisions=[...first.revisions??[],next];
      first.revisions=[...first.revisions??[],...duplicate.revisions??[]];
    }
  }
  if(!renamed.size)return changed;
  const id=(value:string)=>renamed.get(value)??value;
  data.decisions=kept.sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
  const savedSeen=new Set<string>();
  data.savedPicks=data.savedPicks.map((item)=>({...item,trackedPickId:id(item.trackedPickId)}))
    .filter((item)=>{const key=item.accountId+'|'+item.trackedPickId+'|'+(item.removedAt?'removed':'live');
      if(savedSeen.has(key))return false;savedSeen.add(key);return true;});
  for(const crown of data.privateCrowns)crown.trackedPickIds=crown.trackedPickIds.map(id);
  for(const crown of data.crowns)for(const leg of crown.legs)leg.trackedPickId=id(leg.trackedPickId);
  const creditSeen=new Set<string>();
  data.publicCredits=data.publicCredits.map((item)=>({...item,trackedPickId:id(item.trackedPickId)}))
    .filter((item)=>{const key=item.publicId+'|'+item.trackedPickId;
      if(creditSeen.has(key))return false;creditSeen.add(key);return true;});
  return true;
}
const eligible=(line:PropLine,analysis:Analysis)=>analysis.direction!=='PASS' &&
  analysis.score!==null && !!analysis.modelVersion && line.lineType!=='UNKNOWN_ALTERNATE' &&
  line.availableDirections.includes(analysis.direction) && analysis.lineId===line.id;

function snapshot(line:PropLine,analysis:Analysis,evidence:EvidenceLookup,rank:number|null,
  now:Date):TrackedDecision {
  if(!eligible(line,analysis))throw new Error('INELIGIBLE_DECISION');
  const selected=selectedEvidence(analysis,evidence);
  const decisionKey=decisionKeyOf({eventId:line.eventId,playerId:line.playerId,market:line.market,
    exactLine:line.threshold,direction:analysis.direction,lineType:line.lineType,modelVersion:analysis.modelVersion!});
  return {trackedPickId:decisionKey,decisionKey,playerId:line.playerId,playerName:line.playerName,
    sport:line.sport,league:line.league,team:line.team,opponent:line.opponent,eventId:line.eventId,
    eventStartTime:line.eventStartTime,market:line.market,exactLine:line.threshold,
    direction:analysis.direction as 'MORE'|'LESS',lineType:line.lineType,
    contextScore:analysis.contextScore??null,dataConfidence:analysis.dataConfidence??null,
    lineScore:analysis.score!,boardRank:rank,
    scoreBand:analysis.scoreBand??'UNKNOWN',dangerZone:analysis.dangerZone,
    thresholdCushion:analysis.thresholdCushion??null,evidenceQuality:analysis.evidenceQuality,
    evidenceFreshness:analysis.evidenceExpiresAt??null,modelVersion:analysis.modelVersion!,
    researchSnapshotId:createHash('sha256').update(JSON.stringify(selected)).digest('hex'),
    evidenceSnapshot:selected.map((item)=>structuredClone(item)),createdAt:now.toISOString(),
    providerLineId:line.sourceLineId,lineId:line.id,analysisSnapshot:structuredClone(analysis),
    lineSnapshot:structuredClone(line),
    grade:'PENDING',actualResult:null,resultStatus:null,gradedAt:null,
    resultSourceName:null,resultSourceUrl:null};
}

function publicView(data:Data,crown:PublicCrown) {
  return {publicCrownId:crown.publicCrownId,ownerPublicId:crown.ownerPublicId,
    createdAt:crown.createdAt,legs:crown.legs.map((leg)=>({playerName:leg.playerName,
      market:leg.market,exactLine:leg.exactLine,direction:leg.direction,
      lineType:leg.lineType,lineScore:leg.lineScore,modelVersion:leg.modelVersion,
      grade:data.decisions.find((decision)=>decision.trackedPickId===leg.trackedPickId)?.grade??'PENDING'}))};
}
function recordFor(data:Data,publicId:string) {
  const credited=new Set(data.publicCredits.filter((item)=>item.publicId===publicId)
    .map((item)=>item.trackedPickId));
  const grades=data.decisions.filter((item)=>credited.has(item.trackedPickId)).map((item)=>item.grade);
  const wins=grades.filter((grade)=>grade==='WIN').length,losses=grades.filter((grade)=>grade==='LOSS').length;
  const pushes=grades.filter((grade)=>grade==='PUSH').length;
  const dnp=grades.filter((grade)=>grade==='DNP').length,voids=grades.filter((grade)=>grade==='VOID').length;
  return {wins,losses,pushes,dnp,voids,graded:wins+losses+pushes,
    hitRate:wins+losses?wins/(wins+losses):null};
}
function leaders(data:Data){return data.profiles.filter((item)=>item.socialEnabled &&
  item.profileVisible && !item.isSuspended).map((profile)=>({publicId:profile.publicId,
    displayName:profile.displayName,avatarUrl:profile.avatarUrl,...recordFor(data,profile.publicId)}))
  .filter((item)=>item.graded>=20).sort((a,b)=>b.wins-a.wins ||
    (b.hitRate??0)-(a.hitRate??0) || b.graded-a.graded || a.publicId.localeCompare(b.publicId))
  .slice(0,10);}

/** Single-process durable JSON ledger; no separate DB or provider requests. */
export class ProductLedger {
  private chain:Promise<unknown>=Promise.resolve();
  private authCache:{accounts:Map<string,Account>;lifetime:Set<string>;profiles:Map<string,PublicProfile>;
    sessions:Map<string,Session>}|null=null;
  private topCache:{expires:number;value:unknown}|null=null;
  private recentCache:{expires:number;value:ReturnType<typeof publicView>[]} |null=null;
  constructor(private readonly path:string,private readonly minimumBand:'PLAYABLE'|'CROWN_STRONG'='CROWN_STRONG',
    private readonly clock:()=>Date=()=>new Date(),
    private readonly correlationPolicy?:CorrelationPolicy,
    private readonly historySink?:DecisionHistorySink,
    /** Optional: public Crowns may only use lines from an odds snapshot at most this old. 0 = no limit;
     * by default lines stay usable until their event starts. */
    private readonly maxShareSnapshotMinutes=0,
    /** Members allowed besides the lifetime ones (CROWNIQ_MAX_MEMBERS). */
    private readonly maxMembers=DEFAULT_MAX_MEMBERS,
    /** The family code (CROWNIQ_FAMILY_CODE): as a first password, it makes a lifetime family account. */
    private readonly familyCode:string|null=null,
    /** Whether sign-up is open to anyone (owner, 2026-10-05: closed for now; only a valid code unlocks it). */
    private readonly signupOpen=true){}
  /** What a sign-up code unlocks: LIFETIME for the family code (while lifetime seats last), or null. */
  async checkCode(code:string):Promise<'LIFETIME'|'LIFETIME_FULL'|null>{
    if(!this.familyCode||!sameSecret(code.trim(),this.familyCode))return null;
    const data=await this.read();
    return lifetimeIds(data.accounts).size>=LIFETIME_MEMBERS?'LIFETIME_FULL':'LIFETIME';
  }
  /** Whether sign-up without a code is open. */
  get openSignup(){return this.signupOpen;}
  /** Stamp a person's pick with the odds snapshot it was made from. */
  private fromUser(decision:TrackedDecision,board:BoardResponse):TrackedDecision{
    const fetched=Date.parse(board.board.fetchedAt);
    return {...decision,boardFetchedAt:board.board.fetchedAt,
      snapshotAgeMinutes:Math.max(0,Math.round((this.clock().getTime()-fetched)/60_000))};
  }
  private async read():Promise<Data> {
    try {const raw=await readFile(this.path,'utf8'),value=JSON.parse(raw) as Data|LegacyData;
      if((value.version!==1 && value.version!==2) || !Array.isArray(value.decisions) || !Array.isArray(value.profiles) ||
        !Array.isArray(value.crowns) || !Array.isArray(value.follows) || !Array.isArray(value.publicCredits))
        throw new Error('INVALID_PRODUCT_LEDGER');
      const data:Data=value.version===1?{...value,version:2,accounts:[],sessions:[],savedPicks:[],privateCrowns:[]}:value;
      if(!Array.isArray(data.accounts)||!Array.isArray(data.sessions)||
        !Array.isArray(data.savedPicks)||!Array.isArray(data.privateCrowns))
        throw new Error('INVALID_PRODUCT_LEDGER');
      if(foldDuplicateDecisions(data)){
        // Keep the pre-migration ledger before rewriting it.
        await writeFile(`${this.path}.backup-${this.clock().toISOString().replace(/[:.]/g,'-')}`,raw,{mode:0o600});
        await this.write(data);
      }
      return data;
    } catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return blank();throw error;}
  }
  private async write(value:Data){
    await mkdir(dirname(this.path),{recursive:true});
    const temporary=`${this.path}.${randomUUID()}.tmp`;
    try {await writeFile(temporary,JSON.stringify(value),{mode:0o600});await rename(temporary,this.path);}
    finally {await rm(temporary,{force:true});}
    this.indexAuth(value);
    this.topCache=null;
    this.recentCache=null;
  }
  private indexAuth(data:Data){this.authCache={
    accounts:new Map(data.accounts.map((item)=>[item.id,item])),lifetime:lifetimeIds(data.accounts),
    profiles:new Map(data.profiles.map((item)=>[item.actorKey,item])),
    sessions:new Map(data.sessions.map((item)=>[item.hash,item])),
  };}
  private exclusive<T>(task:()=>Promise<T>):Promise<T>{
    const result=this.chain.then(task);this.chain=result.catch(()=>undefined);return result;
  }
  private session(data:Data,account:Account){
    const token=randomBytes(32).toString('base64url'),now=this.clock().toISOString();
    const active=data.sessions.filter((item)=>Date.parse(item.expiresAt)>this.clock().getTime());
    const recent=new Set(active.filter((item)=>item.accountId===account.id)
      .sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,9).map((item)=>item.hash));
    data.sessions=active.filter((item)=>item.accountId!==account.id || recent.has(item.hash));
    const expires=Math.min(this.clock().getTime()+30*24*60*60_000,
      account.guest?Date.parse(account.guest.expiresAt):Infinity);
    data.sessions.push({hash:tokenHash(token),accountId:account.id,createdAt:now,
      expiresAt:new Date(expires).toISOString()});
    const profile=data.profiles.find((item)=>item.actorKey===account.id)!;
    return {token,profile:{publicId:profile.publicId,username:account.username,
      email:account.email,plan:planOf(account,lifetimeIds(data.accounts)),
      ...(account.mustChangePassword?{mustChangePassword:true}:{})},
      ...(account.guest?{guestExpiresAt:account.guest.expiresAt}:{})};
  }
  /** A new non-guest account needs a seat: lifetime seats fill first, then the member cap applies. */
  private assertSeat(accounts:readonly Account[]){
    if(membersUsed(accounts)>=this.maxMembers)throw new Error('MEMBERS_FULL');
  }
  /** Seat counts for the owner (no names or emails). */
  async membership(){
    const data=await this.read(),lifetime=lifetimeIds(data.accounts);
    return {lifetime:{used:lifetime.size,limit:LIFETIME_MEMBERS},members:{used:membersUsed(data.accounts),limit:this.maxMembers},
      guests:data.accounts.filter((item)=>item.guest).length,
      suspended:data.accounts.filter((item)=>!item.guest&&item.status==='SUSPENDED').length};
  }
  async register(email:string,password:string,username:string){return this.exclusive(async()=>{
    const data=await this.read(),name=username.trim(),address=normalizedEmail(email);
    // The family code as the first password makes a lifetime family account (while the 20 seats last).
    const family=!!this.familyCode&&sameSecret(password,this.familyCode);
    if(family&&lifetimeIds(data.accounts).size>=LIFETIME_MEMBERS)throw new Error('LIFETIME_FULL');
    if(!family&&!this.signupOpen)throw new Error('SIGNUP_CLOSED');
    if(!family)this.assertSeat(data.accounts);
    if(data.accounts.some((item)=>item.email===address))throw new Error('EMAIL_TAKEN');
    if(data.profiles.some((item)=>normalizedName(item.displayName)===normalizedName(name)))
      throw new Error('USERNAME_TAKEN');
    const salt=randomBytes(16).toString('hex'),hash=(await passwordKey(password,salt)).toString('hex');
    const account:Account={id:randomUUID(),username:name,email:address,passwordSalt:salt,
      passwordHash:hash,identities:[],createdAt:this.clock().toISOString(),status:'FREE',
      ...(family?{lifetime:true as const,mustChangePassword:true as const}:{})};
    data.accounts.push(account);data.profiles.push({publicId:randomUUID(),actorKey:account.id,
      displayName:name,avatarUrl:null,socialEnabled:true,profileVisible:true,
      isSuspended:false,createdAt:account.createdAt});
    const result=this.session(data,account);await this.write(data);return result;
  });}
  /**
   * Sign in with a guest link. The same device (by its random id) always gets the same account; a new device gets a
   * new account while the pass has room. Each account lasts the pass's days from its first use.
   */
  async guestLogin(pass:GuestPass,code:string,deviceId:string){return this.exclusive(async()=>{
    const entered=createHash('sha256').update(code).digest(),expected=createHash('sha256').update(pass.code).digest();
    if(!timingSafeEqual(entered,expected))throw new Error('GUEST_PASS_INVALID');
    const data=await this.read(),deviceHash=tokenHash(`${pass.code}:${deviceId}`),now=this.clock();
    const guests=data.accounts.filter((item)=>item.guest?.pass===tokenHash(pass.code));
    let account=guests.find((item)=>item.guest!.deviceHash===deviceHash);
    if(!account){
      if(guests.length>=pass.maxGuests)throw new Error('GUEST_PASS_FULL');
      let number=guests.length+1,name=`Guest_${number}`;
      while(data.profiles.some((item)=>normalizedName(item.displayName)===normalizedName(name)))name=`Guest_${++number}`;
      account={id:randomUUID(),username:name,email:null,passwordSalt:null,passwordHash:null,identities:[],
        createdAt:now.toISOString(),status:'FREE',guest:{pass:tokenHash(pass.code),deviceHash,
          expiresAt:new Date(now.getTime()+pass.days*24*60*60_000).toISOString()}};
      data.accounts.push(account);data.profiles.push({publicId:randomUUID(),actorKey:account.id,
        displayName:name,avatarUrl:null,socialEnabled:true,profileVisible:true,
        isSuspended:false,createdAt:account.createdAt});
    }
    if(account.status==='SUSPENDED')throw new Error('ACCOUNT_SUSPENDED');
    if(guestExpired(account,now))throw new Error('GUEST_PASS_EXPIRED');
    const result=this.session(data,account);await this.write(data);return result;
  });}
  /** Sign in with the account's email or its current username (either, case-insensitive). */
  async login(emailOrUsername:string,password:string){return this.exclusive(async()=>{
    const data=await this.read(),entered=emailOrUsername.trim();
    const byName=()=>{const profile=data.profiles.find((item)=>normalizedName(item.displayName)===normalizedName(entered));
      return profile?data.accounts.find((item)=>item.id===profile.actorKey):undefined;};
    const account=entered.includes('@')?data.accounts.find((item)=>item.email===normalizedEmail(entered)):byName();
    // Keep the work comparable for unknown accounts and wrong passwords.
    const actual=await passwordKey(password,account?.passwordSalt??'0'.repeat(32));
    const stored=Buffer.from(account?.passwordHash??'0'.repeat(128),'hex');
    if(!account?.passwordHash || !timingSafeEqual(actual,stored) || account.status==='SUSPENDED')
      throw new Error('INVALID_CREDENTIALS');
    const result=this.session(data,account);await this.write(data);return result;
  });}
  async loginWithProvider(provider:IdentityProvider,subject:string,email:string|null,username?:string){
    return this.exclusive(async()=>{
      const data=await this.read();let account=data.accounts.find((item)=>item.identities.some((identity)=>
        identity.provider===provider && identity.subject===subject));
      if(!account){
        if(!username)throw new Error('USERNAME_REQUIRED');
        if(!this.signupOpen)throw new Error('SIGNUP_CLOSED');
        this.assertSeat(data.accounts);
        if(email && data.accounts.some((item)=>item.email===normalizedEmail(email)))
          throw new Error('ACCOUNT_LINK_REQUIRED');
        if(data.profiles.some((item)=>normalizedName(item.displayName)===normalizedName(username)))
          throw new Error('USERNAME_TAKEN');
        account={id:randomUUID(),username:username.trim(),email:email?normalizedEmail(email):null,
          passwordHash:null,passwordSalt:null,identities:[{provider,subject}],
          createdAt:this.clock().toISOString(),status:'FREE'};
        data.accounts.push(account);data.profiles.push({publicId:randomUUID(),actorKey:account.id,
          displayName:account.username,avatarUrl:null,socialEnabled:true,profileVisible:true,
          isSuspended:false,createdAt:account.createdAt});
      }
      if(account.status==='SUSPENDED')throw new Error('ACCOUNT_SUSPENDED');
      const result=this.session(data,account);await this.write(data);return result;
    });
  }
  async linkProvider(accountId:string,provider:IdentityProvider,subject:string){return this.exclusive(async()=>{
    const data=await this.read(),account=data.accounts.find((item)=>item.id===accountId);
    if(!account || data.accounts.some((item)=>item.identities.some((identity)=>
      identity.provider===provider && identity.subject===subject)))throw new Error('IDENTITY_ALREADY_LINKED');
    if(account.identities.some((item)=>item.provider===provider))throw new Error('PROVIDER_ALREADY_LINKED');
    account.identities.push({provider,subject});await this.write(data);
    return {linked:true,provider};
  });}
  async authenticate(token:string){return this.exclusive(async()=>{
    if(token.length<32 || token.length>100)return null;
    if(!this.authCache)this.indexAuth(await this.read());
    const session=this.authCache!.sessions.get(tokenHash(token));
    if(!session||Date.parse(session.expiresAt)<=this.clock().getTime())return null;
    const account=this.authCache!.accounts.get(session.accountId);
    if(!account)return null;
    if(account.status==='SUSPENDED'||guestExpired(account,this.clock()))return null;
    const profile=this.authCache!.profiles.get(account.id);
    return profile?{accountId:account.id,publicId:profile.publicId,username:account.username,
      email:account.email,plan:planOf(account,this.authCache!.lifetime),mustChangePassword:!!account.mustChangePassword}:null;
  });}
  private accountByLogin(data:Data,login:string){
    const entered=login.trim();
    if(entered.includes('@'))return data.accounts.find((item)=>item.email===normalizedEmail(entered)&&!item.guest);
    const profile=data.profiles.find((item)=>normalizedName(item.displayName)===normalizedName(entered));
    return profile?data.accounts.find((item)=>item.id===profile.actorKey&&!item.guest):undefined;
  }
  /** Every account for the owner's member list, newest first: name, plan and whether access is revoked. */
  async members(){
    const data=await this.read(),lifetime=lifetimeIds(data.accounts);
    const profiles=new Map(data.profiles.map((item)=>[item.actorKey,item]));
    return data.accounts.flatMap((account)=>{
      const profile=profiles.get(account.id);
      return profile?[{publicId:profile.publicId,username:account.guest?'Guest':account.username,email:account.email,
        plan:account.guest?'GUEST' as const:lifetime.has(account.id)?'LIFETIME' as const:'MEMBER' as const,
        revoked:account.status==='SUSPENDED',createdAt:account.createdAt,
        ...(account.guest?{guestExpiresAt:account.guest.expiresAt}:{})}]:[];
    }).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  }
  /**
   * Revokes or restores one account's access (owner only). Revoking signs them out everywhere at once, blocks sign-in and
   * reset codes, hides their public profile and frees a member seat. Restoring a member needs a free seat. The owner's
   * own account can't be revoked.
   */
  async setAccess(publicId:string,revoke:boolean,ownerPublicId:string|null){return this.exclusive(async()=>{
    const data=await this.read(),profile=data.profiles.find((item)=>item.publicId===publicId);
    const account=profile?data.accounts.find((item)=>item.id===profile.actorKey):undefined;
    if(!profile||!account)throw new Error('ACCOUNT_NOT_FOUND');
    if(revoke&&ownerPublicId&&publicId===ownerPublicId)throw new Error('CANNOT_REVOKE_OWNER');
    if(!revoke&&account.status==='SUSPENDED'&&!account.guest&&!lifetimeIds(data.accounts).has(account.id))this.assertSeat(data.accounts);
    account.status=revoke?'SUSPENDED':'FREE';profile.isSuspended=revoke;
    if(revoke){data.sessions=data.sessions.filter((item)=>item.accountId!==account.id);delete account.reset;}
    await this.write(data);
    return {publicId,username:account.guest?'Guest':account.username,revoked:revoke};
  });}
  /**
   * A one-time reset code for a member who forgot their password (the owner passes it on; there is no email yet). It
   * lasts 24 hours and replaces any earlier code.
   */
  async createResetCode(login:string){return this.exclusive(async()=>{
    const data=await this.read(),account=this.accountByLogin(data,login);
    if(!account)throw new Error('ACCOUNT_NOT_FOUND');
    const letters='ABCDEFGHJKLMNPQRSTUVWXYZ23456789',bytes=randomBytes(8);
    const raw=[...bytes].map((byte)=>letters[byte%letters.length]).join('');
    const code=`${raw.slice(0,4)}-${raw.slice(4)}`,expiresAt=new Date(this.clock().getTime()+24*3600_000).toISOString();
    account.reset={hash:tokenHash(raw),expiresAt};
    await this.write(data);
    return {code,username:account.username,expiresAt};
  });}
  /** Sets a new password with a reset code, ends every other session, and signs the member in. */
  async resetPassword(login:string,code:string,next:string){return this.exclusive(async()=>{
    const data=await this.read(),account=this.accountByLogin(data,login);
    const raw=code.toUpperCase().replace(/[^A-Z0-9]/g,'');
    const valid=!!account?.reset&&Date.parse(account.reset.expiresAt)>this.clock().getTime()&&
      timingSafeEqual(Buffer.from(tokenHash(raw),'hex'),Buffer.from(account.reset.hash,'hex'));
    if(!account||!valid||account.status==='SUSPENDED')throw new Error('RESET_INVALID');
    if(this.familyCode&&sameSecret(next,this.familyCode))throw new Error('PASSWORD_NOT_NEW');
    const salt=randomBytes(16).toString('hex');
    account.passwordSalt=salt;account.passwordHash=(await passwordKey(next,salt)).toString('hex');
    delete account.reset;delete account.mustChangePassword;
    data.sessions=data.sessions.filter((item)=>item.accountId!==account.id);
    const result=this.session(data,account);await this.write(data);return result;
  });}
  /**
   * Deletes an account and everything personal to it: profile, sessions, saved picks, private and public Crowns, follows
   * and credits. GKR's own tracked decisions are not the member's and stay. Accounts with a password must confirm it;
   * Google and Apple accounts confirm by typing DELETE. A lifetime seat frees up.
   */
  async deleteAccount(accountId:string,confirmation:string){return this.exclusive(async()=>{
    const data=await this.read(),account=data.accounts.find((item)=>item.id===accountId);
    if(!account)throw new Error('ACCOUNT_NOT_FOUND');
    if(account.passwordHash&&account.passwordSalt){
      const actual=await passwordKey(confirmation,account.passwordSalt);
      if(!timingSafeEqual(actual,Buffer.from(account.passwordHash,'hex')))throw new Error('INVALID_CREDENTIALS');
    }else if(confirmation!=='DELETE')throw new Error('CONFIRMATION_REQUIRED');
    const publicId=data.profiles.find((item)=>item.actorKey===accountId)?.publicId;
    data.accounts=data.accounts.filter((item)=>item.id!==accountId);
    data.sessions=data.sessions.filter((item)=>item.accountId!==accountId);
    data.savedPicks=data.savedPicks.filter((item)=>item.accountId!==accountId);
    data.privateCrowns=data.privateCrowns.filter((item)=>item.accountId!==accountId);
    data.profiles=data.profiles.filter((item)=>item.actorKey!==accountId);
    if(publicId){
      data.crowns=data.crowns.filter((item)=>item.ownerPublicId!==publicId);
      data.follows=data.follows.filter((item)=>item.followerPublicId!==publicId&&item.followedPublicId!==publicId);
      data.publicCredits=data.publicCredits.filter((item)=>item.publicId!==publicId);
    }
    await this.write(data);
  });}
  /** Sets a new password after checking the current one. The family code can't be kept as a password. */
  async changePassword(accountId:string,current:string,next:string){return this.exclusive(async()=>{
    const data=await this.read(),account=data.accounts.find((item)=>item.id===accountId);
    if(!account?.passwordHash||!account.passwordSalt)throw new Error('NO_PASSWORD');
    const actual=await passwordKey(current,account.passwordSalt);
    if(!timingSafeEqual(actual,Buffer.from(account.passwordHash,'hex')))throw new Error('INVALID_CREDENTIALS');
    if(next===current||(this.familyCode&&sameSecret(next,this.familyCode)))throw new Error('PASSWORD_NOT_NEW');
    const salt=randomBytes(16).toString('hex');
    account.passwordSalt=salt;account.passwordHash=(await passwordKey(next,salt)).toString('hex');
    delete account.mustChangePassword;
    await this.write(data);
  });}
  async logout(token:string){return this.exclusive(async()=>{
    const data=await this.read(),before=data.sessions.length;
    data.sessions=data.sessions.filter((item)=>item.hash!==tokenHash(token));
    if(data.sessions.length!==before)await this.write(data);
  });}
  async saveUserPick(accountId:string,lineId:string,board:BoardResponse,evidence:readonly Evidence[]){
    return this.exclusive(async()=>{
      const data=await this.read(),account=data.accounts.find((item)=>item.id===accountId);
      const line=board.board.lines.find((item)=>item.id===lineId),
        analysis=board.analyses.find((item)=>item.lineId===lineId);
      if(!account || account.status==='SUSPENDED' || !line || !analysis || !eligible(line,analysis) ||
        Date.parse(line.eventStartTime)<=this.clock().getTime() ||
        analysis.evidenceExpiresAt && Date.parse(analysis.evidenceExpiresAt)<=this.clock().getTime())
        throw new Error('INVALID_OR_STALE_PICK');
      const candidate=upsertDecision(data,this.fromUser(snapshot(line,analysis,evidence,
        board.rankedLineIds.indexOf(lineId)<0?null:board.rankedLineIds.indexOf(lineId)+1,this.clock()),board));
      let saved=data.savedPicks.find((item)=>item.accountId===accountId &&
        item.trackedPickId===candidate.trackedPickId);
      const alreadySaved=!!saved && !saved.removedAt;
      if(saved?.removedAt){saved.removedAt=null;await this.write(data);}
      else if(!saved){saved={accountId,trackedPickId:candidate.trackedPickId,
        savedAt:this.clock().toISOString(),removedAt:null};data.savedPicks.push(saved);await this.write(data);}
      return {saved:true,trackedPickId:candidate.trackedPickId,alreadySaved};
    });
  }
  async userPicks(accountId:string,offset=0,limit=50){return this.exclusive(async()=>{
    const data=await this.read(),items=data.savedPicks.filter((item)=>item.accountId===accountId &&
      !item.removedAt).sort((a,b)=>b.savedAt.localeCompare(a.savedAt));
    const decisions=new Map(data.decisions.map((item)=>[item.trackedPickId,item]));
    return {total:items.length,picks:items.slice(offset,offset+limit).flatMap((item)=>{
      const decision=decisions.get(item.trackedPickId);
      return decision?[{id:item.trackedPickId,savedAt:item.savedAt,
        playerName:decision.playerName,sport:decision.sport,market:decision.market,
        eventStartTime:decision.eventStartTime,threshold:decision.exactLine,
        direction:decision.direction,lineType:decision.lineType,lineScore:decision.lineScore,
        modelVersion:decision.modelVersion,result:decision.grade,actual:decision.actualResult}]:[];
    })};
  });}
  async removeUserPick(accountId:string,id:string){return this.exclusive(async()=>{
    const data=await this.read(),saved=data.savedPicks.find((item)=>item.accountId===accountId &&
      item.trackedPickId===id && !item.removedAt);
    if(!saved)throw new Error('PICK_NOT_FOUND');
    saved.removedAt=this.clock().toISOString();await this.write(data);
  });}
  async savePrivateCrown(accountId:string,lineIds:readonly string[],board:BoardResponse,
    evidence:readonly Evidence[]){return this.exclusive(async()=>{
      const data=await this.read();
      if(!data.accounts.some((account)=>account.id===accountId && account.status!=='SUSPENDED')||
        lineIds.length<2||lineIds.length>6||new Set(lineIds).size!==lineIds.length)
        throw new Error('INVALID_PRIVATE_CROWN');
      const items=lineIds.map((id)=>{
        const line=board.board.lines.find((item)=>item.id===id),
          analysis=board.analyses.find((item)=>item.lineId===id);
        if(!line||!analysis||!eligible(line,analysis)||
          Date.parse(line.eventStartTime)<=this.clock().getTime()||
          analysis.evidenceExpiresAt && Date.parse(analysis.evidenceExpiresAt)<=this.clock().getTime())
          throw new Error('INVALID_OR_STALE_CROWN');
        return {line,analysis};
      });
      const issues=auditCrown(items,items.length as CrownSize,this.correlationPolicy,this.clock());
      if(issues.length)throw new Error(`CROWN_CONSTRAINT_REJECTED:${issues.join(',')}`);
      const decisions=items.map(({line,analysis})=>this.fromUser(snapshot(line,analysis,evidence,
        board.rankedLineIds.indexOf(line.id)+1,this.clock()),board));
      const known=new Map(data.decisions.map((item)=>[item.decisionKey,item.trackedPickId]));
      const ids=decisions.map((item)=>known.get(item.decisionKey)??item.trackedPickId);
      const existing=data.privateCrowns.find((item)=>item.accountId===accountId &&
        !item.removedAt && JSON.stringify(item.trackedPickIds)===JSON.stringify(ids));
      if(existing)return {id:existing.id,alreadySaved:true};
      for(const decision of decisions)upsertDecision(data,decision);
      const crown:PrivateCrown={id:randomUUID(),accountId,trackedPickIds:ids,
        savedAt:this.clock().toISOString(),removedAt:null};
      data.privateCrowns.push(crown);await this.write(data);
      return {id:crown.id,alreadySaved:false};
    });}
  /**
   * Saves a Crown that includes the user's own calls (PASS lines, the side GKR does not back, or legs past CrownIQ's
   * advice). Only what PrizePicks itself requires is checked; it is kept privately and never tracked or graded as GKR.
   */
  async savePersonalCrown(accountId:string,legs:readonly {lineId:string;direction:'MORE'|'LESS'}[],board:BoardResponse,
    app?:string){
    return this.exclusive(async()=>{
      const data=await this.read();
      if(!data.accounts.some((account)=>account.id===accountId && account.status!=='SUSPENDED')||
        legs.length<2||legs.length>6||new Set(legs.map((leg)=>leg.lineId)).size!==legs.length)
        throw new Error('INVALID_PRIVATE_CROWN');
      const saved=legs.map(({lineId,direction})=>{
        const line=board.board.lines.find((item)=>item.id===lineId),
          analysis=board.analyses.find((item)=>item.lineId===lineId);
        if(!line||line.lineType==='UNKNOWN_ALTERNATE'||!line.availableDirections.includes(direction)||
          Date.parse(line.eventStartTime)<=this.clock().getTime())throw new Error('INVALID_OR_STALE_CROWN');
        const backed=analysis&&analysis.direction===direction&&analysis.score!==null?analysis.score:null;
        return {lineId,playerName:line.playerName,market:line.market,threshold:line.threshold,direction,
          lineType:line.lineType,eventStartTime:line.eventStartTime,score:backed,playerId:line.playerId,
          lineSnapshot:structuredClone(line),grade:'PENDING' as Outcome};
      });
      if(new Set(saved.map((leg)=>leg.playerId)).size!==saved.length)throw new Error('CROWN_CONSTRAINT_REJECTED:DUPLICATE_PLAYER');
      const personalLegs=saved.map(({playerId:_playerId,...leg})=>leg);
      const key=JSON.stringify(personalLegs.map((leg)=>[leg.lineId,leg.direction]));
      const existing=data.privateCrowns.find((item)=>item.accountId===accountId && !item.removedAt &&
        item.personalLegs && JSON.stringify(item.personalLegs.map((leg)=>[leg.lineId,leg.direction]))===key);
      if(existing)return {id:existing.id,alreadySaved:true};
      const crown:PrivateCrown={id:randomUUID(),accountId,trackedPickIds:[],savedAt:this.clock().toISOString(),
        removedAt:null,personalLegs,...app?{app}:{}};
      data.privateCrowns.push(crown);await this.write(data);
      return {id:crown.id,alreadySaved:false};
    });}
  async userCrowns(accountId:string){return this.exclusive(async()=>{
    const data=await this.read(),decisions=new Map(data.decisions.map((item)=>[item.trackedPickId,item]));
    return {crowns:data.privateCrowns.filter((item)=>item.accountId===accountId && !item.removedAt)
      .sort((a,b)=>b.savedAt.localeCompare(a.savedAt)).slice(0,30).map((item)=>item.personalLegs?{id:item.id,
        savedAt:item.savedAt,personal:true,...item.app?{app:item.app}:{},legs:item.personalLegs.map((leg)=>({playerName:leg.playerName,market:leg.market,
          threshold:leg.threshold,direction:leg.direction,lineType:leg.lineType,score:leg.score,grade:leg.grade??'PENDING',
          actual:leg.actual??null}))}:{id:item.id,
        savedAt:item.savedAt,legs:item.trackedPickIds.flatMap((id)=>{
          const decision=decisions.get(id);
          return decision?[{playerName:decision.playerName,market:decision.market,
            threshold:decision.exactLine,direction:decision.direction,lineType:decision.lineType,
            score:decision.lineScore,grade:decision.grade}]:[];
        })})};
  });}
  async removeUserCrown(accountId:string,id:string){return this.exclusive(async()=>{
    const data=await this.read(),crown=data.privateCrowns.find((item)=>item.accountId===accountId &&
      item.id===id && !item.removedAt);
    if(!crown)throw new Error('CROWN_NOT_FOUND');
    crown.removedAt=this.clock().toISOString();await this.write(data);
  });}
  async track(board:BoardResponse,evidence:readonly Evidence[]):Promise<number>{
    return this.exclusive(async()=>{
      const data=await this.read(),before=data.decisions.length;
      const analyses=new Map(board.analyses.map((item)=>[item.lineId,item]));
      const ranks=new Map(board.rankedLineIds.map((id,index)=>[id,index+1]));
      const byKey=new Map(data.decisions.map((item)=>[item.decisionKey!,item]));
      const findings=new Map(evidence.map((item)=>[item.id,item]));
      let revised=false;
      for(const line of board.board.lines){
        const analysis=analyses.get(line.id);
        if(!analysis || !eligible(line,analysis) ||
          !(['CROWN_STRONG','CROWN_ELITE'].includes(analysis.scoreBand??'') ||
            this.minimumBand==='PLAYABLE' && analysis.scoreBand==='PLAYABLE'))continue;
        const next=snapshot(line,analysis,findings,ranks.get(line.id)??null,this.clock());
        const existing=byKey.get(next.decisionKey!);
        if(!existing){byKey.set(next.decisionKey!,next);data.decisions.push(next);continue;}
        const revisions=existing.revisions?.length??0;
        upsertDecision(data,next);
        if((existing.revisions?.length??0)!==revisions)revised=true;
      }
      if(data.decisions.length!==before||revised)await this.write(data);
      return data.decisions.length-before;
    });
  }
  async listDecisions(offset=0,limit=100){return this.exclusive(async()=>{
    const data=await this.read();return {total:data.decisions.length,
      decisions:data.decisions.slice().reverse().slice(offset,offset+limit)};
  });}
  /** Your-call legs still waiting for a result, with the line each was saved on. */
  async pendingPersonalLegs(){return this.exclusive(async()=>{
    const data=await this.read();
    return data.privateCrowns.filter((crown)=>!crown.removedAt).flatMap((crown)=>(crown.personalLegs??[])
      .flatMap((leg)=>leg.lineSnapshot&&(leg.grade??'PENDING')==='PENDING'?[{lineSnapshot:leg.lineSnapshot}]:[]));
  });}
  async grade(facts:readonly ResultFact[]):Promise<{graded:number;unmatched:number;personal:number}>{
    return this.exclusive(async()=>{
      const parsed=facts.map((fact)=>resultFactSchema.parse(fact));
      const key=(value:{eventId:string;playerId:string;market:string})=>JSON.stringify([value.eventId,value.playerId,value.market]);
      const keys=parsed.map(key);
      if(new Set(keys).size!==keys.length)throw new Error('DUPLICATE_RESULT_FACT');
      const lookup=new Map(parsed.map((fact)=>[key(fact),fact]));
      const data=await this.read();let graded=0;const matched=new Set<string>();
      const gradedDecisions:TrackedDecision[]=[];
      for(const decision of data.decisions){
        const identity=key(decision),fact=lookup.get(identity);
        if(!fact || decision.grade!=='PENDING')continue;
        if(Date.parse(fact.completedAt)>this.clock().getTime() ||
          Date.parse(fact.completedAt)<Date.parse(decision.eventStartTime))
          throw new Error('INVALID_RESULT_TIME');
        decision.grade=fact.status==='DNP'?'DNP':fact.status==='VOID'?'VOID':
          fact.actual===decision.exactLine?'PUSH':
          ((fact.actual!>decision.exactLine)===(decision.direction==='MORE'))?'WIN':'LOSS';
        decision.actualResult=fact.actual;decision.resultStatus=fact.status;
        decision.resultSourceName=fact.sourceName;decision.resultSourceUrl=fact.sourceUrl;
        decision.gradedAt=this.clock().toISOString();graded++;matched.add(identity);
        gradedDecisions.push(structuredClone(decision));
      }
      // Your-call legs are graded from the same facts, but never enter the tracked record or history.
      let personal=0;
      for(const leg of data.privateCrowns.flatMap((crown)=>crown.personalLegs??[])){
        if(!leg.lineSnapshot||(leg.grade??'PENDING')!=='PENDING')continue;
        const identity=key({eventId:leg.lineSnapshot.eventId,playerId:leg.lineSnapshot.playerId,market:leg.market}),
          fact=lookup.get(identity);
        if(!fact||Date.parse(fact.completedAt)>this.clock().getTime()||
          Date.parse(fact.completedAt)<Date.parse(leg.eventStartTime))continue;
        leg.grade=fact.status==='DNP'?'DNP':fact.status==='VOID'?'VOID':fact.actual===leg.threshold?'PUSH':
          ((fact.actual!>leg.threshold)===(leg.direction==='MORE'))?'WIN':'LOSS';
        leg.actual=fact.actual;personal++;matched.add(identity);
      }
      if(graded||personal)await this.write(data);
      if(this.historySink&&gradedDecisions.length)
        await Promise.allSettled(gradedDecisions.map((decision)=>this.historySink!.recordGradedDecision(decision)));
      return {graded,unmatched:parsed.length-matched.size,personal};
    });
  }
  async learningSummary(){return this.exclusive(async()=>{
    const data=await this.read(),graded=data.decisions.filter((item)=>
      ['WIN','LOSS','PUSH'].includes(item.grade)&&item.actualResult!==null);
    const buckets=new Map<string,{modelVersion:string;picks:number;wins:number;losses:number;pushes:number;
      scoreSum:number;confidenceSum:number;confidenceCount:number;projectionAbsError:number;
      projectionSignedError:number;projectionCount:number}>();
    const factors=new Map<string,{samples:number;wins:number;losses:number;winContribution:number;
      lossContribution:number}>();
    for(const item of graded){
      const model=buckets.get(item.modelVersion)??{modelVersion:item.modelVersion,picks:0,wins:0,losses:0,
        pushes:0,scoreSum:0,confidenceSum:0,confidenceCount:0,projectionAbsError:0,
        projectionSignedError:0,projectionCount:0};
      model.picks++;model.scoreSum+=item.lineScore;
      if(item.grade==='WIN')model.wins++;else if(item.grade==='LOSS')model.losses++;else model.pushes++;
      const confidence=item.dataConfidence??item.analysisSnapshot.dataConfidence??null;
      if(confidence!==null){model.confidenceSum+=confidence;model.confidenceCount++;}
      const projection=item.evidenceSnapshot.find((e)=>e.kind==='projection:'+item.market)?.numeric?.value;
      if(projection!==undefined&&item.actualResult!==null){
        const error=projection-item.actualResult;model.projectionAbsError+=Math.abs(error);
        model.projectionSignedError+=error;model.projectionCount++;
      }
      buckets.set(item.modelVersion,model);
      if(item.grade==='WIN'||item.grade==='LOSS')for(const component of item.analysisSnapshot.contextBreakdown??[]){
        if(['partial_coverage_adjustment','context_score_clamp'].includes(component.name))continue;
        const key=item.modelVersion+'|'+component.name;
        const factor=factors.get(key)??{samples:0,wins:0,losses:0,winContribution:0,lossContribution:0};
        factor.samples++;
        if(item.grade==='WIN'){factor.wins++;factor.winContribution+=component.contribution;}
        else {factor.losses++;factor.lossContribution+=component.contribution;}
        factors.set(key,factor);
      }
    }
    const pending=data.decisions.filter((item)=>item.grade==='PENDING').length;
    const dnpVoid=data.decisions.filter((item)=>item.grade==='DNP'||item.grade==='VOID').length;
    return {source:'CROWNIQ_TRACKED_OUTCOMES',tracked:data.decisions.length,pending,
      graded:graded.length,dnpVoid,
      models:[...buckets.values()].map((m)=>({modelVersion:m.modelVersion,picks:m.picks,wins:m.wins,
        losses:m.losses,pushes:m.pushes,hitRate:m.wins+m.losses?m.wins/(m.wins+m.losses):null,
        averageLineScore:m.picks?m.scoreSum/m.picks:null,
        averageDataConfidence:m.confidenceCount?m.confidenceSum/m.confidenceCount:null,
        projectionMAE:m.projectionCount?m.projectionAbsError/m.projectionCount:null,
        projectionBias:m.projectionCount?m.projectionSignedError/m.projectionCount:null,
        projectionSamples:m.projectionCount})).sort((a,b)=>b.picks-a.picks),
      factorDiagnostics:[...factors.entries()].map(([key,v])=>{
        const split=key.indexOf('|');return {modelVersion:key.slice(0,split),factor:key.slice(split+1),
          samples:v.samples,wins:v.wins,losses:v.losses,
          averageContributionWins:v.wins?v.winContribution/v.wins:null,
          averageContributionLosses:v.losses?v.lossContribution/v.losses:null};
      }).sort((a,b)=>b.samples-a.samples)};
  });}
  async history(sport:string,playerId:string,market:string){return this.exclusive(async()=>{
    const data=await this.read();const all=data.decisions.filter((item)=>item.sport===sport &&
      item.playerId===playerId && item.market===market && item.grade!=='PENDING')
      .sort((a,b)=>b.eventStartTime.localeCompare(a.eventStartTime)||b.createdAt.localeCompare(a.createdAt));
    const seen=new Set<string>(),recent:TrackedDecision[]=[];
    for(const item of all){if(seen.has(item.eventId))continue;seen.add(item.eventId);recent.push(item);if(recent.length===10)break;}
    const numbers=recent.flatMap((item)=>item.actualResult===null?[]:[item.actualResult]);
    const sorted=[...numbers].sort((a,b)=>a-b),mean=numbers.length?
      numbers.reduce((sum,n)=>sum+n,0)/numbers.length:null;
    const median=sorted.length? (sorted[Math.floor((sorted.length-1)/2)]+sorted[Math.floor(sorted.length/2)])/2:null;
    return {source:'CROWNIQ_INTERNAL_HISTORY',sampleSize:recent.length,
      actualSampleSize:numbers.length,label:`CrownIQ Tracked L${recent.length}`,
      recent:recent.map((item)=>({eventDate:item.eventStartTime.slice(0,10),opponent:item.opponent,
        market:item.market,line:item.exactLine,direction:item.direction,lineType:item.lineType,
        actual:item.actualResult,grade:item.grade,contextScore:item.contextScore,
        dataConfidence:item.dataConfidence??item.analysisSnapshot.dataConfidence??null,
        lineScore:item.lineScore,modelVersion:item.modelVersion})),
      internalOutcomeDistribution:numbers.length?{sampleSize:numbers.length,recentValues:numbers,
        mean,median,variance:numbers.reduce((sum,n)=>sum+(n-mean!)**2,0)/numbers.length,
        lowRange:sorted[0],highRange:sorted.at(-1)}:null,
      fullArchiveCount:all.length};
  });}
  async upsertProfile(actorKey:string,displayName:string){return this.exclusive(async()=>{
    const data=await this.read();let profile=data.profiles.find((item)=>item.actorKey===actorKey);
    if(data.profiles.some((item)=>item.actorKey!==actorKey &&
      normalizedName(item.displayName)===normalizedName(displayName)))throw new Error('USERNAME_TAKEN');
    if(!profile){profile={publicId:randomUUID(),actorKey,displayName,avatarUrl:null,
      socialEnabled:true,profileVisible:true,isSuspended:false,createdAt:this.clock().toISOString()};
      data.profiles.push(profile);} else profile.displayName=displayName;
    const account=data.accounts.find((item)=>item.id===actorKey);
    if(account)account.username=displayName;
    await this.write(data);return {publicId:profile.publicId,displayName:profile.displayName};
  });}
  async profileForActor(actorKey:string){return this.exclusive(async()=>{
    const data=await this.read();return data.profiles.find((item)=>item.actorKey===actorKey)??null;
  });}
  async profile(publicId:string,viewerId:string|null=null){return this.exclusive(async()=>{
    const data=await this.read(),profile=data.profiles.find((item)=>item.publicId===publicId &&
      item.socialEnabled && item.profileVisible && !item.isSuspended);
    if(!profile)return null;
    return {publicId:profile.publicId,displayName:profile.displayName,avatarUrl:profile.avatarUrl,
      ...recordFor(data,publicId),following:viewerId!==null && data.follows.some((item)=>
        item.followerPublicId===viewerId && item.followedPublicId===publicId)};
  });}
  async topUsers(){return this.exclusive(async()=>{
    if(this.topCache && this.topCache.expires>this.clock().getTime())return this.topCache.value;
    const data=await this.read();const candidates=leaders(data);
    const value={method:'wins, then wins/(wins+losses), then graded public selections',
      minimumGraded:20,users:candidates};this.topCache={value,expires:this.clock().getTime()+180_000};
    return value;
  });}
  async follow(actorKey:string,targetId:string,active:boolean){return this.exclusive(async()=>{
    const data=await this.read(),actor=data.profiles.find((item)=>item.actorKey===actorKey),
      target=data.profiles.find((item)=>item.publicId===targetId && item.socialEnabled &&
        item.profileVisible && !item.isSuspended);
    if(!actor||!target||actor.publicId===targetId)throw new Error('INVALID_FOLLOW');
    data.follows=data.follows.filter((item)=>item.followerPublicId!==actor.publicId ||
      item.followedPublicId!==targetId);
    if(active)data.follows.push({followerPublicId:actor.publicId,followedPublicId:targetId,
      createdAt:this.clock().toISOString()});
    await this.write(data);return {following:active};
  });}
  async share(actorKey:string,lineIds:readonly string[],board:BoardResponse,evidence:readonly Evidence[]){return this.exclusive(async()=>{
    const data=await this.read(),actor=data.profiles.find((item)=>item.actorKey===actorKey &&
      item.socialEnabled && item.profileVisible && !item.isSuspended);
    if(!actor || lineIds.length<2 || lineIds.length>6 || new Set(lineIds).size!==lineIds.length)
      throw new Error('INVALID_SHARE');
    const items=lineIds.map((id)=>{
      const line=board.board.lines.find((entry)=>entry.id===id),
        analysis=board.analyses.find((entry)=>entry.lineId===id);
      if(!line || !analysis || !eligible(line,analysis) ||
        Date.parse(line.eventStartTime)<=this.clock().getTime() ||
        analysis.evidenceExpiresAt && Date.parse(analysis.evidenceExpiresAt)<=this.clock().getTime())
        throw new Error('STALE_OR_INVALID_CROWN_LEG');
      return {line,analysis};
    });
    // Reuse the engine's complete Crown audit. Without a trusted correlation policy,
    // sharing fails closed rather than publishing a Crown that bypasses its rules.
    const issues=auditCrown(items,items.length as CrownSize,this.correlationPolicy,this.clock());
    if(issues.length)throw new Error(`CROWN_CONSTRAINT_REJECTED:${issues.join(',')}`);
    const fetchedAt=Date.parse(board.board.fetchedAt);
    if(this.maxShareSnapshotMinutes>0&&this.clock().getTime()-fetchedAt>this.maxShareSnapshotMinutes*60_000)
      throw new Error('SNAPSHOT_TOO_OLD');
    const candidates=items.map(({line,analysis})=>this.fromUser(snapshot(line,analysis,evidence,
      board.rankedLineIds.indexOf(line.id)+1,this.clock()),board));
    const known=new Map(data.decisions.map((item)=>[item.decisionKey,item.trackedPickId]));
    const ids=candidates.map((item)=>known.get(item.decisionKey)??item.trackedPickId);
    if(data.crowns.some((item)=>item.ownerPublicId===actor.publicId && !item.unsharedAt &&
      JSON.stringify(item.legs.map((leg)=>leg.trackedPickId))===JSON.stringify(ids)))
      throw new Error('DUPLICATE_PUBLIC_CROWN');
    const legs=items.map(({line},index)=>{
      const decision=upsertDecision(data,candidates[index]);
      return {trackedPickId:decision.trackedPickId,playerName:line.playerName,market:line.market,
        exactLine:line.threshold,direction:decision.direction,lineType:line.lineType,
        lineScore:decision.lineScore,modelVersion:decision.modelVersion,eventId:line.eventId,
        playerId:line.playerId,sport:line.sport};
    });
    const crown:PublicCrown={publicCrownId:randomUUID(),ownerPublicId:actor.publicId,
      createdAt:this.clock().toISOString(),legs,unsharedAt:null};data.crowns.push(crown);
    for(const leg of legs){if(!data.publicCredits.some((item)=>item.publicId===actor.publicId &&
      item.trackedPickId===leg.trackedPickId))data.publicCredits.push({publicId:actor.publicId,
        trackedPickId:leg.trackedPickId});}
    await this.write(data);return publicView(data,crown);
  });}
  async unshare(actorKey:string,crownId:string){return this.exclusive(async()=>{
    const data=await this.read(),actor=data.profiles.find((item)=>item.actorKey===actorKey),
      crown=data.crowns.find((item)=>item.publicCrownId===crownId);
    if(!actor || !crown || crown.ownerPublicId!==actor.publicId || crown.unsharedAt)
      throw new Error('PUBLIC_CROWN_NOT_FOUND');
    crown.unsharedAt=this.clock().toISOString();await this.write(data);
  });}
  async crownsFor(publicId:string,offset=0,limit=20){return this.exclusive(async()=>{
    const data=await this.read(),profile=data.profiles.find((item)=>item.publicId===publicId &&
      item.profileVisible && item.socialEnabled && !item.isSuspended);
    if(!profile)return null;
    const crowns=data.crowns.filter((item)=>item.ownerPublicId===publicId && !item.unsharedAt)
      .sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    return {total:crowns.length,crowns:crowns.slice(offset,offset+limit).map((item)=>publicView(data,item))};
  });}
  async followingCrowns(actorKey:string,limit=20){return this.exclusive(async()=>{
    const data=await this.read(),actor=data.profiles.find((item)=>item.actorKey===actorKey);
    if(!actor)return [];
    const followed=new Set(data.follows.filter((item)=>item.followerPublicId===actor.publicId)
      .map((item)=>item.followedPublicId));
    const visible=new Set(data.profiles.filter((item)=>followed.has(item.publicId) && item.socialEnabled &&
      item.profileVisible && !item.isSuspended).map((item)=>item.publicId));
    return data.crowns.filter((item)=>!item.unsharedAt && visible.has(item.ownerPublicId))
      .sort((a,b)=>b.createdAt.localeCompare(a.createdAt))
      .slice(0,Math.max(1,Math.min(20,limit))).map((item)=>publicView(data,item));
  });}
  async recentTopCrowns(limit=10){return this.exclusive(async()=>{
    if(this.recentCache && this.recentCache.expires>this.clock().getTime())
      return this.recentCache.value.slice(0,limit);
    const data=await this.read(),allowed=new Set(leaders(data).map((item)=>item.publicId));
    const value=data.crowns.filter((item)=>!item.unsharedAt && allowed.has(item.ownerPublicId))
      .sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,10)
      .map((item)=>publicView(data,item));
    this.recentCache={expires:this.clock().getTime()+180_000,value};return value.slice(0,limit);
  });}
  async crown(crownId:string){return this.exclusive(async()=>{
    const data=await this.read(),crown=data.crowns.find((item)=>item.publicCrownId===crownId &&
      !item.unsharedAt && data.profiles.some((profile)=>profile.publicId===item.ownerPublicId &&
        profile.profileVisible && profile.socialEnabled && !profile.isSuspended));
    return crown?publicView(data,crown):null;
  });}
  async importPreview(crownId:string,board:BoardResponse){
    const crown=await this.crown(crownId);if(!crown)return null;
    const data=await this.read(),original=data.crowns.find((item)=>item.publicCrownId===crownId)!;
    return {publicCrownId:crownId,legs:original.legs.map((leg)=>{
      const matches=board.board.lines.filter((line)=>line.eventId===leg.eventId &&
        line.playerId===leg.playerId && line.market===leg.market);
      const exact=matches.find((line)=>line.threshold===leg.exactLine && line.lineType===leg.lineType &&
        line.availableDirections.includes(leg.direction));
      const analysis=board.analyses.find((item)=>item.lineId===exact?.id);
      const valid=!!exact && !!analysis && analysis.direction===leg.direction &&
        analysis.score!==null && !!analysis.modelVersion &&
        Date.parse(exact.eventStartTime)>this.clock().getTime() &&
        (!analysis.evidenceExpiresAt || Date.parse(analysis.evidenceExpiresAt)>this.clock().getTime());
      return {shared:{playerName:leg.playerName,market:leg.market,threshold:leg.exactLine,
        direction:leg.direction,lineType:leg.lineType},status:valid?'AVAILABLE':'CHANGED_OR_UNAVAILABLE',
        currentOptions:matches.map((line)=>({lineId:line.id,threshold:line.threshold,
          lineType:line.lineType,directions:line.availableDirections}))};
    })};
  }
}
