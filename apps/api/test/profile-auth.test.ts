import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analysisSchema, boardResponseSchema } from '@crowniq/contracts';
import { fixtureLine } from '../../../packages/engine/test/fixtures.js';
import { ProductLedger } from '../src/product-ledger.js';
import { ProviderIdentityVerifier } from '../src/provider-identity.js';
import { buildServer } from '../src/server.js';

const start=new Date('2030-09-24T12:00:00Z');
function board(){
  const lines=['player-a','player-b'].map((name)=>fixtureLine({id:`line-${name}`,
    sourceLineId:`source-${name}`,eventId:'fixture-event',playerId:name,playerName:name,
    team:name==='player-a'?'AAA':'BBB',eventStartTime:'2030-09-25T00:00:00Z',
    fetchedAt:start.toISOString(),threshold:24.5,availableDirections:['MORE']}));
  const analyses=lines.map((line)=>analysisSchema.parse({lineId:line.id,direction:'MORE',score:89,
    scoreBand:'CROWN_STRONG',contextScore:92,scoreBreakdown:[],assessments:[],evidenceIds:[],
    evidenceQuality:'HIGH',evidenceExpiresAt:'2030-09-25T00:00:00Z',dangerZone:false,
    thresholdCushion:2,ruleChecks:[],supportingFactors:[],opposingFactors:[],rationale:'Synthetic',
    reasonCode:null,modelVersion:'fixture-1'}));
  return boardResponseSchema.parse({board:{provider:'prizepicks',fetchedAt:start.toISOString(),lines},
    analyses,rankedLineIds:lines.map((item)=>item.id),builtAt:start.toISOString()});
}

test('profile sessions, private selections and private Crowns survive restart without leaking between users',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'crowniq-profiles-'));
  try{let clock=start;const path=join(folder,'ledger.json');
    const ledger=new ProductLedger(path,'CROWN_STRONG',()=>clock,()=>[]);
    const alice=await ledger.register('ALICE@example.org','long-private-passphrase','Alpha_1');
    const bob=await ledger.register('bob@example.org','another-private-password','Bravo_2');
    await assert.rejects(()=>ledger.register('other@example.org','another-long-password','alpha_1'),
      /USERNAME_TAKEN/);
    await assert.rejects(()=>ledger.login('alice@example.org','incorrect-password'),/INVALID_CREDENTIALS/);
    assert.equal((await ledger.login('alpha_1','long-private-passphrase')).profile.publicId,alice.profile.publicId);
    assert.equal((await ledger.login(' Alice@Example.org ','long-private-passphrase')).profile.publicId,alice.profile.publicId);
    await assert.rejects(()=>ledger.login('Alpha_1','another-private-password'),/INVALID_CREDENTIALS/);
    await assert.rejects(()=>ledger.login('nobody_here','long-private-passphrase'),/INVALID_CREDENTIALS/);
    const data=await readFile(path,'utf8');
    assert.equal(data.includes('long-private-passphrase'),false);
    assert.equal(data.includes(alice.token),false);
    assert.equal((await ledger.authenticate(alice.token))?.username,'Alpha_1');
    const sample=board();
    const a=(await ledger.authenticate(alice.token))!.accountId,
      b=(await ledger.authenticate(bob.token))!.accountId;
    assert.deepEqual(await ledger.saveUserPick(a,sample.board.lines[0].id,sample,[]),
      {saved:true,alreadySaved:false,trackedPickId:(await ledger.userPicks(a)).picks[0].id});
    assert.equal((await ledger.saveUserPick(a,sample.board.lines[0].id,sample,[])).alreadySaved,true);
    assert.equal((await ledger.userPicks(b)).total,0);
    assert.equal((await ledger.topUsers() as {users:unknown[]}).users.length,0);
    assert.equal((await ledger.userCrowns(a)).crowns.length,0);
    const saved=await ledger.savePrivateCrown(a,sample.board.lines.map((item)=>item.id),sample,[]);
    assert.equal(saved.alreadySaved,false);
    assert.equal((await ledger.savePrivateCrown(a,sample.board.lines.map((item)=>item.id),sample,[])).alreadySaved,true);
    assert.equal((await ledger.userCrowns(b)).crowns.length,0);
    const restarted=new ProductLedger(path,'CROWN_STRONG',()=>clock,()=>[]);
    assert.equal((await restarted.authenticate(alice.token))?.publicId,alice.profile.publicId);
    assert.equal((await restarted.userPicks(a)).total,1);
    assert.equal((await restarted.userCrowns(a)).crowns.length,1);
    clock=new Date('2030-09-26T00:00:00Z');
    await restarted.grade([{eventId:'fixture-event',playerId:'player-a',market:sample.board.lines[0].market,
      status:'FINAL',actual:28,sourceName:'Fixture result',sourceUrl:'https://example.org/result',
      completedAt:'2030-09-25T04:00:00Z'}]);
    assert.equal((await restarted.userPicks(a)).picks[0].result,'WIN');
    await restarted.removeUserPick(a,(await restarted.userPicks(a)).picks[0].id);
    await restarted.removeUserCrown(a,saved.id);
    assert.equal((await restarted.userPicks(a)).total,0);
    assert.equal((await restarted.userCrowns(a)).crowns.length,0);
    assert.equal((await restarted.listDecisions()).total,2);
    await restarted.logout(alice.token);
    assert.equal(await restarted.authenticate(alice.token),null);
    assert.ok(await restarted.authenticate(bob.token));
  }finally{await rm(folder,{recursive:true,force:true});}
});

