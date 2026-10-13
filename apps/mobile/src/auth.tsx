import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { demoRequest } from './demo/request';
import { apiBaseUrl } from './api-base';
import { guestCode, startsInDemo } from './links';
import { clearSession, loadSession, saveSession } from './local-store';
import { reportMobileFailure } from './diagnostics';
import { t } from './i18n';

const demoProfile:Profile={publicId:'demo',username:'Demo',email:null,plan:'DEMO'};

/**
 * A random id for this browser, kept so reopening the guest link signs back in to the same guest account instead of
 * taking another of the link's places. Without storage it lasts only for this page.
 */
function guestDeviceId():string{
  const key='crowniq.guestDevice';
  try{const saved=window.localStorage.getItem(key);if(saved)return saved;}catch{ /* storage unavailable */ }
  const bytes=new Uint8Array(16);globalThis.crypto.getRandomValues(bytes);
  const id=Array.from(bytes,(byte)=>byte.toString(16).padStart(2,'0')).join('');
  try{window.localStorage.setItem(key,id);}catch{ /* storage unavailable */ }
  return id;
}
const noSubscription=()=>()=>undefined;
/** What to fix when a new trial's login can't be used (the form stays open). */
const trialLoginMessages:Record<string,string>={EMAIL_TAKEN:'That email already has an account or trial. Sign in with it below instead.',
  USERNAME_TAKEN:'That username is taken. Pick another.',LOGIN_REQUIRED:'Create your login to start your pass.',LOGIN_EXISTS:'This device already started a pass with a login. Sign in with it below.',
  INVALID_REGISTRATION:'Use a 3–24 character username (letters, numbers or _), your email, and a password of at least 12 characters.'};
const guestMessages:Record<string,string>={TRIALS_ALL_USED:'All free trial keys have been claimed. Thanks for your interest in CrownIQ! Watch for the next round.',
  GUEST_PASS_FULL:'This guest link or trial key has already been used.',
  GUEST_PASS_EXPIRED:'Your free trial has ended. Thanks for testing CrownIQ! Finish a short survey for a free week of membership, or subscribe below to keep your picks and profile.',
  GUEST_PASS_INVALID:'This guest link is not valid.',TOO_MANY_ATTEMPTS:'Too many attempts. Please wait a minute.'};

type Profile={publicId:string;username:string;email:string|null;plan:'FREE'|'LIFETIME'|'GUEST'|'SUSPENDED'|'DEMO';
  /** Signed in with the shared family code: must set their own password first. */
  mustChangePassword?:boolean};
type AuthContext={profile:Profile|null;register:(username:string,email:string,password:string,memberKey?:string)=>Promise<void>;
  /** Uses a fresh session the server returned (e.g. after a trial got more time). */
  adoptSession:(value:Session)=>void;
  login:(emailOrUsername:string,password:string)=>Promise<void>;logout:()=>Promise<void>;
  request:(path:string,init?:RequestInit)=>Promise<Response>;setUsername:(username:string)=>void;
  /** Replaces the family code with the member's own password (current: the code, when this device didn't just use it). */
  changePassword:(next:string,current?:string)=>Promise<void>;
  /** This device just signed in with a password, so the family code needn't be typed again. */
  passwordKnown:boolean;
  /** Forgot password: the one-time code the owner gave, and a new password. Signs in. */
  resetPassword:(login:string,code:string,next:string)=>Promise<void>;
  /** True in demo mode: sample data, no account, no server calls. */
  demo:boolean;enterDemo:()=>void;
  /** A guest link is signing in, or why it could not. `expired`: a trial pass that ended (it can still take the poll). */
  /** A new trial starts with a login (owner, 2026-10-12): `start` sends it; `formError` asks for a fix and keeps the form. */
  guest:{signingIn:boolean;waiting:boolean;start:(login:TrialLogin)=>void;message:string;expired:boolean;formError:string};
  /** Answers the end-of-trial survey (a free week of membership): signed in, with the trial link, or with the trial login. */
  /** `login`: a trial whose pass ended answers from any device with its login (owner, 2026-10-12). */
  answerTrialPoll:(answers:TrialPollAnswers,login?:{login:string;password:string})=>Promise<void>};
