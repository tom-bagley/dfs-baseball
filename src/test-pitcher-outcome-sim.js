import assert from 'node:assert/strict';
import { simulatePitcherOutcomes, scoreDraftKingsPitcherLine } from './pitcher-outcome-sim.js';

const average = { Outs: 17, K: 6.5, R: 3, ER: 2.7, H: 5.2, BB: 2, HBP: 0.2, W: 0.42 };
const histograms = {
  Outs: histogram({ 9: 500, 12: 1000, 15: 2200, 18: 3500, 21: 2200, 24: 550, 27: 50 }),
  K: histogram({ 2: 500, 4: 1800, 6: 3000, 8: 3000, 10: 1400, 12: 300 }),
  R: histogram({ 0: 900, 1: 1700, 2: 2200, 3: 2100, 4: 1500, 5: 900, 6: 500, 7: 200 }),
  H: histogram({ 0: 100, 2: 700, 4: 2200, 5: 2600, 6: 2200, 8: 1500, 10: 700 }),
  BB: histogram({ 0: 1700, 1: 2800, 2: 2700, 3: 1700, 4: 800, 5: 300 }),
  HBP: histogram({ 0: 8200, 1: 1600, 2: 200 }),
};

const base = simulatePitcherOutcomes({ playerId: 'test', date: '2026-07-14', average, histograms });
const repeated = simulatePitcherOutcomes({ playerId: 'test', date: '2026-07-14', average, histograms });
const inexperienced = simulatePitcherOutcomes({
  playerId: 'test',
  date: '2026-07-14',
  average,
  histograms,
  experience: { seasonInnings: 5, priorMlbInnings: 0, recentStarts: 1 },
});

assert.deepEqual(repeated, base, 'same inputs must produce deterministic percentiles');
assert.ok(base.p10 <= base.p20 && base.p20 <= base.p50 && base.p50 <= base.p80 && base.p80 <= base.p90);
assert.equal(inexperienced.simulationMean, base.simulationMean, 'experience must not change the mean projection');
assert.ok(inexperienced.p90 - inexperienced.p10 > base.p90 - base.p10, 'limited experience must widen the outcome interval');
assert.equal(scoreDraftKingsPitcherLine({ outs: 18, strikeouts: 7, earnedRuns: 2, hits: 5, walks: 2, hitBatsmen: 0, win: 1, runs: 2 }), 23.3);

console.log({ base, inexperienced });

function histogram(buckets) {
  return { total: Object.values(buckets).reduce((sum, value) => sum + value, 0), buckets };
}
