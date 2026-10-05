import type { HistoryArchive } from '../history-archive.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { sameLineKey } from './markets.js';
import type { DfsApp, ScrapedLine } from './scraped-line.js';

export interface StoredLine extends ScrapedLine {
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  /** Sources (scrapers or feeds) that reported this exact line; two or more = confirmed. */
  readonly confirmedBy: readonly string[];
  /** The number before the app last moved it, when it moved. */
  readonly previousLine: number | null;
  /** Set when a complete pull of this app no longer listed the line. */
  readonly removedAt: string | null;
}

export interface IngestReport {
  readonly received: number;
  readonly added: number;
  readonly moved: number;
  readonly unchanged: number;
  readonly frozen: number;
  readonly removed: number;
}

const key = (line: Pick<ScrapedLine, 'app' | 'appLineId'>) => `${line.app}:${line.appLineId}`;
/** Best information wins: each field keeps the newest value any source supplied, never a blank over a value. */
function fill<T extends object>(existing: T, update: Partial<T>): T {
  const merged = { ...existing };
  for (const [field, value] of Object.entries(update))
    if (value !== null && value !== undefined) (merged as Record<string, unknown>)[field] = value;
  return merged;
}
const sameLine = sameLineKey;

/**
 * Durable store of scraped lines, one record per app line. It applies the board rules:
 * a line already held is not copied again, a moved number replaces the old one, a second source
 * reporting the same line confirms it, and games that have started are frozen and never updated.
 */
export class ScrapedLineStore {
  private lines = new Map<string, StoredLine>();
  private loaded = false;
  constructor(private readonly file: string | null, private readonly clock: () => Date = () => new Date(),
    /** New lines and number moves also go to CrownIQ's own archive, which keeps them after this store lets them go. */
    private readonly archive: HistoryArchive | null = null) {}

  private async load() {
    if (this.loaded || !this.file) { this.loaded = true; return; }
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8')) as { lines?: StoredLine[] };
      for (const line of saved.lines ?? []) this.lines.set(key(line), line);
    } catch { /* first run */ }
    this.loaded = true;
  }

  private async save() {
    if (!this.file) return;
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ lines: [...this.lines.values()] }));
    await rename(temporary, this.file);
  }

  /**
   * Add one pull's lines from `source`. When `complete` (the pull was not cut short), lines of the pulled apps that this
   * source listed before and no longer lists, on games not yet started, lose this source; a line is marked removed only
   * when no source lists it any more. (One source covering part of an app, like The Odds API's share of PrizePicks, never
   * clears what the other sources found.)
   */
  async ingest(source: string, lines: readonly ScrapedLine[], options: { complete: boolean; apps: readonly DfsApp[] }): Promise<IngestReport> {
    await this.load();
    const now = this.clock(), at = now.toISOString(), started = (line: ScrapedLine) => Date.parse(line.startTime) <= now.getTime();
    let added = 0, moved = 0, unchanged = 0, frozen = 0, removed = 0;
    const seen = new Set<string>();
    const changed: { line: ScrapedLine; previousLine: number | null }[] = [];
    // Lines other sources already hold, to confirm across sources.
    const bySame = new Map<string, StoredLine[]>();
    for (const line of this.lines.values()) bySame.set(sameLine(line), [...bySame.get(sameLine(line)) ?? [], line]);
    for (const line of lines) {
      const id = key(line); seen.add(id);
      const existing = this.lines.get(id);
      if (existing && started(existing)) { frozen++; continue; }
      if (started(line)) { frozen++; continue; }
      const others = (bySame.get(sameLine(line)) ?? []).filter((item) => key(item) !== id).flatMap((item) => item.confirmedBy);
      if (!existing) {
        this.lines.set(id, { ...line, firstSeenAt: at, lastSeenAt: at, previousLine: null, removedAt: null,
          confirmedBy: [...new Set([source, ...others])] });
        changed.push({ line, previousLine: null });
        added++; continue;
      }
      const numberMoved = existing.line !== line.line;
      if (numberMoved) { moved++; changed.push({ line, previousLine: existing.line }); } else unchanged++;
      this.lines.set(id, { ...fill(existing, line), lastSeenAt: at, removedAt: null,
        previousLine: numberMoved ? existing.line : existing.previousLine,
        // A moved number needs confirming again; otherwise this source adds to the confirmations.
        confirmedBy: numberMoved ? [...new Set([source, ...others])] : [...new Set([...existing.confirmedBy, source, ...others])] });
    }
    if (options.complete) {
      for (const [id, line] of this.lines) {
        if (seen.has(id) || line.removedAt || started(line) || !options.apps.includes(line.app) ||
          !line.confirmedBy.includes(source)) continue;
        const confirmedBy = line.confirmedBy.filter((item) => item !== source);
        if (confirmedBy.length) { this.lines.set(id, { ...line, confirmedBy }); continue; }
        this.lines.set(id, { ...line, confirmedBy, removedAt: at }); removed++;
      }
    }
    // Every new line and every move goes to CrownIQ's own archive, which keeps them after the store lets them go.
    void this.archive?.append('lines', changed.map(({ line, previousLine }) => ({
      key: `${line.app}:${line.appLineId}:${line.line}`,
      record: { source, app: line.app, appLineId: line.appLineId, league: line.league, gameId: line.gameId, player: line.player,
        team: line.team, stat: line.stat, line: line.line, previousLine, tier: line.tier, startTime: line.startTime, seenAt: at } })));
    // Keep two days of finished games for reference, then let them go.
    for (const [id, line] of this.lines) if (Date.parse(line.startTime) < now.getTime() - 2 * 86_400_000) this.lines.delete(id);
    await this.save();
    return { received: lines.length, added, moved, unchanged, frozen, removed };
  }

  /** Puts back lines marked removed at or after `since` on games not yet started (undoing a bad pull). */
  async restoreRemoved(since: Date): Promise<number> {
    await this.load();
    const now = this.clock().getTime();
    let restored = 0;
    for (const [id, line] of this.lines) {
      if (!line.removedAt || Date.parse(line.removedAt) < since.getTime() || Date.parse(line.startTime) <= now) continue;
      this.lines.set(id, { ...line, removedAt: null }); restored++;
    }
    if (restored) await this.save();
    return restored;
  }

  /** Lines still on offer for games that have not started. */
  async active(app?: DfsApp): Promise<StoredLine[]> {
    await this.load();
    const now = this.clock().getTime();
    return [...this.lines.values()].filter((line) => !line.removedAt && Date.parse(line.startTime) > now &&
      (!app || line.app === app));
  }
}
