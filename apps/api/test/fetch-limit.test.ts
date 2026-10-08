import assert from 'node:assert/strict';
import test from 'node:test';

test('every request ends within the limit, even one whose own time limit never fires', async () => {
  const original = globalThis.fetch;
  // A source that never answers unless aborted.
  globalThis.fetch = ((_input: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
  })) as typeof fetch;
  const { startMemoryWatch } = await import('../src/memory-watch.js');
  const watch = startMemoryWatch(1e9, 60_000, 50);
  try {
    const started = Date.now();
    await assert.rejects(fetch('https://example.test/never'), /FETCH_TIMEOUT/);
    assert.ok(Date.now() - started < 2000);
    const caller = new AbortController();
    setTimeout(() => caller.abort(new Error('CALLER_ABORT')), 10);
    await assert.rejects(fetch('https://example.test/never', { signal: caller.signal }), /CALLER_ABORT/, 'the caller can still end it sooner');
  } finally { clearInterval(watch); globalThis.fetch = original; }
});

test('a request whose network call ignores the abort still ends at the limit', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (() => new Promise(() => undefined)) as typeof fetch; // never settles, even when aborted
  const { startMemoryWatch } = await import('../src/memory-watch.js');
  const watch = startMemoryWatch(1e9, 60_000, 50);
  try { await assert.rejects(fetch('https://example.test/stuck'), /FETCH_TIMEOUT/); }
  finally { clearInterval(watch); globalThis.fetch = original; }
});
