import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseCsv, predictionMetrics, toCsv } from './hitter-bayesian-calibration.js';
import {
  loadSeasonHistories,
  predictSeasonBayesian,
  seasonBayesianCandidates,
} from './hitter-season-bayesian.js';

const args = parseArgs(process.argv.slice(2));
const input = resolve(args.input || 'out/hitter-direct-projections-2026-05-04-to-2026-07-12-hitters.csv');
const historyDir = resolve(args.historyDir || 'out/cache/hitter-season-histories/2026');
const holdoutStart = args.holdoutStart || '2026-07-06';
const minTrainingDates = positiveInteger(args.minTrainingDates, 3);
const outputPrefix = resolve(args.outputPrefix || `out/hitter-season-bayesian-holdout-${holdoutStart}`);

const rows = parseCsv(await readFile(input, 'utf8'));
const histories = await loadSeasonHistories(historyDir);
const dates = [...new Set(rows.map((row) => row.date))].sort();
const developmentDates = dates.filter((date) => date < holdoutStart);
const validationDates = developmentDates.slice(minTrainingDates);
const holdoutDates = dates.filter((date) => date >= holdoutStart);
if (!validationDates.length || !holdoutDates.length) throw new Error('Insufficient development or holdout dates.');

const candidates = seasonBayesianCandidates().map((candidate) => scoreCandidate(candidate));
candidates.sort((left, right) => left.rmse - right.rmse || left.mae - right.mae);
const selected = candidates[0];
const rankingSelected = [...candidates].sort((left, right) => right.meanDailyCorrelation - left.meanDailyCorrelation || left.rmse - right.rmse)[0];
const holdoutRows = rows.filter((row) => row.date >= holdoutStart);
const evaluated = holdoutRows.map((row) => ({
  ...row,
  baselineProjection: round(row.projectedDraftKingsPoints),
  seasonBayesianProjection: round(predictSeasonBayesian(row, histories, selected)),
}));
const validationRows = rows.filter((row) => validationDates.includes(row.date));
const baselineValidation = predictionMetrics(validationRows, (row) => row.projectedDraftKingsPoints);
const baselineHoldout = predictionMetrics(evaluated, (row) => row.baselineProjection);
const bayesianHoldout = predictionMetrics(evaluated, (row) => row.seasonBayesianProjection);
const rankingEvaluated = holdoutRows.map((row) => ({
  ...row,
  baselineProjection: round(row.projectedDraftKingsPoints),
  seasonBayesianProjection: round(predictSeasonBayesian(row, histories, rankingSelected)),
}));
const rankingBayesianHoldout = predictionMetrics(rankingEvaluated, (row) => row.seasonBayesianProjection);
const summary = {
  input,
  historyDir,
  design: {
    holdoutStart,
    developmentDates,
    rollingValidationDates: validationDates,
    holdoutDates,
    seasonHistories: histories.size,
    holdoutHitters: holdoutRows.length,
    candidateModels: candidates.length,
    leakageControl: 'Hyperparameters use development dates only. Every season-to-date posterior filters MLB game logs to dates strictly before the projected game.',
  },
  selectedModel: displayCandidate(selected),
  rankingSelectedModel: displayCandidate(rankingSelected),
  rollingValidation: comparison(baselineValidation, selected.metrics),
  untouchedHoldout: comparison(baselineHoldout, bayesianHoldout),
  rankingSelectedHoldout: {
    ...comparison(baselineHoldout, rankingBayesianHoldout),
    ranking: {
      baseline: rankingMetrics(holdoutRows, (row) => row.projectedDraftKingsPoints),
      bayesian: rankingMetrics(rankingEvaluated, (row) => row.seasonBayesianProjection),
    },
  },
  holdoutByDate: Object.fromEntries(holdoutDates.map((date) => {
    const dateRows = evaluated.filter((row) => row.date === date);
    return [date, comparison(
      predictionMetrics(dateRows, (row) => row.baselineProjection),
      predictionMetrics(dateRows, (row) => row.seasonBayesianProjection),
    )];
  })),
  topCandidates: candidates.slice(0, 10).map((candidate) => ({
    ...displayCandidate(candidate), rollingValidationMetrics: candidate.metrics,
  })),
};

await mkdir(dirname(outputPrefix), { recursive: true });
await writeFile(`${outputPrefix}-hitters.csv`, toCsv(evaluated), 'utf8');
await writeFile(`${outputPrefix}-summary.json`, JSON.stringify(summary, null, 2), 'utf8');
console.log(`Selected ${JSON.stringify(summary.selectedModel)}`);
console.table(summary.rollingValidation);
console.table(summary.untouchedHoldout);
console.log(`Wrote ${outputPrefix}-summary.json`);

