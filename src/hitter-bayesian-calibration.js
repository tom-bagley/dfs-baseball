const DAY_MS = 24 * 60 * 60 * 1000;

export const FEATURE_SETS = {
  offset: ['intercept'],
  affine: ['intercept', 'projection'],
  nonlinear: ['intercept', 'projection', 'above8', 'above10'],
  'nonlinear-lineup': [
    'intercept', 'projection', 'above8', 'above10',
    'slot2', 'slot3', 'slot4', 'slot5', 'slot6', 'slot7', 'slot8', 'slot9',
  ],
};

export function fitBayesianCalibration(rows, options = {}) {
  const featureSet = options.featureSet || 'offset';
  const featureNames = FEATURE_SETS[featureSet];
  if (!featureNames) throw new Error(`Unknown feature set: ${featureSet}`);
  const ridge = finiteNumber(options.ridge, 100);
  const halfLifeDays = finiteNumber(options.halfLifeDays, Infinity);
  const playerPriorGames = finiteNumber(options.playerPriorGames, Infinity);
  const asOfDate = options.asOfDate || maxDate(rows.map((row) => row.date));
  const matrix = featureNames.map(() => featureNames.map(() => 0));
  const vector = featureNames.map(() => 0);

  for (const row of rows) {
    const x = features(row, featureNames);
    const residual = row.actualDraftKingsPoints - row.projectedDraftKingsPoints;
    const weight = recencyWeight(row.date, asOfDate, halfLifeDays);
    for (let i = 0; i < x.length; i += 1) {
      vector[i] += weight * x[i] * residual;
      for (let j = 0; j < x.length; j += 1) matrix[i][j] += weight * x[i] * x[j];
    }
  }
  for (let index = 0; index < featureNames.length; index += 1) {
    // The zero-centered coefficient prior means "leave the FanGraphs projection
    // unchanged." Lineup effects receive extra shrinkage because they are less
    // stable and share information poorly across batting-order positions.
    matrix[index][index] += ridge * (featureNames[index].startsWith('slot') ? 2 : 1);
  }

  const coefficients = solveLinearSystem(matrix, vector);
  const playerResiduals = new Map();
  if (Number.isFinite(playerPriorGames)) {
    for (const row of rows) {
      const id = playerKey(row);
      if (!id) continue;
      const base = calibratedBase(row, featureNames, coefficients);
      const weight = recencyWeight(row.date, asOfDate, halfLifeDays);
      const current = playerResiduals.get(id) || { weightedResidual: 0, weight: 0 };
      current.weightedResidual += weight * (row.actualDraftKingsPoints - base);
      current.weight += weight;
      playerResiduals.set(id, current);
    }
  }

  return {
    featureSet,
    featureNames,
    ridge,
    halfLifeDays,
    playerPriorGames,
    asOfDate,
    coefficients,
    playerEffects: new Map([...playerResiduals].map(([id, value]) => [
      id,
      value.weightedResidual / (value.weight + playerPriorGames),
    ])),
  };
}

export function predictBayesianCalibration(row, model) {
  const base = calibratedBase(row, model.featureNames, model.coefficients);
  const playerEffect = model.playerEffects.get(playerKey(row)) || 0;
  return Math.max(0, base + playerEffect);
}

export function candidateModels() {
  const candidates = [];
  for (const featureSet of Object.keys(FEATURE_SETS)) {
    for (const ridge of [25, 100, 400, 1600]) {
      for (const halfLifeDays of [14, 35, Infinity]) {
        for (const playerPriorGames of [8, 20, Infinity]) {
          candidates.push({ featureSet, ridge, halfLifeDays, playerPriorGames });
        }
      }
    }
  }
  return candidates;
}

export function predictionMetrics(rows, predictor) {
  if (!rows.length) return { hitters: 0 };
  const predictions = rows.map(predictor);
  const actual = rows.map((row) => row.actualDraftKingsPoints);
  const errors = actual.map((value, index) => value - predictions[index]);
  const absoluteErrors = errors.map(Math.abs);
  return {
    hitters: rows.length,
    averageProjection: round(mean(predictions)),
    averageActual: round(mean(actual)),
    biasActualMinusProjection: round(mean(errors)),
    meanAbsoluteError: round(mean(absoluteErrors)),
    medianAbsoluteError: round(median(absoluteErrors)),
    rootMeanSquaredError: round(Math.sqrt(mean(errors.map((value) => value ** 2)))),
    correlation: round(correlation(predictions, actual), 4),
  };
}

