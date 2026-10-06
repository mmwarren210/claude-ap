// The Tips slip: singles or a parlay of tip picks, priced at the best known odds (the post's, else what CrownIQ found), with
// CrownIQ's chance for each. A pick with no known price uses its fair odds and is flagged.

export interface SlipLeg { readonly id: string; readonly label: string; readonly chance: number; readonly price: number | null;
  readonly fairOdds: number; readonly event: string | null }

export const decimalOdds = (american: number) => american > 0 ? 1 + american / 100 : 1 + 100 / -american;
export const americanOdds = (decimal: number) => decimal >= 2 ? Math.round((decimal - 1) * 100) : -Math.round(100 / (decimal - 1));
export const formatOdds = (american: number) => `${american > 0 ? '+' : ''}${american}`;

export interface SlipSummary {
  readonly mode: 'SINGLES' | 'PARLAY'; readonly stake: number; readonly risk: number;
  /** Parlay: payout if it hits (stake included) and its chance; singles: the payout if every single hits. */
  readonly payout: number; readonly chance: number | null; readonly expectedProfit: number; readonly odds: number | null;
  readonly unpriced: number; readonly sameGame: boolean;
}

export function slipSummary(legs: readonly SlipLeg[], mode: 'SINGLES' | 'PARLAY', stake: number): SlipSummary {
  const decimal = (leg: SlipLeg) => decimalOdds(leg.price ?? leg.fairOdds);
  const unpriced = legs.filter((leg) => leg.price === null).length;
  const events = legs.map((leg) => leg.event).filter((event): event is string => !!event);
  const sameGame = new Set(events).size < events.length;
  if (mode === 'PARLAY') {
    const product = legs.reduce((value, leg) => value * decimal(leg), 1), chance = legs.reduce((value, leg) => value * leg.chance, 1);
    return { mode, stake, risk: stake, payout: round(stake * product), chance: round(chance, 4), expectedProfit: round(stake * (chance * product - 1)),
      odds: legs.length > 1 ? americanOdds(product) : legs[0] ? legs[0].price ?? legs[0].fairOdds : null, unpriced, sameGame };
  }
  return { mode, stake, risk: round(stake * legs.length), payout: round(legs.reduce((sum, leg) => sum + stake * decimal(leg), 0)), chance: null,
    expectedProfit: round(legs.reduce((sum, leg) => sum + stake * (leg.chance * decimal(leg) - 1), 0)), odds: null, unpriced, sameGame };
}

const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;

/** Plain-text slip to paste into a sportsbook or a note. */
export function slipText(legs: readonly SlipLeg[], summary: SlipSummary): string {
  return [...legs.map((leg) => `${leg.label} ${leg.price !== null ? formatOdds(leg.price) : `(fair ${formatOdds(leg.fairOdds)})`}`),
    summary.mode === 'PARLAY' && summary.odds !== null ? `Parlay ${formatOdds(summary.odds)} · $${summary.stake} to win $${round(summary.payout - summary.stake)}`
      : `Singles · $${summary.stake} each`].join('\n');
}
