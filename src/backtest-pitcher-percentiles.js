import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { simulatePitcherOutcomes, scoreDraftKingsPitcherLine } from './pitcher-outcome-sim.js';

const FANGRAPHS_BASE_URL = 'https://www.fangraphs.com';
const SIM_BASE_URL = `${FANGRAPHS_BASE_URL}/api-baseball-sim/Simulation`;
const MLB_BASE_URL = 'https://statsapi.mlb.com/api/v1';
const args = parseArgs(process.argv.slice(2));
const start = args.start || '2026-05-04';
const end = args.end || '2026-07-05';
const projectionSystem = args.projection || 'rSteamer';
const simulations = positiveInteger(args.simulations, 10000);
const uncertaintyStrength = numberOr(args.uncertaintyStrength, 0.10);
const concurrency = positiveInteger(args.concurrency, 4);
const requestDelayMs = positiveInteger(args.requestDelayMs, 100);
const retries = positiveInteger(args.retries, 4);
const cacheDir = resolve(args.cacheDir || 'out/cache/pitcher-percentile-backtest');
const outputPrefix = resolve(args.outputPrefix || `out/pitcher-percentile-backtest-${start}-to-${end}`);
const localSimCache = args.localSimCache ? resolve(args.localSimCache) : '';

if (args.help) {
  printHelp();
  process.exit(0);
}

await main();

async function main() {
  validateDate(start);
  validateDate(end);
  if (start > end) throw new Error('--start must not be after --end.');

  const rawRows = [];
  if (localSimCache) {
    rawRows.push(...await loadLocalSimulationRows(localSimCache));
  } else {
    for (const date of dateRange(start, end)) {
      const rows = await loadDateRows(date);
      rawRows.push(...rows);
      process.stdout.write(`${date}: ${rows.length} projected starters\n`);
    }
  }

  const matchedRows = rawRows.filter((row) => row.starterMatched && row.actual);
  const experienceByKey = new Map();
  const uniquePitchers = new Map(matchedRows.map((row) => [row.mlbPitcherId, row]));
  let completedPitchers = 0;
  await mapLimit([...uniquePitchers.values()], concurrency, async (row) => {
    const history = await loadPitcherHistory(row.mlbPitcherId, row.actualPitcherName, Number(row.date.slice(0, 4)));
    experienceByKey.set(row.mlbPitcherId, history);
    completedPitchers += 1;
    if (completedPitchers % 25 === 0) process.stdout.write(`Experience histories: ${completedPitchers}/${uniquePitchers.size}\n`);
  });

  const evaluated = matchedRows.map((row) => {
    const history = experienceByKey.get(row.mlbPitcherId);
    const experience = experienceBeforeDate(history, row.date);
    const base = simulatePitcherOutcomes({
      playerId: row.fangraphsPitcherId,
      date: row.date,
      average: row.average,
      histograms: row.histograms,
      simulations,
    });
    const adjusted = simulatePitcherOutcomes({
      playerId: row.fangraphsPitcherId,
      date: row.date,
      average: row.average,
      histograms: row.histograms,
      simulations,
      experience,
      uncertaintyStrength,
    });
    return {
      ...row,
      average: undefined,
      histograms: undefined,
      actual: undefined,
      seasonInningsBeforeStart: round(experience.seasonInnings),
      priorMlbInnings: round(experience.priorMlbInnings),
      recentStarts: experience.recentStarts,
      actualDraftKingsPoints: row.actual.draftKingsPoints,
      actualOuts: row.actual.outs,
      actualStrikeouts: row.actual.strikeouts,
      actualEarnedRuns: row.actual.earnedRuns,
      actualHits: row.actual.hits,
      actualWalks: row.actual.walks,
      actualHitBatsmen: row.actual.hitBatsmen,
      actualWin: row.actual.win,
      ...prefixObject(base, 'base'),
      ...prefixObject(adjusted, 'adjusted'),
    };
  });

  const summary = buildSummary({ rawRows, evaluated });
  await mkdir(dirname(outputPrefix), { recursive: true });
  await writeFile(`${outputPrefix}-pitchers.csv`, toCsv(evaluated), 'utf8');
  await writeFile(`${outputPrefix}-summary.json`, JSON.stringify(summary, null, 2), 'utf8');
  printSummary(summary);
}

