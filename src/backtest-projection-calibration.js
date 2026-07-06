import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const FANGRAPHS_BASE_URL = 'https://www.fangraphs.com';
const SIM_BASE_URL = `${FANGRAPHS_BASE_URL}/api-baseball-sim/Simulation`;
const DEFAULT_SYSTEMS = ['rSteamer', 'rSteamerPN', 'Steamer', 'ZiPS'];

const args = parseArgs(process.argv.slice(2));
const today = localDateString();
const end = args.end || addDays(today, -1);
const start = args.start || '2026-05-04';
const systems = args.systems || DEFAULT_SYSTEMS;
const requestDelayMs = args.requestDelayMs ?? 250;
const retries = args.retries ?? 4;
const concurrency = args.concurrency || 6;
const cacheDir = resolve(args.cacheDir || 'out/cache/projection-calibration');
const outputPrefix = resolve(args.outputPrefix || `out/fangraphs-projection-calibration-${start}-to-${end}`);

try {
  const rows = await collectGameRows({ start, end, systems, concurrency, requestDelayMs, retries });
  const summary = summarize({ start, end, systems, rows });

  await writeCsv(`${outputPrefix}-games.csv`, rows.map((row) => flattenRow(row, systems)));
  await writeJson(`${outputPrefix}-summary.json`, summary);
  printSummary(summary, outputPrefix);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

async function collectGameRows({ start, end, systems, concurrency, requestDelayMs, retries }) {
  validateDateRange(start, end);
  const rows = [];

  for (const date of dateRange(start, end)) {
    const cached = await readDateCache(date, systems);
    if (cached) {
      process.stdout.write(`Cached ${date} (${cached.length} games)\n`);
      rows.push(...cached);
      continue;
    }

    process.stdout.write(`Fetching ${date}...\n`);
    const games = await fetchFangraphsGames(date, { requestDelayMs, retries });

    const rowsForDate = await mapLimit(games, concurrency, async (game) => {
      return buildGameRow({ date, game, systems, requestDelayMs, retries });
    });

    const kept = rowsForDate.filter(Boolean);
    await writeDateCache(date, systems, kept);
    rows.push(...kept);
  }

  return rows;
}

async function buildGameRow({ date, game, systems, requestDelayMs, retries }) {
  const schedule = game.schedule || {};
  const scores = game.scores || {};
  const simId = getSimId(schedule, date);
  if (!simId) return null;

  const awayTeamAbbrev = schedule.AwayTeamAbbName || schedule.awayTeamAbbName || scores.AwayAbb || '';
  const homeTeamAbbrev = schedule.HomeTeamAbbName || schedule.homeTeamAbbName || scores.HomeAbb || '';
  const awayScore = numberOrNull(scores.AwayScore ?? scores.awayScore);
  const homeScore = numberOrNull(scores.HomeScore ?? scores.homeScore);
  const isFinal = Boolean(scores.isFinal);
  const winner = getWinner({ awayTeamAbbrev, homeTeamAbbrev, awayScore, homeScore, scores });

  const row = {
    date,
    simId,
    awayTeamAbbrev,
    homeTeamAbbrev,
    isFinal,
    awayScore,
    homeScore,
    winner,
    systems: {},
  };

  for (const system of systems) {
    try {
      const sim = await fetchGameSimulation(simId, system, { requestDelayMs, retries });
      const homeWinPct = numberOrNull(sim?.homeWinPct);
      row.systems[system] = {
        homeWinPct,
        loadDate: sim?.loadDate || '',
        error: homeWinPct == null ? 'No stored simulation result.' : '',
      };
    } catch (error) {
      row.systems[system] = {
        homeWinPct: null,
        loadDate: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return row;
}

function summarize({ start, end, systems, rows }) {
  const finals = rows.filter((row) => row.isFinal && row.winner);
  const sharedRows = finals.filter((row) => systems.every((system) => row.systems[system]?.homeWinPct != null));

  return {
    start,
    end,
    systems,
    totalGames: rows.length,
    finalGamesWithWinner: finals.length,
    gamesWhereAllSystemsHaveSims: sharedRows.length,
    perSystemAllCoveredGames: Object.fromEntries(systems.map((system) => [
      system,
      metricsForSystem(finals, system),
    ])),
    perSystemSharedGamesOnly: Object.fromEntries(systems.map((system) => [
      system,
      metricsForSystem(sharedRows, system),
    ])),
  };
}

function metricsForSystem(rows, system) {
  const games = rows.filter((row) => row.systems[system]?.homeWinPct != null);

  let favoriteBets = 0;
  let favoriteWins = 0;
  let expectedWinSum = 0;
  let fairOddsProfit = 0;
  let brierSum = 0;
  let logLossSum = 0;
  let homeWinPctSum = 0;
  let homeWins = 0;

  for (const row of games) {
    const homeWinPct = row.systems[system].homeWinPct;
    const homeWon = row.winner === row.homeTeamAbbrev;

    homeWinPctSum += homeWinPct;
    if (homeWon) homeWins += 1;
    brierSum += (homeWinPct - (homeWon ? 1 : 0)) ** 2;
    const clamped = Math.min(Math.max(homeWinPct, 1e-9), 1 - 1e-9);
    logLossSum += homeWon ? -Math.log(clamped) : -Math.log(1 - clamped);

    if (homeWinPct === 0.5) continue;
    const favoriteIsHome = homeWinPct > 0.5;
    const favoritePct = favoriteIsHome ? homeWinPct : 1 - homeWinPct;
    const favoriteWon = favoriteIsHome ? homeWon : !homeWon;

    favoriteBets += 1;
    expectedWinSum += favoritePct;
    if (favoriteWon) favoriteWins += 1;
    // 1-unit bet at the fair moneyline: win pays (1 - p) / p, loss costs 1.
    fairOddsProfit += favoriteWon ? (1 - favoritePct) / favoritePct : -1;
  }

  const expectedWinPct = favoriteBets ? expectedWinSum / favoriteBets : null;
  const actualWinPct = favoriteBets ? favoriteWins / favoriteBets : null;

  return {
    games: games.length,
    favoriteBets,
    predictedWinPct: round6(expectedWinPct),
    actualWinPct: round6(actualWinPct),
    calibrationGap: expectedWinPct == null ? null : round6(actualWinPct - expectedWinPct),
    fairOddsProfitUnits: round6(fairOddsProfit),
    fairOddsRoi: favoriteBets ? round6(fairOddsProfit / favoriteBets) : null,
    avgHomeWinPct: games.length ? round6(homeWinPctSum / games.length) : null,
    actualHomeWinPct: games.length ? round6(homeWins / games.length) : null,
    brierScore: games.length ? round6(brierSum / games.length) : null,
    logLoss: games.length ? round6(logLossSum / games.length) : null,
  };
}

function printSummary(summary, outputPrefix) {
  console.log('\nProjection calibration backtest');
  console.log(`Range: ${summary.start} to ${summary.end}`);
  console.log(`Games: ${summary.totalGames} (${summary.finalGamesWithWinner} final with winner, ${summary.gamesWhereAllSystemsHaveSims} covered by every system)`);

  for (const [label, bySystem] of [
    ['All covered games per system', summary.perSystemAllCoveredGames],
    ['Shared games only (same slate for every system)', summary.perSystemSharedGamesOnly],
  ]) {
    console.log(`\n${label}:`);
    console.log('system      games  bets  predicted  actual   gap      fair-odds ROI  Brier');
    for (const [system, metrics] of Object.entries(bySystem)) {
      console.log([
        system.padEnd(11),
        String(metrics.games).padEnd(6),
        String(metrics.favoriteBets).padEnd(5),
        formatPct(metrics.predictedWinPct).padEnd(10),
        formatPct(metrics.actualWinPct).padEnd(8),
        formatPct(metrics.calibrationGap).padEnd(8),
        formatPct(metrics.fairOddsRoi).padEnd(14),
        metrics.brierScore == null ? 'n/a' : metrics.brierScore.toFixed(4),
      ].join(' '));
    }
  }

  console.log(`\nWrote ${outputPrefix}-games.csv`);
  console.log(`Wrote ${outputPrefix}-summary.json`);
}

function flattenRow(row, systems) {
  const flat = {
    date: row.date,
    simId: row.simId,
    awayTeamAbbrev: row.awayTeamAbbrev,
    homeTeamAbbrev: row.homeTeamAbbrev,
    isFinal: row.isFinal,
    awayScore: row.awayScore ?? '',
    homeScore: row.homeScore ?? '',
    winner: row.winner,
  };
  for (const system of systems) {
    const entry = row.systems[system] || {};
    flat[`${system}HomeWinPct`] = entry.homeWinPct ?? '';
    flat[`${system}LoadDate`] = entry.loadDate || '';
    flat[`${system}Error`] = entry.error || '';
  }
  return flat;
}

async function readDateCache(date, systems) {
  try {
    const raw = JSON.parse(await readFile(dateCachePath(date), 'utf8'));
    if (!Array.isArray(raw.rows)) return null;
    const hasAllSystems = raw.rows.every((row) => systems.every((system) => row.systems?.[system] !== undefined));
    if (!hasAllSystems) return null;
    const allFinal = raw.rows.every((row) => row.isFinal && row.winner);
    return allFinal || raw.rows.length === 0 ? raw.rows : null;
  } catch {
    return null;
  }
}

async function writeDateCache(date, systems, rows) {
  const path = dateCachePath(date);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ date, systems, rows }, null, 2), 'utf8');
}

function dateCachePath(date) {
  return resolve(cacheDir, `${date}.json`);
}

async function fetchFangraphsGames(date, options = {}) {
  const url = new URL('/api/scores/live', FANGRAPHS_BASE_URL);
  url.searchParams.set('gamedate', date);

  const data = await fetchJson(url, {
    accept: 'application/json, text/plain, */*',
    'user-agent': 'fangraphs-projection-calibration/1.0',
    referer: `${FANGRAPHS_BASE_URL}/lab/baseball-sim`,
  }, options);

  if (!Array.isArray(data)) {
    throw new Error(`Expected FanGraphs schedule to be an array for ${date}.`);
  }
  return data;
}

async function fetchGameSimulation(simId, projectionSystem, options = {}) {
  const url = new URL(`${SIM_BASE_URL}/sim-game-json/${encodeURIComponent(simId)}`);
  url.searchParams.set('idType', 'upid');
  url.searchParams.set('projectionSystem', projectionSystem);
  return fetchJson(url, {
    accept: 'application/json, text/plain, */*',
    'user-agent': 'fangraphs-projection-calibration/1.0',
    referer: `${FANGRAPHS_BASE_URL}/lab/baseball-sim`,
  }, options);
}

async function fetchJson(url, headers = {}, { requestDelayMs = 0, retries = 0 } = {}) {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (requestDelayMs > 0) await sleep(requestDelayMs);

    const response = await fetch(url, { headers });
    if (response.ok) return response.json();

    const body = await response.text().catch(() => '');
    lastError = new Error(`Request failed (${response.status}) for ${url}: ${body.slice(0, 240)}`);

    if (!isRetryableStatus(response.status) || attempt === retries) {
      throw lastError;
    }

    const retryAfter = Number(response.headers.get('retry-after'));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(120000, 15000 * 2 ** attempt);
    process.stdout.write(`Rate limited (${response.status}); waiting ${Math.round(waitMs / 1000)}s before retrying ${url}\n`);
    await sleep(waitMs);
  }

  throw lastError;
}