export type Session={token:string;profile:Profile};
export type TrialLogin={username:string;email:string;password:string};
export type TrialPlan='WEEK'|'MONTH'|'QUARTER'|'HALF_YEAR'|'YEAR'|'NONE';
export type TrialPollAnswers={recommend:'YES'|'MAYBE'|'NO';liked:string[];improve:string|null;plan:TrialPlan|null;price:string|null};
const Context=createContext<AuthContext|null>(null);
const base=apiBaseUrl();

async function parseSession(response:Response):Promise<Session>{
  if(!response.ok){const payload=await response.json().catch(()=>({})) as {code?:string};
    const messages:Record<string,string>={EMAIL_TAKEN:'Email already has an account. Sign in instead.',
      USERNAME_TAKEN:'That display username is taken.',
      MEMBER_KEY_INVALID:'That member key isn’t right or was already used. Check it with the owner.',
      MEMBERS_FULL:'CrownIQ is full right now (100 members). Ask the owner for a spot or a guest link.',
      LIFETIME_FULL:'All 20 lifetime family spots are taken. Ask the owner.',
      SIGNUP_CLOSED:'Sign-up is invite-only for now. Enter your access code, or contact the owner for one.',
      RESET_INVALID:'That reset code isn’t right or has expired. Ask the owner for a new one.',
      PASSWORD_NOT_NEW:'Choose a password different from the family code.',
      INVALID_RESET:'Enter your email or username, the 8-character code and a password of at least 12 characters.',INVALID_CREDENTIALS:'Email, username or password is incorrect.',
      TOO_MANY_ATTEMPTS:'Too many attempts. Please wait a minute.',
      GUEST_PASS_EXPIRED:'Your 2-day pass has ended. Finish the short survey below for a free week, or subscribe.',
      PLAN_ENDED:'Your free time has ended. Subscribe to keep using CrownIQ.',
      INVALID_REGISTRATION:'Use a 3–24 character username with letters, numbers or underscores, and a password of at least 12 characters.'};
    // The code rides along so a screen can react to it (a trial that ended opens the survey).
    throw Object.assign(new Error(messages[payload.code??'']??'Sign-in failed. Try again.'),{code:payload.code??null});}
  const value=await response.json() as Session;
  if(!value.token || !value.profile?.publicId)throw new Error('The server did not create a session.');
  return value;
}

