import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { demoRequest } from './demo/request';
import { apiBaseUrl } from './api-base';
import { guestCode, startsInDemo } from './links';
import { clearSession, loadSession, saveSession } from './local-store';
import { reportMobileFailure } from './diagnostics';

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
const guestMessages:Record<string,string>={GUEST_PASS_FULL:'This guest link has already been used by its four testers.',
  GUEST_PASS_EXPIRED:'Your three-day guest pass has ended. Thanks for testing CrownIQ!',
  GUEST_PASS_INVALID:'This guest link is not valid.',TOO_MANY_ATTEMPTS:'Too many attempts. Please wait a minute.'};

type Profile={publicId:string;username:string;email:string|null;plan:'FREE'|'LIFETIME'|'GUEST'|'SUSPENDED'|'DEMO'};
type Session={token:string;profile:Profile};
type AuthContext={profile:Profile|null;register:(username:string,email:string,password:string)=>Promise<void>;
  login:(emailOrUsername:string,password:string)=>Promise<void>;logout:()=>Promise<void>;
  request:(path:string,init?:RequestInit)=>Promise<Response>;setUsername:(username:string)=>void;
  /** True in demo mode: sample data, no account, no server calls. */
  demo:boolean;enterDemo:()=>void;
  /** A guest link is signing in, or why it could not. */
  guest:{signingIn:boolean;message:string}};
const Context=createContext<AuthContext|null>(null);
const base=apiBaseUrl();

async function parseSession(response:Response):Promise<Session>{
  if(!response.ok){const payload=await response.json().catch(()=>({})) as {code?:string};
    const messages:Record<string,string>={EMAIL_TAKEN:'Email already has an account. Sign in instead.',
      USERNAME_TAKEN:'That display username is taken.',
      MEMBERS_FULL:'CrownIQ is full right now (100 members). Ask the owner for a spot or a guest link.',INVALID_CREDENTIALS:'Email, username or password is incorrect.',
      TOO_MANY_ATTEMPTS:'Too many attempts. Please wait a minute.',
      INVALID_REGISTRATION:'Use a 3–24 character username with letters, numbers or underscores, and a password of at least 12 characters.'};
    throw new Error(messages[payload.code??'']??'Sign-in failed. Try again.');}
  const value=await response.json() as Session;
  if(!value.token || !value.profile?.publicId)throw new Error('The server did not create a session.');
  return value;
}

export function AuthProvider({children}:{children:ReactNode}){
  // The session token is kept on this device until Log Out (owner choice); the server ends it after 30 days.
  const [session,setSession]=useState<Session|null>(null);
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
  const [guestResult,setGuestResult]=useState<{done:boolean;message:string}>({done:false,message:''});
  const guest=useMemo(()=>({signingIn:guestLink&&!guestResult.done,message:guestResult.message}),[guestLink,guestResult]);
  useEffect(()=>{
    const code=guestCode();
    if(!code||!base)return;
    let active=true;
    void (async()=>{
      try{
        const response=await fetch(`${base}/v1/auth/guest`,{method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({code,deviceId:guestDeviceId()})});
        if(!response.ok){const payload=await response.json().catch(()=>({})) as {code?:string};
          throw new Error(guestMessages[payload.code??'']??'Could not open the guest link. Try again.');}
        const value=await parseSession(response);
        if(active){signIn(value);setGuestResult({done:true,message:''});}
      }catch(error){
        if(active)setGuestResult({done:true,message:error instanceof Error?error.message:'Could not open the guest link.'});
      }
    })();
    return ()=>{active=false;};
  },[]);
  const value=useMemo<AuthContext>(()=>({
    profile:session?.profile??(demo?demoProfile:null),demo,guest,
    enterDemo:()=>setDemo(true),
    register:async(username,email,password)=>{
      if(!base)throw new Error('Set EXPO_PUBLIC_API_URL to your CrownIQ server first.');
      const response=await fetch(`${base}/v1/auth/register`,{method:'POST',
        headers:{'content-type':'application/json'},body:JSON.stringify({username,email,password})});
      signIn(await parseSession(response));
    },
    login:async(emailOrUsername,password)=>{
      if(!base)throw new Error('Set EXPO_PUBLIC_API_URL to your CrownIQ server first.');
      const response=await fetch(`${base}/v1/auth/login`,{method:'POST',
        headers:{'content-type':'application/json'},body:JSON.stringify({login:emailOrUsername,password})});
      signIn(await parseSession(response));
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
    setUsername:(username)=>setSession((current)=>current
      ? {...current,profile:{...current.profile,username}}:null),
  }),[session,demo,guest]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useAuth(){const value=useContext(Context);
  if(!value)throw new Error('AuthProvider required');return value;}

