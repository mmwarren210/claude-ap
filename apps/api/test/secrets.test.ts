import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProductLedger } from '../src/product-ledger.js';
import { SecretUnlocks, passwordMatches } from '../src/secrets.js';
import { buildServer } from '../src/server.js';

test('GKR+ is the owner\'s only: the Secrets password no longer opens it for members (owner, 2026-10-13)', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'crowniq-secrets-'));
  const product = new ProductLedger(join(folder, 'product.json'));
  const owner = await product.register('owner@example.org', 'long-private-passphrase', 'Owner_1');
  const member = await product.register('member@example.org', 'another-long-passphrase', 'Member_1');
  const unlocks = new SecretUnlocks(join(folder, 'secret-unlocks.json'));
  await unlocks.add((await product.authenticate(member.token))!.accountId, 'Member_1');
  const app = buildServer({ product, ownerPublicId: owner.profile.publicId, secrets: { password: 'test-secret-phrase', unlocks } });
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  try {
    const status = async (token: string) => (await app.inject({ method: 'GET', url: '/v1/secrets', headers: auth(token) })).json();
    assert.deepEqual(await status(owner.token), { gkrPlus: true }, 'the owner always has it');
    assert.deepEqual(await status(member.token), { gkrPlus: false }, 'an old unlock no longer counts');
    const right = await app.inject({ method: 'POST', url: '/v1/secrets/unlock', headers: auth(member.token), payload: { password: 'test-secret-phrase' } });
    assert.equal(right.statusCode, 403, 'the right password unlocks nothing for a member');
    assert.deepEqual(await status(member.token), { gkrPlus: false });
    assert.equal((await app.inject({ method: 'GET', url: '/v1/secrets' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/owner/secrets', headers: auth(member.token) })).statusCode, 404, 'owner only');
  } finally { await app.close(); await rm(folder, { recursive: true, force: true }); }
});

test('no password set unlocks nothing; matching is exact', () => {
  assert.equal(passwordMatches('anything', null), false);
  assert.equal(passwordMatches('Abc', 'abc'), false);
  assert.equal(passwordMatches('abc', 'abc'), true);
});
