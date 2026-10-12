import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { normalizedName } from './context/match.js';
import { statWords } from './tip-models.js';

// The free screenshot reader (owner, 2026-10-12: "2 as a back up"): when the AI reader is down or fails, the open-source text
// reader (Tesseract, run on the server with its English data bundled, so nothing is downloaded or paid for) pulls the words off
// the picture, and each player it finds is matched to his real board line by name, number and stat. The person confirms each
// pick with More or Less, and it goes in as a hand-added pick: GKR and Edge check it, no AI.

/** A board line a screenshot pick can become (the same shape the hand-pick search returns). */
export interface ReadableLine {
  readonly platform: string; readonly lineId: string; readonly playerName: string; readonly market: string; readonly line: number;
  readonly lineType: string;
}

type Worker = { recognize(image: Buffer): Promise<{ data: { text: string } }>; terminate(): Promise<unknown> };
let worker: Promise<Worker> | null = null;
/** One reader for the server's life, started on first use (about a second per screenshot). */
async function reader(): Promise<Worker> {
  worker ??= (async () => {
    const { createWorker } = await import('tesseract.js');
    const require = createRequire(import.meta.url);
    const langPath = join(dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0');
    return await createWorker('eng', 1, { langPath, cacheMethod: 'none', gzip: true }) as unknown as Worker;
  })().catch((error: unknown) => { worker = null; throw error; });
  return worker;
}

/** Stops the reader (server shutdown, tests); the next read starts a new one. */
export async function closeScreenshotReader(): Promise<void> {
  const current = worker; worker = null;
  if (current) await (await current.catch(() => null))?.terminate();
}

/** The text on a screenshot (base64 PNG, JPEG, WebP or GIF). */
export async function screenshotText(base64: string): Promise<string> {
  return (await (await reader()).recognize(Buffer.from(base64, 'base64'))).data.text;
}

const SIDES: readonly [RegExp, 'MORE' | 'LESS'][] = [[/\b(more|over|higher)\b/, 'MORE'], [/\b(less|under|lower)\b/, 'LESS']];
const words = (text: string) => ` ${normalizedName(text).replace(/[^a-z0-9.]+/g, ' ').trim()} `;

/**
 * The picks in a screenshot's text: every board player named in it, with the line whose number shows in the few lines under
 * the name (the closest stat wins; PrizePicks and regular lines first), and the side when the slip says it.
 */
export function picksInText<T extends ReadableLine>(text: string, lines: readonly T[]): { line: T; side: 'MORE' | 'LESS' | null }[] {
  const rows = text.split(/\r?\n/).map((row) => row.trim()).filter(Boolean), flat = rows.map(words);
  const byPlayer = new Map<string, T[]>();
  for (const line of lines) { const key = words(line.playerName); byPlayer.set(key, [...byPlayer.get(key) ?? [], line]); }
  // Where each player is named (first mention), in reading order.
  const hits: { row: number; key: string }[] = [];
  for (const key of byPlayer.keys()) {
    if (key.trim().split(' ').length < 2) continue;
    const row = flat.findIndex((item) => item.includes(key));
    if (row >= 0) hits.push({ row, key });
  }
  hits.sort((a, b) => a.row - b.row);
  const out: { line: T; side: 'MORE' | 'LESS' | null }[] = [];
  hits.forEach((hit, index) => {
    // The pick's own block: from the name to the next player's name, at most five lines.
    const end = Math.min(hit.row + 5, hits.find((other, at) => at > index && other.row > hit.row)?.row ?? rows.length);
    const block = rows.slice(hit.row, end).join(' ').replace(new RegExp(hit.key.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' ');
    const numbers = new Set((block.match(/\d+(?:\.\d+)?/g) ?? []).map(Number));
    const wanted = statWords(block);
    const order = (line: T) => (line.platform === 'prizepicks' ? 0 : 1) + (line.lineType === 'REGULAR' ? 0 : .5);
    const best = byPlayer.get(hit.key)!.filter((line) => numbers.has(line.line))
      .map((line) => ({ line, shared: [...statWords(line.market)].filter((word) => wanted.has(word)).length }))
      .sort((a, b) => b.shared - a.shared || order(a.line) - order(b.line))[0];
    if (!best) return;
    const lower = words(block);
    out.push({ line: best.line, side: SIDES.find(([pattern]) => pattern.test(lower))?.[1] ?? null });
  });
  return out;
}
