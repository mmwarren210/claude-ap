// The Underdog and Pick6 slip builder: the strongest backed lines on the app, one per player, no more than two from one game,
// and at least two teams (the apps require it). Pure, so tests can load it.

type Side = 'MORE' | 'LESS';
export type SlipLine = { id: string; eventId: string; eventStartTime: string; playerId: string; team: string | null;
  lineType: string; availableDirections: readonly Side[]; gkr?: { direction: Side; score: number } | null };

type Pick = { side: Side; score: number; tier?: number };
const gkrPick = (line: SlipLine): Pick | null => line.gkr ? { side: line.gkr.direction, score: line.gkr.score } : null;

/**
 * Up to `size` picks from backed lines, strongest first (by `pickOf`: GKR's side by default; a higher tier first, then
 * the higher score). `offset` skips that many of the strongest for "build another". Games starting within 10 minutes
 * are left out.
 */
export function buildSlip<T extends SlipLine>(lines: readonly T[], size: number, nowMs: number, offset = 0,
  pickOf: (line: T) => Pick | null = gkrPick): { line: T; side: Side }[] {
  const candidates = lines.flatMap((line) => {
    const pick = pickOf(line);
    return pick && line.availableDirections.includes(pick.side) && Date.parse(line.eventStartTime) > nowMs + 10 * 60_000
      ? [{ line, pick }] : [];
  }).sort((a, b) => (b.pick.tier ?? 0) - (a.pick.tier ?? 0) || b.pick.score - a.pick.score ||
    Number(b.line.lineType === 'REGULAR') - Number(a.line.lineType === 'REGULAR'));
  const rotated = [...candidates.slice(offset), ...candidates.slice(0, offset)];
  const picked: { line: T; side: Side }[] = [], players = new Set<string>(), games = new Map<string, number>();
  for (const { line, pick } of rotated) {
    if (picked.length >= size) break;
    if (players.has(line.playerId) || (games.get(line.eventId) ?? 0) >= 2) continue;
    // The last pick must bring a second team when every pick so far is from one team.
    const teams = new Set(picked.map((item) => item.line.team ?? item.line.playerId));
    if (picked.length === size - 1 && teams.size === 1 && teams.has(line.team ?? line.playerId)) continue;
    picked.push({ line, side: pick.side }); players.add(line.playerId); games.set(line.eventId, (games.get(line.eventId) ?? 0) + 1);
  }
  return picked;
}
