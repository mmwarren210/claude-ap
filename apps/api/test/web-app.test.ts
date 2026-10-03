import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildServer } from '../src/server.js';

async function exported() {
  const dir = await mkdtemp(join(tmpdir(), 'crowniq-web-'));
  await mkdir(join(dir, 'player'), { recursive: true });
  await mkdir(join(dir, '_expo/static/js'), { recursive: true });
  await writeFile(join(dir, 'index.html'), 'home');
  await writeFile(join(dir, 'crown.html'), 'crown');
  await writeFile(join(dir, 'player/[lineId].html'), 'player');
  await writeFile(join(dir, '+not-found.html'), 'missing');
  await writeFile(join(dir, '_expo/static/js/app-abc.js'), 'js');
  return dir;
}

test('the server hosts the web app at non-API paths and keeps JSON 404s for the API', async () => {
  const app = buildServer({ webAppDir: await exported() });
  const get = (url: string) => app.inject({ method: 'GET', url });
  const home = await get('/');
  assert.equal(home.statusCode, 200);
  assert.equal(home.body, 'home');
  assert.match(String(home.headers['content-type']), /text\/html/);
  assert.equal((await get('/crown')).body, 'crown');
  assert.equal((await get('/player/pp:123?x=1')).body, 'player');
  const script = await get('/_expo/static/js/app-abc.js');
  assert.match(String(script.headers['content-type']), /javascript/);
  assert.match(String(script.headers['cache-control']), /immutable/);
  const missing = await get('/nowhere/at/all');
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.body, 'missing');
  assert.equal((await get('/../../etc/passwd')).body, 'missing');
  assert.equal((await get('/%2e%2e/%2e%2e/etc/passwd')).statusCode, 404);
  const api = await get('/v1/nothing-here');
  assert.equal(api.statusCode, 404);
  assert.equal(api.json().statusCode, 404);
  assert.equal((await get('/health')).json().status, 'ok');
  await app.close();
});

test('without a web app the root stays a JSON 404', async () => {
  const app = buildServer();
  const response = await app.inject({ method: 'GET', url: '/' });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().statusCode, 404);
  await app.close();
});
