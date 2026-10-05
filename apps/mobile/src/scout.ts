// Scout reads (two research models, shown as Scout A and Scout B; the app never names the AI products): types and pure helpers, kept free of React so tests can load them.

/**
 * A Scout read (two research models): a pick on a line GKR can't score (kind scout), or a second opinion on a GKR Top
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
    .map((reason) => ({ text: unbrand(reason.text), url: reason.url, by: providerName(provider.provider) }))) }))
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
/** The name the app shows for the research read, so it never reads as plain "AI" or names an AI product. */
export const SCOUT = 'Scout';
/** Each research model's name on screen (owner, 2026-10-05: never the AI products' names). */
export const providerName = (provider: string) => provider === 'chatgpt' ? 'Scout A' : 'Scout B';
/** A model's own words with any AI product's name replaced by Scout (older reads, or a model naming itself). */
export const unbrand = (text: string) => text
  .replace(/\b(chat\s?gpt|gpt[-\s]?[\d.]+(?:[-\s]?(?:mini|nano|pro|turbo))?|gpt|openai|claude|anthropic|opus|sonnet|haiku|gemini)\b(['’]s)?/gi, 'Scout$2');
/** The first late-news warning either model gave, or null. */
export const lateNews = (read: AiRead | undefined) => {
  const news = read?.providers.find((item) => item.lateNews)?.lateNews;
  return news ? unbrand(news) : null;
};
export const agreementText = (read: AiRead) => read.agreement === 'BOTH' ? 'Both scouts agree'
  : read.agreement === 'ONE' ? 'One scout picked a side, the other passed' : read.agreement === 'SPLIT'
    ? 'The two scouts disagree' : `${providerName(read.providers[0]?.provider ?? '')} only`;
