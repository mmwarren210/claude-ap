import 'dotenv/config';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { boardSchema } from '@crowniq/contracts';
import { researchTargetsFor } from '@crowniq/engine';
import { WebResearchAdapter, WebResearchCatalog } from '../src/web-research.js';

const [, , boardPath, outputPath] = process.argv;
const apiKey = process.env.OPENAI_API_KEY ?? process.env.AI_API_KEY;
if (!boardPath || !outputPath || !apiKey) {
  throw new Error('Usage: OPENAI_API_KEY=... npm run run:research -- BOARD_JSON OUTPUT_JSON');
}
const board = boardSchema.parse(JSON.parse(await readFile(boardPath, 'utf8')));
const catalog = new WebResearchCatalog(process.env.CROWNIQ_RESEARCH_CATALOG_FILE ??
  'tmp/research-catalog.json');
const adapter = new WebResearchAdapter({ apiKey, catalog,
  model: process.env.WEB_RESEARCH_MODEL ?? 'gpt-5.4-mini',
  maxSearches: Number(process.env.WEB_RESEARCH_MAX_SEARCHES ?? '1500'),
  concurrency: Number(process.env.WEB_RESEARCH_CONCURRENCY ?? '4') });
const evidence = await adapter.research(researchTargetsFor(board));
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify({ boardFetchedAt: board.fetchedAt,
  researchedAt: new Date().toISOString(), health: adapter.getHealth(),
  sourceCatalog: adapter.getCatalogSummary(), evidence }, null, 2));
console.log(JSON.stringify({ health: adapter.getHealth(),
  sourceCatalog: adapter.getCatalogSummary(), evidence: evidence.length }));
