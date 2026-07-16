import assert from 'node:assert/strict';
import {
  fitBayesianCalibration,
  parseCsv,
  predictBayesianCalibration,
  predictionMetrics,
} from './hitter-bayesian-calibration.js';
import { calibrateHitterProjection, HITTER_PROJECTION_CALIBRATION } from './hitter-projection-calibration.js';

const rows = [
  row('2026-06-01', 'a', 6, 5, 1),
  row('2026-06-01', 'b', 8, 7, 2),
  row('2026-06-02', 'a', 10, 8, 1),
  row('2026-06-02', 'b', 12, 9, 2),
];
const model = fitBayesianCalibration(rows, {
  featureSet: 'offset', ridge: 0, halfLifeDays: Infinity, playerPriorGames: Infinity,
});
assert.equal(model.coefficients.length, 1);
assert.equal(model.coefficients[0], -1.75);
assert.equal(predictBayesianCalibration(row('2026-06-03', 'c', 8, 0, 3), model), 6.25);

const shrunk = fitBayesianCalibration(rows, {
  featureSet: 'offset', ridge: 4, halfLifeDays: Infinity, playerPriorGames: Infinity,
});
assert.equal(shrunk.coefficients[0], -0.875);

const parsed = parseCsv('date,lineupSlot,fangraphsPlayerId,projectedDraftKingsPoints,actualDraftKingsPoints\r\n2026-01-01,1,10,8.5,12\r\n');
assert.equal(parsed.length, 1);
assert.equal(parsed[0].projectedDraftKingsPoints, 8.5);
assert.equal(parsed[0].actualDraftKingsPoints, 12);

const metrics = predictionMetrics(rows, (value) => value.projectedDraftKingsPoints - 1.75);
assert.equal(metrics.biasActualMinusProjection, 0);
assert.ok(metrics.rootMeanSquaredError < predictionMetrics(rows, (value) => value.projectedDraftKingsPoints).rootMeanSquaredError);
assert.equal(HITTER_PROJECTION_CALIBRATION.version, 'global-bias-calibration-v1');
assert.equal(calibrateHitterProjection(8), 7.4);
assert.equal(calibrateHitterProjection(0.25), 0);

console.log('Hitter shrinkage calibration tests passed.');

function row(date, player, projection, actual, lineupSlot) {
  return {
    date,
    fangraphsPlayerId: player,
    lineupSlot,
    projectedDraftKingsPoints: projection,
    actualDraftKingsPoints: actual,
  };
}
