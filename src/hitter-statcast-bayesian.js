import { predictSeasonBayesian, seasonBayesianDiagnostics } from './hitter-season-bayesian.js';
import { statcastFeaturesBefore } from './statcast-hitter-features.js';

export function predictStatcastBayesian(row, seasonHistories, statcastHistories, options = {}, precomputedFeatures = null) {
  const features = precomputedFeatures || statcastFeaturesBefore(row, statcastHistories, { recentDays: 30 });
  const minimumStatcastPA = Number(options.minimumStatcastPA || 100);
  const xwobaThreshold = Number(options.xwobaThreshold || 0.02);
  if (!(features.seasonPlateAppearances >= minimumStatcastPA) || features.seasonXwobaDifference == null) {
    return row.projectedDraftKingsPoints;
  }
  const diagnostics = seasonBayesianDiagnostics(row, seasonHistories, options);
  const outcomeZ = diagnostics.totalDisagreementZ;
  const qualityDelta = features.seasonXwobaDifference;
  const sameDirection = Math.sign(outcomeZ) === Math.sign(qualityDelta);
  const clearsThreshold = Math.abs(outcomeZ) > Number(options.disagreementThreshold || 1)
    && Math.abs(qualityDelta) >= xwobaThreshold;
  if (!sameDirection || !clearsThreshold || !contactQualityConfirms(features, qualityDelta, options.confirmationMode)) {
    return row.projectedDraftKingsPoints;
  }
  return predictSeasonBayesian(row, seasonHistories, {
    ...options,
    gateUpdates: true,
    disagreementMode: 'total',
    requirePersistentDisagreement: false,
  });
}

export function statcastBayesianCandidates() {
  const candidates = [];
  for (const priorPlateAppearances of [25, 50, 100]) {
    for (const multiplierCap of [1.5, 2]) {
      for (const adaptiveSensitivity of [2, 4]) {
        for (const disagreementThreshold of [0.5, 1]) {
          for (const xwobaThreshold of [0.01, 0.03, 0.05]) {
            for (const minimumStatcastPA of [50, 100, 200]) {
              for (const confirmationMode of ['xwoba', 'xwoba-contact']) candidates.push({
                priorPlateAppearances,
                halfLifeDays: 14,
                multiplierCap,
                adaptiveSensitivity,
                disagreementThreshold,
                xwobaThreshold,
                minimumStatcastPA,
                confirmationMode,
              });
            }
          }
        }
      }
    }
  }
  return candidates;
}

function contactQualityConfirms(features, direction, mode = 'xwoba') {
  if (mode === 'xwoba') return true;
  if (direction > 0) {
    const confirmations = [
      features.seasonAverageExitVelocity >= 90,
      features.seasonHardHitRate >= 0.45,
      features.seasonBarrelRate >= 0.10,
      features.seasonAverageLaunchAngle >= 8 && features.seasonAverageLaunchAngle <= 30,
    ];
    return confirmations.filter(Boolean).length >= 2;
  }
  const confirmations = [
    features.seasonAverageExitVelocity < 88.5,
    features.seasonHardHitRate < 0.38,
    features.seasonBarrelRate < 0.06,
  ];
  return confirmations.filter(Boolean).length >= 2;
}
