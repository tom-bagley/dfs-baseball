import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseCsv, toCsv } from './hitter-bayesian-calibration.js';
import { HITTER_COMPONENTS } from './hitter-player-bayesian.js';
import { loadSeasonHistories } from './hitter-season-bayesian.js';
import { loadStatcastHitterDays, statcastFeaturesBefore } from './statcast-hitter-features.js';

const DAY_MS = 86400000;
const args = parseArgs(process.argv.slice(2));
const input = resolve(args.input || 'out/hitter-direct-projections-2026-05-04-to-2026-07-12-hitters.csv');
const seasonHistoryDir = resolve(args.seasonHistoryDir || 'out/cache/hitter-season-histories/2026');
const statcastDir = resolve(args.statcastDir || 'out/cache/statcast/chunks');
const horizonDays = Number(args.horizonDays || 7);
const holdoutStart = args.holdoutStart || '2026-07-06';
const outputPrefix = resolve(args.outputPrefix || `out/hitter-forward-disagreements-${horizonDays}d-holdout-${holdoutStart}`);

const rawRows = parseCsv(await readFile(input, 'utf8'));
const histories = await loadSeasonHistories(seasonHistoryDir);
const statcast = await loadStatcastHitterDays(statcastDir);
const lastHistoryDate = [...histories.values()].flat().reduce((latest, game) => game.date > latest ? game.date : latest, '');
const completeThroughExclusive = addDays(lastHistoryDate, 1);
const anchors = uniqueAnchors(rawRows).map(buildAnchor).filter((row) => (
  row.targetEnd <= completeThroughExclusive && row.futurePlateAppearances >= 12
));
const dates = [...new Set(anchors.map((row) => row.date))].sort();
const developmentDates = dates.filter((date) => date < holdoutStart);
const validationDates = developmentDates.filter((date) => eligibleTraining(anchors, date).length >= 100);
const candidates = candidateOptions().map(scoreCandidate);
const selected = [...candidates].sort((a, b) => a.validationWeightedRmse - b.validationWeightedRmse || b.validationCorrelation - a.validationCorrelation)[0];
const rankingSelected = [...candidates].sort((a, b) => b.validationCorrelation - a.validationCorrelation || a.validationWeightedRmse - b.validationWeightedRmse)[0];
const holdout = anchors.filter((row) => row.date >= holdoutStart);
const training = eligibleTraining(anchors, holdoutStart);
const errorModel = fit(training, selected.options);
const rankingModel = fit(training, rankingSelected.options);
const evaluated = holdout.map((row) => evaluateRow(row, errorModel, rankingModel));
const summary = {
  design: {
    horizonDays, holdoutStart, developmentDates, validationDates,
    anchors: anchors.length, trainingAnchors: training.length, holdoutAnchors: holdout.length,
    minimumFuturePlateAppearances: 12, lastHistoryDate, completeThroughExclusive,
    leakageControl: 'A training target is used only when its entire forward horizon ends on or before the prediction date.',
  },
  errorSelectedModel: describe(selected, errorModel),
  rankingSelectedModel: describe(rankingSelected, rankingModel),
  holdout: {
    baseline: metrics(evaluated, 'baselineRate'),
    errorSelected: metrics(evaluated, 'errorAdjustedRate'),
    rankingSelected: metrics(evaluated, 'rankingAdjustedRate'),
    largestDisagreements: disagreementMetrics(evaluated),
  },
  jordanWalker: evaluated.filter((row) => row.projectedPlayerName === 'Jordan Walker'),
  topCandidates: [...candidates].sort((a, b) => a.validationWeightedRmse - b.validationWeightedRmse).slice(0, 12)
    .map((candidate) => describe(candidate)),
};
await mkdir(dirname(outputPrefix), { recursive: true });
await writeFile(`${outputPrefix}-players.csv`, toCsv(evaluated), 'utf8');
await writeFile(`${outputPrefix}-summary.json`, JSON.stringify(summary, null, 2), 'utf8');
console.log(`Error selected: ${JSON.stringify(summary.errorSelectedModel)}`);
console.log(`Ranking selected: ${JSON.stringify(summary.rankingSelectedModel)}`);
console.table(summary.holdout);
console.log(`Wrote ${outputPrefix}-summary.json`);