function getSimId(schedule, date) {
  const mlbGameId = schedule?.MLBGameId ?? schedule?.mlbgameid;
  if (mlbGameId) return String(mlbGameId);

  const homeTeamId = schedule?.HomeTeamId ?? schedule?.homeTeamId;
  const awayTeamId = schedule?.AwayTeamId ?? schedule?.awayTeamId;
  if (homeTeamId != null && awayTeamId != null) {
    const doubleHeaderGame = schedule?.DH ?? schedule?.dh ?? 0;
    return `${date}_${homeTeamId}_${awayTeamId}_${doubleHeaderGame}`;
  }
  return '';
}

function getWinner({ awayTeamAbbrev, homeTeamAbbrev, awayScore, homeScore, scores }) {
  const winTeamId = scores.WinTeamId ?? scores.winTeamId;
  const awayTeamId = scores.AwayTeamId ?? scores.awayTeamId;
  const homeTeamId = scores.HomeTeamId ?? scores.homeTeamId;
  if (winTeamId != null && awayTeamId != null && String(winTeamId) === String(awayTeamId)) return awayTeamAbbrev;
  if (winTeamId != null && homeTeamId != null && String(winTeamId) === String(homeTeamId)) return homeTeamAbbrev;

  if (awayScore == null || homeScore == null || awayScore === homeScore) return '';
  return awayScore > homeScore ? awayTeamAbbrev : homeTeamAbbrev;
}

