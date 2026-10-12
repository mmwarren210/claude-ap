import assert from 'node:assert/strict';
import test from 'node:test';

test('a guest link keeps its code after the app moves to the sign-in page', async () => {
  // The page opens on the guest link; then the router sends a signed-out visitor to /sign-in, dropping the query.
  const location = { search: '?guest=CIQ-277A-D421-8E0B' };
  (globalThis as { window?: unknown }).window = { location };
  const { guestCode, startsInDemo } = await import('../src/links');
  location.search = '';
  assert.equal(guestCode(), 'CIQ-277A-D421-8E0B');
  assert.equal(startsInDemo(), false);
  assert.equal(guestCode('?demo'), null, 'an address passed in is read as given');
  delete (globalThis as { window?: unknown }).window;
});
