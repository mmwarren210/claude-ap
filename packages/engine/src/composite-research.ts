import type { Evidence } from '@crowniq/contracts';
import type { ResearchAdapter, ResearchHealth, ResearchTarget } from './interfaces.js';

const emptyHealth = (): ResearchHealth => ({ status: 'OK', targets: 0, searches: 0,
  cacheHits: 0, skipped: 0, failures: 0, noSources: 0, lastRunAt: null });

/**
 * Runs independent attributed research adapters and merges their evidence.
 * One broken optional source degrades the run instead of discarding healthy evidence.
 */
export class CompositeResearchAdapter implements ResearchAdapter {
  readonly id: string;
  private health: ResearchHealth = emptyHealth();

  constructor(private readonly adapters: readonly ResearchAdapter[]) {
    if (!adapters.length) throw new Error('COMPOSITE_RESEARCH_REQUIRES_ADAPTER');
    this.id = 'composite:' + adapters.map((item) => item.id).join('+');
  }

  getHealth(): ResearchHealth { return this.health; }
  supports(target: ResearchTarget): boolean {
    return this.adapters.some((adapter) => adapter.supports?.(target) ?? true);
  }

  async research(targets: readonly ResearchTarget[]): Promise<readonly Evidence[]> {
    const settled = await Promise.allSettled(this.adapters.map((adapter) => adapter.research(targets)));
    const evidence: Evidence[] = [];
    let adapterFailures = 0;
    let partial = false;
    let searches = 0, cacheHits = 0, skipped = 0, failures = 0, noSources = 0;
    let lastRunAt: string | null = null;
    const sources:Record<string,{status:'OK'|'PARTIAL'|'FAILED'|'SKIPPED';targets:number;
      evidence:number;failures:number;errorCode?:string|null}>={};

    for (let index = 0; index < settled.length; index++) {
      const outcome = settled[index];
      const sourceHealth = this.adapters[index].getHealth?.();
      if (sourceHealth) {
        searches += sourceHealth.searches;
        cacheHits += sourceHealth.cacheHits;
        skipped += sourceHealth.skipped;
        failures += sourceHealth.failures;
        noSources += sourceHealth.noSources ?? 0;
        if (sourceHealth.status !== 'OK') partial = true;
        if (!lastRunAt || sourceHealth.lastRunAt && sourceHealth.lastRunAt > lastRunAt) {
          lastRunAt = sourceHealth.lastRunAt;
        }
        sources[this.adapters[index].id]={status:sourceHealth.status,targets:sourceHealth.targets,
          evidence:outcome.status==='fulfilled'?outcome.value.length:0,
          failures:sourceHealth.failures,errorCode:null};
        for(const [key,value] of Object.entries(sourceHealth.sources??{}))
          sources[this.adapters[index].id+':'+key]=value;
      }
      if (outcome.status === 'rejected') {
        adapterFailures++; partial = true;
        sources[this.adapters[index].id]={status:'FAILED',targets:targets.length,evidence:0,
          failures:1,errorCode:'ADAPTER_REJECTED'};
        continue;
      }
      evidence.push(...outcome.value);
    }

    const byId = new Map<string, Evidence>();
    for (const item of evidence) {
      const previous = byId.get(item.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(item)) {
        throw new Error('CONFLICTING_EVIDENCE_ID');
      }
      byId.set(item.id, item);
    }
    const allFailed = adapterFailures === this.adapters.length;
    this.health = { status: allFailed ? 'FAILED' : partial ? 'PARTIAL' : 'OK',
      targets: targets.length, searches, cacheHits, skipped,
      failures: failures + adapterFailures, noSources,
      lastRunAt: lastRunAt ?? new Date().toISOString(), sources };
    return [...byId.values()];
  }
}
