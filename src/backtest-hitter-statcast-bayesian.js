import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseCsv, predictionMetrics, toCsv } from './hitter-bayesian-calibration.js';
import { loadSeasonHistories } from './hitter-season-bayesian.js';
import { loadStatcastHitterDays, statcastFeaturesBefore } from './statcast-hitter-features.js';
import { predictStatcastBayesian, statcastBayesianCandidates } from './hitter-statcast-bayesian.js';

const args = parseArgs(process.argv.slice(2));
const input = resolve(args.input || 'out/hitter-direct-projections-2026-05-04-to-2026-07-12-hitters.csv');
const seasonHistoryDir = resolve(args.seasonHistoryDir || 'out/cache/hitter-season-histories/2026');
const statcastDir = resolve(args.statcastDir || 'out/cache/statcast/chunks');
const holdoutStart = args.holdoutStart || '2026-07-06';
const outputPrefix = resolve(args.outputPrefix || `out/hitter-statcast-bayesian-holdout-${holdoutStart}`);

const rows = parseCsv(await readFile(input, 'utf8'));
const seasonHistories = await loadSeasonHistories(seasonHistoryDir);
const statcastHistories = await loadStatcastHitterDays(statcastDir);
const featureByRow = new Map(rows.map((row) => [row, statcastFeaturesBefore(row, statcastHistories, { recentDays: 30 })]));
const dates = [...new Set(rows.map((row) => row.date))].sort();
const developmentDates = dates.filter((date) => date < holdoutStart);
const validationDates = developmentDates.slice(3);
const holdoutDates = dates.filter((date) => date >= holdoutStart);
const validationRows = rows.filter((row) => validationDates.includes(row.date));
const holdoutRows = rows.filter((row) => row.date >= holdoutStart);

const candidates = statcastBayesianCandidates().map(scoreCandidate);
const errorSelected = [...candidates].sort((left, right) => left.rmse - right.rmse || right.meanDailyCorrelation - left.meanDailyCorrelation)[0];
const rankingSelected = [...candidates].sort((left, right) => right.meanDailyCorrelation - left.meanDailyCorrelation || left.rmse - right.rmse)[0];
const errorEvaluation = evaluate(holdoutRows, errorSelected);
const rankingEvaluation = evaluate(holdoutRows, rankingSelected);
const baseline = predictionMetrics(holdoutRows, (row) => row.projectedDraftKingsPoints);
const summary = {
  design: {
    holdoutStart, developmentDates, validationDates, holdoutDates,
    candidates: candidates.length, statcastPlayers: statcastHistories.size,
    leakageControl: 'All Statcast and MLB game-log evidence is filtered strictly before each projection date.',
  },
  errorSelectedModel: errorSelected.options,
  rankingSelectedModel: rankingSelected.options,
  errorSelectedHoldout: comparison(baseline, errorEvaluation.metrics),
  rankingSelectedHoldout: {
    ...comparison(baseline, rankingEvaluation.metrics),
    baselineRanking: rankingMetrics(holdoutRows, (row) => row.projectedDraftKingsPoints),
    bayesianRanking: rankingMetrics(rankingEvaluation.rows, (row) => row.statcastBayesianProjection),
  },
  jordanWalker: walkerComparison(holdoutRows, rankingEvaluation.rows),
  topRankingCandidates: [...candidates].sort((left, right) => right.meanDailyCorrelation - left.meanDailyCorrelation)
    .slice(0, 10).map((candidate) => ({ ...candidate.options, validationMetrics: candidate.metrics, meanDailyCorrelation: candidate.meanDailyCorrelation })),
};
await mkdir(dirname(outputPrefix), { recursive: true });
await writeFile(`${outputPrefix}-hitters.csv`, toCsv(rankingEvaluation.rows), 'utf8');
await writeFile(`${outputPrefix}-summary.json`, JSON.stringify(summary, null, 2), 'utf8');
console.log(`Error selected: ${JSON.stringify(errorSelected.options)}`);
console.log(`Ranking selected: ${JSON.stringify(rankingSelected.options)}`);
console.table(summary.errorSelectedHoldout);
console.table(summary.rankingSelectedHoldout);
console.log(`Wrote ${outputPrefix}-summary.json`);

