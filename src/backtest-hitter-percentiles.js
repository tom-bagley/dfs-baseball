import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { simulateHitterOutcomes, scoreDraftKingsHitterLine } from './hitter-outcome-sim.js';

const FANGRAPHS_SIM_URL = 'https://www.fangraphs.com/api-baseball-sim/Simulation/sim-game-json';
const MLB_BASE_URL = 'https://statsapi.mlb.com/api/v1';
const args = parseArgs(process.argv.slice(2));
const start = args.start || '2026-07-06';
const end = args.end || '2026-07-12';
const projectionSystem = args.projection || 'rSteamer';
const simulations = positiveInteger(args.simulations, 10000);
const calibrationOffset = numberOr(args.calibrationOffset, 0);
const concurrency = positiveInteger(args.concurrency, 4);
const requestDelayMs = positiveInteger(args.requestDelayMs, 100);
const retries = positiveInteger(args.retries, 4);
const sourceDir = resolve(args.sourceDir || 'out/cache/pitcher-percentile-backtest/dates');
const cacheDir = resolve(args.cacheDir || 'out/cache/hitter-percentile-backtest');
const sharedSimDir = resolve(args.sharedSimDir || `out/cache/fangraphs-sims/${projectionSystem}`);
const outputPrefix = resolve(args.outputPrefix || `out/hitter-percentile-backtest-${start}-to-${end}`);

if (args.help) {
  printHelp();
  process.exit(0);
}

await main();

async function main() {
  validateDate(start);
  validateDate(end);
  if (start > end) throw new Error('--start must not be after --end.');

  const projectedRows = [];
  let gamesFound = 0;
  for (const date of dateRange(start, end)) {
    const games = await gameIdsForDate(date);
    gamesFound += games.length;
    const dateRows = (await mapLimit(games, concurrency, (game) => loadGameRows(date, game))).flat();
    projectedRows.push(...dateRows);
    process.stdout.write(`${date}: ${dateRows.length} projected hitters from ${games.length} games\n`);
  }

  const evaluated = projectedRows.filter((row) => row.playerMatched && row.actual).map((row) => {
    const simulation = simulateHitterOutcomes({
      playerId: row.fangraphsPlayerId,
      date: row.date,
      average: row.average,
      histograms: row.histograms,
      simulations,
      calibrationOffset,
    });
    const projectedDraftKingsPoints = scoreDraftKingsHitterLine({
      singles: row.average?.['1B'],
      doubles: row.average?.['2B'],
      triples: row.average?.['3B'],
      homeRuns: row.average?.HR,
      runs: row.average?.R,
      runsBattedIn: row.average?.RBI,
      walks: row.average?.BB,
      hitByPitch: row.average?.HBP,
      stolenBases: row.average?.SB,
    });
    return {
      ...row,
      average: undefined,
      histograms: undefined,
      actual: undefined,
      actualDraftKingsPoints: row.actual.draftKingsPoints,
      actualSingles: row.actual.singles,
      actualDoubles: row.actual.doubles,
      actualTriples: row.actual.triples,
      actualHomeRuns: row.actual.homeRuns,
      actualRuns: row.actual.runs,
      actualRunsBattedIn: row.actual.runsBattedIn,
      actualWalks: row.actual.walks,
      actualHitByPitch: row.actual.hitByPitch,
      actualStolenBases: row.actual.stolenBases,
      projectedDraftKingsPoints,
      simulationMeanDelta: round(simulation.simulationMean - projectedDraftKingsPoints),
      ...simulation,
    };
  });

  const summary = {
    start,
    end,
    projectionSystem,
    simulationsPerHitter: simulations,
    calibrationOffset,
    gamesFound,
    projectedHitterRows: projectedRows.length,
    matchedHitters: evaluated.length,
    unmatchedOrMissingHitters: projectedRows.length - evaluated.length,
    metrics: percentileMetrics(evaluated),
    byLineupSlot: Object.fromEntries(Array.from({ length: 9 }, (_, index) => {
      const slot = index + 1;
      return [String(slot), percentileMetrics(evaluated.filter((row) => row.lineupSlot === slot))];
    })),
  };

  await mkdir(dirname(outputPrefix), { recursive: true });
  await writeFile(`${outputPrefix}-hitters.csv`, toCsv(evaluated), 'utf8');
  await writeFile(`${outputPrefix}-summary.json`, JSON.stringify(summary, null, 2), 'utf8');
  printSummary(summary);
}

