import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseCsv, predictionMetrics, toCsv } from './hitter-bayesian-calibration.js';
import { loadStatcastHitterDays, statcastFeaturesBefore } from './statcast-hitter-features.js';
import { fitStatcastResidualModel, predictStatcastResidual, statcastResidualCandidates } from './statcast-residual-model.js';

const args = parseArgs(process.argv.slice(2));
const input = resolve(args.input || 'out/hitter-direct-projections-2026-05-04-to-2026-07-12-hitters.csv');
const statcastDir = resolve(args.statcastDir || 'out/cache/statcast/chunks');
const holdoutStart = args.holdoutStart || '2026-07-06';
const outputPrefix = resolve(args.outputPrefix || `out/hitter-statcast-regression-holdout-${holdoutStart}`);
const rows = parseCsv(await readFile(input, 'utf8'));
const statcast = await loadStatcastHitterDays(statcastDir);
const features = new Map(rows.map((row) => [row, statcastFeaturesBefore(row, statcast, { recentDays: 30 })]));
const dates = [...new Set(rows.map((row) => row.date))].sort();
const developmentDates = dates.filter((date) => date < holdoutStart);
const validationDates = developmentDates.slice(3);
const holdoutRows = rows.filter((row) => row.date >= holdoutStart);
const scored = statcastResidualCandidates().map(scoreCandidate);
const errorSelected = [...scored].sort((a, b) => a.rmse - b.rmse)[0];
const rankingSelected = [...scored].sort((a, b) => b.dailyCorrelation - a.dailyCorrelation || a.rmse - b.rmse)[0];
const errorEvaluation = evaluate(errorSelected);
const rankingEvaluation = evaluate(rankingSelected);
const baseline = predictionMetrics(holdoutRows, (row) => row.projectedDraftKingsPoints);
const summary = {
  design: { holdoutStart, developmentDates, validationDates, holdoutHitters: holdoutRows.length, candidates: scored.length },
  errorSelectedModel: describe(errorSelected, errorEvaluation.model),
  rankingSelectedModel: describe(rankingSelected, rankingEvaluation.model),
  errorSelectedHoldout: comparison(baseline, errorEvaluation.metrics),
  rankingSelectedHoldout: {
    ...comparison(baseline, rankingEvaluation.metrics),
    baselineRanking: rankingMetrics(holdoutRows, (row) => row.projectedDraftKingsPoints),
    modelRanking: rankingMetrics(rankingEvaluation.rows, (row) => row.statcastRegressionProjection),
  },
  jordanWalker: {
    baseline: predictionMetrics(holdoutRows.filter(isWalker), (row) => row.projectedDraftKingsPoints),
    model: predictionMetrics(rankingEvaluation.rows.filter(isWalker), (row) => row.statcastRegressionProjection),
  },
  topRankingCandidates: [...scored].sort((a, b) => b.dailyCorrelation - a.dailyCorrelation).slice(0, 10)
    .map((candidate) => describe(candidate)),
};
await mkdir(dirname(outputPrefix), { recursive: true });
await writeFile(`${outputPrefix}-hitters.csv`, toCsv(rankingEvaluation.rows), 'utf8');
await writeFile(`${outputPrefix}-summary.json`, JSON.stringify(summary, null, 2), 'utf8');
console.log(`Error selected: ${JSON.stringify(summary.errorSelectedModel)}`);
console.log(`Ranking selected: ${JSON.stringify(summary.rankingSelectedModel)}`);
console.table(summary.errorSelectedHoldout);
console.table(summary.rankingSelectedHoldout);
console.log(`Wrote ${outputPrefix}-summary.json`);

function scoreCandidate(options) {
  const predictions = [];
  const predictedRows = [];
  for (const date of validationDates) {
    const training = rows.filter((row) => row.date < date);
    const validation = rows.filter((row) => row.date === date);
    const model = fitStatcastResidualModel(training, features, options);
    for (const row of validation) { predictions.push(predictStatcastResidual(row, features.get(row), model)); predictedRows.push(row); }
  }
  const byRow = new Map(predictedRows.map((row, index) => [row, predictions[index]]));
  const errors = predictedRows.map((row, index) => row.actualDraftKingsPoints - predictions[index]);
  return {
    options,
    rmse: Math.sqrt(errors.reduce((sum, value) => sum + value ** 2, 0) / errors.length),
    metrics: predictionMetrics(predictedRows, (_, index) => predictions[index]),
    dailyCorrelation: rankingMetrics(predictedRows, (row) => byRow.get(row)).meanDailyCorrelation,
  };
}
function evaluate(candidate) {
  const training = rows.filter((row) => row.date < holdoutStart);
  const model = fitStatcastResidualModel(training, features, candidate.options);
  const evaluated = holdoutRows.map((row) => ({
    ...row,
    statcastRegressionProjection: round(predictStatcastResidual(row, features.get(row), model)),
    statcastRegressionAdjustment: round(predictStatcastResidual(row, features.get(row), model) - row.projectedDraftKingsPoints),
    ...features.get(row),
  }));
  return { rows: evaluated, metrics: predictionMetrics(evaluated, (row) => row.statcastRegressionProjection), model };
}
function describe(candidate, fittedModel = null) {
  return {
    ...candidate.options,
    coefficients: fittedModel
      ? Object.fromEntries(fittedModel.names.map((name, index) => [name, round(fittedModel.coefficients[index], 6)]))
      : undefined,
    validationRmse: round(candidate.rmse, 4),
    validationDailyCorrelation: candidate.dailyCorrelation,
  };
}
function comparison(baseline, model) {
  return { baseline, model, improvement: { mae: round(baseline.meanAbsoluteError - model.meanAbsoluteError), rmse: round(baseline.rootMeanSquaredError - model.rootMeanSquaredError), correlation: round(model.correlation - baseline.correlation, 4) } };
}
function rankingMetrics(inputRows, predictor) {
  const daily = [...new Set(inputRows.map((row) => row.date))].map((date) => {
    const dateRows = inputRows.filter((row) => row.date === date); const p = dateRows.map(predictor); const a = dateRows.map((row) => row.actualDraftKingsPoints);
    const top = dateRows.map((row, index) => ({ row, p: p[index] })).sort((x, y) => y.p - x.p).slice(0, Math.max(1, Math.ceil(dateRows.length * .1)));
    return { c: correlation(p, a), top: top.reduce((sum, value) => sum + value.row.actualDraftKingsPoints, 0) / top.length };
  });
  return { meanDailyCorrelation: round(daily.reduce((s, v) => s + v.c, 0) / daily.length, 4), meanTop10PercentActual: round(daily.reduce((s, v) => s + v.top, 0) / daily.length) };
}
function correlation(xs, ys) { const m = (v) => v.reduce((s, x) => s + x, 0) / v.length; const xm=m(xs),ym=m(ys); let n=0,xd=0,yd=0; for(let i=0;i<xs.length;i++){const x=xs[i]-xm,y=ys[i]-ym;n+=x*y;xd+=x*x;yd+=y*y;} return xd&&yd?n/Math.sqrt(xd*yd):0; }
function isWalker(row) { return row.projectedPlayerName === 'Jordan Walker'; }
function round(value, digits=2) { return Number(Number(value).toFixed(digits)); }
function parseArgs(tokens) { const p={}; for(let i=0;i<tokens.length;i++){if(tokens[i].startsWith('--')){p[tokens[i].slice(2).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=tokens[i+1];i++;}} return p; }
