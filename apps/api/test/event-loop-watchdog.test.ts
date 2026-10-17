import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

const moduleUrl = new URL('../src/event-loop-watchdog.ts', import.meta.url).href;
const run = (body: string) => new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve, reject) => {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `import {startEventLoopWatchdog} from ${JSON.stringify(moduleUrl)};${body}`], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('WATCHDOG_TEST_TIMEOUT')); }, 8000);
  child.stderr.on('data', (part) => { stderr += String(part); });
  child.once('error', (error) => { clearTimeout(deadline); reject(error); });
  child.once('exit', (code, signal) => { clearTimeout(deadline); resolve({ code, signal, stderr }); });
});

test('independent watchdog kills a subprocess whose main thread never yields', { skip: process.platform === 'win32' }, async () => {
  const result = await run('startEventLoopWatchdog(500,50);setTimeout(()=>{for(;;){}},200);setInterval(()=>{},1000);');
  assert.equal(result.signal, 'SIGKILL');
  assert.match(result.stderr, /heartbeat missing.*last main heap.*SIGKILL/);
  assert.ok(!result.stderr.includes('WATCHDOG_TEST_TIMEOUT'));
});

test('healthy heartbeats and a short recoverable pause do not trigger the watchdog; shutdown stops it', async () => {
  const result = await run(`const stop=startEventLoopWatchdog(600,50);
    const held=setInterval(()=>{},1000);
    setTimeout(()=>{const until=performance.now()+100;while(performance.now()<until){}},200);
    setTimeout(async()=>{await stop();clearInterval(held);},1300);`);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.ok(!result.stderr.includes('heartbeat missing'));
});