async function gameIdsForDate(date) {
  const source = await readJson(join(sourceDir, `${date}.json`));
  const rows = Array.isArray(source?.rows) ? source.rows : [];
  const games = new Map();
  for (const row of rows) {
    const simId = String(row.simId || '');
    const mlbGameId = Number(row.mlbGameId);
    if (!simId || !Number.isFinite(mlbGameId)) continue;
    games.set(`${simId}|${mlbGameId}`, { simId, mlbGameId });
  }
  return [...games.values()];
}

async function loadGameRows(date, { simId, mlbGameId }) {
  try {
    const [sim, boxscore] = await Promise.all([
      loadSimulation(simId),
      loadBoxscore(mlbGameId),
    ]);
    return [
      ...buildSideRows({ date, simId, mlbGameId, side: 'away', sim, boxscore }),
      ...buildSideRows({ date, simId, mlbGameId, side: 'home', sim, boxscore }),
    ];
  } catch (error) {
    return [{
      date,
      simId,
      mlbGameId,
      playerMatched: false,
      error: error instanceof Error ? error.message : String(error),
    }];
  }
}

async function loadSimulation(simId) {
  const localPath = join(cacheDir, 'sims', `${safeSegment(projectionSystem)}-${safeSegment(simId)}.json`);
  const local = await readJson(localPath);
  if (local?.home && local?.away) return local;
  const shared = await readJson(join(sharedSimDir, `${safeSegment(simId)}.json`));
  if (shared?.home && shared?.away) {
    await writeJson(localPath, shared);
    return shared;
  }
  const url = new URL(`${FANGRAPHS_SIM_URL}/${encodeURIComponent(simId)}`);
  url.searchParams.set('idType', 'upid');
  url.searchParams.set('projectionSystem', projectionSystem);
  const sim = await fetchJson(url, fangraphsHeaders());
  await writeJson(localPath, sim);
  return sim;
}

async function loadBoxscore(mlbGameId) {
  const path = join(cacheDir, 'boxscores', `${mlbGameId}.json`);
  const cached = await readJson(path);
  if (cached?.teams) return cached;
  const boxscore = await fetchJson(`${MLB_BASE_URL}/game/${mlbGameId}/boxscore`, mlbHeaders());
  await writeJson(path, boxscore);
  return boxscore;
}

function buildSideRows({ date, simId, mlbGameId, side, sim, boxscore }) {
  const projected = Array.isArray(sim?.[side]?.batters) ? sim[side].batters : [];
  const actualPlayers = Object.values(boxscore?.teams?.[side]?.players || {});
  const actualIndex = new Map(actualPlayers
    .filter((player) => player?.stats?.batting)
    .map((player) => [normalizeName(player.person?.fullName), player]));
  const team = sim?.[side]?.name || sim?.[`${side}Team`]?.name || '';
  const opponentSide = side === 'away' ? 'home' : 'away';
  const opponent = sim?.[opponentSide]?.name || sim?.[`${opponentSide}Team`]?.name || '';

  return projected.map((player, index) => {
    const actualPlayer = actualIndex.get(normalizeName(player.name));
    const actual = actualPlayer ? actualHitterLine(actualPlayer.stats.batting) : null;
    return {
      date,
      simId,
      mlbGameId,
      projectionSystem,
      simLoadDate: sim?.loadDate || '',
      side,
      team,
      opponent,
      lineupSlot: index + 1,
      lineupSource: sim?.[side]?.lineupSource || '',
      fangraphsPlayerId: String(player.playerId || ''),
      projectedPlayerName: player.name || '',
      projectedPosition: player.position || '',
      mlbPlayerId: actualPlayer?.person?.id ? String(actualPlayer.person.id) : '',
      actualPlayerName: actualPlayer?.person?.fullName || '',
      playerMatched: Boolean(actualPlayer),
      average: player.average || {},
      histograms: player.histograms || {},
      actual,
      error: actualPlayer ? '' : 'Projected hitter did not appear in the MLB box score.',
    };
  });
}

