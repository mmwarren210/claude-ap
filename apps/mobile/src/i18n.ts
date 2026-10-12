import { useSyncExternalStore } from 'react';
import { es } from './es';

// The app's language (owner, 2026-10-12): English or Spanish, chosen in More › Language. A phone set to Spanish starts in
// Spanish, with a one-time note that it can be changed. The choice is kept on this device and on the account.

export type Language = 'en' | 'es';
const KEY = 'crowniq-language-v1';
type Saved = { language: Language; prompted?: boolean };

/** The phone's language, from the browser or the system (Spanish when it starts with "es"). */
export function deviceLanguage(): Language {
  const tags: string[] = [];
  try { if (typeof navigator !== 'undefined') tags.push(...(navigator.languages ?? []), navigator.language ?? ''); } catch { /* none */ }
  try { tags.push(Intl.DateTimeFormat().resolvedOptions().locale); } catch { /* none */ }
  return tags.find(Boolean)?.toLowerCase().startsWith('es') ? 'es' : 'en';
}

function readSaved(): Saved | null {
  try {
    if (typeof localStorage !== 'undefined') {
      const value = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Saved | null;
      return value && (value.language === 'en' || value.language === 'es') ? value : null;
    }
  } catch { /* storage unavailable */ }
  return null;
}
function writeSaved(value: Saved) {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

const saved = readSaved();
let current: Language = saved?.language ?? deviceLanguage();
/** Whether this device's language was chosen by the person (not just detected). */
let chosen = !!saved && saved.prompted !== false;
/** A phone in Spanish that hasn't seen the "you can change this" note yet. */
let needsPrompt = !saved && current === 'es';
const listeners = new Set<() => void>();
const emit = () => { cache.clear(); for (const listener of listeners) listener(); };

export const getLanguage = () => current;
export const languageWasChosen = () => chosen;
export const languagePromptNeeded = () => needsPrompt;

/** Sets the language (the person's choice): saved on this device, and the app re-renders. */
export function setLanguage(language: Language) {
  chosen = true; needsPrompt = false;
  writeSaved({ language, prompted: true });
  if (language !== current) { current = language; emit(); }
  else emit();
}
/** The first-run note was seen: keep the detected language and don't show the note again. */
export function dismissLanguagePrompt() { needsPrompt = false; chosen = true; writeSaved({ language: current, prompted: true }); emit(); }

function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
/** The current language; a component using it re-renders when it changes. */
// The web app is pre-rendered in English, so the first paint (hydration) reads English to match it, then the chosen
// language takes over.
const serverLanguage = (): Language => 'en';
export function useLanguage(): Language { return useSyncExternalStore(subscribe, getLanguage, serverLanguage); }
/** Whether the first-run note should show (re-renders when it's dismissed; never during the first paint). */
export function useLanguagePrompt(): boolean { return useSyncExternalStore(subscribe, languagePromptNeeded, () => false); }

// Lines with values in them ("Top {0}", "{0} of {1} left today") match by pattern; each {n} takes the matching value.
type Pattern = { regex: RegExp; english: string; spanish: string };
const escape = (value: string) => value.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
const patterns: Pattern[] = Object.entries(es).filter(([english]) => /\{\d+\}/.test(english) && english.replace(/\{\d+\}/g, '').trim().length >= 2)
  .map(([english, spanish]) => ({ english, spanish,
    regex: new RegExp('^' + escape(english).replace(/\\?\{(\d+)\\?\}/g, '(?<v$1>[\\s\\S]*?)') + '$') }))
  // Longer templates first, so the most specific one wins.
  .sort((a, b) => b.english.replace(/\{\d+\}/g, '').length - a.english.replace(/\{\d+\}/g, '').length);
const cache = new Map<string, string>();

const DAYS: Readonly<Record<string, string>> = { Mon: 'lun', Tue: 'mar', Wed: 'mié', Thu: 'jue', Fri: 'vie', Sat: 'sáb', Sun: 'dom' };
const MONTHS: Readonly<Record<string, string>> = { Jan: 'ene', Feb: 'feb', Mar: 'mar', Apr: 'abr', May: 'may', Jun: 'jun', Jul: 'jul',
  Aug: 'ago', Sep: 'sep', Oct: 'oct', Nov: 'nov', Dec: 'dic' };
/** A date or game time the app wrote in English ("Thu, Jan 15", "Wed 3:00 AM", "Oct 12, 7:05 PM") in Spanish; null otherwise. */
function dateInSpanish(text: string): string | null {
  const match = /^(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun),? ?)?(?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}),? ?)?(\d{1,2}:\d{2} ?[AP]M)?$/.exec(text);
  if (!match || (!match[1] && !match[2])) return null;
  const parts = [match[1] ? DAYS[match[1]] : null, match[2] ? `${match[3]} ${MONTHS[match[2]]}` : null, match[4] ?? null].filter(Boolean);
  return match[1] && match[2] ? `${parts[0]}, ${parts.slice(1).join(' ')}` : parts.join(' ');
}

/** English text in the current language (unchanged in English, or when there's no Spanish for it). */
export function t(text: string, language: Language = current, depth = 0): string {
  if (language === 'en' || !text) return text;
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const lead = /^\s*/.exec(text)![0], trail = /\s*$/.exec(text)![0], core = text.trim();
  let out: string | undefined = es[core];
  if (out === undefined && /[A-Za-z]/.test(core)) {
    for (const pattern of patterns) {
      const match = pattern.regex.exec(core);
      if (!match) continue;
      // A value that is itself a phrase ("Hand-picked") is translated too; names and numbers pass through.
      out = pattern.spanish.replace(/\{(\d+)\}/g, (_, n: string) => { const value = match.groups?.[`v${n}`] ?? ''; return depth < 2 ? t(value, language, depth + 1) : value; });
      break;
    }
  }
  if (out === undefined) out = dateInSpanish(core) ?? undefined;
  const result = out === undefined ? text : lead + out + trail;
  if (cache.size > 5000) cache.clear();
  cache.set(text, result);
  return result;
}