function buildAnchor(rows) {
  const representative = averageProjectionRows(rows);
  const games = histories.get(String(representative.mlbPlayerId)) || [];
  const before = aggregateGames(games, null, representative.date);
  const futureEnd = addDays(representative.date, horizonDays);
  const future = aggregateGames(games, representative.date, futureEnd);
  const features = statcastFeaturesBefore(representative, statcast, { recentDays: 30 });
  const baselineRate = representative.projectedDraftKingsPoints / representative.projectedPlateAppearances;
  const priorActualRate = before.plateAppearances ? before.points / before.plateAppearances : baselineRate;
  return {
    ...representative, ...features,
    targetEnd: futureEnd,
    baselineRate,
    priorActualRate,
    outcomeRateDifference: priorActualRate - baselineRate,
    futurePlateAppearances: future.plateAppearances,
    futurePoints: future.points,
    futureRate: future.plateAppearances ? future.points / future.plateAppearances : null,
  };
}

function scoreCandidate(options) {
  const predictions = [];
  for (const date of validationDates) {
    const trainingRows = eligibleTraining(anchors, date);
    const model = fit(trainingRows, options);
    for (const row of anchors.filter((value) => value.date === date)) predictions.push(evaluateRow(row, model, model));
  }
  const result = metrics(predictions, 'errorAdjustedRate');
  return { options, validationWeightedRmse: result.weightedRmse, validationCorrelation: result.correlation };
}

function fit(rows, options) {
  const names = featureNames(options.featureSet);
  const matrix = names.map(() => names.map(() => 0));
  const vector = names.map(() => 0);
  for (const row of rows) {
    const x = featureVector(row, options);
    const residual = row.futureRate - row.baselineRate;
    const weight = Math.min(35, row.futurePlateAppearances) / 20;
    for (let i = 0; i < x.length; i += 1) {
      vector[i] += weight * x[i] * residual;
      for (let j = 0; j < x.length; j += 1) matrix[i][j] += weight * x[i] * x[j];
    }
  }
  for (let i = 0; i < names.length; i += 1) matrix[i][i] += options.ridge;
  return { ...options, names, coefficients: solve(matrix, vector) };
}

function evaluateRow(row, errorModel, rankingModel) {
  const errorAdjustment = predictAdjustment(row, errorModel);
  const rankingAdjustment = predictAdjustment(row, rankingModel);
  return {
    ...row,
    errorAdjustedRate: Math.max(0, row.baselineRate + errorAdjustment),
    errorAdjustmentRate: errorAdjustment,
    rankingAdjustedRate: Math.max(0, row.baselineRate + rankingAdjustment),
    rankingAdjustmentRate: rankingAdjustment,
  };
}

function predictAdjustment(row, model) {
  const raw = featureVector(row, model).reduce((sum, value, index) => sum + value * model.coefficients[index], 0);
  return clamp(raw, -model.maxAdjustmentRate, model.maxAdjustmentRate);
}

function featureNames(featureSet) {
  if (featureSet === 'xwoba') return ['seasonXwobaDifference', 'recentXwobaDifference'];
  if (featureSet === 'xwoba-spline') return ['seasonXwobaDifference', 'recentXwobaDifference', 'seasonXwobaTail'];
  if (featureSet === 'confirmed') return ['seasonXwobaDifference', 'recentXwobaDifference', 'confirmedOutcome'];
  if (featureSet === 'confirmed-spline') return ['seasonXwobaDifference', 'recentXwobaDifference', 'seasonXwobaTail', 'confirmedOutcome'];
  if (featureSet === 'skills') return ['seasonXwobaDifference', 'recentXwobaDifference', 'exitVelocity', 'barrelRate', 'hardHitRate'];
  if (featureSet === 'skills-confirmed') return ['seasonXwobaDifference', 'recentXwobaDifference', 'exitVelocity', 'barrelRate', 'hardHitRate', 'confirmedOutcome'];
  throw new Error(`Unknown feature set: ${featureSet}`);
}