export function AuthProvider({children}:{children:ReactNode}){
  // The session token is kept on this device until Log Out (owner choice); the server ends it after 30 days.
  const [session,setSession]=useState<Session|null>(null);
  // The password used to sign in, kept in memory only, so a family member doesn't type the family code twice.
  const [familyPassword,setFamilyPassword]=useState('');
  const signIn=(value:Session)=>{
    setSession(value);setDemo(false);
    void saveSession(value.token).catch((error:unknown)=>reportMobileFailure('storage',error));
  };
  // Sign back in with the saved session, unless a guest link is signing this device in.
  useEffect(()=>{
    if(!base||guestCode())return;
    let active=true;
    void (async()=>{
      const saved=await loadSession();
      if(!saved)return;
      const response=await fetch(`${base}/v1/auth/me`,{headers:{Authorization:`Bearer ${saved.token}`}}).catch(()=>null);
      if(!response)return;
      if(!response.ok){if(response.status===401)await clearSession();return;}
      const body=await response.json() as {profile?:Profile};
      if(active&&body.profile?.publicId)setSession((current)=>current??{token:saved.token,profile:body.profile!});
    })().catch((error:unknown)=>reportMobileFailure('storage',error));
    return ()=>{active=false;};
  },[]);
  // The page's link is read as an external value that is empty while hydrating, so the first render matches the
  // prebuilt web page. Choices made in the app (Try the demo, sign in, log out) then take over.
  const demoLink=useSyncExternalStore(noSubscription,()=>startsInDemo(),()=>false);
  const guestLink=useSyncExternalStore(noSubscription,()=>!!guestCode()&&!!base,()=>false);
  const [demoChoice,setDemo]=useState<boolean|null>(null);
  const demo=demoChoice??demoLink;
  const [guestResult,setGuestResult]=useState<{done:boolean;message:string;expired?:boolean}>({done:false,message:''});
  // A guest link claims its key only when the person taps Start (owner, 2026-10-12: link previews opened every posted link
  // and used up the keys the minute they were posted).
  const [guestStarted,setGuestStarted]=useState(false);
  const guestLogin=useRef<TrialLogin|null>(null);
  const [guestFormError,setGuestFormError]=useState('');
  const guest=useMemo(()=>({signingIn:guestLink&&guestStarted&&!guestResult.done,waiting:guestLink&&!guestStarted&&!guestResult.done,
    start:(login:TrialLogin)=>{guestLogin.current=login;setGuestFormError('');setGuestStarted(true);},message:guestResult.message,
    expired:!!guestResult.expired,formError:guestFormError}),[guestLink,guestStarted,guestResult,guestFormError]);
  useEffect(()=>{
    const code=guestCode();
    if(!code||!base||!guestStarted)return;
    let active=true;
    void (async()=>{
      try{
        const response=await fetch(`${base}/v1/auth/guest`,{method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({code,deviceId:guestDeviceId(),...guestLogin.current?{login:guestLogin.current}:{}})});
        if(!response.ok){const payload=await response.json().catch(()=>({})) as {code?:string};
          if(payload.code==='GUEST_PASS_EXPIRED'){if(active)setGuestResult({done:true,message:guestMessages.GUEST_PASS_EXPIRED,expired:true});return;}
          // A login problem keeps the form open with what to fix.
          const fix=trialLoginMessages[payload.code??''];
          if(fix){if(active){setGuestFormError(fix);setGuestStarted(false);}return;}
          throw new Error(guestMessages[payload.code??'']??'Could not open the guest link. Try again.');}
        const value=await parseSession(response);
        if(active){signIn(value);setGuestResult({done:true,message:''});
          // A shared trial link rolls over to the next free key; a short welcome, no key numbers (owner, 2026-10-12).
          const note=(value as {trialNote?:string}).trialNote;
          if(note)setTimeout(()=>{if(typeof window!=='undefined'&&typeof window.alert==='function')window.alert(t(note));},300);}
      }catch(error){
        if(active)setGuestResult({done:true,message:error instanceof Error?error.message:'Could not open the guest link.'});
      }
    })();
    return ()=>{active=false;};
  },[guestStarted]);
  const value=useMemo<AuthContext>(()=>({
    profile:session?.profile??(demo?demoProfile:null),demo,guest,
    enterDemo:()=>setDemo(true),
    answerTrialPoll:async(answers,login)=>{
      if(!base)throw new Error('Set EXPO_PUBLIC_API_URL to your CrownIQ server first.');
      const signedIn=!login&&!!session?.token, code=guestCode();
      const response=await fetch(`${base}${signedIn?'/v1/trial/poll':'/v1/auth/trial-poll'}`,{method:'POST',
        headers:{'content-type':'application/json',...(signedIn?{authorization:`Bearer ${session!.token}`}:{})},
        body:JSON.stringify(signedIn?answers:login?{...login,answers}:{code,deviceId:guestDeviceId(),answers})});
      if(!response.ok){const payload=await response.json().catch(()=>({})) as {code?:string};
        throw new Error(payload.code==='POLL_ALREADY_ANSWERED'?'You already answered the poll. Thanks!'
          :payload.code==='TRIAL_NOT_FOUND'?'This survey is for the 2-day trial passes.':payload.code==='INVALID_POLL'?'Answer every question to get your free week.'
          :payload.code==='POLL_NOT_OPEN'?'The survey opens in the last day of your pass.':'Could not send your answers. Try again.');}
      signIn(await parseSession(response));setGuestResult({done:true,message:''});
    },
    adoptSession:(next)=>signIn(next),
    register:async(username,email,password,memberKey)=>{
      if(!base)throw new Error('Set EXPO_PUBLIC_API_URL to your CrownIQ server first.');
      const response=await fetch(`${base}/v1/auth/register`,{method:'POST',
        headers:{'content-type':'application/json'},body:JSON.stringify({username,email,password,
          // This device's trial (by its id) becomes the member account, keeping its picks; a member key sets the paid plan.
          guestCode:guestCode()??'trial',deviceId:guestDeviceId(),...(memberKey?{memberKey}:{})})});
      const created=await parseSession(response);
      setFamilyPassword(created.profile.mustChangePassword?password:'');
      signIn(created);
    },
    login:async(emailOrUsername,password)=>{
      if(!base)throw new Error('Set EXPO_PUBLIC_API_URL to your CrownIQ server first.');
      const response=await fetch(`${base}/v1/auth/login`,{method:'POST',
        headers:{'content-type':'application/json'},body:JSON.stringify({login:emailOrUsername,password})});
      const opened=await parseSession(response);
      setFamilyPassword(opened.profile.mustChangePassword?password:'');
      signIn(opened);
    },
    logout:async()=>{
      const token=session?.token;
      setSession(null);setDemo(false);
      await clearSession().catch((error:unknown)=>reportMobileFailure('storage',error));
      if(base && token)await fetch(`${base}/v1/auth/logout`,{method:'POST',
        headers:{Authorization:`Bearer ${token}`}}).catch(()=>undefined);
    },
    request:(path,init={})=>{
      if(demo&&!session)return demoRequest(path,init);
      if(!base)throw new Error('CrownIQ server is not configured.');
      if(!session)throw new Error('Sign in to continue.');
      const headers=new Headers(init.headers);
      headers.set('Authorization',`Bearer ${session.token}`);
      return fetch(`${base}${path}`,{...init,headers});
    },
    passwordKnown:!!familyPassword,
    resetPassword:async(login,code,next)=>{
      if(!base)throw new Error('Set EXPO_PUBLIC_API_URL to your CrownIQ server first.');
      const response=await fetch(`${base}/v1/auth/reset`,{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({login,code,newPassword:next})});
      setFamilyPassword('');
      signIn(await parseSession(response));
    },
    changePassword:async(next,entered)=>{
      if(!base||!session)throw new Error('Sign in to continue.');
      // The family code is the current password: it was the one used to sign in.
      const current=entered??familyPassword;
      const response=await fetch(`${base}/v1/auth/password`,{method:'POST',headers:{'content-type':'application/json',
        Authorization:`Bearer ${session.token}`},body:JSON.stringify({currentPassword:current,newPassword:next})});
      if(!response.ok){const payload=await response.json().catch(()=>({})) as {code?:string};
        throw new Error(payload.code==='PASSWORD_NOT_NEW'?'Choose a password different from the family code.'
          :payload.code==='INVALID_CREDENTIALS'?'That family code isn’t right.'
          :payload.code==='INVALID_PASSWORD'?'Use at least 12 characters.':'Could not save your password. Try again.');}
      setFamilyPassword('');
      setSession((value)=>value?{...value,profile:{...value.profile,mustChangePassword:false}}:null);
    },
    setUsername:(username)=>setSession((current)=>current
      ? {...current,profile:{...current.profile,username}}:null),
  }),[session,demo,guest,familyPassword]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useAuth(){const value=useContext(Context);
  if(!value)throw new Error('AuthProvider required');return value;}


/** A trial or guest-link account (owner, 2026-10-11): sees picks and scores, not how CrownIQ makes them, under a watermark. */
export function useTrial():boolean{return useAuth().profile?.plan==='GUEST';}
