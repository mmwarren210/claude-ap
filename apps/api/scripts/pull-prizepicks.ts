import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { boardSchema } from '@crowniq/contracts';
import { FullPrizePicksProvider } from '../src/full-prizepicks-provider.js';
import { classifyPrizePicksLineTypes } from '../src/prizepicks-line-types.js';

const key = process.env.THE_ODDS_API_KEY;
if (!key) throw new Error('THE_ODDS_API_KEY_REQUIRED');

const provider = new FullPrizePicksProvider({
  apiKey: key,
  maxEvents: process.env.THE_ODDS_API_MAX_EVENTS
    ? Number(process.env.THE_ODDS_API_MAX_EVENTS) : undefined,
  maxCreditsPerRefresh: process.env.THE_ODDS_API_MAX_CREDITS_PER_REFRESH
    ? Number(process.env.THE_ODDS_API_MAX_CREDITS_PER_REFRESH) : undefined,
});

try {
  const fetchedAt = new Date().toISOString();
  const raw = await provider.fetchPrizePicksLines();
  const board = boardSchema.parse({ provider: 'prizepicks', fetchedAt,
    lines: classifyPrizePicksLineTypes(raw.map((selection) => provider.normalize(selection, fetchedAt))) });
  const coverage = provider.getHealth().coverage;
  if (!coverage?.complete) throw new Error('ODDS_API_BOARD_INCOMPLETE');
  const output = resolve(process.env.CROWNIQ_PULL_OUTPUT_DIR ?? 'tmp/prizepicks-pull');
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, 'board.json'), JSON.stringify(board, null, 2) + '\n');
  await writeFile(resolve(output, 'coverage.json'), JSON.stringify(coverage, null, 2) + '\n');
  // GitHub Actions logs contain only the summary, never the credential or URLs.
  console.log(JSON.stringify({ complete: coverage.complete, fetchedAt,
    sportsScanned: coverage.sportsScanned, eventsDiscovered: coverage.eventsDiscovered,
    eventsWithPrizePicks: coverage.eventsWithPrizePicks,
    marketsDiscovered: coverage.marketsDiscovered, selections: board.lines.length,
    creditsSpent: coverage.creditsSpent, creditsRemaining: coverage.creditsRemaining,
    sportKeysWithLines: coverage.sportKeysWithLines }));
} catch (error) {
  const message = error instanceof Error ? error.message : 'ODDS_API_PULL_FAILED';
  console.error(JSON.stringify({ error: /^ODDS_API_[A-Z0-9_]+$/.test(message)
    ? message : 'ODDS_API_PULL_FAILED', coverage: provider.getHealth().coverage }));
  process.exitCode = 1;
}