function scoreCandidate(candidate) {
  const validation = rows.filter((row) => validationDates.includes(row.date));
  const predictions = validation.map((row) => predictSeasonBayesian(row, histories, candidate));
  const predictionByRow = new Map(validation.map((row, index) => [row, predictions[index]]));
  const errors = validation.map((row, index) => row.actualDraftKingsPoints - predictions[index]);
  return {
    ...candidate,
    rmse: Math.sqrt(errors.reduce((sum, value) => sum + value ** 2, 0) / errors.length),
    mae: errors.reduce((sum, value) => sum + Math.abs(value), 0) / errors.length,
    metrics: predictionMetrics(validation, (_, index) => predictions[index]),
    meanDailyCorrelation: rankingMetrics(validation, (row) => predictionByRow.get(row)).meanDailyCorrelation,
  };
}

function comparison(baseline, bayesian) {
  return {
    baseline,
    bayesian,
    improvement: {
      meanAbsoluteError: round(baseline.meanAbsoluteError - bayesian.meanAbsoluteError),
      meanAbsoluteErrorPercent: round(100 * (baseline.meanAbsoluteError - bayesian.meanAbsoluteError) / baseline.meanAbsoluteError),
      rootMeanSquaredError: round(baseline.rootMeanSquaredError - bayesian.rootMeanSquaredError),
      rootMeanSquaredErrorPercent: round(100 * (baseline.rootMeanSquaredError - bayesian.rootMeanSquaredError) / baseline.rootMeanSquaredError),
      correlation: round(bayesian.correlation - baseline.correlation, 4),
    },
  };
}
function displayCandidate(candidate) {
  return {
    priorPlateAppearances: candidate.priorPlateAppearances,
    halfLifeDays: Number.isFinite(candidate.halfLifeDays) ? candidate.halfLifeDays : 'none',
    multiplierCap: candidate.multiplierCap,
    adaptiveSensitivity: candidate.adaptiveSensitivity,
    disagreementThreshold: candidate.disagreementThreshold,
    disagreementMode: candidate.disagreementMode,
    gateUpdates: Boolean(candidate.gateUpdates),
    requirePersistentDisagreement: Boolean(candidate.requirePersistentDisagreement),
    minimumEvidencePA: Number(candidate.minimumEvidencePA || 0),
  };
}
function rankingMetrics(rows, predictor) {
  const dates = [...new Set(rows.map((row) => row.date))];
  const daily = dates.map((date) => {
    const dateRows = rows.filter((row) => row.date === date);
    const predictions = dateRows.map(predictor);
    const actual = dateRows.map((row) => row.actualDraftKingsPoints);
    const ordered = dateRows.map((row, index) => ({ row, prediction: predictions[index] }))
      .sort((left, right) => right.prediction - left.prediction);
    const topCount = Math.max(1, Math.ceil(ordered.length * 0.1));
    return {
      correlation: rawCorrelation(predictions, actual),
      top10PercentActualAverage: ordered.slice(0, topCount)
        .reduce((sum, value) => sum + value.row.actualDraftKingsPoints, 0) / topCount,
    };
  });
  return {
    meanDailyCorrelation: round(daily.reduce((sum, value) => sum + value.correlation, 0) / daily.length, 4),
    meanTop10PercentActualAverage: round(daily.reduce((sum, value) => sum + value.top10PercentActualAverage, 0) / daily.length),
  };
}
function rawCorrelation(xs, ys) {
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const xMean = mean(xs); const yMean = mean(ys);
  let numerator = 0; let xSum = 0; let ySum = 0;
  for (let index = 0; index < xs.length; index += 1) {
    const x = xs[index] - xMean; const y = ys[index] - yMean;
    numerator += x * y; xSum += x ** 2; ySum += y ** 2;
  }
  return xSum && ySum ? numerator / Math.sqrt(xSum * ySum) : 0;
}
function round(value, digits = 2) { return Number(Number(value).toFixed(digits)); }
function positiveInteger(value, fallback) { const number = Number(value); return Number.isInteger(number) && number > 0 ? number : fallback; }
function parseArgs(tokens) {
  const parsed = {};
  for (let index = 0; index < tokens.length; index += 1) {
    if (!tokens[index].startsWith('--')) continue;
    const key = tokens[index].slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    parsed[key] = tokens[index + 1]; index += 1;
  }
  return parsed;
}
