import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

const watchdog = new URL('../src/watchdog.ts', import.meta.url).href;
/** Runs a small script with the watchdog in a child process; resolves with how the process ended. */
function child(script: string): Promise<{ code: number | null; signal: string | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      `import { startWatchdog } from ${JSON.stringify(watchdog)};\n${script}`], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const limit = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('child never ended')); }, 10_000);
    proc.once('exit', (code, signal) => { clearTimeout(limit); resolve({ code, signal, stderr }); });
  });
}

test('the watchdog kills a process whose server thread is stuck', { skip: process.platform === 'win32' }, async () => {
  const ended = await child('startWatchdog(400, 50); setTimeout(() => { for (;;) { /* stuck */ } }, 150);');
  assert.equal(ended.signal, 'SIGKILL');
  assert.match(ended.stderr, /server thread stuck \d+s \(last reading: heap \d+ MB, rss \d+ MB\)/);
});

test('a short pause and a clean stop leave the process alone', async () => {
  const ended = await child(`const stop = startWatchdog(500, 50); const keep = setInterval(() => {}, 1000);
    setTimeout(() => { const until = Date.now() + 150; while (Date.now() < until) { /* busy, but under the limit */ } }, 100);
    setTimeout(async () => { await stop(); clearInterval(keep); }, 1200);`);
  assert.equal(ended.code, 0, ended.stderr);
  assert.doesNotMatch(ended.stderr, /thread stuck \d/);
});