test('v1 ledgers migrate without dropping decisions and a new profile has a separate private record',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'crowniq-migrate-'));
  try{const path=join(folder,'ledger.json');
    await writeFile(path,JSON.stringify({version:1,decisions:[],profiles:[],crowns:[],
      follows:[],publicCredits:[]}));
    const ledger=new ProductLedger(path,'CROWN_STRONG',()=>start);
    await ledger.register('new@example.org','durable-private-password','New_user');
    const data=JSON.parse(await readFile(path,'utf8')) as {version:number;accounts:unknown[]};
    assert.equal(data.version,2);assert.equal(data.accounts.length,1);
  }finally{await rm(folder,{recursive:true,force:true});}
});

test('provider email collision requires explicit linking; the verified subject keeps the same profile',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'crowniq-provider-link-'));
  try{const ledger=new ProductLedger(join(folder,'ledger.json'),'CROWN_STRONG',()=>start);
    const existing=await ledger.register('same@example.org','valid-password-value','First_1');
    await assert.rejects(()=>ledger.loginWithProvider('GOOGLE','verified-subject',
      'same@example.org','Other_1'),/ACCOUNT_LINK_REQUIRED/);
    const accountId=(await ledger.authenticate(existing.token))!.accountId;
    await ledger.linkProvider(accountId,'GOOGLE','verified-subject');
    const returned=await ledger.loginWithProvider('GOOGLE','verified-subject',null);
    assert.equal(returned.profile.publicId,existing.profile.publicId);
    assert.equal((await ledger.authenticate(returned.token))?.username,'First_1');
    const second=await ledger.loginWithProvider('APPLE','different-subject',null,'Second_2');
    assert.notEqual(second.profile.publicId,existing.profile.publicId);
    assert.equal((await ledger.userPicks((await ledger.authenticate(second.token))!.accountId)).total,0);
  }finally{await rm(folder,{recursive:true,force:true});}
});

