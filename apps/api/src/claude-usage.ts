// One log line per Claude call with its prompt-cache use, so the cache hit rate can be checked in the server logs.
export function logClaudeUsage(caller: string, usage: { input_tokens?: number | null; cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null; output_tokens?: number | null } | null | undefined): void {
  if (!usage) return;
  const read = usage.cache_read_input_tokens ?? 0, written = usage.cache_creation_input_tokens ?? 0, fresh = usage.input_tokens ?? 0;
  const total = read + written + fresh;
  console.log(`[claude-cache] ${caller} input ${total} (cached ${read}, written ${written}, uncached ${fresh})` +
    `${total ? `, hit ${Math.round(read / total * 100)}%` : ''}, output ${usage.output_tokens ?? 0}`);
}
