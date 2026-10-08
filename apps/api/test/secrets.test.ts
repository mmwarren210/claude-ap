import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProductLedger } from '../src/product-ledger.js';
import { SecretUnlocks, passwordMatches } from '../src/secrets.js';
import { buildServer } from '../src/server.js';

test('the Secrets password unlocks GKR+ for that account only, and survives a restart', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'crowniq-secrets-'));
  const product = new ProductLedger(join(folder, 'product.json'));
  const owner = await product.register('owner@example.org', 'long-private-passphrase', 'Owner_1');
  const member = await product.register('member@example.org', 'another-long-passphrase', 'Member_1');
  const other = await product.register('other@example.org', 'third-long-passphrase', 'Other_1');
  const file = join(folder, 'secret-unlocks.json');
  const app = buildServer({ product, ownerPublicId: owner.profile.publicId,
    secrets: { password: 'test-secret-phrase', unlocks: new SecretUnlocks(file) } });
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  try {
    const status = async (token: string) => (await app.inject({ method: 'GET', url: '/v1/secrets', headers: auth(token) })).json();
    assert.deepEqual(await status(owner.token), { gkrPlus: true }, 'the owner always has it');
    assert.deepEqual(await status(member.token), { gkrPlus: false });
    const wrong = await app.inject({ method: 'POST', url: '/v1/secrets/unlock', headers: auth(member.token), payload: { password: 'nope' } });
    assert.equal(wrong.statusCode, 403);
    const right = await app.inject({ method: 'POST', url: '/v1/secrets/unlock', headers: auth(member.token), payload: { password: 'test-secret-phrase' } });
    assert.deepEqual(right.json(), { gkrPlus: true });
    assert.deepEqual(await status(member.token), { gkrPlus: true });
    assert.deepEqual(await status(other.token), { gkrPlus: false }, 'only the account that entered it');
    assert.equal((await app.inject({ method: 'GET', url: '/v1/secrets' })).statusCode, 401);
    const restarted = buildServer({ product, ownerPublicId: owner.profile.publicId,
      secrets: { password: 'test-secret-phrase', unlocks: new SecretUnlocks(file) } });
    assert.deepEqual((await restarted.inject({ method: 'GET', url: '/v1/secrets', headers: auth(member.token) })).json(), { gkrPlus: true },
      'the unlock is saved');
    await restarted.close();
  } finally { await app.close(); await rm(folder, { recursive: true, force: true }); }
});

test('no password set unlocks nothing; matching is exact', () => {
  assert.equal(passwordMatches('anything', null), false);
  assert.equal(passwordMatches('Abc', 'abc'), false);
  assert.equal(passwordMatches('abc', 'abc'), true);
});
