import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const BASE_URL = 'https://www.fangraphs.com';
const SIM_BASE_URL = `${BASE_URL}/api-baseball-sim/Simulation`;
const DEFAULT_PROJECTION_SYSTEM = 'rSteamer';
const DISPLAY_TIME_ZONE = 'America/Chicago';

const args = parseArgs(process.argv.slice(2));
const date = args.date || localDateString();
const projectionSystem = args.projection || DEFAULT_PROJECTION_SYSTEM;
const outputPath = resolve(args.output || `fangraphs-baseball-sim-${date}.csv`);

try {
  const rows = await exportSimRows({ date, projectionSystem });
  await writeCsv(outputPath, rows);
  console.log(`Wrote ${rows.length} rows to ${outputPath}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

async function exportSimRows({ date, projectionSystem }) {
  const games = await fetchTodaysGames(date);

  const rows = [];
  for (const game of games) {
    const schedule = game.schedule || {};
    const scores = game.scores || {};
    const simId = getSimId(schedule, date);

    let sim = null;
    let error = '';
    if (simId) {
      try {
        sim = await fetchGameSimulation(simId, projectionSystem);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
    } else {
      error = 'No MLBGameId or team ids were available for this schedule row.';
    }

    rows.push(buildGameRow({ date, game, simId, projectionSystem, sim, error, schedule, scores }));
  }

  return rows;
}

async function fetchTodaysGames(date) {
  const url = new URL('/api/scores/live', BASE_URL);
  url.searchParams.set('gamedate', date);

  const data = await fetchJson(url);
  if (!Array.isArray(data)) {
    throw new Error(`Expected FanGraphs schedule to be an array for ${date}.`);
  }

  return data;
}

async function fetchGameSimulation(simId, projectionSystem) {
  const url = new URL(`${SIM_BASE_URL}/sim-game-json/${encodeURIComponent(simId)}`);
  url.searchParams.set('idType', 'upid');
  url.searchParams.set('projectionSystem', projectionSystem);
  return fetchJson(url);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json, text/plain, */*',
      'user-agent': 'fangraphs-baseball-sim-csv/1.0',
      referer: `${BASE_URL}/lab/baseball-sim`,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`FanGraphs request failed (${response.status}) for ${url}: ${body.slice(0, 240)}`);
  }

  return response.json();
}

function buildGameRow({ date, game, simId, projectionSystem, sim, error, schedule, scores }) {
  const homeWinPct = numberOrNull(sim?.homeWinPct);
  const awayWinPct = homeWinPct == null ? null : numberOrNull(1 - homeWinPct);

  const awayTeam = sim?.awayTeam || {};
  const homeTeam = sim?.homeTeam || {};
  const awayRuns = getAverageRuns(sim?.away);
  const homeRuns = getAverageRuns(sim?.home);
  const awayStarter = getStartingPitcher(sim?.away);
  const homeStarter = getStartingPitcher(sim?.home);

  return {
    date,
    gameId: schedule.GameId ?? game.GameId ?? '',
    mlbGameId: schedule.MLBGameId ?? game.MLBGameId ?? '',
    simId,
    projectionSystem: sim?.projectionSystem || projectionSystem,
    gameTimeUtc: schedule.GameDateTimeUTC || '',
    gameTimeLocal: formatLocalTime(schedule.GameDateTimeUTC),
    status: scores.isFinal ? 'Final' : scores.Inning ? `${scores.IH || ''} ${scores.Inning}`.trim() : '',
    awayTeamId: awayTeam.id ?? schedule.AwayTeamId ?? '',
    awayTeam: awayTeam.name || schedule.AwayTeamName || schedule.AwayTeamAbbName || '',
    awayTeamAbbrev: schedule.AwayTeamAbbName || '',
    awayLineupSource: sim?.away?.lineupSource || '',
    awayStartingPitcherId: awayStarter.playerId || '',
    awayStartingPitcher: awayStarter.name || '',
    homeTeamId: homeTeam.id ?? schedule.HomeTeamId ?? '',
    homeTeam: homeTeam.name || schedule.HomeTeamName || schedule.HomeTeamAbbName || '',
    homeTeamAbbrev: schedule.HomeTeamAbbName || '',
    homeLineupSource: sim?.home?.lineupSource || '',
    homeStartingPitcherId: homeStarter.playerId || '',
    homeStartingPitcher: homeStarter.name || '',
    awayWinPct,
    homeWinPct,
    awayMoneyline: pctToAmericanOdds(awayWinPct),
    homeMoneyline: pctToAmericanOdds(homeWinPct),
    awayProjectedRuns: awayRuns,
    homeProjectedRuns: homeRuns,
    projectedTotalRuns: sumNullable(awayRuns, homeRuns),
    simulations: sim?.simulations ?? '',
    simLoadDate: sim?.loadDate || '',
    awayScore: scores.AwayScore ?? '',
    homeScore: scores.HomeScore ?? '',
    isFinal: scores.isFinal ?? '',
    error,
  };
}

function getStartingPitcher(side) {
  const pitchers = Array.isArray(side?.pitchers) ? side.pitchers : [];
  return pitchers.find((pitcher) => String(pitcher.role || '').toLowerCase() === 'starter')
    || pitchers.find((pitcher) => String(pitcher.role || '').toLowerCase() === 'primary pitcher')
    || {};
}

function getSimId(schedule, date) {
  if (schedule?.MLBGameId) return String(schedule.MLBGameId);
  if (schedule?.HomeTeamId != null && schedule?.AwayTeamId != null) {
    const doubleHeaderGame = schedule.DH ?? 0;
    return `${date}_${schedule.HomeTeamId}_${schedule.AwayTeamId}_${doubleHeaderGame}`;
  }
  return '';
}

function getAverageRuns(side) {
  return firstNumber(
    side?.teamBatting?.average?.R,
    side?.batting?.average?.R,
    side?.batters?.average?.R,
    side?.average?.R,
    side?.runs,
    side?.averageRuns,
  );
}

function firstNumber(...values) {
  for (const value of values) {
    const number = numberOrNull(value);
    if (number != null) return number;
  }
  return null;
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(6)) : null;
}

function sumNullable(a, b) {
  return a == null || b == null ? null : Number((a + b).toFixed(6));
}

function pctToAmericanOdds(pct) {
  if (pct == null || pct <= 0 || pct >= 1) return null;
  return pct >= 0.5
    ? Math.round((-100 * pct) / (1 - pct))
    : Math.round((100 * (1 - pct)) / pct);
}

function formatLocalTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-US', {
    timeZone: DISPLAY_TIME_ZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

async function writeCsv(path, rows) {
  await mkdir(dirname(path), { recursive: true });

  const headers = rows.length
    ? Object.keys(rows[0])
    : [
        'date',
        'gameId',
        'mlbGameId',
        'simId',
        'projectionSystem',
        'gameTimeUtc',
        'gameTimeLocal',
        'status',
        'awayTeamId',
        'awayTeam',
        'awayTeamAbbrev',
        'awayLineupSource',
        'awayStartingPitcherId',
        'awayStartingPitcher',
        'homeTeamId',
        'homeTeam',
        'homeTeamAbbrev',
        'homeLineupSource',
        'homeStartingPitcherId',
        'homeStartingPitcher',
        'awayWinPct',
        'homeWinPct',
        'awayMoneyline',
        'homeMoneyline',
        'awayProjectedRuns',
        'homeProjectedRuns',
        'projectedTotalRuns',
        'simulations',
        'simLoadDate',
        'awayScore',
        'homeScore',
        'isFinal',
        'error',
      ];

  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(','));
  }

  await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
}

function csvEscape(value) {
  if (value == null) return '';
  const string = String(value);
  return /[",\n\r]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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

    if (name === 'date') parsed.date = value;
    else if (name === 'output') parsed.output = value;
    else if (name === 'projection') parsed.projection = value;
    else {
      throw new Error(`Unknown option: --${name}`);
    }
  }

  if (parsed.date && !/^\d{4}-\d{2}-\d{2}$/.test(parsed.date)) {
    throw new Error('Use --date in YYYY-MM-DD format.');
  }

  return parsed;
}

function printHelp() {
  console.log(`Usage:
  npm run export -- --date 2026-06-30 --output out/sims.csv
  node src/export-fangraphs-sim.js --date 2026-06-30

Options:
  --date YYYY-MM-DD       Game date to export. Defaults to local today.
  --output PATH           CSV path. Defaults to fangraphs-baseball-sim-YYYY-MM-DD.csv.
  --projection NAME       FanGraphs projection system. Defaults to rSteamer.
`);
}
