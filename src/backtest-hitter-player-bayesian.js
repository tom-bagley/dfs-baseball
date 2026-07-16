import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseCsv, predictionMetrics, toCsv } from './hitter-bayesian-calibration.js';
import {
  fitPlayerBayesianModel,
  playerBayesianCandidates,
  predictPlayerBayesian,
} from './hitter-player-bayesian.js';

const args = parseArgs(process.argv.slice(2));
const input = resolve(args.input || 'out/hitter-direct-projections-2026-05-04-to-2026-07-12-hitters.csv');
const holdoutStart = args.holdoutStart || '2026-07-06';
const minTrainingDates = positiveInteger(args.minTrainingDates, 3);
const outputPrefix = resolve(args.outputPrefix || `out/hitter-player-bayesian-holdout-${holdoutStart}`);

await main();

async function main() {
  const rows = parseCsv(await readFile(input, 'utf8'));
  requireComponents(rows);
  const dates = [...new Set(rows.map((row) => row.date))].sort();
  const developmentDates = dates.filter((date) => date < holdoutStart);
  const validationDates = developmentDates.slice(minTrainingDates);
  const holdoutDates = dates.filter((date) => date >= holdoutStart);
  if (!validationDates.length || !holdoutDates.length) throw new Error('Insufficient development or holdout dates.');

  const scored = playerBayesianCandidates().map((candidate) => scoreCandidate(rows, validationDates, candidate));
  scored.sort((left, right) => left.rmse - right.rmse || left.mae - right.mae);
  const selected = scored[0];
  const developmentRows = rows.filter((row) => row.date < holdoutStart);
  const holdoutRows = rows.filter((row) => row.date >= holdoutStart);
  const model = fitPlayerBayesianModel(developmentRows, { ...selected, asOfDate: holdoutStart });
  const evaluated = holdoutRows.map((row) => ({
    ...row,
    baselineProjection: round(row.projectedDraftKingsPoints),
    playerBayesianProjection: round(predictPlayerBayesian(row, model)),
  }));
  const baselineValidationRows = rows.filter((row) => validationDates.includes(row.date));
  const baselineValidation = predictionMetrics(baselineValidationRows, (row) => row.projectedDraftKingsPoints);
  const baselineHoldout = predictionMetrics(evaluated, (row) => row.baselineProjection);
  const bayesianHoldout = predictionMetrics(evaluated, (row) => row.playerBayesianProjection);
  const summary = {
    input,
    design: {
      holdoutStart,
      developmentDates,
      rollingValidationDates: validationDates,
      holdoutDates,
      developmentHitters: developmentRows.length,
      holdoutHitters: holdoutRows.length,
      candidateModels: scored.length,
      leakageControl: 'Each player posterior contains results from dates strictly before the prediction date; the final model is frozen before holdout.',
    },
    selectedModel: displayCandidate(selected),
    rollingValidation: comparison(baselineValidation, selected.metrics),
    untouchedHoldout: comparison(baselineHoldout, bayesianHoldout),
    holdoutByDate: Object.fromEntries(holdoutDates.map((date) => {
      const dateRows = evaluated.filter((row) => row.date === date);
      return [date, comparison(
        predictionMetrics(dateRows, (row) => row.baselineProjection),
        predictionMetrics(dateRows, (row) => row.playerBayesianProjection),
      )];
    })),
    topCandidates: scored.slice(0, 10).map((candidate) => ({
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
}

function scoreCandidate(rows, validationDates, candidate) {
  const predictions = [];
  for (const date of validationDates) {
    const training = rows.filter((row) => row.date < date);
    const validation = rows.filter((row) => row.date === date);
    const model = fitPlayerBayesianModel(training, { ...candidate, asOfDate: date });
    for (const row of validation) predictions.push({ row, prediction: predictPlayerBayesian(row, model) });
  }
  const errors = predictions.map(({ row, prediction }) => row.actualDraftKingsPoints - prediction);
  return {
    ...candidate,
    rmse: Math.sqrt(errors.reduce((sum, value) => sum + value ** 2, 0) / errors.length),
    mae: errors.reduce((sum, value) => sum + Math.abs(value), 0) / errors.length,
    metrics: predictionMetrics(predictions.map(({ row }) => row), (_, index) => predictions[index].prediction),
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
    mode: candidate.mode,
    priorStrength: candidate.priorStrength,
    halfLifeDays: Number.isFinite(candidate.halfLifeDays) ? candidate.halfLifeDays : 'none',
    multiplierCap: candidate.multiplierCap,
  };
}

function requireComponents(rows) {
  if (!rows.length || !Number.isFinite(rows[0].projectedHomeRuns) || !Number.isFinite(rows[0].actualHomeRuns)) {
    throw new Error('Input is missing projected/actual component columns; rerun analyze-hitter-direct-projections.js.');
  }
}
function round(value, digits = 2) { return Number(Number(value).toFixed(digits)); }
function positiveInteger(value, fallback) { const number = Number(value); return Number.isInteger(number) && number > 0 ? number : fallback; }
function parseArgs(tokens) {
  const parsed = {};
  for (let index = 0; index < tokens.length; index += 1) {
    if (!tokens[index].startsWith('--')) continue;
    const key = tokens[index].slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    parsed[key] = tokens[index + 1];
    index += 1;
  }
  return parsed;
}
