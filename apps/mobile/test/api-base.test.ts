import assert from 'node:assert/strict';
import test from 'node:test';
import { apiBaseUrl } from '../src/api-base';

test('the app uses the configured server, else the site the web app came from', () => {
  assert.equal(apiBaseUrl('https://api.example.com/', undefined), 'https://api.example.com');
  assert.equal(apiBaseUrl('https://api.example.com', { origin: 'https://web.example.com' }), 'https://api.example.com');
  assert.equal(apiBaseUrl(undefined, { origin: 'https://crowniq.up.railway.app' }),
    'https://crowniq.up.railway.app');
  assert.equal(apiBaseUrl('', undefined), undefined);
  assert.equal(apiBaseUrl(undefined, { origin: 'null' }), undefined);
});
