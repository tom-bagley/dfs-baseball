import assert from 'node:assert/strict';
import { statcastFeaturesBefore } from './statcast-hitter-features.js';

const row = {
  date: '2026-07-02', mlbPlayerId: '1', projectedPlateAppearances: 4,
  projectedSingles: 0.5, projectedDoubles: 0.2, projectedTriples: 0,
  projectedHomeRuns: 0.1, projectedWalks: 0.3, projectedHitByPitch: 0,
};
const histories = new Map([['1', [
  aggregate('2026-06-30', 4, 2, 180, 20, 1, 1, 1.0, 3),
  aggregate('2026-07-02', 4, 2, 220, 30, 2, 2, 1.8, 3),
]]]);
const features = statcastFeaturesBefore(row, histories, { recentDays: 30 });
assert.equal(features.seasonPlateAppearances, 4, 'same-day data must be excluded');
assert.equal(features.seasonAverageExitVelocity, 90);
assert.equal(features.seasonHardHitRate, 0.5);
assert.equal(features.seasonBarrelRate, 0.5);
assert.equal(Number(features.seasonXwoba.toFixed(4)), 0.3333);
console.log('Statcast hitter feature tests passed.');

function aggregate(date, plateAppearances, battedBalls, exitVelocitySum, launchAngleSum, hardHits, barrels, expectedWobaSum, expectedWobaPa) {
  return {
    date, plateAppearances, battedBalls, exitVelocitySum, launchAngleSum, hardHits, barrels,
    expectedWobaSum, expectedWobaPa, expectedSlgSum: 0, expectedSlgBbe: 0,
    batSpeedSum: 0, batSpeedSwings: 0,
  };
}