function actualHitterLine(stats = {}) {
  const hits = numberOr(stats.hits, 0);
  const doubles = numberOr(stats.doubles, 0);
  const triples = numberOr(stats.triples, 0);
  const homeRuns = numberOr(stats.homeRuns, 0);
  const line = {
    singles: Math.max(0, hits - doubles - triples - homeRuns),
    doubles,
    triples,
    homeRuns,
    runs: numberOr(stats.runs, 0),
    runsBattedIn: numberOr(stats.rbi, 0),
    walks: numberOr(stats.baseOnBalls, 0),
    hitByPitch: numberOr(stats.hitByPitch, 0),
    stolenBases: numberOr(stats.stolenBases, 0),
  };
  line.draftKingsPoints = scoreDraftKingsHitterLine(line);
  return line;
}

function percentileMetrics(rows) {
  if (!rows.length) return { hitters: 0 };
  const actual = (row) => row.actualDraftKingsPoints;
  const quantileBracket = (key) => ({
    below: round(rows.filter((row) => actual(row) < row[key]).length / rows.length, 4),
    atOrBelow: round(rows.filter((row) => actual(row) <= row[key]).length / rows.length, 4),
  });
  const p10 = quantileBracket('p10');
  const p20 = quantileBracket('p20');
  const p50 = quantileBracket('p50');
  const p80 = quantileBracket('p80');
  const p90 = quantileBracket('p90');
  return {
    hitters: rows.length,
    p10,
    p20,
    p50,
    p80,
    p90,
    actualAboveP80: round(rows.filter((row) => actual(row) > row.p80).length / rows.length, 4),
    actualAtOrAboveP80: round(rows.filter((row) => actual(row) >= row.p80).length / rows.length, 4),
    actualAboveP90: round(rows.filter((row) => actual(row) > row.p90).length / rows.length, 4),
    actualAtOrAboveP90: round(rows.filter((row) => actual(row) >= row.p90).length / rows.length, 4),
    p10ToP90Coverage: round(rows.filter((row) => actual(row) >= row.p10 && actual(row) <= row.p90).length / rows.length, 4),
    p20ToP80Coverage: round(rows.filter((row) => actual(row) >= row.p20 && actual(row) <= row.p80).length / rows.length, 4),
    meanPredictionBias: round(mean(rows.map((row) => actual(row) - row.simulationMean))),
    meanSimulationDeltaFromProjection: round(mean(rows.map((row) => row.simulationMeanDelta))),
    meanAbsoluteSimulationDeltaFromProjection: round(mean(rows.map((row) => Math.abs(row.simulationMeanDelta)))),
    medianErrorFromP50: round(median(rows.map((row) => actual(row) - row.p50))),
    medianAbsoluteError: round(median(rows.map((row) => Math.abs(actual(row) - row.p50)))),
    averagePinballLoss: round(mean(rows.flatMap((row) => [
      pinball(actual(row), row.p10, 0.1),
      pinball(actual(row), row.p20, 0.2),
      pinball(actual(row), row.p50, 0.5),
      pinball(actual(row), row.p80, 0.8),
      pinball(actual(row), row.p90, 0.9),
    ]))),
    averageP10ToP90Width: round(mean(rows.map((row) => row.p90 - row.p10))),
  };
}

