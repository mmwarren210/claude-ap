import { Worker } from 'node:worker_threads';

// A timer on the server thread cannot detect that thread hanging. The worker reads one shared timestamp instead of
// queued messages, so old heartbeats cannot hide a freeze. It has its own isolate and needs no service or dependency.
export function startEventLoopWatchdog(timeoutMs = 60_000, heartbeatMs = 1000) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(heartbeatMs) || heartbeatMs <= 0 || heartbeatMs >= timeoutMs)
    throw new Error('INVALID_WATCHDOG_INTERVAL');
  const shared = new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT * 3), state = new BigInt64Array(shared);
  const beat = () => {
    const memory = process.memoryUsage();
    Atomics.store(state, 1, BigInt(Math.round(memory.heapUsed / 1_048_576)));
    Atomics.store(state, 2, BigInt(Math.round(memory.rss / 1_048_576)));
    Atomics.store(state, 0, process.hrtime.bigint());
  };
  beat();
  const worker = new Worker(new URL('./event-loop-watchdog-worker.mjs', import.meta.url), {
    workerData: { shared, timeoutMs }, execArgv: [],
    // No environment (keys) or application stores are copied into the diagnostic worker.
    env: {}, resourceLimits: { maxOldGenerationSizeMb: 16 },
  });
  let stopped = false;
  const failed = () => { if (!stopped) { console.error('[watchdog] monitor stopped; exiting for restart'); process.exit(1); } };
  worker.once('error', failed); worker.once('exit', failed);
  worker.unref();
  const timer = setInterval(beat, heartbeatMs); timer.unref();
  console.warn(`[watchdog] armed: ${timeoutMs}ms without a heartbeat triggers SIGKILL`);
  return async () => { stopped = true; clearInterval(timer); await worker.terminate(); };
}
