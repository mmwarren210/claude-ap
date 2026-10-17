import assert from 'node:assert/strict';
import test from 'node:test';
import { summarize } from '../src/freeze-profiler.js';

test('the freeze profile names the slow function and the CrownIQ code that called it', () => {
  const frame = (functionName: string, url: string) => ({ functionName, url, lineNumber: 9 });
  const profile = {
    nodes: [
      { id: 1, callFrame: frame('(root)', ''), children: [2, 5] },
      { id: 2, callFrame: frame('pruneSnapshots', 'file:///app/apps/api/dist/edge/snapshots.js'), children: [3] },
      { id: 3, callFrame: frame('all', 'node:sqlite'), children: [] },
      { id: 5, callFrame: frame('(idle)', ''), children: [] },
    ],
    samples: [3, 3, 3, 2, 5, 5],
    timeDeltas: [5000, 5000, 5000, 5000, 5000, 5000],
  };
  const { self, ours } = summarize(profile);
  assert.equal(self[0], '15ms all node:sqlite:10');
  assert.equal(ours[0], '20ms pruneSnapshots apps/api/dist/edge/snapshots.js:10');
  assert.equal(self.some((item) => item.includes('idle')), false);
});
