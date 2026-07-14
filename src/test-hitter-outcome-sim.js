import assert from 'node:assert/strict';
import { scoreDraftKingsHitterLine, simulateHitterOutcomes } from './hitter-outcome-sim.js';

const average = { '1B': 0.75, '2B': 0.22, '3B': 0.03, HR: 0.18, BB: 0.38, HBP: 0.04, R: 0.58, RBI: 0.61, SB: 0.09 };
const result = simulateHitterOutcomes({ playerId: 'test-hitter', date: '2026-07-17', average });
const repeat = simulateHitterOutcomes({ playerId: 'test-hitter', date: '2026-07-17', average });

assert.deepEqual(result, repeat, 'hitter percentiles must be deterministic');
assert.ok(result.p10 <= result.p20 && result.p20 <= result.p50 && result.p50 <= result.p80 && result.p80 <= result.p90);
assert.equal(scoreDraftKingsHitterLine({ singles: 1, doubles: 1, triples: 1, homeRuns: 1, runs: 1, runsBattedIn: 1, walks: 1, hitByPitch: 1, stolenBases: 1 }), 39);
assert.equal(result.simulationCount, 10000);

console.log(result);