function pinball(actual, forecast, quantile) {
  const error = actual - forecast;
  return error >= 0 ? quantile * error : (quantile - 1) * error;
}

async function fetchJson(url, headers = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      if (requestDelayMs) await sleep(requestDelayMs);
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
      if (response.ok) return response.json();
      const body = await response.text().catch(() => '');
      const error = new Error(`HTTP ${response.status}: ${body.slice(0, 160)}`);
      error.status = response.status;
      throw error;
    } catch (error) {
      lastError = error;
      if (attempt >= retries) break;
      await sleep(error?.status === 429 ? 2500 * 2 ** attempt : 500 * 2 ** attempt);
    }
  }
  throw lastError;
}

function fangraphsHeaders() {
  return { accept: 'application/json, text/plain, */*', 'user-agent': 'dfs-baseball-hitter-percentile-backtest/1.0', referer: 'https://www.fangraphs.com/lab/baseball-sim' };
}

function mlbHeaders() {
  return { accept: 'application/json', 'user-agent': 'dfs-baseball-hitter-percentile-backtest/1.0' };
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value), 'utf8');
}

function normalizeName(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function dateRange(first, last) {
  const dates = [];
  const current = new Date(`${first}T12:00:00Z`);
  const finish = new Date(`${last}T12:00:00Z`);
  while (current <= finish) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function validateDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) throw new Error(`Invalid date: ${value}`);
}

function parseArgs(tokens) {
  const parsed = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--help' || token === '-h') parsed.help = true;
    else if (token.startsWith('--')) {
      const [rawName, inlineValue] = token.slice(2).split('=', 2);
      const name = rawName.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      parsed[name] = inlineValue ?? tokens[++index];
    }
  }
  return parsed;
}

function positiveInteger(value, fallback) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function safeSegment(value) {
  return encodeURIComponent(String(value || 'unknown')).replaceAll('%', '_');
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function toCsv(rows) {
  if (!rows.length) return '';
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row).filter((key) => row[key] !== undefined)))];
  const escape = (value) => {
    const text = value == null ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return `${headers.map(escape).join(',')}\n${rows.map((row) => headers.map((header) => escape(row[header])).join(',')).join('\n')}\n`;
}

function printSummary(summary) {
  const metrics = summary.metrics;
  console.log(`\nHitter percentile backtest: ${summary.start} to ${summary.end}`);
  console.log(`Matched hitters: ${summary.matchedHitters}/${summary.projectedHitterRows} across ${summary.gamesFound} games`);
  console.table({
    P10: metrics.p10,
    P20: metrics.p20,
    P50: metrics.p50,
    P80: metrics.p80,
    P90: metrics.p90,
  });
  console.log({
    p10ToP90Coverage: metrics.p10ToP90Coverage,
    p20ToP80Coverage: metrics.p20ToP80Coverage,
    meanPredictionBias: metrics.meanPredictionBias,
    medianErrorFromP50: metrics.medianErrorFromP50,
    medianAbsoluteError: metrics.medianAbsoluteError,
    averagePinballLoss: metrics.averagePinballLoss,
  });
  console.log(`Wrote ${outputPrefix}-hitters.csv`);
  console.log(`Wrote ${outputPrefix}-summary.json`);
}

function printHelp() {
  console.log(`
Hitter percentile backtest

  node src/backtest-hitter-percentiles.js --start 2026-07-06 --end 2026-07-12

Options:
  --start YYYY-MM-DD
  --end YYYY-MM-DD
  --projection NAME
  --simulations NUMBER
  --calibration-offset NUMBER
  --concurrency NUMBER
  --request-delay-ms NUMBER
  --retries NUMBER
  --source-dir PATH
  --cache-dir PATH
  --shared-sim-dir PATH
  --output-prefix PATH
`);
}