function scoreCandidate(options) {
  const predictions = validationRows.map((row) => predictStatcastBayesian(
    row, seasonHistories, statcastHistories, options, featureByRow.get(row),
  ));
  const predictionByRow = new Map(validationRows.map((row, index) => [row, predictions[index]]));
  const errors = validationRows.map((row, index) => row.actualDraftKingsPoints - predictions[index]);
  return {
    options,
    rmse: Math.sqrt(errors.reduce((sum, value) => sum + value ** 2, 0) / errors.length),
    metrics: predictionMetrics(validationRows, (_, index) => predictions[index]),
    meanDailyCorrelation: rankingMetrics(validationRows, (row) => predictionByRow.get(row)).meanDailyCorrelation,
  };
}
function evaluate(inputRows, options) {
  const evaluated = inputRows.map((row) => ({
    ...row,
    statcastBayesianProjection: round(predictStatcastBayesian(
      row, seasonHistories, statcastHistories, options.options || options, featureByRow.get(row),
    )),
    ...featureByRow.get(row),
  }));
  return { rows: evaluated, metrics: predictionMetrics(evaluated, (row) => row.statcastBayesianProjection) };
}
function walkerComparison(baselineRows, evaluatedRows) {
  const base = baselineRows.filter((row) => row.projectedPlayerName === 'Jordan Walker');
  const bayes = evaluatedRows.filter((row) => row.projectedPlayerName === 'Jordan Walker');
  return {
    baseline: predictionMetrics(base, (row) => row.projectedDraftKingsPoints),
    bayesian: predictionMetrics(bayes, (row) => row.statcastBayesianProjection),
  };
}
function comparison(baselineMetrics, bayesianMetrics) {
  return {
    baseline: baselineMetrics, bayesian: bayesianMetrics,
    improvement: {
      mae: round(baselineMetrics.meanAbsoluteError - bayesianMetrics.meanAbsoluteError),
      rmse: round(baselineMetrics.rootMeanSquaredError - bayesianMetrics.rootMeanSquaredError),
      correlation: round(bayesianMetrics.correlation - baselineMetrics.correlation, 4),
    },
  };
}
function rankingMetrics(inputRows, predictor) {
  const daily = [...new Set(inputRows.map((row) => row.date))].map((date) => {
    const dateRows = inputRows.filter((row) => row.date === date);
    const predictions = dateRows.map(predictor);
    const actual = dateRows.map((row) => row.actualDraftKingsPoints);
    const ordered = dateRows.map((row, index) => ({ row, prediction: predictions[index] })).sort((a, b) => b.prediction - a.prediction);
    const top = ordered.slice(0, Math.max(1, Math.ceil(ordered.length * 0.1)));
    return { correlation: correlation(predictions, actual), topActual: top.reduce((sum, value) => sum + value.row.actualDraftKingsPoints, 0) / top.length };
  });
  return {
    meanDailyCorrelation: round(daily.reduce((sum, value) => sum + value.correlation, 0) / daily.length, 4),
    meanTop10PercentActual: round(daily.reduce((sum, value) => sum + value.topActual, 0) / daily.length),
  };
}
function correlation(xs, ys) {
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const xm = mean(xs); const ym = mean(ys); let n = 0; let xd = 0; let yd = 0;
  for (let index = 0; index < xs.length; index += 1) { const x = xs[index] - xm; const y = ys[index] - ym; n += x * y; xd += x ** 2; yd += y ** 2; }
  return xd && yd ? n / Math.sqrt(xd * yd) : 0;
}
function round(value, digits = 2) { return Number(Number(value).toFixed(digits)); }
function parseArgs(tokens) {
  const parsed = {};
  for (let index = 0; index < tokens.length; index += 1) { if (tokens[index].startsWith('--')) { parsed[tokens[index].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = tokens[index + 1]; index += 1; } }
  return parsed;
}