function featureVector(row, options) {
  const seasonReliability = row.seasonPlateAppearances / (row.seasonPlateAppearances + options.reliabilityPA);
  const recentReliability = row.recentPlateAppearances / (row.recentPlateAppearances + options.reliabilityPA / 2);
  const outcomeReliability = Math.min(1, row.seasonPlateAppearances / (options.reliabilityPA * 2));
  const sameDirection = Math.sign(row.outcomeRateDifference) === Math.sign(row.seasonXwobaDifference);
  const values = {
    seasonXwobaDifference: 10 * row.seasonXwobaDifference * seasonReliability,
    recentXwobaDifference: 10 * row.recentXwobaDifference * recentReliability,
    seasonXwobaTail: 10 * signedExcess(row.seasonXwobaDifference, options.tailThreshold || 0.03) * seasonReliability,
    exitVelocity: ((row.seasonAverageExitVelocity - 89) / 4) * seasonReliability,
    barrelRate: 10 * (row.seasonBarrelRate - 0.08) * seasonReliability,
    hardHitRate: 5 * (row.seasonHardHitRate - 0.40) * seasonReliability,
    confirmedOutcome: sameDirection ? clamp(row.outcomeRateDifference, -2, 2) * outcomeReliability : 0,
  };
  return featureNames(options.featureSet).map((name) => Number.isFinite(values[name]) ? values[name] : 0);
}

function metrics(rows, predictionKey) {
  if (!rows.length) return {};
  let weight = 0; let squared = 0; let absolute = 0;
  for (const row of rows) {
    const w = row.futurePlateAppearances;
    const error = row.futureRate - row[predictionKey];
    weight += w; squared += w * error ** 2; absolute += w * Math.abs(error);
  }
  return {
    players: rows.length,
    plateAppearances: weight,
    weightedMae: round(absolute / weight, 4),
    weightedRmse: round(Math.sqrt(squared / weight), 4),
    correlation: round(correlation(rows.map((row) => row[predictionKey]), rows.map((row) => row.futureRate)), 4),
    top20PercentActualRate: round(topActual(rows, predictionKey, 0.2), 4),
  };
}

function disagreementMetrics(rows) {
  const cutoff = quantile(rows.map((row) => Math.abs(row.rankingAdjustmentRate)), 0.8);
  const largest = rows.filter((row) => Math.abs(row.rankingAdjustmentRate) >= cutoff && Math.abs(row.rankingAdjustmentRate) > 0);
  return {
    cutoff: round(cutoff, 4), count: largest.length,
    baseline: metrics(largest, 'baselineRate'), rankingSelected: metrics(largest, 'rankingAdjustedRate'),
    directionAccuracy: round(largest.filter((row) => Math.sign(row.rankingAdjustmentRate) === Math.sign(row.futureRate - row.baselineRate)).length / largest.length, 4),
  };
}

