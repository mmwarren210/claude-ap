// Big stores saved at most once a window (owner, 2026-10-17: the server froze for 15-40s at a time and reached 4-5 GB because
// PropLine's push feed rewrote the 86 MB line store every 15-60 seconds, and the two ~100 MB Edge ledgers about as often).
// The data in memory is always current; the file catches up within the window. One save runs at a time.

/** Wraps `save` so calls within `windowMs` of the last save run once, at the end of the window. */
export function throttledSave(save: () => Promise<void>, windowMs: number, clock: () => number = Date.now) {
  let last = -Infinity, timer: NodeJS.Timeout | null = null, running: Promise<void> | null = null, again = false;
  const run = async (): Promise<void> => {
    if (running) { again = true; return running; }
    timer = null; last = clock();
    running = save().catch((error: unknown) => { console.warn(`[save] ${error instanceof Error ? error.message : String(error)}`); })
      .finally(() => { running = null; if (again) { again = false; schedule(); } });
    return running;
  };
  const schedule = (): Promise<void> => {
    const wait = last + windowMs - clock();
    if (wait <= 0) return run();
    if (!timer) { timer = setTimeout(() => void run(), wait); timer.unref?.(); }
    return Promise.resolve();
  };
  return { save: schedule, flush: async () => { if (timer) { clearTimeout(timer); timer = null; } await run(); } };
}