async function loadLocalSimulationRows(directory) {
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => join(directory, entry.name));
  const byDate = new Map();
  for (const file of files) {
    const sim = await readJson(file);
    const date = String(sim?.loadDate || '').slice(0, 10);
    if (!date || date < start || date > end) continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push({ file, sim });
  }

  const rows = [];
  for (const [date, entries] of [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const path = join(cacheDir, 'local-dates', `${date}.json`);
    const cached = await readJson(path);
    if (Array.isArray(cached?.rows) && cached.sourceFiles === entries.length) {
      rows.push(...cached.rows);
      process.stdout.write(`${date}: ${cached.rows.length} locally cached projected starters\n`);
      continue;
    }
    const mlbGames = await loadMlbSchedule(date);
    const dateRows = (await mapLimit(entries, concurrency, async ({ file, sim }) => {
      const fileId = basename(file, '.json');
      const numericId = /^\d+$/.test(fileId) ? Number(fileId) : null;
      const game = numericId
        ? mlbGames.find((candidate) => Number(candidate.gamePk) === numericId)
        : findMatchingMlbGame(mlbGames, sim);
      if (!game?.gamePk) return [];
      try {
        const boxscore = await fetchJson(`${MLB_BASE_URL}/game/${game.gamePk}/boxscore`, mlbHeaders());
        const schedule = {
          AwayTeamAbbName: game.teams?.away?.team?.name || sim?.awayTeam?.name || '',
          HomeTeamAbbName: game.teams?.home?.team?.name || sim?.homeTeam?.name || '',
        };
        return [
          buildPitcherRow({ date, simId: fileId, mlbGameId: game.gamePk, side: 'away', sim, boxscore, schedule }),
          buildPitcherRow({ date, simId: fileId, mlbGameId: game.gamePk, side: 'home', sim, boxscore, schedule }),
        ].filter(Boolean);
      } catch (error) {
        return [{ date, simId: fileId, mlbGameId: game.gamePk, starterMatched: false, error: error.message }];
      }
    })).flat();
    await writeJson(path, { date, sourceFiles: entries.length, rows: dateRows });
    rows.push(...dateRows);
    process.stdout.write(`${date}: ${dateRows.length} local projected starters\n`);
  }
  return rows;
}

async function loadMlbSchedule(date) {
  const path = join(cacheDir, 'mlb-schedules', `${date}.json`);
  const cached = await readJson(path);
  if (Array.isArray(cached?.games)) return cached.games;
  const url = new URL(`${MLB_BASE_URL}/schedule`);
  url.searchParams.set('sportId', '1');
  url.searchParams.set('date', date);
  const data = await fetchJson(url, mlbHeaders());
  const games = data?.dates?.[0]?.games || [];
  await writeJson(path, { date, games });
  return games;
}

function findMatchingMlbGame(games, sim) {
  const away = normalizeTeamName(sim?.awayTeam?.name);
  const home = normalizeTeamName(sim?.homeTeam?.name);
  return games.find((game) => (
    normalizeTeamName(game.teams?.away?.team?.name) === away
    && normalizeTeamName(game.teams?.home?.team?.name) === home
  ));
}

function normalizeTeamName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/^oakland/, '')
    .replace(/^athletics$/, 'athletics');
}

async function loadDateRows(date) {
  const path = join(cacheDir, 'dates', `${date}.json`);
  const cached = await readJson(path);
  if (Array.isArray(cached?.rows)) return cached.rows;

  const games = await fetchFangraphsGames(date);
  const rows = (await mapLimit(games, concurrency, async (game) => buildGamePitcherRows(date, game))).flat();
  await writeJson(path, { date, projectionSystem, rows });
  return rows;
}

async function buildGamePitcherRows(date, game) {
  const schedule = game.schedule || {};
  const simId = getSimId(schedule, date);
  const mlbGameId = Number(schedule.MLBGameId || schedule.mlbgameid || game.MLBGameId || game.mlbgameid || simId);
  if (!simId || !Number.isFinite(mlbGameId)) return [];

  try {
    const [sim, boxscore] = await Promise.all([
      fetchGameSimulation(simId, projectionSystem),
      fetchJson(`${MLB_BASE_URL}/game/${mlbGameId}/boxscore`, mlbHeaders()),
    ]);
    return [
      buildPitcherRow({ date, simId, mlbGameId, side: 'away', sim, boxscore, schedule }),
      buildPitcherRow({ date, simId, mlbGameId, side: 'home', sim, boxscore, schedule }),
    ].filter(Boolean);
  } catch (error) {
    return [{
      date,
      simId,
      mlbGameId,
      projectionSystem,
      starterMatched: false,
      error: error instanceof Error ? error.message : String(error),
    }];
  }
}