function eligibleTraining(rows, predictionDate) {
  return rows.filter((row) => addDays(row.date, horizonDays) <= predictionDate);
}
function uniqueAnchors(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = `${row.date}|${row.mlbPlayerId}`;
    const values = grouped.get(key) || []; values.push(row); grouped.set(key, values);
  }
  return [...grouped.values()];
}
function averageProjectionRows(rows) {
  const result = { ...rows[0] };
  const numeric = ['projectedDraftKingsPoints', 'projectedPlateAppearances', ...HITTER_COMPONENTS.map((component) => `projected${component.key}`)];
  for (const key of numeric) result[key] = rows.reduce((sum, row) => sum + Number(row[key] || 0), 0) / rows.length;
  return result;
}
function aggregateGames(games, start, end) {
  let plateAppearances = 0; let points = 0;
  for (const game of games) {
    if (start && game.date < start) continue;
    if (end && game.date >= end) continue;
    plateAppearances += game.plateAppearances;
    for (const component of HITTER_COMPONENTS) points += component.points * game[component.key];
  }
  return { plateAppearances, points };
}
function candidateOptions() {
  const values = [];
  for (const featureSet of ['xwoba', 'confirmed', 'skills', 'skills-confirmed']) {
    for (const ridge of [1, 4, 16, 64, 256]) for (const reliabilityPA of [50, 100, 200, 400]) {
      for (const maxAdjustmentRate of [0.25, 0.5, 1]) values.push({ featureSet, ridge, reliabilityPA, maxAdjustmentRate });
    }
  }
  for (const featureSet of ['xwoba-spline', 'confirmed-spline']) {
    for (const tailThreshold of [0.015, 0.03, 0.045]) for (const ridge of [1, 4, 16, 64, 256]) {
      for (const reliabilityPA of [50, 100, 200, 400]) for (const maxAdjustmentRate of [0.25, 0.5, 1]) {
        values.push({ featureSet, tailThreshold, ridge, reliabilityPA, maxAdjustmentRate });
      }
    }
  }
  return values;
}
function describe(candidate, model = null) {
  const result = { ...candidate.options, validationWeightedRmse: round(candidate.validationWeightedRmse, 4), validationCorrelation: round(candidate.validationCorrelation, 4) };
  if (model) result.coefficients = Object.fromEntries(model.names.map((name, index) => [name, round(model.coefficients[index], 6)]));
  return result;
}
function topActual(rows, key, share) {
  const top = [...rows].sort((a, b) => b[key] - a[key]).slice(0, Math.max(1, Math.ceil(rows.length * share)));
  return top.reduce((sum, row) => sum + row.futureRate, 0) / top.length;
}
function correlation(xs, ys) { const mean=(v)=>v.reduce((s,x)=>s+x,0)/v.length; const xm=mean(xs),ym=mean(ys); let n=0,xd=0,yd=0; for(let i=0;i<xs.length;i++){const x=xs[i]-xm,y=ys[i]-ym;n+=x*y;xd+=x*x;yd+=y*y;} return xd&&yd?n/Math.sqrt(xd*yd):0; }
function solve(matrix, vector) { const n=vector.length,a=matrix.map((r,i)=>[...r,vector[i]]); for(let c=0;c<n;c++){let p=c;for(let r=c+1;r<n;r++)if(Math.abs(a[r][c])>Math.abs(a[p][c]))p=r;[a[c],a[p]]=[a[p],a[c]];const d=a[c][c];if(Math.abs(d)<1e-12)throw new Error('Singular matrix');for(let i=c;i<=n;i++)a[c][i]/=d;for(let r=0;r<n;r++){if(r===c)continue;const f=a[r][c];for(let i=c;i<=n;i++)a[r][i]-=f*a[c][i];}}return a.map((r)=>r[n]); }
function quantile(values, q) { const sorted=[...values].sort((a,b)=>a-b); return sorted[Math.min(sorted.length-1,Math.floor(q*(sorted.length-1)))]; }
function addDays(date, days) { return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10); }
function clamp(value, low, high) { return Math.max(low, Math.min(high, value)); }
function signedExcess(value, threshold) { return Math.sign(value) * Math.max(0, Math.abs(value) - threshold); }
function round(value, digits = 4) { return Number(Number(value).toFixed(digits)); }
function parseArgs(tokens) { const parsed={};for(let i=0;i<tokens.length;i++){if(tokens[i].startsWith('--')){parsed[tokens[i].slice(2).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=tokens[i+1];i++;}}return parsed; }
