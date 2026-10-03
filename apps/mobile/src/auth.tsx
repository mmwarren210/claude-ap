import { createContext, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { demoRequest } from './demo/request';
import { apiBaseUrl } from './api-base';

const demoProfile:Profile={publicId:'demo',username:'Demo',email:null,plan:'DEMO'};

type Profile={publicId:string;username:string;email:string|null;plan:'FREE'|'SUSPENDED'|'DEMO'};
type Session={token:string;profile:Profile};
type AuthContext={profile:Profile|null;register:(username:string,email:string,password:string)=>Promise<void>;
  login:(emailOrUsername:string,password:string)=>Promise<void>;logout:()=>Promise<void>;
  request:(path:string,init?:RequestInit)=>Promise<Response>;setUsername:(username:string)=>void;
  /** True in demo mode: sample data, no account, no server calls. */
  demo:boolean;enterDemo:()=>void};
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
  const [demo,setDemo]=useState(false);
  const value=useMemo<AuthContext>(()=>({
    profile:session?.profile??(demo?demoProfile:null),demo,
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
  }),[session,demo]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useAuth(){const value=useContext(Context);
  if(!value)throw new Error('AuthProvider required');return value;}
