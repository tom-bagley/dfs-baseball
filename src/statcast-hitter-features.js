import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { csvRecords } from './hitter-bayesian-calibration.js';

const WOBA_WEIGHTS = { Walks: 0.691, HitByPitch: 0.722, Singles: 0.882, Doubles: 1.252, Triples: 1.584, HomeRuns: 2.037 };

export async function loadStatcastHitterDays(directory) {
  const players = new Map();
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.csv'))
    .map((entry) => entry.name).sort();
  for (const file of files) {
    const records = csvRecords((await readFile(join(directory, file), 'utf8')).replace(/^\uFEFF/, ''));
    if (!records.length) continue;
    const columns = records[0];
    const index = Object.fromEntries(columns.map((column, position) => [column, position]));
    for (const record of records.slice(1)) {
      const playerId = record[index.batter];
      const date = record[index.game_date];
      if (!playerId || !date) continue;
      const playerDays = players.get(playerId) || new Map();
      const day = playerDays.get(date) || blankAggregate();
      addPitch(day, record, index);
      playerDays.set(date, day);
      players.set(playerId, playerDays);
    }
  }
  return new Map([...players].map(([playerId, days]) => [
    playerId,
    [...days].map(([date, aggregate]) => ({ date, ...aggregate })).sort((left, right) => left.date.localeCompare(right.date)),
  ]));
}

export function statcastFeaturesBefore(row, histories, options = {}) {
  const days = histories.get(String(row.mlbPlayerId || '')) || [];
  const date = row.date;
  const recentDays = Number(options.recentDays || 30);
  const cutoff = new Date(Date.parse(`${date}T00:00:00Z`) - recentDays * 86400000).toISOString().slice(0, 10);
  const season = blankAggregate();
  const recent = blankAggregate();
  for (const day of days) {
    if (day.date >= date) break;
    mergeAggregate(season, day);
    if (day.date >= cutoff) mergeAggregate(recent, day);
  }
  const projectedWoba = projectedWobaRate(row);
  const seasonMetrics = finalize(season);
  const recentMetrics = finalize(recent);
  return {
    projectedWoba,
    ...prefixMetrics('season', seasonMetrics),
    ...prefixMetrics('recent', recentMetrics),
    seasonXwobaDifference: seasonMetrics.xwoba == null ? null : seasonMetrics.xwoba - projectedWoba,
    recentXwobaDifference: recentMetrics.xwoba == null ? null : recentMetrics.xwoba - projectedWoba,
  };
}

function addPitch(aggregate, record, index) {
  const batSpeed = numeric(record[index.bat_speed]);
  if (batSpeed != null) { aggregate.batSpeedSum += batSpeed; aggregate.batSpeedSwings += 1; }
  const events = record[index.events];
  if (!events) return;
  aggregate.plateAppearances += 1;
  const launchSpeed = numeric(record[index.launch_speed]);
  const launchAngle = numeric(record[index.launch_angle]);
  if (launchSpeed != null) {
    aggregate.battedBalls += 1;
    aggregate.exitVelocitySum += launchSpeed;
    if (launchAngle != null) aggregate.launchAngleSum += launchAngle;
    if (launchSpeed >= 95) aggregate.hardHits += 1;
    if (Number(record[index.launch_speed_angle]) === 6) aggregate.barrels += 1;
    const expectedSlg = numeric(record[index.estimated_slg_using_speedangle]);
    if (expectedSlg != null) { aggregate.expectedSlgSum += expectedSlg; aggregate.expectedSlgBbe += 1; }
  }
  if (Number(record[index.woba_denom]) === 1) {
    const expectedWoba = numeric(record[index.estimated_woba_using_speedangle]) ?? numeric(record[index.woba_value]);
    if (expectedWoba != null) { aggregate.expectedWobaSum += expectedWoba; aggregate.expectedWobaPa += 1; }
  }
}

function projectedWobaRate(row) {
  const pa = Number(row.projectedPlateAppearances);
  if (!(pa > 0)) return 0;
  return Object.entries(WOBA_WEIGHTS).reduce((sum, [key, weight]) => sum + weight * Number(row[`projected${key}`] || 0), 0) / pa;
}
function blankAggregate() {
  return {
    plateAppearances: 0, battedBalls: 0, exitVelocitySum: 0, launchAngleSum: 0,
    hardHits: 0, barrels: 0, expectedWobaSum: 0, expectedWobaPa: 0,
    expectedSlgSum: 0, expectedSlgBbe: 0, batSpeedSum: 0, batSpeedSwings: 0,
  };
}
function mergeAggregate(target, source) { for (const key of Object.keys(target)) target[key] += Number(source[key] || 0); }
function finalize(value) {
  return {
    plateAppearances: value.plateAppearances,
    battedBalls: value.battedBalls,
    averageExitVelocity: divide(value.exitVelocitySum, value.battedBalls),
    averageLaunchAngle: divide(value.launchAngleSum, value.battedBalls),
    hardHitRate: divide(value.hardHits, value.battedBalls),
    barrelRate: divide(value.barrels, value.battedBalls),
    xwoba: divide(value.expectedWobaSum, value.expectedWobaPa),
    expectedSlgOnContact: divide(value.expectedSlgSum, value.expectedSlgBbe),
    averageBatSpeed: divide(value.batSpeedSum, value.batSpeedSwings),
  };
}
function prefixMetrics(prefix, metrics) {
  return Object.fromEntries(Object.entries(metrics).map(([key, value]) => [`${prefix}${key[0].toUpperCase()}${key.slice(1)}`, value]));
}
function divide(numerator, denominator) { return denominator > 0 ? numerator / denominator : null; }
function numeric(value) { const number = Number(value); return value !== '' && Number.isFinite(number) ? number : null; }
