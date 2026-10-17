import { write } from 'node:fs';
import { workerData } from 'node:worker_threads';

const state = new BigInt64Array(workerData.shared), timeoutMs = workerData.timeoutMs;
let killing = false;
setInterval(() => {
  const ageMs = Number(process.hrtime.bigint() - Atomics.load(state, 0)) / 1e6;
  if (killing || ageMs < timeoutMs) return;
  killing = true;
  const line = `[watchdog] heartbeat missing ${Math.round(ageMs)}ms; last main heap ${Atomics.load(state, 1)} MB, rss ${Atomics.load(state, 2)} MB; SIGKILL pid ${process.pid}\n`;
  const kill = () => process.kill(process.pid, 'SIGKILL');
  // No heap snapshot or main-thread inspector call: either can wait on the thread that is stuck. A blocked log pipe
  // must not prevent recovery either; give this small diagnostic at most 100ms to reach stderr.
  setTimeout(kill, 100);
  try { write(2, line, () => kill()); } catch { kill(); }
}, Math.min(1000, Math.max(10, timeoutMs / 4)));
