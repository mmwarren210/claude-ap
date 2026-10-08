import assert from 'node:assert/strict';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import Fastify from 'fastify';
import { registerCompression } from '../src/compress.js';

test('large responses are gzipped for clients that accept it; small ones and other clients are not', async () => {
  const app = Fastify();
  registerCompression(app, 1024);
  const big = { lines: Array.from({ length: 500 }, (_, index) => ({ id: `line-${index}`, player: 'Test Player', threshold: 49.5 })) };
  app.get('/big', async () => big);
  app.get('/small', async () => ({ ok: true }));
  const zipped = await app.inject({ method: 'GET', url: '/big', headers: { 'accept-encoding': 'gzip, br' } });
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  assert.deepEqual(JSON.parse(gunzipSync(zipped.rawPayload).toString()), big);
  assert.ok(zipped.rawPayload.length < JSON.stringify(big).length / 3);
  assert.equal((await app.inject({ method: 'GET', url: '/big' })).headers['content-encoding'], undefined);
  assert.equal((await app.inject({ method: 'GET', url: '/small', headers: { 'accept-encoding': 'gzip' } })).headers['content-encoding'], undefined);
});