async function writeCsv(path, rows) {
  await mkdir(dirname(path), { recursive: true });
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const lines = headers.length ? [headers.join(',')] : [];
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(','));
  }
  await writeFile(path, `${lines.join('\n')}${lines.length ? '\n' : ''}`, 'utf8');
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function csvEscape(value) {
  if (value == null) return '';
  const string = String(value);
  return /[",\n\r]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? round6(number) : null;
}

function round6(value) {
  if (value == null) return null;
  return Number(Number(value).toFixed(6));
}

function isRetryableStatus(status) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatPct(value) {
  if (value == null) return 'n/a';
  return `${(Number(value) * 100).toFixed(2)}%`;
}

function dateRange(start, end) {
  const dates = [];
  for (let current = start; current <= end; current = addDays(current, 1)) {
    dates.push(current);
  }
  return dates;
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function validateDateRange(start, end) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    throw new Error('Use dates in YYYY-MM-DD format.');
  }
  if (start > end) {
    throw new Error('--start must be on or before --end.');
  }
}

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [name, inlineValue] = arg.startsWith('--') ? arg.slice(2).split('=', 2) : [null, null];

    if (!name) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }

    if (name === 'help') {
      printHelp();
      process.exit(0);
    }

    const value = inlineValue ?? argv[++index];
    if (!value) {
      throw new Error(`Missing value for --${name}`);
    }

    if (name === 'start') parsed.start = value;
    else if (name === 'end') parsed.end = value;
    else if (name === 'output-prefix') parsed.outputPrefix = value;
    else if (name === 'cache-dir') parsed.cacheDir = value;
    else if (name === 'systems') parsed.systems = value.split(',').map((system) => system.trim()).filter(Boolean);
    else if (name === 'concurrency') {
      const number = Number(value);
      if (!Number.isInteger(number) || number < 1) throw new Error('--concurrency must be a positive integer.');
      parsed.concurrency = number;
    } else if (name === 'request-delay-ms') {
      const number = Number(value);
      if (!Number.isInteger(number) || number < 0) throw new Error('--request-delay-ms must be a non-negative integer.');
      parsed.requestDelayMs = number;
    } else if (name === 'retries') {
      const number = Number(value);
      if (!Number.isInteger(number) || number < 0) throw new Error('--retries must be a non-negative integer.');
      parsed.retries = number;
    } else {
      throw new Error(`Unknown option: --${name}`);
    }
  }

  return parsed;
}

function printHelp() {
  console.log(`Usage:
  node src/backtest-projection-calibration.js --start 2026-05-04 --end 2026-07-05

Compares FanGraphs sim projection systems by betting every sim favorite at its
fair moneyline: predicted win% (average favorite probability) vs actual win%.

Options:
  --start YYYY-MM-DD          First game date. Defaults to 2026-05-04 (first date with stored sims).
  --end YYYY-MM-DD            Last game date. Defaults to yesterday.
  --systems A,B,C             Projection systems. Defaults to ${DEFAULT_SYSTEMS.join(',')}.
  --output-prefix PATH        Output prefix. Defaults to out/fangraphs-projection-calibration-START-to-END.
  --cache-dir PATH            Per-date cache directory. Defaults to out/cache/projection-calibration.
  --concurrency NUMBER        Per-date game request concurrency. Defaults to 6.
  --request-delay-ms NUMBER   Delay before each HTTP request. Defaults to 250.
  --retries NUMBER            Retry count for 429/5xx responses. Defaults to 4.
`);
}
