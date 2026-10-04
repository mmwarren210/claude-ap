import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { demoRequest } from './demo/request';
import { apiBaseUrl } from './api-base';

const demoProfile:Profile={publicId:'demo',username:'Demo',email:null,plan:'DEMO'};

/** A web link with `?demo` in it (for example `https://<server>/?demo`) opens straight into demo mode. */
export function startsInDemo(search=typeof window!=='undefined'?window.location?.search:undefined):boolean{
  return !!search && new URLSearchParams(search).has('demo') && !guestCode(search);
}

/** The code in a guest link (`https://<server>/?guest=<code>`), or null. */
export function guestCode(search=typeof window!=='undefined'?window.location?.search:undefined):string|null{
  return search ? new URLSearchParams(search).get('guest')?.trim() || null : null;
}

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
      USERNAME_TAKEN:'That display username is taken.',INVALID_CREDENTIALS:'Email, username or password is incorrect.',
      TOO_MANY_ATTEMPTS:'Too many attempts. Please wait a minute.',
      INVALID_REGISTRATION:'Use a 3–24 character username with letters, numbers or underscores, and a password of at least 12 characters.'};
    throw new Error(messages[payload.code??'']??'Sign-in failed. Try again.');}
  const value=await response.json() as Session;
  if(!value.token || !value.profile?.publicId)throw new Error('The server did not create a session.');
  return value;
}

export function AuthProvider({children}:{children:ReactNode}){
  // Session tokens stay in memory; device-local files hold only non-secret drafts.
  const [session,setSession]=useState<Session|null>(null);
  const [demo,setDemo]=useState(()=>startsInDemo());
  const [guest,setGuest]=useState(()=>({signingIn:!!guestCode()&&!!base,message:''}));
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
        if(active){setSession(value);setGuest({signingIn:false,message:''});}
      }catch(error){
        if(active)setGuest({signingIn:false,message:error instanceof Error?error.message:'Could not open the guest link.'});
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
      setSession(await parseSession(response));setDemo(false);
    },
    login:async(emailOrUsername,password)=>{
      if(!base)throw new Error('Set EXPO_PUBLIC_API_URL to your CrownIQ server first.');
      const response=await fetch(`${base}/v1/auth/login`,{method:'POST',
        headers:{'content-type':'application/json'},body:JSON.stringify({login:emailOrUsername,password})});
      setSession(await parseSession(response));setDemo(false);
    },
    logout:async()=>{
      const token=session?.token;
      setSession(null);setDemo(false);
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
