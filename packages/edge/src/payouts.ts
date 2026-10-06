import type { EdgeEntry } from '@crowniq/contracts';

export interface EntryDefinition {
  readonly type: 'POWER' | 'FLEX';
  readonly size: number;
  /** payouts[k] = multiple of the stake returned when exactly k legs hit. */
  readonly payouts: Readonly<Record<number, number>>;
}

/** Default standard-line PrizePicks payout tables. PrizePicks changes these by market and
 * promotion, so they are configurable (EDGE_PAYOUTS) and must be checked in the app. */
export const defaultEntries: readonly EntryDefinition[] = [
  { type: 'POWER', size: 2, payouts: { 2: 3 } },
  { type: 'POWER', size: 3, payouts: { 3: 6 } },
  { type: 'POWER', size: 4, payouts: { 4: 10 } },
  { type: 'POWER', size: 5, payouts: { 5: 20 } },
  { type: 'POWER', size: 6, payouts: { 6: 37.5 } },
  { type: 'FLEX', size: 3, payouts: { 3: 3, 2: 1 } },
  { type: 'FLEX', size: 4, payouts: { 4: 6, 3: 1.5 } },
  { type: 'FLEX', size: 5, payouts: { 5: 10, 4: 2, 3: .4 } },
  { type: 'FLEX', size: 6, payouts: { 6: 25, 5: 2, 4: .4 } },
];

/** Entries from an app's payout tables in the shape the app keeps them ({ POWER: { size: { hits: pays } } }), so Edge
 * uses the same owner-checked charts as the rest of the app. */
export function entriesFromTables(tables: Readonly<Partial<Record<'POWER' | 'FLEX', Readonly<Record<string,
  Readonly<Record<string, number>>>>>>>): EntryDefinition[] {
  const out: EntryDefinition[] = [];
  for (const type of ['POWER', 'FLEX'] as const) for (const [size, table] of Object.entries(tables[type] ?? {})) {
    const payouts: Record<number, number> = {};
    for (const [hits, pays] of Object.entries(table)) payouts[Number(hits)] = pays;
    if (Object.keys(payouts).length) out.push({ type, size: Number(size), payouts });
  }
  return out;
}

/** Exact distribution of the number of hits for independent legs (Poisson binomial). */
export function hitDistribution(probabilities: readonly number[]): number[] {
  let dist = [1];
  for (const p of probabilities) {
    const next = new Array(dist.length + 1).fill(0);
    dist.forEach((mass, hits) => { next[hits] += mass * (1 - p); next[hits + 1] += mass * p; });
    dist = next;
  }
  return dist;
}

export function expectedReturn(entry: EntryDefinition, probabilities: readonly number[]): number {
  return hitDistribution(probabilities).reduce((sum, mass, hits) => sum + mass * (entry.payouts[hits] ?? 0), 0);
}

/** Per-leg probability at which an entry of identical legs exactly breaks even. */
export function breakEven(entry: EntryDefinition): number {
  let lo = 0, hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (expectedReturn(entry, new Array(entry.size).fill(mid)) < 1) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

export function describeEntry(entry: EntryDefinition): EdgeEntry {
  return { type: entry.type, size: entry.size, breakEven: breakEven(entry),
    payouts: Object.fromEntries(Object.entries(entry.payouts).map(([k, v]) => [String(k), v])) };
}

/** Parse EDGE_PAYOUTS, e.g. "POWER2=3;POWER3=6;FLEX6=25/2/0.4" (flex lists payouts from all-hit down). */
export function parseEntries(spec: string | undefined): EntryDefinition[] {
  if (!spec?.trim()) return [...defaultEntries];
  return spec.split(/[;,]/).map((item) => item.trim()).filter(Boolean).map((item) => {
    const match = /^(POWER|FLEX)([2-6])=([\d.]+(?:\/[\d.]+)*)$/i.exec(item);
    if (!match) throw new Error('INVALID_EDGE_PAYOUTS');
    const type = match[1].toUpperCase() as 'POWER' | 'FLEX', size = Number(match[2]);
    const values = match[3].split('/').map(Number);
    if (values.some((value) => !Number.isFinite(value) || value < 0) ||
      (type === 'POWER' && values.length !== 1) || values.length > size) throw new Error('INVALID_EDGE_PAYOUTS');
    const payouts: Record<number, number> = {};
    values.forEach((value, index) => { payouts[size - index] = value; });
    return { type, size, payouts };
  });
}
