export const STATCAST_FEATURE_SETS = Object.freeze({
  xwoba: ['seasonXwobaDifference', 'recentXwobaDifference'],
  contact: ['averageExitVelocity', 'hardHitRate', 'barrelRate', 'launchAngleQuality'],
  'xwoba-contact': [
    'seasonXwobaDifference', 'recentXwobaDifference',
    'averageExitVelocity', 'hardHitRate', 'barrelRate', 'launchAngleQuality',
  ],
  'xwoba-contact-bat': [
    'seasonXwobaDifference', 'recentXwobaDifference',
    'averageExitVelocity', 'hardHitRate', 'barrelRate', 'launchAngleQuality', 'averageBatSpeed',
  ],
});

export function fitStatcastResidualModel(rows, featureByRow, options = {}) {
  const featureSet = options.featureSet || 'xwoba-contact';
  const names = STATCAST_FEATURE_SETS[featureSet];
  if (!names) throw new Error(`Unknown Statcast feature set: ${featureSet}`);
  const ridge = Number(options.ridge || 100);
  const reliabilityPA = Number(options.reliabilityPA || 100);
  const matrix = names.map(() => names.map(() => 0));
  const vector = names.map(() => 0);
  for (const row of rows) {
    const x = featureVector(featureByRow.get(row), names, reliabilityPA);
    const residual = row.actualDraftKingsPoints - row.projectedDraftKingsPoints;
    for (let i = 0; i < x.length; i += 1) {
      vector[i] += x[i] * residual;
      for (let j = 0; j < x.length; j += 1) matrix[i][j] += x[i] * x[j];
    }
  }
  for (let index = 0; index < names.length; index += 1) matrix[index][index] += ridge;
  return { featureSet, names, ridge, reliabilityPA, coefficients: solve(matrix, vector) };
}

export function predictStatcastResidual(row, features, model) {
  const x = featureVector(features, model.names, model.reliabilityPA);
  const adjustment = x.reduce((sum, value, index) => sum + value * model.coefficients[index], 0);
  return Math.max(0, row.projectedDraftKingsPoints + adjustment);
}

export function statcastResidualCandidates() {
  const candidates = [];
  for (const featureSet of Object.keys(STATCAST_FEATURE_SETS)) {
    for (const ridge of [10, 40, 160, 640]) {
      for (const reliabilityPA of [50, 100, 200, 400]) candidates.push({ featureSet, ridge, reliabilityPA });
    }
  }
  return candidates;
}

function featureVector(features = {}, names, reliabilityPA) {
  const seasonReliability = Number(features.seasonPlateAppearances || 0) / (Number(features.seasonPlateAppearances || 0) + reliabilityPA);
  const recentReliability = Number(features.recentPlateAppearances || 0) / (Number(features.recentPlateAppearances || 0) + reliabilityPA / 2);
  const values = {
    seasonXwobaDifference: 10 * Number(features.seasonXwobaDifference || 0) * seasonReliability,
    recentXwobaDifference: 10 * Number(features.recentXwobaDifference || 0) * recentReliability,
    averageExitVelocity: (Number(features.seasonAverageExitVelocity || 89) - 89) / 4 * seasonReliability,
    hardHitRate: 5 * (Number(features.seasonHardHitRate || 0.40) - 0.40) * seasonReliability,
    barrelRate: 10 * (Number(features.seasonBarrelRate || 0.08) - 0.08) * seasonReliability,
    launchAngleQuality: (1 - Math.min(1, Math.abs(Number(features.seasonAverageLaunchAngle || 15) - 15) / 20)) * seasonReliability,
    averageBatSpeed: (Number(features.seasonAverageBatSpeed || 73) - 73) / 4 * seasonReliability,
  };
  return names.map((name) => values[name]);
}

function solve(matrix, vector) {
  const n = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < n; row += 1) if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    if (Math.abs(divisor) < 1e-12) throw new Error('Singular Statcast regression matrix.');
    for (let index = column; index <= n; index += 1) augmented[column][index] /= divisor;
    for (let row = 0; row < n; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let index = column; index <= n; index += 1) augmented[row][index] -= factor * augmented[column][index];
    }
  }
  return augmented.map((row) => row[n]);
}