export function parseCsv(text) {
  const records = csvRecords(text);
  if (!records.length) return [];
  const columns = records[0];
  return records.slice(1).filter((record) => record.some((value) => value !== '')).map((record) => {
    const row = Object.fromEntries(columns.map((column, index) => [column, record[index] ?? '']));
    for (const column of columns) {
      if (/^(?:projected|actual)(?:Singles|Doubles|Triples|HomeRuns|Runs|RunsBattedIn|Walks|HitByPitch|StolenBases)$/.test(column)) {
        row[column] = Number(row[column]);
      }
    }
    return {
      ...row,
      lineupSlot: Number(row.lineupSlot),
      projectedDraftKingsPoints: Number(row.projectedDraftKingsPoints),
      actualDraftKingsPoints: Number(row.actualDraftKingsPoints),
    };
  }).filter((row) => row.date
    && Number.isFinite(row.lineupSlot)
    && Number.isFinite(row.projectedDraftKingsPoints)
    && Number.isFinite(row.actualDraftKingsPoints));
}

export function toCsv(rows) {
  if (!rows.length) return '';
  const columns = Object.keys(rows[0]);
  const cell = (value) => {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return `${columns.join(',')}\n${rows.map((row) => columns.map((column) => cell(row[column])).join(',')).join('\n')}\n`;
}

function calibratedBase(row, featureNames, coefficients) {
  const correction = features(row, featureNames)
    .reduce((sum, value, index) => sum + value * coefficients[index], 0);
  return row.projectedDraftKingsPoints + correction;
}

function features(row, names) {
  const projection = row.projectedDraftKingsPoints;
  const values = {
    intercept: 1,
    projection: (projection - 8) / 2,
    above8: Math.max(0, projection - 8) / 2,
    above10: Math.max(0, projection - 10) / 2,
  };
  for (let slot = 2; slot <= 9; slot += 1) values[`slot${slot}`] = row.lineupSlot === slot ? 1 : 0;
  return names.map((name) => values[name]);
}

function playerKey(row) {
  return String(row.fangraphsPlayerId || row.mlbPlayerId || '').trim();
}

function recencyWeight(date, asOfDate, halfLifeDays) {
  if (!Number.isFinite(halfLifeDays)) return 1;
  const elapsedDays = Math.max(0, (Date.parse(`${asOfDate}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / DAY_MS);
  return 0.5 ** (elapsedDays / halfLifeDays);
}

function solveLinearSystem(matrix, vector) {
  const n = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < n; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    if (Math.abs(divisor) < 1e-12) throw new Error('Calibration matrix is singular.');
    for (let index = column; index <= n; index += 1) augmented[column][index] /= divisor;
    for (let row = 0; row < n; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let index = column; index <= n; index += 1) augmented[row][index] -= factor * augmented[column][index];
    }
  }
  return augmented.map((row) => row[n]);
}

export function csvRecords(text) {
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ',') { record.push(field); field = ''; }
    else if (character === '\n') { record.push(field.replace(/\r$/, '')); records.push(record); record = []; field = ''; }
    else field += character;
  }
  if (field || record.length) { record.push(field.replace(/\r$/, '')); records.push(record); }
  return records;
}

function maxDate(values) { return [...values].sort().at(-1) || ''; }
function finiteNumber(value, fallback) { return Number.isFinite(Number(value)) ? Number(value) : fallback; }
function mean(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function correlation(xs, ys) {
  const xMean = mean(xs);
  const yMean = mean(ys);
  let numerator = 0;
  let xSum = 0;
  let ySum = 0;
  for (let index = 0; index < xs.length; index += 1) {
    const x = xs[index] - xMean;
    const y = ys[index] - yMean;
    numerator += x * y;
    xSum += x ** 2;
    ySum += y ** 2;
  }
  return xSum && ySum ? numerator / Math.sqrt(xSum * ySum) : null;
}
function round(value, digits = 2) { return value == null ? null : Number(value.toFixed(digits)); }