test('protected routes require a real profile; public registration and logout never pull paid odds',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'crowniq-auth-routes-'));
  const ledger=new ProductLedger(join(folder,'ledger.json'),'CROWN_STRONG',()=>start);
  const app=buildServer({product:ledger,requireProfiles:true,clock:()=>start});
  try{
    assert.equal((await app.inject('/health')).statusCode,200);
    assert.equal((await app.inject('/v1/board')).statusCode,401);
    assert.equal((await app.inject('/v1/me/picks')).statusCode,401);
    assert.equal((await app.inject('/v1/social/top-users')).statusCode,401);
    const register=await app.inject({method:'POST',url:'/v1/auth/register',
      payload:{username:'Private_1',email:'someone@example.org',password:'private-passphrase-1'}});
    assert.equal(register.statusCode,201);
    const session=register.json() as {token:string;profile:{publicId:string}};
    const headers={authorization:`Bearer ${session.token}`};
    assert.equal((await app.inject({url:'/v1/auth/me',headers})).json().profile.publicId,
      session.profile.publicId);
    assert.equal((await app.inject({url:'/v1/me/picks',headers})).json().total,0);
    assert.equal((await app.inject({url:'/v1/me/crowns',headers})).json().crowns.length,0);
    assert.equal((await app.inject({url:'/v1/board',headers})).statusCode,503);
    assert.equal((await app.inject({method:'POST',url:'/v1/me/picks',headers,
      payload:{lineId:'fixture'}})).statusCode,503);
    assert.equal((await app.inject({method:'POST',url:'/v1/admin/force-provider-refresh',headers})).statusCode,503);
    assert.equal((await app.inject({method:'POST',url:'/v1/auth/logout',headers})).statusCode,200);
    assert.equal((await app.inject({url:'/v1/me/picks',headers})).statusCode,401);
    const login=await app.inject({method:'POST',url:'/v1/auth/login',
      payload:{email:'someone@example.org',password:'private-passphrase-1'}});
    assert.equal(login.statusCode,200);
    assert.notEqual(login.json().token,session.token);
    const byName=await app.inject({method:'POST',url:'/v1/auth/login',payload:{login:'PRIVATE_1',password:'private-passphrase-1'}});
    assert.equal(byName.statusCode,200,byName.body);
    assert.equal(byName.json().profile.publicId,session.profile.publicId);
    assert.equal((await app.inject({method:'POST',url:'/v1/auth/login',payload:{password:'private-passphrase-1'}})).statusCode,400);
  }finally{await app.close();await rm(folder,{recursive:true,force:true});}
});

test('provider ID tokens require a trusted signature, audience, issuer, expiration and nonce',async()=>{
  const pair=generateKeyPairSync('rsa',{modulusLength:2048});
  const jwk=pair.publicKey.export({format:'jwk'}) as {n:string;e:string};
  const now=Math.floor(start.getTime()/1000);
  const calls:string[]=[];
  const verifier=new ProviderIdentityVerifier({GOOGLE:['fixture-client'],APPLE:[]},
    async(input)=>{calls.push(String(input));return new Response(JSON.stringify({keys:[{
      kid:'fixture-key',kty:'RSA',alg:'RS256',use:'sig',n:jwk.n,e:jwk.e}]}),{status:200});},()=>start);
  const token=(overrides:Record<string,unknown>={})=>{
    const head=Buffer.from(JSON.stringify({alg:'RS256',kid:'fixture-key'})).toString('base64url');
    const payload=Buffer.from(JSON.stringify({iss:'https://accounts.google.com',aud:'fixture-client',
      sub:'trusted-subject',exp:now+300,iat:now,nonce:'server-issued-nonce',
      email:'verified@example.org',email_verified:true,...overrides})).toString('base64url');
    const signature=sign('RSA-SHA256',Buffer.from(`${head}.${payload}`),pair.privateKey).toString('base64url');
    return `${head}.${payload}.${signature}`;
  };
  assert.equal((await verifier.verify('GOOGLE',token(),'server-issued-nonce')).subject,'trusted-subject');
  assert.deepEqual(calls,['https://www.googleapis.com/oauth2/v3/certs']);
  await assert.rejects(()=>verifier.verify('GOOGLE',token({aud:'attacker'}),'server-issued-nonce'));
  await assert.rejects(()=>verifier.verify('GOOGLE',token({exp:now-1}),'server-issued-nonce'));
  await assert.rejects(()=>verifier.verify('GOOGLE',token(),'wrong-nonce'));
  await assert.rejects(()=>verifier.verify('GOOGLE',token({email_verified:false}),'server-issued-nonce'));
  // Change a character in the middle of the signature: the last characters carry padding bits, so swapping them can
  // leave the decoded signature unchanged and the token valid.
  const tampered=(value:string)=>{const at=value.length-40;return value.slice(0,at)+(value[at]==='A'?'B':'A')+value.slice(at+1);};
  await assert.rejects(()=>verifier.verify('GOOGLE',tampered(token()),'server-issued-nonce'));
  const folder=await mkdtemp(join(tmpdir(),'crowniq-oidc-'));
  const app=buildServer({product:new ProductLedger(join(folder,'ledger.json'),
    'CROWN_STRONG',()=>start),identityVerifier:verifier,requireProfiles:true,clock:()=>start});
  try{const nonce=(await app.inject('/v1/auth/nonce')).json().nonce as string;
    const payload={provider:'GOOGLE',nonce,idToken:token({nonce}),username:'Google_user'};
    const signedIn=await app.inject({method:'POST',url:'/v1/auth/provider',payload});
    assert.equal(signedIn.statusCode,200);
    assert.ok(signedIn.json().token);
    const replay=await app.inject({method:'POST',url:'/v1/auth/provider',payload});
    assert.equal(replay.statusCode,401);assert.equal(replay.json().code,'INVALID_NONCE');
  }finally{await app.close();await rm(folder,{recursive:true,force:true});}
});

