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
export async function loadBoard():Promise<BoardResponse|null> {
  const result=boardResponseSchema.safeParse(await read('board'));
  return result.success ? result.data : null;
}
export async function saveBoard(board:BoardResponse):Promise<void> { await write('board',board); }