function buildPitcherRow({ date, simId, mlbGameId, side, sim, boxscore, schedule }) {
  const projected = getStartingPitcher(sim?.[side]);
  const actual = getActualStartingPitcher(boxscore, side);
  if (!projected?.name && !actual?.name) return null;
  const projectedName = projected?.name || '';
  const actualName = actual?.name || '';
  const starterMatched = Boolean(projectedName && actualName && normalizeName(projectedName) === normalizeName(actualName));
  const teamAbbrev = side === 'away' ? schedule.AwayTeamAbbName : schedule.HomeTeamAbbName;
  const opponentAbbrev = side === 'away' ? schedule.HomeTeamAbbName : schedule.AwayTeamAbbName;
  return {
    date,
    simId,
    mlbGameId,
    projectionSystem,
    simLoadDate: sim?.loadDate || '',
    side,
    teamAbbrev: teamAbbrev || '',
    opponentAbbrev: opponentAbbrev || '',
    fangraphsPitcherId: projected?.playerId || '',
    projectedPitcherName: projectedName,
    mlbPitcherId: actual?.mlbPitcherId || '',
    actualPitcherName: actualName,
    starterMatched,
    projectedRole: projected?.role || '',
    average: projected?.average || {},
    histograms: projected?.histograms || {},
    actual: actual?.line || null,
    error: starterMatched ? '' : 'Projected and actual starting pitchers did not match.',
  };
}

function getActualStartingPitcher(boxscore, side) {
  const team = boxscore?.teams?.[side];
  const pitcherId = Array.isArray(team?.pitchers) ? team.pitchers[0] : null;
  const player = pitcherId == null ? null : team?.players?.[`ID${pitcherId}`];
  const stats = player?.stats?.pitching;
  if (!player || !stats) return null;
  const line = {
    outs: numberOr(stats.outs, inningsToOuts(stats.inningsPitched)),
    strikeouts: numberOr(stats.strikeOuts, 0),
    earnedRuns: numberOr(stats.earnedRuns, 0),
    runs: numberOr(stats.runs, stats.earnedRuns),
    hits: numberOr(stats.hits, 0),
    walks: numberOr(stats.baseOnBalls, 0),
    hitBatsmen: numberOr(stats.hitBatsmen, 0),
    win: numberOr(stats.wins, 0) > 0 ? 1 : 0,
  };
  line.draftKingsPoints = scoreDraftKingsPitcherLine(line);
  return {
    mlbPitcherId: String(pitcherId),
    name: player.person?.fullName || '',
    line,
  };
}

async function loadPitcherHistory(mlbPitcherId, name, season) {
  const path = join(cacheDir, 'pitcher-history', `${season}-${mlbPitcherId}.json`);
  const cached = await readJson(path);
  if (cached?.mlbPitcherId) return cached;
  const url = new URL(`${MLB_BASE_URL}/people/${encodeURIComponent(mlbPitcherId)}/stats`);
  url.searchParams.set('stats', 'gameLog,yearByYear');
  url.searchParams.set('group', 'pitching');
  url.searchParams.set('season', String(season));
  url.searchParams.set('gameType', 'R');
  const data = await fetchJson(url, mlbHeaders());
  const blocks = Array.isArray(data?.stats) ? data.stats : [];
  const gameLog = blocks.find((block) => block?.type?.displayName === 'gameLog')?.splits || [];
  const yearByYear = blocks.find((block) => block?.type?.displayName === 'yearByYear')?.splits || [];
  const history = {
    mlbPitcherId: String(mlbPitcherId),
    name,
    season,
    gameLog: gameLog.map((split) => ({
      date: split.date || '',
      outs: numberOr(split.stat?.outs, inningsToOuts(split.stat?.inningsPitched)),
      gamesStarted: numberOr(split.stat?.gamesStarted, 0),
    })),
    yearByYear: yearByYear.map((split) => ({
      season: Number(split.season),
      outs: numberOr(split.stat?.outs, inningsToOuts(split.stat?.inningsPitched)),
    })),
  };
  await writeJson(path, history);
  return history;
}

