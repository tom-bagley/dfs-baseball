import assert from 'node:assert/strict';
import { predictSeasonBayesian } from './hitter-season-bayesian.js';

const row = {
  date: '2026-06-10',
  mlbPlayerId: '1',
  projectedPlateAppearances: 5,
  projectedDraftKingsPoints: 5,
  projectedSingles: 0,
  projectedDoubles: 0,
  projectedTriples: 0,
  projectedHomeRuns: 0.5,
  projectedRunsBattedIn: 0,
  projectedRuns: 0,
  projectedWalks: 0,
  projectedHitByPitch: 0,
  projectedStolenBases: 0,
};
const histories = new Map([['1', [
  game('2026-06-01', 5, 1),
  game('2026-06-10', 5, 10),
  game('2026-06-11', 5, 10),
]]]);
const prediction = predictSeasonBayesian(row, histories, {
  priorPlateAppearances: 10,
  halfLifeDays: Infinity,
  multiplierCap: 3,
});

assert.equal(Number(prediction.toFixed(4)), 6.6667);
assert.ok(prediction < 10, 'same-day and future outcomes must not enter the posterior');
console.log('Hitter season Bayesian tests passed.');

function game(date, plateAppearances, homeRuns) {
  return {
    date,
    plateAppearances,
    Singles: 0,
    Doubles: 0,
    Triples: 0,
    HomeRuns: homeRuns,
    RunsBattedIn: 0,
    Runs: 0,
    Walks: 0,
    HitByPitch: 0,
    StolenBases: 0,
  };
}
