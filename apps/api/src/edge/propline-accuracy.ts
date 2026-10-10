import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { devigPower, fitMean, profileFor, varianceAt } from '@crowniq/edge';
import type { BookScore } from '@crowniq/edge';
import { normalizedName } from '../context/match.js';
import { leagueInfo } from '../scrapers/markets.js';
import type { PropLineClient } from '../scrapers/propline.js';
import { proplineLeague, proplineMarketKey } from '../scrapers/propline.js';

// Each book's accuracy on player props, from PropLine (owner, 2026-10-09): for every finished game, a book's closing main
// number and prices (the last before the start) give its implied mean, which is compared with the player's actual stat,
// in SDs of the stat. Those scores join the book-versus-book scores Edge already learns its book weights from, so Kalshi,
// Pinnacle and every other book are weighted by how they really did. Only pregame closing prices are used: PropLine's
// results carry the in-game price at the final whistle, which says nothing about accuracy.

export const ACCURACY_BOOKS = ['pinnacle', 'kalshi', 'draftkings', 'fanduel', 'hardrock', 'betmgm', 'betrivers', 'fanatics',
  'novig', 'prophetx', 'bovada'] as const;

type Outcome = { name?: string; description?: string; point?: number | null; price?: number | null; actual_value?: unknown };
type Body = { status?: string; bookmakers?: { key: string; markets?: { key: string; outcomes?: Outcome[] }[] }[] };

/** One finished game's book scores: closing main line (two-sided, fair over nearest 50%) against the actual stat. */
export function scoreGame(sportKey: string, results: Body, closing: Body): BookScore[] {
  if (results.status && results.status !== 'final') return [];
  const actual = new Map<string, number>();
  for (const book of results.bookmakers ?? []) for (const market of book.markets ?? []) for (const outcome of market.outcomes ?? [])
    if (outcome.description && typeof outcome.actual_value === 'number' && Number.isFinite(outcome.actual_value))
      actual.set(`${normalizedName(outcome.description)}|${market.key}`, outcome.actual_value);
  const sport = leagueInfo(proplineLeague(sportKey)).sport, scores: BookScore[] = [];
  for (const book of closing.bookmakers ?? []) for (const market of book.markets ?? []) {
    const pairs = new Map<string, { player: string; point: number; over?: number; under?: number }>();
    for (const outcome of market.outcomes ?? []) {
      const side = /^over$/i.test(outcome.name ?? '') ? 'over' : /^under$/i.test(outcome.name ?? '') ? 'under' : null;
      if (!side || !outcome.description || typeof outcome.point !== 'number' || typeof outcome.price !== 'number') continue;
      const key = `${normalizedName(outcome.description)}|${outcome.point}`;
      const pair = pairs.get(key) ?? { player: outcome.description, point: outcome.point };
      pair[side] = outcome.price > 0 ? 1 + outcome.price / 100 : 1 + 100 / -outcome.price; pairs.set(key, pair);
    }
    const main = new Map<string, { point: number; fair: number }>();
    for (const pair of pairs.values()) {
      if (!pair.over || !pair.under) continue;
      const fair = devigPower(pair.over, pair.under), player = normalizedName(pair.player), best = main.get(player);
      if (!best || Math.abs(fair - .5) < Math.abs(best.fair - .5)) main.set(player, { point: pair.point, fair });
    }
    const canonical = proplineMarketKey(sport, market.key), profile = profileFor(sport, canonical);
    for (const [player, line] of main) {
      const value = actual.get(`${player}|${market.key}`);
      if (value === undefined) continue;
      const mean = fitMean(profile.family, profile.variance, line.point, line.fair, profile.discrete);
      const sd = Math.sqrt(varianceAt(profile.variance, Math.max(mean, .5)));
      if (Number.isFinite(mean) && sd > 0) scores.push({ book: book.key, sport, market: canonical, errorSd: (mean - value) / sd });
    }
  }
  return scores;
}

interface Saved { scored: Record<string, string>; scores: (BookScore & { at: string })[] }

