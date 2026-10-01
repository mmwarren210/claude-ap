import { randomUUID } from 'node:crypto';
import type { Board } from '@crowniq/contracts';
import { researchTargetsFor } from '@crowniq/engine';
import type { ResearchHealth } from '@crowniq/engine';
import { BoardService } from './board-service.js';
import { WebResearchAdapter } from './web-research.js';

export interface ResearchJobStatus {
  readonly id: string;
  readonly status: 'RUNNING' | 'COMPLETE' | 'PARTIAL' | 'FAILED' | 'CANCELLED' | 'OBSOLETE';
  readonly boardFetchedAt: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly health: ResearchHealth;
  readonly evidenceCount: number;
  readonly sourceCatalog: { searches: number; citedWebsites: number };
}

/** Full-board research runs after owner refresh; public requests never trigger web calls. */
export class ResearchBuild {
  private status: ResearchJobStatus | null = null;
  private controller: AbortController | null = null;
  constructor(private readonly board: BoardService,
    private readonly adapter: WebResearchAdapter,
    private readonly clock: () => Date = () => new Date(),
    private readonly onApplied?: () => Promise<unknown>) {}

  getStatus(): ResearchJobStatus | null { return this.status; }

  start(snapshot: Board): ResearchJobStatus {
    if (this.status?.status === 'RUNNING' && this.board.getBoard()?.board === snapshot) return this.status;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const id = randomUUID();
    const initial: ResearchHealth = { status: 'OK', targets: 0, searches: 0,
    cacheHits: 0, skipped: 0, failures: 0, noSources: 0, lastRunAt: null };
    this.status = { id, status: 'RUNNING', boardFetchedAt: snapshot.fetchedAt,
      startedAt: this.clock().toISOString(), finishedAt: null, health: initial,
      evidenceCount: 0, sourceCatalog: this.adapter.getCatalogSummary() };
    void this.adapter.research(researchTargetsFor(snapshot), (health) => {
      if (this.status?.id === id) this.status = { ...this.status, health,
        sourceCatalog: this.adapter.getCatalogSummary() };
    }, controller.signal).then((evidence) => {
      if (this.status?.id !== id) return;
      if (controller.signal.aborted) {
        this.status = { ...this.status, status: 'CANCELLED', finishedAt: this.clock().toISOString() };
        return;
      }
      const health = this.adapter.getHealth();
      const applied = this.board.applyWebEvidence(snapshot, evidence, health);
      if(applied && this.onApplied)void this.onApplied().catch(()=>undefined);
      this.status = { ...this.status, status: !applied ? 'OBSOLETE' : health.status === 'OK'
        ? 'COMPLETE' : health.status === 'PARTIAL' ? 'PARTIAL' : 'FAILED',
        finishedAt: this.clock().toISOString(), health,
        evidenceCount: evidence.length, sourceCatalog: this.adapter.getCatalogSummary() };
    }).catch(() => {
      if (this.status?.id === id) this.status = { ...this.status, status: 'FAILED',
        finishedAt: this.clock().toISOString() };
    });
    return this.status;
  }

  cancel(): ResearchJobStatus | null {
    this.controller?.abort();
    if (this.status?.status === 'RUNNING') this.status = { ...this.status,
      status: 'CANCELLED', finishedAt: this.clock().toISOString() };
    return this.status;
  }
}