test('the family code as a first password makes a lifetime account that must set its own password; 10 seats',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'crowniq-lifetime-'));
  try{let clock=start;const path=join(folder,'ledger.json');const code='Family-Code-For-Tests!';
    const ledger=new ProductLedger(path,'CROWN_STRONG',()=>clock,undefined,undefined,0,100,code);
    const plans:string[]=[];
    for(let index=0;index<20;index++){
      clock=new Date(start.getTime()+index*60_000);
      const result=await ledger.register(`member${index}@example.org`,code,`Member_${index}`);
      plans.push(result.profile.plan);
      assert.equal((result.profile as {mustChangePassword?:boolean}).mustChangePassword,true);
    }
    assert.deepEqual(plans,Array(20).fill('LIFETIME'));
    await assert.rejects(ledger.register('late@example.org',code,'Member_20'),/LIFETIME_FULL/);
    const normal=await ledger.register('normal@example.org','long-private-passphrase','Normal_one');
    assert.equal(normal.profile.plan,'FREE','no code: a member seat');
    // A family member signs in with the code, must change it, and can't keep the code.
    const first=await ledger.login('Member_0',code);
    const me=await ledger.authenticate(first.token);
    assert.equal(me?.mustChangePassword,true);
    await assert.rejects(ledger.changePassword(me!.accountId,code,code),/PASSWORD_NOT_NEW/);
    await assert.rejects(ledger.changePassword(me!.accountId,'wrong-password-here',`${code}x`),/INVALID_CREDENTIALS/);
    await ledger.changePassword(me!.accountId,code,'my-own-long-passphrase');
    assert.equal((await ledger.authenticate(first.token))?.mustChangePassword,false);
    await assert.rejects(ledger.login('Member_0',code),/INVALID_CREDENTIALS/,'the code no longer opens the account');
    const restarted=new ProductLedger(path,'CROWN_STRONG',()=>clock,undefined,undefined,0,100,code);
    assert.equal((await restarted.login('Member_0','my-own-long-passphrase')).profile.plan,'LIFETIME');
    assert.equal((await restarted.login('normal@example.org','long-private-passphrase')).profile.plan,'FREE');
  }finally{await rm(folder,{recursive:true,force:true});}
});

test('the member cap applies to sign-ups without the family code',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'crowniq-seats-'));
  try{let clock=start;
    // A cap of 3 members stands in for 100.
    const ledger=new ProductLedger(join(folder,'ledger.json'),'CROWN_STRONG',()=>clock,undefined,undefined,0,3,'Family-Code-For-Tests!');
    for(let index=0;index<3;index++){
      clock=new Date(start.getTime()+index*60_000);
      await ledger.register(`seat${index}@example.org`,'long-private-passphrase',`Seat_${index}`);
    }
    await assert.rejects(ledger.register('late@example.org','long-private-passphrase','Late_one'),/MEMBERS_FULL/);
    await assert.rejects(ledger.loginWithProvider('GOOGLE','sub-1','g@example.org','Google_one'),/MEMBERS_FULL/);
    await ledger.register('family@example.org','Family-Code-For-Tests!','Family_one');
    assert.deepEqual(await ledger.membership(),{lifetime:{used:1,limit:20},members:{used:3,limit:3},guests:0,suspended:0},
      'a family sign-up still works when member seats are full');
  }finally{await rm(folder,{recursive:true,force:true});}
});