/** Collects book scores from finished games (the last 3 days each run), keeps 30 days of them, and summarizes accuracy. */
export class PropLineAccuracy {
  private data: Saved = { scored: {}, scores: [] };
  private loaded = false;
  private running = false;
  readonly stats = { games: 0, requests: 0, failed: 0, lastRunAt: null as string | null };
  constructor(private readonly client: PropLineClient, private readonly file: string | null,
    private readonly clock: () => Date = () => new Date()) {}

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file) return;
    try { this.data = { scored: {}, scores: [], ...JSON.parse(await readFile(this.file, 'utf8')) as Partial<Saved> }; } catch { /* first run */ }
  }

  private async save() {
    if (!this.file) return;
    const cutoff = this.clock().getTime() - 30 * 86_400_000;
    this.data.scores = this.data.scores.filter((score) => Date.parse(score.at) >= cutoff);
    for (const [id, at] of Object.entries(this.data.scored)) if (Date.parse(at) < cutoff) delete this.data.scored[id];
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(`${this.file}.tmp`, JSON.stringify(this.data));
    await rename(`${this.file}.tmp`, this.file);
  }

  /** Scores up to `limit` finished games not yet scored, across every sport PropLine lists props for. */
  async refresh(limit = 60): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      await this.load();
      const books = ACCURACY_BOOKS.join(','), sports = [...(await this.client.propMarkets([]).catch(() => new Map<string, string[]>())).keys()];
      let done = 0;
      for (const sportKey of sports) {
        if (done >= limit) break;
        const events = await this.client.get<{ id?: string | number; status?: string; completed?: boolean | null }[]>(
          `/v1/sports/${sportKey}/scores?daysFrom=3`).catch(() => []);
        this.stats.requests++;
        for (const event of Array.isArray(events) ? events : []) {
          if (done >= limit) break;
          const id = event.id === undefined ? null : String(event.id);
          if (!id || this.data.scored[id] || !(event.status === 'final' || event.completed === true)) continue;
          await yieldToLoop();
          try {
            const results = await this.client.get<Body>(`/v1/sports/${sportKey}/events/${id}/results?bookmakers=${books}`);
            const keys = [...new Set((results.bookmakers ?? []).flatMap((book) => (book.markets ?? [])
              .filter((market) => (market.outcomes ?? []).some((outcome) => outcome.description && typeof outcome.actual_value === 'number'))
              .map((market) => market.key)))];
            const closing: Body = { bookmakers: [] };
            for (let index = 0; index < keys.length; index += 3) {
              const part = await this.client.get<Body>(`/v1/sports/${sportKey}/events/${id}/odds/closing?markets=${keys.slice(index, index + 3).join(',')}&bookmakers=${books}`);
              closing.bookmakers!.push(...part.bookmakers ?? []);
            }
            this.stats.requests += 1 + Math.ceil(keys.length / 3);
            const at = this.clock().toISOString();
            for (const score of scoreGame(sportKey, results, closing)) this.data.scores.push({ ...score, at });
            this.data.scored[id] = at; this.stats.games++; done++;
          } catch { this.stats.failed++; }
        }
      }
      this.stats.lastRunAt = this.clock().toISOString();
      await this.save();
      return done;
    } finally { this.running = false; }
  }

  /** The stored scores (last 30 days), for the book-weight fit. */
  async scores(): Promise<BookScore[]> { await this.load(); return this.data.scores; }

  /** Each book's accuracy per sport: games' props scored and the mean squared error in SDs (lower is better; 1 ≈ no skill beyond the stat's own spread). */
  async report() {
    await this.load();
    const groups = new Map<string, { n: number; sse: number; bias: number }>();
    for (const score of this.data.scores) {
      const key = `${score.book}|${score.sport}`, group = groups.get(key) ?? { n: 0, sse: 0, bias: 0 };
      const error = Math.min(Math.abs(score.errorSd), 3) * Math.sign(score.errorSd);
      group.n++; group.sse += error * error; group.bias += error; groups.set(key, group);
    }
    return { ...this.stats, gamesScored: Object.keys(this.data.scored).length, books: Object.fromEntries([...groups]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, group]) => [key, { props: group.n, mse: Math.round(group.sse / group.n * 1000) / 1000, bias: Math.round(group.bias / group.n * 1000) / 1000 }])) };
  }
}
