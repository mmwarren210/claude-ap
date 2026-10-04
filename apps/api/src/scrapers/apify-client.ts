const BASE = 'https://api.apify.com/v2';
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);

export interface ApifyRun {
  readonly id: string;
  readonly status: string;
  readonly datasetId: string;
  /** What Apify charged for the run, in USD. */
  readonly usageUsd: number;
}

export interface ApifyRunOptions {
  /** Hard cap Apify enforces on the run's charge. */
  readonly maxChargeUsd: number;
  /** Optional cap on result rows. Left out, the actor returns everything it finds. */
  readonly maxItems?: number;
  readonly timeoutSecs?: number;
}

/**
 * Minimal Apify API client: start an actor run, wait for it, read its dataset.
 * The token is sent as a bearer header when given; in a Claude cloud session the proxy adds it instead.
 */
export class ApifyClient {
  constructor(private readonly token: string | null, private readonly fetchFn: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {}

  private async json(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const headers = new Headers(init.headers);
    if (this.token) headers.set('authorization', `Bearer ${this.token}`);
    let response: Response;
    try { response = await this.fetchFn(BASE + path, { ...init, headers, signal: AbortSignal.timeout(90_000) }); }
    catch { throw new Error('APIFY_CONNECTION_FAILED'); }
    if (!response.ok) throw new Error('APIFY_HTTP_' + response.status);
    return await response.json() as Record<string, unknown>;
  }

  private static run(value: unknown): ApifyRun {
    const data = (value as { data?: Record<string, unknown> })?.data;
    if (!data || typeof data.id !== 'string' || typeof data.status !== 'string' || typeof data.defaultDatasetId !== 'string')
      throw new Error('APIFY_INVALID_RUN');
    const usage = Number(data.usageTotalUsd ?? 0);
    return { id: data.id, status: data.status, datasetId: data.defaultDatasetId, usageUsd: Number.isFinite(usage) ? usage : 0 };
  }

  /** Start `actorId` (owner/name) with `input` and wait until it finishes. */
  async runActor(actorId: string, input: unknown, options: ApifyRunOptions): Promise<ApifyRun> {
    const params = new URLSearchParams({ waitForFinish: '60', maxTotalChargeUsd: String(options.maxChargeUsd),
      timeout: String(options.timeoutSecs ?? 900), ...(options.maxItems ? { maxItems: String(options.maxItems) } : {}) });
    let run = ApifyClient.run(await this.json(`/acts/${actorId.replace('/', '~')}/runs?${params}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }));
    for (let poll = 0; !TERMINAL.has(run.status) && poll < 30; poll++) {
      await this.sleep(1_000);
      run = ApifyClient.run(await this.json(`/actor-runs/${run.id}?waitForFinish=60`));
    }
    if (!TERMINAL.has(run.status)) throw new Error('APIFY_RUN_DID_NOT_FINISH');
    // Apify settles a run's charge a few seconds after it finishes; read it again so the daily budget counts it.
    await this.sleep(5_000);
    try {
      const settled = ApifyClient.run(await this.json(`/actor-runs/${run.id}`));
      if (settled.usageUsd > run.usageUsd) run = { ...run, usageUsd: settled.usageUsd };
    } catch { /* keep the charge read at finish */ }
    return run;
  }

  /** Every row of a dataset, read in pages. */
  async datasetItems(datasetId: string, pageSize = 5_000): Promise<unknown[]> {
    const items: unknown[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const headers = new Headers();
      if (this.token) headers.set('authorization', `Bearer ${this.token}`);
      let response: Response;
      try {
        response = await this.fetchFn(`${BASE}/datasets/${datasetId}/items?clean=1&format=json&offset=${offset}&limit=${pageSize}`,
          { headers, signal: AbortSignal.timeout(90_000) });
      } catch { throw new Error('APIFY_CONNECTION_FAILED'); }
      if (!response.ok) throw new Error('APIFY_HTTP_' + response.status);
      const page = await response.json() as unknown;
      if (!Array.isArray(page)) throw new Error('APIFY_INVALID_DATASET');
      items.push(...page);
      if (page.length < pageSize) return items;
    }
  }
}
