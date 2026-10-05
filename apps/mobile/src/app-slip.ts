// The Underdog and Pick6 slip builder: GKR's strongest lines on the app, one per player, no more than two from one game,
// and at least two teams (the apps require it). Pure, so tests can load it.

type Side = 'MORE' | 'LESS';
export type SlipLine = { id: string; eventId: string; eventStartTime: string; playerId: string; team: string | null;
  lineType: string; availableDirections: readonly Side[]; gkr?: { direction: Side; score: number } | null };

/**
 * Up to `size` picks from GKR-backed lines, strongest first. `offset` skips that many of the strongest for "build
 * another". Games starting within 10 minutes are left out.
 */
export function buildSlip<T extends SlipLine>(lines: readonly T[], size: number, nowMs: number, offset = 0): { line: T; side: Side }[] {
  const candidates = lines.filter((line) => line.gkr && line.availableDirections.includes(line.gkr.direction) &&
    Date.parse(line.eventStartTime) > nowMs + 10 * 60_000)
    .sort((a, b) => b.gkr!.score - a.gkr!.score || Number(b.lineType === 'REGULAR') - Number(a.lineType === 'REGULAR'));
  const rotated = [...candidates.slice(offset), ...candidates.slice(0, offset)];
  const picked: T[] = [], players = new Set<string>(), games = new Map<string, number>();
  for (const line of rotated) {
    if (picked.length >= size) break;
    if (players.has(line.playerId) || (games.get(line.eventId) ?? 0) >= 2) continue;
    // The last pick must bring a second team when every pick so far is from one team.
    const teams = new Set(picked.map((item) => item.team ?? item.playerId));
    if (picked.length === size - 1 && teams.size === 1 && teams.has(line.team ?? line.playerId)) continue;
    picked.push(line); players.add(line.playerId); games.set(line.eventId, (games.get(line.eventId) ?? 0) + 1);
  }
  return picked.map((line) => ({ line, side: line.gkr!.direction }));
}
