import assert from 'node:assert/strict';
import test from 'node:test';
import { fitDispersion, ksUniform, profileFor, setLearnedDispersion } from '../src/index.js';

// Synthetic players only: negative binomial (gamma–Poisson) and normal draws with known dispersion.
function generator(seed: number) {
  let state = seed >>> 0;
  const uniform = () => { state = (state * 1664525 + 1013904223) >>> 0; return (state + .5) / 2 ** 32; };
  const gaussian = () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
  const gamma = (shape: number): number => {
    if (shape < 1) return gamma(shape + 1) * uniform() ** (1 / shape);
    const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) {
      const x = gaussian(), v = (1 + c * x) ** 3;
      if (v > 0 && Math.log(uniform()) < .5 * x * x + d - d * v + d * Math.log(v)) return d * v;
    }
  };
  const poisson = (mean: number) => { let k = 0, p = 1; const limit = Math.exp(-mean); do { k++; p *= uniform(); } while (p > limit); return k - 1; };
  return { uniform, gaussian, negbin: (mean: number, psi: number) => poisson(gamma(1 / psi) * mean * psi) };
}

test('learned dispersion: synthetic negative-binomial data recovers ψ within 15%, and its PIT is uniform', () => {
  const draw = generator(3), psi = .12;
  const players = Array.from({ length: 150 }, () => {
    const mean = 3 + draw.uniform() * 9;
    return Array.from({ length: 30 }, () => draw.negbin(mean, psi));
  });
  const fit = fitDispersion(players, profileFor('NBA', 'player_rebounds'))!;
  assert.ok(Math.abs(fit.fittedPsi / psi - 1) < .15, `fitted ψ ${fit.fittedPsi}`);
  assert.equal(fit.n, 4500);
  // Shrunk toward the 0.08 default with 500 games of prior.
  assert.ok(Math.abs(fit.psi - (4500 * fit.fittedPsi + 500 * .08) / 5000) < 1e-9);
  assert.ok(fit.ks < .03, `KS ${fit.ks}`);
});

test('learned dispersion: normal markets fit φ and ψ; too few games gives no fit', () => {
  const draw = generator(5);
  const players = Array.from({ length: 120 }, () => {
    const mean = 30 + draw.uniform() * 60;
    return Array.from({ length: 25 }, () => mean + draw.gaussian() * Math.sqrt(2 * mean + .2 * mean * mean));
  });
  const fit = fitDispersion(players, profileFor('NFL', 'player_rush_yds'))!;
  const variance = (phi: number, psi: number) => phi * 60 + psi * 3600;
  assert.ok(Math.abs(variance(fit.fittedPhi, fit.fittedPsi) / variance(2, .2) - 1) < .15);
  assert.equal(fitDispersion([[1, 2, 3]], profileFor('NBA', 'player_points')), null);
});

test('PIT uniformity check and the learned profile override', () => {
  assert.ok(ksUniform(Array.from({ length: 1000 }, (_, i) => (i + .5) / 1000)) < .01);
  assert.ok(ksUniform(Array.from({ length: 1000 }, (_, i) => ((i + .5) / 1000) ** 2)) > .2);
  const before = profileFor('NBA', 'player_points').variance.psi;
  setLearnedDispersion(new Map([['NBA:player_points', { phi: 1, psi: .07 }], ['NHL:player_total_saves', { phi: 1.5, psi: .01 }]]));
  try {
    assert.equal(profileFor('NBA', 'player_points').variance.psi, .07);
    assert.equal(profileFor('NHL', 'saves').variance.phi, 1.5, 'board aliases too');
  } finally { setLearnedDispersion(new Map()); }
  assert.equal(profileFor('NBA', 'player_points').variance.psi, before);
});