test('a guest link gives up to four devices their own three-day account and keeps it for the same device',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'crowniq-guest-'));
  try{let clock=start;const path=join(folder,'ledger.json');
    const ledger=new ProductLedger(path,'CROWN_STRONG',()=>clock,()=>[]);
    const owner=await ledger.register('owner@example.org','long-private-passphrase','Owner_1');
    const pass={code:'testers-2030',maxGuests:4,days:3};
    const device=(index:number)=>`device-${index}-0123456789abcdef`;
    await assert.rejects(()=>ledger.guestLogin(pass,'wrong-code',device(1)),/GUEST_PASS_INVALID/);
    const first=await ledger.guestLogin(pass,'testers-2030',device(1));
    assert.equal(first.profile.username,'Guest_1');
    assert.equal(first.profile.plan,'GUEST');
    assert.equal(first.guestExpiresAt,'2030-09-27T12:00:00.000Z');
    const again=await ledger.guestLogin(pass,'testers-2030',device(1));
    assert.equal(again.profile.publicId,first.profile.publicId,'the same device keeps its account');
    for(const index of [2,3,4])await ledger.guestLogin(pass,'testers-2030',device(index));
    await assert.rejects(()=>ledger.guestLogin(pass,'testers-2030',device(5)),/GUEST_PASS_FULL/);
    const sample=board();
    const guest=(await ledger.authenticate(first.token))!;
    await ledger.saveUserPick(guest.accountId,sample.board.lines[0].id,sample,[]);
    clock=new Date('2030-09-27T12:00:01Z');
    assert.equal(await ledger.authenticate(first.token),null,'the pass ends after three days');
    await assert.rejects(()=>ledger.guestLogin(pass,'testers-2030',device(1)),/GUEST_PASS_EXPIRED/);
    assert.equal((await ledger.userPicks(guest.accountId)).total,1,'the guest picks are kept');
    // Guests never take a seat: a regular sign-up after them is a member, as without them.
    assert.equal((await ledger.login('Owner_1','long-private-passphrase')).profile.plan,'FREE');
    assert.deepEqual((await ledger.membership()).members,{used:1,limit:100});
  }finally{await rm(folder,{recursive:true,force:true});}
});

test('the guest route is off without a configured pass and needs a device id',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'crowniq-guest-route-'));
  const product=new ProductLedger(join(folder,'ledger.json'),'CROWN_STRONG',()=>start);
  const payload={code:'testers-2030',deviceId:'device-1-0123456789abcdef'};
  const off=buildServer({product,requireProfiles:true,clock:()=>start});
  const on=buildServer({product,requireProfiles:true,clock:()=>start,guestPass:{code:'testers-2030',maxGuests:4,days:3}});
  try{
    assert.equal((await off.inject({method:'POST',url:'/v1/auth/guest',payload})).statusCode,404);
    assert.equal((await on.inject({method:'POST',url:'/v1/auth/guest',payload:{code:'testers-2030',deviceId:'short'}})).statusCode,400);
    const signedIn=await on.inject({method:'POST',url:'/v1/auth/guest',payload});
    assert.equal(signedIn.statusCode,200);
    const me=await on.inject({url:'/v1/auth/me',headers:{authorization:`Bearer ${signedIn.json().token}`}});
    assert.equal(me.json().profile.plan,'GUEST');
  }finally{await off.close();await on.close();await rm(folder,{recursive:true,force:true});}
});

