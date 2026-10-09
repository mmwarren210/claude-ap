import { File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import { boardResponseSchema } from '@crowniq/contracts';
import type { BoardResponse } from '@crowniq/contracts';
import { parseDraft, profileDraftKey } from './draft-codec';
import type { Draft } from './draft-codec';
const filename=(key:string)=>`crowniq-${key}-v1.json`;
async function read(key:string):Promise<unknown> {
  try {
    if (Platform.OS === 'web') {
      if (typeof localStorage === 'undefined') return null;
      return JSON.parse(localStorage.getItem(filename(key)) ?? 'null');
    }
    const file=new File(Paths.document,filename(key));
    return file.exists ? JSON.parse(await file.text()) : null;
  } catch { return null; }
}
async function write(key:string,value:unknown):Promise<void> {
  if (Platform.OS === 'web') {
    if (typeof localStorage !== 'undefined') localStorage.setItem(filename(key),JSON.stringify(value));
    return;
  }
  const file=new File(Paths.document,filename(key));
  file.create({overwrite:true});
  file.write(JSON.stringify(value));
}
export async function loadDraft(profileId:string):Promise<Draft> {
  return parseDraft(await read(profileDraftKey(profileId)));
}
export async function saveDraft(profileId:string,draft:Draft):Promise<void> {
  await write(profileDraftKey(profileId),draft);
}
// The saved Board list is too big for the browser's ~5 MB localStorage, so the web app keeps it in IndexedDB.
function idb():Promise<IDBDatabase|null>{
  if(typeof indexedDB==='undefined')return Promise.resolve(null);
  return new Promise((resolve)=>{
    const open=indexedDB.open('crowniq',1);
    open.onupgradeneeded=()=>{open.result.createObjectStore('kv');};
    open.onsuccess=()=>resolve(open.result);open.onerror=()=>resolve(null);
  });
}
async function readBig(key:string):Promise<unknown>{
  if(Platform.OS!=='web')return read(key);
  const db=await idb();if(!db)return null;
  return new Promise((resolve)=>{const get=db.transaction('kv').objectStore('kv').get(filename(key));
    get.onsuccess=()=>resolve(get.result??null);get.onerror=()=>resolve(null);});
}
async function writeBig(key:string,value:unknown):Promise<void>{
  if(Platform.OS!=='web')return write(key,value);
  const db=await idb();if(!db)return;
  // An old copy in localStorage (from before IndexedDB) is dropped so it stops using the quota.
  try{localStorage.removeItem(filename(key));}catch{ /* not there */ }
  await new Promise<void>((resolve,reject)=>{const tx=db.transaction('kv','readwrite');tx.objectStore('kv').put(value,filename(key));
    tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});
}
/** The last Board list this device got, with its tag (so the server can answer "nothing new"). */
export async function loadBoard():Promise<{board:BoardResponse;etag:string|null}|null> {
  const saved=await readBig('board') as {board?:unknown;etag?:unknown}|null;
  // Older saves are the bare board, with no tag.
  const result=boardResponseSchema.safeParse(saved&&typeof saved==='object'&&'board' in saved?saved.board:saved);
  if(!result.success)return null;
  return {board:result.data,etag:saved&&typeof saved==='object'&&typeof saved.etag==='string'?saved.etag:null};
}
export async function saveBoard(board:BoardResponse,etag:string|null=null):Promise<void> { await writeBig('board',{board,etag}); }

/**
 * The signed-in session, kept in this browser so the web app stays signed in until Log Out (owner choice). The server
 * ends it after 30 days regardless; a stale token is rejected and cleared. Native builds keep it in memory only until
 * a secure native store is added (see docs/PROFILE_SIGNIN.md).
 */
export async function loadSession():Promise<{token:string}|null> {
  if (Platform.OS !== 'web') return null;
  const value=await read('session') as {token?:unknown}|null;
  return typeof value?.token==='string'&&value.token.length>=32?{token:value.token}:null;
}
export async function saveSession(token:string):Promise<void> { if (Platform.OS === 'web') await write('session',{token}); }
export async function clearSession():Promise<void> { if (Platform.OS === 'web') await write('session',null); }
