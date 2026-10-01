import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { nflPassingResultSchema, savedSelectionSchema } from '@crowniq/contracts';
import type { NflPassingResult, SavedSelection } from '@crowniq/contracts';
import { gradeNflPassingSelection } from '@crowniq/engine';
import { z } from 'zod';

const fileSchema = z.object({ version: z.literal(1), selections: z.array(savedSelectionSchema) });

export interface SelectionLedger {
  list(): Promise<SavedSelection[]>;
  save(selection: SavedSelection): Promise<void>;
  grade(results: readonly NflPassingResult[], now: Date): Promise<{ graded: number; unmatched: number }>;
}

/** Single-process atomic JSON ledger. Mount persistent storage in deployment. */
export class JsonSelectionLedger implements SelectionLedger {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) {}

  private async read(): Promise<SavedSelection[]> {
    try { return fileSchema.parse(JSON.parse(await readFile(this.path, 'utf8'))).selections; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private async write(selections: readonly SavedSelection[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, selections }), { mode: 0o600 });
      await rename(temporary, this.path);
    } finally { await rm(temporary, { force: true }); }
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.chain.then(task);
    this.chain = operation.catch(() => undefined);
    return operation;
  }

  list(): Promise<SavedSelection[]> { return this.exclusive(() => this.read()); }

  save(selection: SavedSelection): Promise<void> {
    return this.exclusive(async () => {
      const parsed = savedSelectionSchema.parse(selection);
      if (parsed.grade !== 'PENDING') throw new Error('ONLY_PENDING_CAN_BE_SAVED');
      const existing = await this.read();
      if (existing.some((item) => item.id === parsed.id || item.line.id === parsed.line.id &&
        item.direction === parsed.direction && item.grade === 'PENDING')) {
        throw new Error('DUPLICATE_SELECTION');
      }
      await this.write([...existing, parsed]);
    });
  }

  grade(results: readonly NflPassingResult[], now: Date): Promise<{ graded: number; unmatched: number }> {
    return this.exclusive(async () => {
      const parsed = results.map((item) => nflPassingResultSchema.parse(item));
      const keys = parsed.map((item) => JSON.stringify([item.eventId, item.playerId, item.market]));
      if (new Set(keys).size !== keys.length) throw new Error('DUPLICATE_RESULTS');
      const byKey = new Map(keys.map((key, index) => [key, parsed[index]]));
      let graded = 0;
      const found = new Set<string>();
      const next = (await this.read()).map((selection) => {
        const key = JSON.stringify([selection.line.eventId, selection.line.playerId, selection.line.market]);
        const result = byKey.get(key);
        if (!result || selection.grade !== 'PENDING') return selection;
        found.add(key);
        const updated = gradeNflPassingSelection(selection, result, now);
        graded++;
        return updated;
      });
      if (graded) await this.write(next);
      return { graded, unmatched: parsed.length - found.size };
    });
  }
}

export function summarizeNflPilot(selections: readonly SavedSelection[]) {
  const groups = new Map<string, { sport: string; market: string; lineType: string;
    modelVersion: string; scoreBand: string; win: number; loss: number; push: number;
    dnpVoid: number; pending: number }>();
  for (const selection of selections) {
    const { sport, market, lineType } = selection.line;
    const key = JSON.stringify([sport, market, lineType, selection.modelVersion, selection.scoreBand]);
    const group = groups.get(key) ?? { sport, market, lineType,
      modelVersion: selection.modelVersion, scoreBand: selection.scoreBand ?? 'UNKNOWN',
      win: 0, loss: 0, push: 0, dnpVoid: 0, pending: 0 };
    if (selection.grade === 'WIN') group.win++;
    else if (selection.grade === 'LOSS') group.loss++;
    else if (selection.grade === 'PUSH') group.push++;
    else if (selection.grade === 'DNP_VOID') group.dnpVoid++;
    else group.pending++;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.sport.localeCompare(b.sport) ||
    a.market.localeCompare(b.market) || a.modelVersion.localeCompare(b.modelVersion));
}
