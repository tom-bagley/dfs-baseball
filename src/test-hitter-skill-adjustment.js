import assert from 'node:assert/strict';
import { calculateHitterSkillAdjustment } from './hitter-skill-adjustment.js';

const positive = calculateHitterSkillAdjustment({
  seasonPlateAppearances: 400, recentPlateAppearances: 100,
  seasonXwobaDifference: 0.05, recentXwobaDifference: 0.04,
}, 4.5);
const negative = calculateHitterSkillAdjustment({
  seasonPlateAppearances: 400, recentPlateAppearances: 100,
  seasonXwobaDifference: -0.05, recentXwobaDifference: -0.04,
}, 4.5);
assert(positive > 0, 'positive full-season xwOBA disagreement should raise the projection');
assert(negative < 0, 'negative full-season xwOBA disagreement should lower the projection');
assert.equal(calculateHitterSkillAdjustment({}, 4.5), 0, 'missing evidence should retain the baseline');
assert(Math.abs(positive) <= 4.5 * 0.25, 'adjustment must respect the per-PA cap');
console.log('Hitter skill adjustment tests passed.');
