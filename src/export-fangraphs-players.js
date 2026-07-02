import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const BASE_URL = 'https://www.fangraphs.com';
const SIM_BASE_URL = `${BASE_URL}/api-baseball-sim/Simulation`;
const DEFAULT_PROJECTION_SYSTEM = 'rSteamer';

const args = parseArgs(process.argv.slice(2));
const date = args.date || localDateString();
const projectionSystem = args.projection || DEFAULT_PROJECTION_SYSTEM;
const simIdOverrides = args.simIdOverrides || [];
const outputPath = resolve(args.output || `fangraphs-baseball-sim-players-${date}.csv`);

try {
  const rows = await exportPlayerRows({ date, projectionSystem, simIdOverrides });
  await writeCsv(outputPath, rows);
  console.log(`Wrote ${rows.length} rows to ${outputPath}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

async function exportPlayerRows({ date, projectionSystem, simIdOverrides }) {
  const games = await fetchTodaysGames(date);
  const rows = [];

  for (const game of games) {
    const schedule = game.schedule || {};
    const scores = game.scores || {};
    const simId = getSimId(game, schedule, date, simIdOverrides);

    if (!simId) continue;

    try {
      const sim = await fetchGameSimulation(simId, projectionSystem);
      rows.push(...buildGamePlayerRows({ date, game, schedule, scores, simId, sim, projectionSystem }));
    } catch (error) {
      rows.push({
        date,
        gameId: schedule.GameId ?? game.GameId ?? '',
        mlbGameId: schedule.MLBGameId ?? game.MLBGameId ?? '',
        simId,
        projectionSystem,
        gameTimeUtc: schedule.GameDateTimeUTC || '',
        gameTimeLocal: formatLocalTime(schedule.GameDateTimeUTC),
        playerType: 'error',
        playerId: '',
        playerName: '',
        team: schedule.AwayTeamAbbName && schedule.HomeTeamAbbName
          ? `${schedule.AwayTeamAbbName} @ ${schedule.HomeTeamAbbName}`
          : '',
        expectedPoints: '',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  rows.sort((a, b) => Number(b.expectedPoints || -9999) - Number(a.expectedPoints || -9999));
  return rows;
}

function buildGamePlayerRows({ date, game, schedule, scores, simId, sim, projectionSystem }) {
  const context = {
    date,
    gameId: schedule.GameId ?? game.GameId ?? '',
    mlbGameId: schedule.MLBGameId ?? game.MLBGameId ?? '',
    simId,
    projectionSystem: sim?.projectionSystem || projectionSystem,
    gameTimeUtc: schedule.GameDateTimeUTC || '',
    gameTimeLocal: formatLocalTime(schedule.GameDateTimeUTC),
    status: scores.isFinal ? 'Final' : scores.Inning ? `${scores.IH || ''} ${scores.Inning}`.trim() : '',
    simulations: sim?.simulations ?? '',
    simLoadDate: sim?.loadDate || '',
  };

  const sides = [
    {
      side: 'away',
      team: sim?.away,
      teamInfo: sim?.awayTeam,
      teamAbbrev: schedule.AwayTeamAbbName || '',
      opponent: sim?.home,
      opponentInfo: sim?.homeTeam,
      opponentAbbrev: schedule.HomeTeamAbbName || '',
    },
    {
      side: 'home',
      team: sim?.home,
      teamInfo: sim?.homeTeam,
      teamAbbrev: schedule.HomeTeamAbbName || '',
      opponent: sim?.away,
      opponentInfo: sim?.awayTeam,
      opponentAbbrev: schedule.AwayTeamAbbName || '',
    },
  ];

  const rows = [];
  for (const side of sides) {
    const teamName = side.teamInfo?.name || side.team?.name || side.teamAbbrev;
    const opponentName = side.opponentInfo?.name || side.opponent?.name || side.opponentAbbrev;
    const teamId = side.teamInfo?.id ?? side.team?.id ?? '';
    const opponentId = side.opponentInfo?.id ?? side.opponent?.id ?? '';

    (side.team?.batters || []).forEach((player, index) => {
      rows.push({
        ...context,
        playerType: 'hitter',
        side: side.side,
        teamId,
        team: teamName,
        teamAbbrev: side.teamAbbrev,
        opponentId,
        opponent: opponentName,
        opponentAbbrev: side.opponentAbbrev,
        lineupSlot: index + 1,
        playerId: player.playerId || '',
        playerName: player.name || '',
        position: player.position || '',
        role: '',
        ...blankPitchingStats(),
        ...hitterStats(player.average),
        error: '',
      });
    });

    (side.team?.pitchers || []).forEach((player) => {
      rows.push({
        ...context,
        playerType: 'pitcher',
        side: side.side,
        teamId,
        team: teamName,
        teamAbbrev: side.teamAbbrev,
        opponentId,
        opponent: opponentName,
        opponentAbbrev: side.opponentAbbrev,
        lineupSlot: '',
        playerId: player.playerId || '',
        playerName: player.name || '',
        position: '',
        role: player.role || '',
        ...blankHittingStats(),
        ...pitcherStats(player.average, player.histograms),
        error: '',
      });
    });
  }

  return rows;
}

function hitterStats(average = {}) {
  const singles = stat(average, '1B');
  const doubles = stat(average, '2B');
  const triples = stat(average, '3B');
  const homeRuns = stat(average, 'HR');
  const runsBattedIn = stat(average, 'RBI');
  const runs = stat(average, 'R');
  const walks = stat(average, 'BB');
  const hitByPitch = stat(average, 'HBP');
  const stolenBases = stat(average, 'SB');

  const hitterPoints =
    singles * 3 +
    doubles * 5 +
    triples * 8 +
    homeRuns * 10 +
    runsBattedIn * 2 +
    runs * 2 +
    walks * 2 +
    hitByPitch * 2 +
    stolenBases * 5;

  return {
    singles,
    doubles,
    triples,
    homeRuns,
    runsBattedIn,
    runs,
    walks,
    hitByPitch,
    stolenBases,
    hitterPoints: round(hitterPoints),
    pitcherPoints: '',
    expectedPoints: round(hitterPoints),
  };
}

function pitcherStats(average = {}, histograms = {}) {
  const outs = stat(average, 'Outs');
  const inningsPitched = round(outs / 3);
  const strikeouts = stat(average, 'K');
  const win = stat(average, 'W');
  const earnedRunsAllowed = stat(average, 'ER');
  const hitsAgainst = stat(average, 'H');
  const walksAgainst = stat(average, 'BB');
  const hitBatsmen = stat(average, 'HBP');
  const completeGamePct = histogramProbability(histograms.Outs, (bucket) => bucket >= 27);
  const runShutoutPct = histogramProbability(histograms.R, (bucket) => bucket === 0);
  const noHitsAllowedPct = histogramProbability(histograms.H, (bucket) => bucket === 0);

  const cgShutoutPctEstimate = Math.min(completeGamePct, runShutoutPct);
  const noHitterPctEstimate = Math.min(completeGamePct, noHitsAllowedPct);

  const pitcherPoints =
    outs * 0.75 +
    strikeouts * 2 +
    win * 4 -
    earnedRunsAllowed * 2 -
    hitsAgainst * 0.6 -
    walksAgainst * 0.6 -
    hitBatsmen * 0.6 +
    completeGamePct * 2.5 +
    cgShutoutPctEstimate * 2.5 +
    noHitterPctEstimate * 5;

  return {
    inningsPitched,
    outs,
    strikeouts,
    win,
    earnedRunsAllowed,
    hitsAgainst,
    walksAgainst,
    hitBatsmen,
    completeGamePct: round(completeGamePct),
    cgShutoutPctEstimate: round(cgShutoutPctEstimate),
    noHitterPctEstimate: round(noHitterPctEstimate),
    pitcherPoints: round(pitcherPoints),
    expectedPoints: round(pitcherPoints),
  };
}

function blankHittingStats() {
  return {
    singles: '',
    doubles: '',
    triples: '',
    homeRuns: '',
    runsBattedIn: '',
    runs: '',
    walks: '',
    hitByPitch: '',
    stolenBases: '',
    hitterPoints: '',
  };
}

function blankPitchingStats() {
  return {
    inningsPitched: '',
    outs: '',
    strikeouts: '',
    win: '',
    earnedRunsAllowed: '',
    hitsAgainst: '',
    walksAgainst: '',
    hitBatsmen: '',
    completeGamePct: '',
    cgShutoutPctEstimate: '',
    noHitterPctEstimate: '',
  };
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
  const url = isFanGraphsSimulationId(simId)
    ? new URL(`${SIM_BASE_URL}/sim-run/${encodeURIComponent(simId)}`)
    : new URL(`${SIM_BASE_URL}/sim-game-json/${encodeURIComponent(simId)}`);

  if (!isFanGraphsSimulationId(simId)) {
    url.searchParams.set('idType', 'upid');
    url.searchParams.set('projectionSystem', projectionSystem);
  }

  return fetchJson(url);
}

function isFanGraphsSimulationId(simId) {
  const value = String(simId ?? '');
  return /^[a-z0-9]+$/i.test(value) && /[a-z]/i.test(value);
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

function getSimId(game, schedule, date, simIdOverrides = []) {
  const override = getSimIdOverride(game, schedule, simIdOverrides);
  if (override) return override;

  if (schedule?.MLBGameId) return String(schedule.MLBGameId);
  if (schedule?.HomeTeamId != null && schedule?.AwayTeamId != null) {
    const doubleHeaderGame = schedule.DH ?? 0;
    return `${date}_${schedule.HomeTeamId}_${schedule.AwayTeamId}_${doubleHeaderGame}`;
  }
  return '';
}

function getSimIdOverride(game, schedule, simIdOverrides) {
  for (const { target, simId } of simIdOverrides) {
    if (matchesGameTarget(game, schedule, target)) return simId;
  }

  return '';
}

function matchesGameTarget(game, schedule, target) {
  const normalizedTarget = normalizeTarget(target);
  if (!normalizedTarget) return false;

  const exactTargets = [
    schedule?.MLBGameId,
    game?.MLBGameId,
    schedule?.GameId,
    game?.GameId,
  ].map((value) => normalizeTarget(value));

  if (exactTargets.includes(normalizedTarget)) return true;

  const away = schedule?.AwayTeamAbbName;
  const home = schedule?.HomeTeamAbbName;
  const matchupTargets = [
    away && home ? `${away}@${home}` : '',
    away && home ? `${away}-${home}` : '',
    away && home ? `${away}_${home}` : '',
    away && home ? `${away} at ${home}` : '',
  ].map((value) => normalizeTarget(value));

  return matchupTargets.includes(normalizedTarget);
}

function normalizeTarget(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, '');
}

function histogramProbability(histogram, predicate) {
  const buckets = histogram?.buckets;
  const total = Number(histogram?.total);
  if (!buckets || !Number.isFinite(total) || total <= 0) return 0;

  let matching = 0;
  for (const [bucket, count] of Object.entries(buckets)) {
    const value = Number(bucket);
    const bucketCount = Number(count);
    if (Number.isFinite(value) && Number.isFinite(bucketCount) && predicate(value)) {
      matching += bucketCount;
    }
  }

  return matching / total;
}

function stat(average, key) {
  return round(average?.[key] ?? 0);
}

function round(value, places = 6) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Number(number.toFixed(places));
}

function formatLocalTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

async function writeCsv(path, rows) {
  await mkdir(dirname(path), { recursive: true });

  const headers = [
    'date',
    'gameId',
    'mlbGameId',
    'simId',
    'projectionSystem',
    'gameTimeUtc',
    'gameTimeLocal',
    'status',
    'simulations',
    'simLoadDate',
    'playerType',
    'side',
    'teamId',
    'team',
    'teamAbbrev',
    'opponentId',
    'opponent',
    'opponentAbbrev',
    'lineupSlot',
    'playerId',
    'playerName',
    'position',
    'role',
    'expectedPoints',
    'hitterPoints',
    'singles',
    'doubles',
    'triples',
    'homeRuns',
    'runsBattedIn',
    'runs',
    'walks',
    'hitByPitch',
    'stolenBases',
    'pitcherPoints',
    'inningsPitched',
    'outs',
    'strikeouts',
    'win',
    'earnedRunsAllowed',
    'hitsAgainst',
    'walksAgainst',
    'hitBatsmen',
    'completeGamePct',
    'cgShutoutPctEstimate',
    'noHitterPctEstimate',
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
    else if (name === 'sim-id-override') {
      parsed.simIdOverrides = parsed.simIdOverrides || [];
      parsed.simIdOverrides.push(parseSimIdOverride(value));
    }
    else {
      throw new Error(`Unknown option: --${name}`);
    }
  }

  if (parsed.date && !/^\d{4}-\d{2}-\d{2}$/.test(parsed.date)) {
    throw new Error('Use --date in YYYY-MM-DD format.');
  }

  return parsed;
}

function parseSimIdOverride(value) {
  const separatorIndex = value.indexOf('=');
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    throw new Error('Use --sim-id-override as target=simid, for example 823122=dkUZReYv02.');
  }

  const target = value.slice(0, separatorIndex).trim();
  const simId = value.slice(separatorIndex + 1).trim();
  if (!target || !simId) {
    throw new Error('Use --sim-id-override as target=simid, for example 823122=dkUZReYv02.');
  }

  return { target, simId };
}

function printHelp() {
  console.log(`Usage:
  npm run export:players -- --date 2026-06-30 --output out/player-points.csv
  node src/export-fangraphs-players.js --date 2026-06-30

Options:
  --date YYYY-MM-DD       Game date to export. Defaults to local today.
  --output PATH           CSV path. Defaults to fangraphs-baseball-sim-players-YYYY-MM-DD.csv.
  --projection NAME       FanGraphs projection system. Defaults to rSteamer.
  --sim-id-override X=ID   Override one game's sim id. X can be gameId, mlbGameId, or AWAY@HOME.

Note:
  Complete-game and no-hitter bonuses are estimated from marginal simulation histograms.
  CG shutout is estimated as min(P(CG), P(runs allowed = 0)).
`);
}