function experienceBeforeDate(history, date) {
  const season = Number(date.slice(0, 4));
  const priorGames = (history?.gameLog || []).filter((game) => game.date && game.date < date);
  const starts = priorGames.filter((game) => game.gamesStarted > 0);
  const priorMlbOuts = (history?.yearByYear || [])
    .filter((row) => row.season < season)
    .reduce((sum, row) => sum + numberOr(row.outs, 0), 0);
  return {
    seasonInnings: priorGames.reduce((sum, game) => sum + numberOr(game.outs, 0), 0) / 3,
    priorMlbInnings: priorMlbOuts / 3,
    recentStarts: starts.slice(-8).length,
    minorLeagueInnings: 0,
  };
}

function buildSummary({ rawRows, evaluated }) {
  return {
    start,
    end,
    projectionSystem,
    simulationsPerPitcher: simulations,
    uncertaintyStrength,
    projectedStarterRows: rawRows.length,
    matchedStarts: evaluated.length,
    unmatchedOrMissingStarts: rawRows.length - evaluated.length,
    models: {
      base: percentileMetrics(evaluated, 'base'),
      experienceAdjusted: percentileMetrics(evaluated, 'adjusted'),
    },
    bySeasonInnings: Object.fromEntries([
      ['0-10', evaluated.filter((row) => row.seasonInningsBeforeStart < 10)],
      ['10-30', evaluated.filter((row) => row.seasonInningsBeforeStart >= 10 && row.seasonInningsBeforeStart < 30)],
      ['30-60', evaluated.filter((row) => row.seasonInningsBeforeStart >= 30 && row.seasonInningsBeforeStart < 60)],
      ['60+', evaluated.filter((row) => row.seasonInningsBeforeStart >= 60)],
    ].map(([label, rows]) => [label, {
      base: percentileMetrics(rows, 'base'),
      experienceAdjusted: percentileMetrics(rows, 'adjusted'),
    }])),
    byExperienceConfidence: Object.fromEntries(['low', 'medium', 'high', 'unknown'].map((label) => {
      const rows = evaluated.filter((row) => row.adjustedExperienceConfidence === label);
      return [label, {
        base: percentileMetrics(rows, 'base'),
        experienceAdjusted: percentileMetrics(rows, 'adjusted'),
      }];
    })),
  };
}

function percentileMetrics(rows, prefix) {
  if (!rows.length) return { starts: 0 };
  const actual = (row) => row.actualDraftKingsPoints;
  const value = (row, suffix) => row[`${prefix}${suffix}`];
  const below = (suffix) => rows.filter((row) => actual(row) < value(row, suffix)).length / rows.length;
  const above = (suffix) => rows.filter((row) => actual(row) > value(row, suffix)).length / rows.length;
  return {
    starts: rows.length,
    actualBelowP10: round(below('P10'), 4),
    actualBelowP20: round(below('P20'), 4),
    actualAboveP80: round(above('P80'), 4),
    actualAboveP90: round(above('P90'), 4),
    p10ToP90Coverage: round(rows.filter((row) => actual(row) >= value(row, 'P10') && actual(row) <= value(row, 'P90')).length / rows.length, 4),
    p20ToP80Coverage: round(rows.filter((row) => actual(row) >= value(row, 'P20') && actual(row) <= value(row, 'P80')).length / rows.length, 4),
    meanPredictionBias: round(mean(rows.map((row) => actual(row) - value(row, 'SimulationMean')))),
    medianAbsoluteError: round(median(rows.map((row) => Math.abs(actual(row) - value(row, 'P50'))))),
    averagePinballLoss: round(mean(rows.flatMap((row) => [
      pinball(actual(row), value(row, 'P10'), 0.1),
      pinball(actual(row), value(row, 'P20'), 0.2),
      pinball(actual(row), value(row, 'P50'), 0.5),
      pinball(actual(row), value(row, 'P80'), 0.8),
      pinball(actual(row), value(row, 'P90'), 0.9),
    ]))),
    averageP10ToP90Width: round(mean(rows.map((row) => value(row, 'P90') - value(row, 'P10')))),
  };
}

function pinball(actual, forecast, quantile) {
  const error = actual - forecast;
  return error >= 0 ? quantile * error : (quantile - 1) * error;
}

function prefixObject(object, prefix) {
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [
    `${prefix}${key[0].toUpperCase()}${key.slice(1)}`,
    value,
  ]));
}

