// Scout reads (ChatGPT + Claude): types and pure helpers, kept free of React so tests can load them.

/**
 * A Scout read (ChatGPT + Claude): a pick on a line GKR can't score (kind scout), or a second opinion on a GKR Top
 * Pick (kind second). Its own score, never a GKR score.
 */
export type AiRead = {
  pick: 'MORE' | 'LESS' | 'PASS'; score: number | null; agreement: 'BOTH' | 'ONE' | 'SPLIT' | 'SINGLE'; researchedAt: string;
  kind?: 'scout' | 'second'; gkr?: { direction: 'MORE' | 'LESS'; score: number | null } | null;
  providers: { provider: 'chatgpt' | 'claude'; pick: string; confidence: number; summary: string;
    reasons: { text: string; url: string | null; kind?: EvidenceKind }[]; lateNews?: string }[];
};
export type EvidenceKind = 'matchup' | 'recent_form' | 'history' | 'injury_news' | 'role' | 'market' | 'other';
/** The order and names evidence is filed under on the player page. */
export const evidenceGroups: readonly { kind: EvidenceKind; label: string }[] = [
  { kind: 'matchup', label: 'Matchup' }, { kind: 'recent_form', label: 'Recent form' }, { kind: 'history', label: 'History' },
  { kind: 'role', label: 'Role and usage' }, { kind: 'injury_news', label: 'Injury and news' },
  { kind: 'market', label: 'Market' }, { kind: 'other', label: 'Other' }];
/** Both models' reasons filed by the evidence they are, each tagged with who found it. */
export function scoutEvidence(read: AiRead): { label: string; items: { text: string; url: string | null; by: string }[] }[] {
  return evidenceGroups.map(({ kind, label }) => ({ label, items: read.providers.flatMap((provider) => provider.reasons
    .filter((reason) => (reason.kind ?? 'other') === kind)
    .map((reason) => ({ text: reason.text, url: reason.url, by: providerName(provider.provider) }))) }))
    .filter((group) => group.items.length);
}
/** A Scout pick (not a second opinion) that names a side, so the line is a play. */
export const aiPlay = (read: AiRead | undefined) => !!read && read.kind !== 'second' && read.pick !== 'PASS' &&
  read.score !== null && read.score >= 55;
export type ScoutVerdict = 'AGREES' | 'DISAGREES' | 'NO_EDGE';
/** Scout's second opinion against GKR's current pick on the same line; null when there is none. */
export function scoutVerdict(read: AiRead | undefined, gkrDirection: string | undefined): ScoutVerdict | null {
  if (!read || read.kind !== 'second' || (gkrDirection !== 'MORE' && gkrDirection !== 'LESS')) return null;
  return read.pick === 'PASS' ? 'NO_EDGE' : read.pick === gkrDirection ? 'AGREES' : 'DISAGREES';
}
export const verdictText: Readonly<Record<ScoutVerdict, string>> = { AGREES: 'Scout agrees', DISAGREES: 'Scout disagrees',
  NO_EDGE: 'Scout sees no edge' };
/** The first late-news warning either model gave, or null. */
export const lateNews = (read: AiRead | undefined) => read?.providers.find((item) => item.lateNews)?.lateNews ?? null;
/** The name the app shows for the ChatGPT + Claude read, so it never reads as plain "AI". */
export const SCOUT = 'Scout';
export const providerName = (provider: string) => provider === 'chatgpt' ? 'ChatGPT' : 'Claude';
export const agreementText = (read: AiRead) => read.agreement === 'BOTH' ? 'ChatGPT and Claude agree'
  : read.agreement === 'ONE' ? 'One scout picked a side, the other passed' : read.agreement === 'SPLIT'
    ? 'ChatGPT and Claude disagree' : `${providerName(read.providers[0]?.provider ?? '')} only`;
