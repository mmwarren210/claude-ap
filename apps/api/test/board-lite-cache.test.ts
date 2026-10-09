import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import type { OddsProvider } from '@crowniq/engine';
import { fixtureLine } from '../../../packages/engine/test/fixtures.js';
import { buildServer } from '../src/server.js';
import { ProductLedger } from '../src/product-ledger.js';

const at = new Date('2030-09-24T12:00:00.000Z');

test('the Board list is built once per board and answers "nothing new" (304) to an app that already has it', async () => {
  const provider: OddsProvider = { id: 'fixture-provider', fetchPrizePicksLines: async () => [{ id: 'fixture' }],
    normalize: (_raw, fetchedAt) => fixtureLine({ fetchedAt }) };
  const folder = await mkdtemp(join(tmpdir(), 'crowniq-lite-'));
  const ledger = new ProductLedger(join(folder, 'ledger.json'), 'CROWN_STRONG', () => at);
  const owner = await ledger.register('lite-owner@example.org', 'abcdefghijkl', 'Lite_owner');
  const app = buildServer({ provider, product: ledger, requireProfiles: true, ownerPublicId: owner.profile.publicId, clock: () => at });
  const headers = { authorization: 'Bearer ' + owner.token };
  try {
    await app.inject({ method: 'POST', url: '/v1/owner/board/bootstrap', headers, payload: { acknowledgeProviderCost: true } });
    let first = await app.inject({ url: '/v1/board/lite', headers });
    for (let i = 0; i < 50 && first.statusCode !== 200; i++) { await new Promise((done) => setImmediate(done)); first = await app.inject({ url: '/v1/board/lite', headers }); }
    assert.equal(first.statusCode, 200);
    const etag = String(first.headers.etag);
    assert.match(etag, /^"lite-/);
    const lines = (JSON.parse(first.body) as { board: { lines: unknown[] } }).board.lines.length;
    assert.ok(lines > 0);
    // Same board: a tiny 304 with no body.
    const again = await app.inject({ url: '/v1/board/lite', headers: { ...headers, 'if-none-match': etag } });
    assert.equal(again.statusCode, 304);
    assert.equal(again.body, '');
    // Gzip is served from the saved copy.
    const zipped = await app.inject({ url: '/v1/board/lite', headers: { ...headers, 'accept-encoding': 'gzip' } });
    assert.equal(zipped.headers['content-encoding'], 'gzip');
    assert.equal((JSON.parse(gunzipSync(zipped.rawPayload).toString()) as { board: { lines: unknown[] } }).board.lines.length, lines);
    const updates = await app.inject({ url: '/v1/board/updates', headers });
    assert.equal(updates.statusCode, 200);
    assert.equal((JSON.parse(updates.body) as { rescoring: unknown }).rescoring, null);
  } finally { await app.close(); await rm(folder, { recursive: true, force: true }); }
});
