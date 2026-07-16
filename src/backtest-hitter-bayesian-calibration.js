import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  candidateModels,
  fitBayesianCalibration,
  parseCsv,
  predictBayesianCalibration,
  predictionMetrics,
  toCsv,
} from './hitter-bayesian-calibration.js';

const args = parseArgs(process.argv.slice(2));
const input = resolve(args.input || 'out/hitter-direct-projections-2026-05-04-to-2026-07-12-hitters.csv');
const holdoutStart = args.holdoutStart || '2026-07-06';
const minTrainingDates = positiveInteger(args.minTrainingDates, 3);
const outputPrefix = resolve(args.outputPrefix || `out/hitter-bayesian-calibration-holdout-${holdoutStart}`);

await main();

async function main() {
  const rows = parseCsv(await readFile(input, 'utf8'));
  const dates = [...new Set(rows.map((row) => row.date))].sort();
  const developmentDates = dates.filter((date) => date < holdoutStart);
  const holdoutDates = dates.filter((date) => date >= holdoutStart);
  if (developmentDates.length <= minTrainingDates) throw new Error('Not enough pre-holdout dates for rolling model selection.');
  if (!holdoutDates.length) throw new Error('No holdout rows found.');

  const validationDates = developmentDates.slice(minTrainingDates);
  const candidates = candidateModels();
  const candidateScores = candidates.map((candidate) => {
    const predictions = [];
    for (const validationDate of validationDates) {
      const trainingRows = rows.filter((row) => row.date < validationDate);
      const validationRows = rows.filter((row) => row.date === validationDate);
      const model = fitBayesianCalibration(trainingRows, { ...candidate, asOfDate: validationDate });
      for (const row of validationRows) predictions.push({ row, prediction: predictBayesianCalibration(row, model) });
    }
    const metrics = predictionMetrics(predictions.map(({ row }) => row), (_, index) => predictions[index].prediction);
    const errors = predictions.map(({ row, prediction }) => row.actualDraftKingsPoints - prediction);
    return {
      ...candidate,
      metrics,
      selectionRmse: Math.sqrt(errors.reduce((sum, value) => sum + value ** 2, 0) / errors.length),
      selectionMae: errors.reduce((sum, value) => sum + Math.abs(value), 0) / errors.length,
    };
  }).sort(compareCandidates);

  const selected = candidateScores[0];
  const developmentRows = rows.filter((row) => row.date < holdoutStart);
  const holdoutRows = rows.filter((row) => row.date >= holdoutStart);
  const finalModel = fitBayesianCalibration(developmentRows, { ...selected, asOfDate: holdoutStart });
  const evaluated = holdoutRows.map((row) => {
    const calibrated = predictBayesianCalibration(row, finalModel);
    return {
      ...row,
      baselineProjection: round(row.projectedDraftKingsPoints),
      bayesianProjection: round(calibrated),
      bayesianAdjustment: round(calibrated - row.projectedDraftKingsPoints),
      baselineError: round(row.actualDraftKingsPoints - row.projectedDraftKingsPoints),
      bayesianError: round(row.actualDraftKingsPoints - calibrated),
    };
  });
  const baselineValidation = rollingBaselineMetrics(rows, validationDates);
  const baselineHoldout = predictionMetrics(holdoutRows, (row) => row.projectedDraftKingsPoints);
  const bayesianHoldout = predictionMetrics(evaluated, (row) => row.bayesianProjection);
  const summary = {
    input,
    design: {
      holdoutStart,
      developmentDates,
      rollingValidationDates: validationDates,
      holdoutDates,
      developmentHitters: developmentRows.length,
      holdoutHitters: holdoutRows.length,
      candidateModels: candidates.length,
      selectionMetric: 'lowest rolling-validation RMSE, then MAE',
      leakageControl: 'Every validation prediction uses earlier dates only; the final model is frozen before the holdout starts.',
    },
    selectedModel: {
      featureSet: selected.featureSet,
      ridge: selected.ridge,
      halfLifeDays: displayInfinity(selected.halfLifeDays),
      playerPriorGames: displayInfinity(selected.playerPriorGames),
      coefficients: Object.fromEntries(finalModel.featureNames.map((name, index) => [name, round(finalModel.coefficients[index], 4)])),
      learnedPlayerEffects: finalModel.playerEffects.size,
    },
    rollingValidation: comparison(baselineValidation, selected.metrics),
    untouchedHoldout: comparison(baselineHoldout, bayesianHoldout),
    holdoutByDate: Object.fromEntries(holdoutDates.map((date) => {
      const dateRows = evaluated.filter((row) => row.date === date);
      return [date, comparison(
        predictionMetrics(dateRows, (row) => row.baselineProjection),
        predictionMetrics(dateRows, (row) => row.bayesianProjection),
      )];
    })),
    topCandidates: candidateScores.slice(0, 10).map((candidate) => ({
      featureSet: candidate.featureSet,
      ridge: candidate.ridge,
      halfLifeDays: displayInfinity(candidate.halfLifeDays),
      playerPriorGames: displayInfinity(candidate.playerPriorGames),
      rollingValidationMetrics: candidate.metrics,
    })),
  };

  await mkdir(dirname(outputPrefix), { recursive: true });
  await writeFile(`${outputPrefix}-hitters.csv`, toCsv(evaluated), 'utf8');
  await writeFile(`${outputPrefix}-summary.json`, JSON.stringify(summary, null, 2), 'utf8');
  printSummary(summary);
}

function rollingBaselineMetrics(rows, validationDates) {
  const validation = rows.filter((row) => validationDates.includes(row.date));
  return predictionMetrics(validation, (row) => row.projectedDraftKingsPoints);
}

function comparison(baseline, bayesian) {
  return {
    baseline,
    bayesian,
    improvement: {
      meanAbsoluteError: round(baseline.meanAbsoluteError - bayesian.meanAbsoluteError),
      meanAbsoluteErrorPercent: percentReduction(baseline.meanAbsoluteError, bayesian.meanAbsoluteError),
      rootMeanSquaredError: round(baseline.rootMeanSquaredError - bayesian.rootMeanSquaredError),
      rootMeanSquaredErrorPercent: percentReduction(baseline.rootMeanSquaredError, bayesian.rootMeanSquaredError),
      correlation: round(bayesian.correlation - baseline.correlation, 4),
    },
  };
}

function compareCandidates(left, right) {
  return left.selectionRmse - right.selectionRmse
    || left.selectionMae - right.selectionMae
    || modelComplexity(left) - modelComplexity(right);
}

function modelComplexity(candidate) {
  const features = { offset: 1, affine: 2, nonlinear: 4, 'nonlinear-lineup': 12 }[candidate.featureSet];
  return features + (Number.isFinite(candidate.playerPriorGames) ? 1 : 0);
}

function percentReduction(baseline, calibrated) {
  return round(100 * (baseline - calibrated) / baseline, 2);
}

function displayInfinity(value) { return Number.isFinite(value) ? value : 'none'; }
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

function printSummary(summary) {
  console.log(`Selected: ${JSON.stringify(summary.selectedModel)}`);
  console.log('Rolling validation:');
  console.table(summary.rollingValidation);
  console.log('Untouched holdout:');
  console.table(summary.untouchedHoldout);
  console.log(`Wrote ${outputPrefix}-hitters.csv`);
  console.log(`Wrote ${outputPrefix}-summary.json`);
}
