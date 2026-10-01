import { createPublicKey, verify } from 'node:crypto';

export type ProviderName='GOOGLE'|'APPLE';
type Claims={iss?:string;aud?:string;sub?:string;exp?:number;iat?:number;
  nonce?:string;email?:string;email_verified?:boolean|string};
type Key={kty:string;use?:string;alg?:string;kid?:string;n?:string;e?:string};
const providers={
  GOOGLE:{issuer:'https://accounts.google.com',keys:'https://www.googleapis.com/oauth2/v3/certs'},
  APPLE:{issuer:'https://appleid.apple.com',keys:'https://appleid.apple.com/auth/keys'},
} as const;

/** Fixed, provider-owned JWKS URLs; the JWT never supplies a key URL. */
export class ProviderIdentityVerifier {
  private keys=new Map<ProviderName,{expires:number;keys:Key[]}>();
  constructor(private readonly audiences:Record<ProviderName,string[]>,
    private readonly fetchKeys:typeof fetch=fetch,private readonly clock:()=>Date=()=>new Date()){}
  async verify(provider:ProviderName,idToken:string,nonce:string){
    const allowed=this.audiences[provider];
    if(!allowed.length)throw new Error('PROVIDER_UNCONFIGURED');
    const parts=idToken.split('.');
    if(parts.length!==3 || idToken.length>16000)throw new Error('INVALID_ID_TOKEN');
    let header:{alg?:string;kid?:string},claims:Claims;
    try {header=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));
      claims=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));}
    catch {throw new Error('INVALID_ID_TOKEN');}
    const now=Math.floor(this.clock().getTime()/1000),issuer=providers[provider].issuer;
    if(header.alg!=='RS256'||!header.kid||claims.iss!==issuer||
      !claims.aud||!allowed.includes(claims.aud)||!claims.sub||!claims.exp||
      claims.exp<=now||claims.exp>now+86400||!claims.iat||claims.iat>now+60||
      claims.iat<now-86400||claims.nonce!==nonce)
      throw new Error('INVALID_ID_TOKEN');
    let cached=this.keys.get(provider);
    if(!cached || cached.expires<=this.clock().getTime() ||
      !cached.keys.some((item)=>item.kid===header.kid)){
      const response=await this.fetchKeys(providers[provider].keys);
      if(!response.ok)throw new Error('PROVIDER_KEYS_UNAVAILABLE');
      const payload=await response.json() as {keys?:Key[]};
      if(!Array.isArray(payload.keys)||payload.keys.length>100)
        throw new Error('PROVIDER_KEYS_UNAVAILABLE');
      cached={keys:payload.keys,expires:this.clock().getTime()+600_000};this.keys.set(provider,cached);
    }
    const key=cached.keys.find((item)=>item.kid===header.kid && item.kty==='RSA' &&
      (!item.use||item.use==='sig')&&(!item.alg||item.alg==='RS256')&&item.n&&item.e);
    if(!key)throw new Error('INVALID_ID_TOKEN');
    let valid=false;
    try {valid=verify('RSA-SHA256',Buffer.from(`${parts[0]}.${parts[1]}`),
      createPublicKey({key:{kty:'RSA',n:key.n!,e:key.e!},format:'jwk'}),
      Buffer.from(parts[2],'base64url'));}catch{throw new Error('INVALID_ID_TOKEN');}
    if(!valid)throw new Error('INVALID_ID_TOKEN');
    const emailVerified=claims.email_verified===true||claims.email_verified==='true';
    if(provider==='GOOGLE' && !emailVerified)
      throw new Error('UNVERIFIED_PROVIDER_EMAIL');
    return {subject:claims.sub,email:emailVerified?claims.email??null:null};
  }
}