test('a personal Crown keeps the user own calls outside the tracked record',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'crowniq-personal-'));
  try{let clock=start;const ledger=new ProductLedger(join(folder,'ledger.json'),'CROWN_STRONG',()=>clock,()=>[]);
    const user=await ledger.register('person@example.org','long-private-passphrase','Person_1');
    const account=(await ledger.authenticate(user.token))!.accountId;
    const sample=board();
    const pass=boardResponseSchema.parse({...sample,analyses:[sample.analyses[0],
      {...sample.analyses[1],direction:'PASS',score:null,scoreBand:'PASS',modelVersion:null,reasonCode:'INSUFFICIENT_EDGE'}]});
    const legs=pass.board.lines.map((line)=>({lineId:line.id,direction:'MORE' as const}));
    await assert.rejects(()=>ledger.savePrivateCrown(account,legs.map((leg)=>leg.lineId),pass,[]),/INVALID_OR_STALE_CROWN/);
    const saved=await ledger.savePersonalCrown(account,legs,pass);
    assert.equal(saved.alreadySaved,false);
    assert.equal((await ledger.savePersonalCrown(account,legs,pass)).alreadySaved,true);
    await assert.rejects(()=>ledger.savePersonalCrown(account,[legs[0],{...legs[1],direction:'LESS'}],pass),
      /INVALID_OR_STALE_CROWN/,'a side PrizePicks does not offer is still refused');
    const crowns=(await ledger.userCrowns(account)).crowns;
    assert.equal(crowns.length,1);
    assert.equal((crowns[0] as {personal?:boolean}).personal,true);
    assert.deepEqual(crowns[0].legs.map((leg)=>leg.score),[89,null]);
    assert.equal((await ledger.userPicks(account)).total,0,'personal Crowns do not create tracked picks');
    assert.equal((await ledger.pendingPersonalLegs()).length,2);
    const line=pass.board.lines[1];
    clock=new Date('2030-09-25T06:00:00Z');
    const result=await ledger.grade([{eventId:line.eventId,playerId:line.playerId,market:line.market,status:'FINAL',
      actual:30,sourceName:'Fixture',sourceUrl:'https://example.org/result',completedAt:'2030-09-25T04:00:00Z'}]);
    assert.deepEqual([result.graded,result.personal],[0,1],'graded as a your-call leg, not a tracked decision');
    const graded=(await ledger.userCrowns(account)).crowns[0].legs;
    assert.deepEqual(graded.map((leg)=>leg.grade),['PENDING','WIN']);
    assert.equal((await ledger.pendingPersonalLegs()).length,1);
  }finally{await rm(folder,{recursive:true,force:true});}
});

test('a forgotten password resets with a one-time owner code that expires, signs the member in and ends old sessions',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'crowniq-reset-'));
  try{let clock=start;
    const ledger=new ProductLedger(join(folder,'ledger.json'),'CROWN_STRONG',()=>clock,undefined,undefined,0,100,'Family-Code-For-Tests!');
    const first=await ledger.register('forgot@example.org','long-private-passphrase','Forgot_one');
    await assert.rejects(ledger.createResetCode('Nobody_here'),/ACCOUNT_NOT_FOUND/);
    const { code, username } = await ledger.createResetCode('forgot@example.org');
    assert.equal(username,'Forgot_one');
    assert.match(code,/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    await assert.rejects(ledger.resetPassword('Forgot_one','AAAA-AAAA','a-brand-new-passphrase'),/RESET_INVALID/);
    await assert.rejects(ledger.resetPassword('Forgot_one',code,'Family-Code-For-Tests!'),/PASSWORD_NOT_NEW/);
    const reset=await ledger.resetPassword('forgot_one',code.toLowerCase().replace('-',' '),'a-brand-new-passphrase');
    assert.ok(reset.token,'signed in');
    assert.equal(await ledger.authenticate(first.token),null,'the old session ends');
    await assert.rejects(ledger.resetPassword('Forgot_one',code,'another-new-passphrase'),/RESET_INVALID/,'a code works once');
    assert.ok((await ledger.login('Forgot_one','a-brand-new-passphrase')).token);
    const late=await ledger.createResetCode('Forgot_one');
    clock=new Date(start.getTime()+25*3600_000);
    await assert.rejects(ledger.resetPassword('Forgot_one',late.code,'another-new-passphrase'),/RESET_INVALID/,'expires in 24 hours');
  }finally{await rm(folder,{recursive:true,force:true});}
});