async function fetchFangraphsGames(date) {
  const url = new URL('/api/scores/live', FANGRAPHS_BASE_URL);
  url.searchParams.set('gamedate', date);
  const data = await fetchJson(url, fangraphsHeaders());
  if (!Array.isArray(data)) throw new Error(`FanGraphs returned no schedule array for ${date}.`);
  return data;
}

async function fetchGameSimulation(simId, system) {
  const url = new URL(`${SIM_BASE_URL}/sim-game-json/${encodeURIComponent(simId)}`);
  url.searchParams.set('idType', 'upid');
  url.searchParams.set('projectionSystem', system);
  return fetchJson(url, fangraphsHeaders());
}

async function fetchJson(url, headers = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      if (requestDelayMs > 0) await sleep(requestDelayMs);
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
      if (response.ok) return response.json();
      const body = await response.text().catch(() => '');
      const error = new Error(`HTTP ${response.status}: ${body.slice(0, 160)}`);
      error.status = response.status;
      error.retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      throw error;
    } catch (error) {
      lastError = error;
      if (attempt >= retries) break;
      const rateLimitDelay = error?.status === 429 ? 2500 * 2 ** attempt : 500 * 2 ** attempt;
      await sleep(Math.max(error?.retryAfterMs || 0, rateLimitDelay));
    }
  }
  throw lastError;
}

function parseRetryAfter(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 0;
}

function fangraphsHeaders() {
  return {
    accept: 'application/json, text/plain, */*',
    'user-agent': 'dfs-baseball-pitcher-percentile-backtest/1.0',
    referer: `${FANGRAPHS_BASE_URL}/lab/baseball-sim`,
  };
}

function mlbHeaders() {
  return { accept: 'application/json', 'user-agent': 'dfs-baseball-pitcher-percentile-backtest/1.0' };
}

function getStartingPitcher(side = {}) {
  const pitchers = Array.isArray(side?.pitchers) ? side.pitchers : [];
  return pitchers.find((pitcher) => String(pitcher.role || '').toLowerCase() === 'starter')
    || pitchers.find((pitcher) => String(pitcher.role || '').toLowerCase() === 'primary pitcher')
    || null;
}

function getSimId(schedule, date) {
  if (schedule?.MLBGameId || schedule?.mlbgameid) return String(schedule.MLBGameId || schedule.mlbgameid);
  if (schedule?.GameId || schedule?.gameid) return String(schedule.GameId || schedule.gameid);
  const away = schedule?.AwayTeamId ?? schedule?.awayTeamId;
  const home = schedule?.HomeTeamId ?? schedule?.homeTeamId;
  if (away && home) return `${date}_${away}_${home}_0`;
  return '';
}

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function inningsToOuts(value) {
  const text = String(value || '0');
  const [innings, remainder = '0'] = text.split('.');
  return Math.max(0, Number(innings) * 3 + Number(remainder));
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value), 'utf8');
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

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveInteger(value, fallback) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
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

function printSummary(summary) {
  console.log(`\nPitcher percentile backtest: ${summary.start} to ${summary.end}`);
  console.log(`Matched starts: ${summary.matchedStarts}/${summary.projectedStarterRows}`);
  console.table(Object.fromEntries(Object.entries(summary.models).map(([name, metrics]) => [name, {
    starts: metrics.starts,
    belowP10: metrics.actualBelowP10,
    belowP20: metrics.actualBelowP20,
    aboveP80: metrics.actualAboveP80,
    aboveP90: metrics.actualAboveP90,
    coverage10_90: metrics.p10ToP90Coverage,
    pinball: metrics.averagePinballLoss,
  }])));
  console.log(`Wrote ${outputPrefix}-pitchers.csv`);
  console.log(`Wrote ${outputPrefix}-summary.json`);
}

function printHelp() {
  console.log(`
Pitcher percentile backtest

  node src/backtest-pitcher-percentiles.js --start 2026-05-04 --end 2026-07-05

Options:
  --start YYYY-MM-DD
  --end YYYY-MM-DD
  --projection NAME
  --simulations NUMBER
  --uncertainty-strength NUMBER
  --concurrency NUMBER
  --request-delay-ms NUMBER
  --retries NUMBER
  --cache-dir PATH
  --output-prefix PATH
  --local-sim-cache PATH    Backtest saved FanGraphs sim JSON files without downloading them again.
`);
}
