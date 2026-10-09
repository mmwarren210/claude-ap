import assert from 'node:assert/strict';
import test from 'node:test';
import type { ScraperSource } from '../src/scrapers/scraped-line.js';
import { ScraperPuller } from '../src/scrapers/scraper-puller.js';

test('a source set to every 15 minutes pulls once per quarter hour, and the next pull time is the next quarter', async () => {
  let clock = new Date('2030-01-10T15:02:00Z');
  let pulls = 0;
  const source = { id: 'propline-prizepicks', actor: null, apps: ['prizepicks'],
    run: async () => { pulls++; return { rows: [], complete: false, usageUsd: 0 }; } } as unknown as ScraperSource;
  const puller = new ScraperPuller({} as never, { ingest: async () => ({ added: 0, moved: 0, removed: 0 }) } as never,
    { spent: async () => 0, remaining: async () => 100, record: async () => undefined, limitUsd: 100 } as never,
    [{ source, hoursEt: Array.from({ length: 24 }, (_, hour) => hour), everyMinutes: 15 }], { maxRunUsd: 5 }, () => clock);
  assert.equal(puller.nextPullAt(['propline-prizepicks'])?.toISOString(), '2030-01-10T15:15:00.000Z');
  await puller.tick(); await puller.tick();
  assert.equal(pulls, 1, 'one pull per quarter hour, however many ticks');
  clock = new Date('2030-01-10T15:16:00Z');
  await puller.tick();
  assert.equal(pulls, 2);
  assert.equal(puller.nextPullAt(['propline-prizepicks'])?.toISOString(), '2030-01-10T15:30:00.000Z');
});
