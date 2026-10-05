import { appendFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

// CrownIQ's own archive, for built-in verification and evidence later: every player game log it fetched, every final
// result it graded and every line it saw (with each move), across all sports and apps. Append-only JSON lines, one file
// per stream per month. Nothing reads it for scoring: it changes no GKR score.

export type ArchiveStream = 'games' | 'results' | 'lines';

export class HistoryArchive {
  /** Keys already written this run, so repeated fetches of the same game log or result aren't stored twice. */
  private seen = new Map<ArchiveStream, Set<string>>();
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly dir: string | null, private readonly clock: () => Date = () => new Date()) {}

  /** Appends records not already written (by key). Failures never reach the caller: the archive is best effort. */
  append(stream: ArchiveStream, records: readonly { key: string; record: Record<string, unknown> }[]): Promise<number> {
    // The time a record was handed over decides its month, however long the write waits in line.
    const at = this.clock().toISOString();
    const task = this.chain.then(async () => {
      if (!this.dir || !records.length) return 0;
      // After a restart, the keys this month's file already holds count as written.
      let seen = this.seen.get(stream);
      if (!seen) {
        seen = new Set<string>();
        try {
          for (const row of (await readFile(join(this.dir, `${stream}-${at.slice(0, 7)}.jsonl`), 'utf8')).split('\n')) {
            const match = /^\{"key":"((?:[^"\\]|\\.)*)"/.exec(row);
            if (match) seen.add(JSON.parse(`"${match[1]}"`) as string);
          }
        } catch { /* no file yet */ }
        this.seen.set(stream, seen);
      }
      if (seen.size > 500_000) seen.clear();
      const batch = new Set<string>();
      const fresh = records.filter(({ key }) => !seen.has(key) && !batch.has(key) && batch.add(key));
      if (!fresh.length) return 0;
      await mkdir(this.dir, { recursive: true });
      await appendFile(join(this.dir, `${stream}-${at.slice(0, 7)}.jsonl`),
        fresh.map(({ key, record }) => JSON.stringify({ key, archivedAt: at, ...record })).join('\n') + '\n');
      for (const { key } of fresh) seen.add(key);
      return fresh.length;
    }).catch(() => 0);
    this.chain = task;
    return task;
  }

  /** Files and sizes per stream. */
  async status() {
    if (!this.dir) return { configured: false, streams: {} };
    const streams: Record<string, { files: number; bytes: number }> = {};
    try {
      for (const name of await readdir(this.dir)) {
        const stream = name.split('-')[0]!, size = (await stat(join(this.dir, name))).size;
        streams[stream] = { files: (streams[stream]?.files ?? 0) + 1, bytes: (streams[stream]?.bytes ?? 0) + size };
      }
    } catch { /* nothing yet */ }
    return { configured: true, streams };
  }
}
