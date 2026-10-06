// Replace this adapter with an owner-approved native diagnostics provider when configured.
// Never include tokens, request headers, raw player evidence, or full server responses.
export function reportMobileFailure(area:'startup'|'board'|'rankings'|'navigation'|'storage'|'edge',error:unknown):void {
  if(__DEV__) console.warn(`[CrownIQ ${area}]`,error instanceof Error ? error.name : 'Unknown error');
}
