// Selected using rolling-origin validation through 2026-07-02, then evaluated
// once on the untouched 2026-07-06 through 2026-07-12 holdout. After that test,
// the same fixed model shape was refit on all 3,960 available hitter games.
export const HITTER_PROJECTION_CALIBRATION = Object.freeze({
  version: 'global-bias-calibration-v1',
  trainedThrough: '2026-07-12',
  trainingHitters: 3960,
  offset: -0.60,
  holdout: Object.freeze({
    start: '2026-07-06',
    end: '2026-07-12',
    hitters: 1746,
    baselineMae: 5.76,
    calibratedMae: 5.62,
    baselineRmse: 7.26,
    calibratedRmse: 7.23,
  }),
});

export function calibrateHitterProjection(baseProjection) {
  const base = Number(baseProjection);
  if (!Number.isFinite(base)) return null;
  return Math.max(0, base + HITTER_PROJECTION_CALIBRATION.offset);
}
