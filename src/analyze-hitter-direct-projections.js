import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { scoreDraftKingsHitterLine } from './hitter-outcome-sim.js';

const MLB_BASE_URL = 'https://statsapi.mlb.com/api/v1';
const args = parseArgs(process.argv.slice(2));
const start = args.start || '2026-05-04';
const end = args.end || '2026-07-12';
const simDirs = String(args.simDirs || 'out/cache/hitter-percentile-backtest/sims,out/cache/fangraphs-sims/rSteamer')
  .split(',').map((value) => resolve(value.trim())).filter(Boolean);
const cacheDir = resolve(args.cacheDir || 'out/cache/hitter-direct-backtest');
const legacyBoxscoreDir = resolve(args.legacyBoxscoreDir || 'out/cache/hitter-percentile-backtest/boxscores');
const outputPrefix = resolve(args.outputPrefix || `out/hitter-direct-projections-${start}-to-${end}`);
const concurrency = positiveInteger(args.concurrency, 4);

await main();

async function main() {
  const simulations = await discoverSimulations();
  const dates = [...new Set(simulations.map((row) => row.date))].sort();
  const schedules = new Map();
  for (const date of dates) schedules.set(date, await loadSchedule(date));

  const assigned = assignGameIds(simulations, schedules);
  const rows = (await mapLimit(assigned, concurrency, evaluateGame)).flat();
  const matched = rows.filter((row) => row.playerMatched);
  const gameErrors = assigned.filter((game) => !game.mlbGameId || game.error);
  const summary = summarize({ simulations, assigned, rows, matched, gameErrors });

  await mkdir(dirname(outputPrefix), { recursive: true });
  await writeFile(`${outputPrefix}-hitters.csv`, toCsv(matched), 'utf8');
  await writeFile(`${outputPrefix}-summary.json`, JSON.stringify(summary, null, 2), 'utf8');
  printSummary(summary);
}

async function discoverSimulations() {
  const found = [];
  for (let priority = 0; priority < simDirs.length; priority += 1) {
    const directory = simDirs[priority];
    let files = [];
    try { files = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of files) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const path = join(directory, entry.name);
      const sim = await readJson(path);
      const date = String(sim?.loadDate || '').slice(0, 10);
      if (date < start || date > end) continue;
      if (sim?.home?.batters?.length !== 9 || sim?.away?.batters?.length !== 9) continue;
      const fileId = basename(entry.name, '.json').replace(/^rSteamer-/, '');
      const numericGameId = /^\d+$/.test(fileId) ? Number(fileId) : null;
      found.push({
        date,
        priority,
        path,
        fileId,
        numericGameId,
        awayTeam: sim.away?.name || sim.awayTeam?.name || '',
        homeTeam: sim.home?.name || sim.homeTeam?.name || '',
        sim,
      });
    }
  }

  const deduped = new Map();
  for (const row of found.sort((a, b) => a.priority - b.priority)) {
    const key = row.numericGameId
      ? `game:${row.numericGameId}`
      : `teams:${row.date}:${normalizeName(row.awayTeam)}:${normalizeName(row.homeTeam)}`;
    if (!deduped.has(key)) deduped.set(key, row);
  }
  return [...deduped.values()].sort((a, b) => a.date.localeCompare(b.date) || a.fileId.localeCompare(b.fileId));
}

async function loadSchedule(date) {
  const path = join(cacheDir, 'schedules', `${date}.json`);
  let schedule = await readJson(path);
  if (!schedule?.dates) {
    const url = new URL(`${MLB_BASE_URL}/schedule`);
    url.searchParams.set('sportId', '1');
    url.searchParams.set('date', date);
    schedule = await fetchJson(url);
    await writeJson(path, schedule);
  }
  return schedule?.dates?.flatMap((day) => day.games || []) || [];
}

function assignGameIds(simulations, schedules) {
  const used = new Set();
  return simulations.map((simulation) => {
    const games = schedules.get(simulation.date) || [];
    let game = simulation.numericGameId
      ? games.find((candidate) => Number(candidate.gamePk) === simulation.numericGameId)
      : null;
    if (!game) {
      game = games.find((candidate) => !used.has(candidate.gamePk)
        && teamsMatch(simulation.awayTeam, candidate.teams?.away?.team?.name)
        && teamsMatch(simulation.homeTeam, candidate.teams?.home?.team?.name));
    }
    if (game) used.add(game.gamePk);
    return {
      ...simulation,
      mlbGameId: game?.gamePk || simulation.numericGameId || null,
      error: game ? '' : 'No matching MLB schedule game.',
    };
  });
}

async function evaluateGame(game) {
  if (!game.mlbGameId || game.error) return [];
  try {
    const boxscore = await loadBoxscore(game.mlbGameId);
    return [
      ...evaluateSide(game, boxscore, 'away'),
      ...evaluateSide(game, boxscore, 'home'),
    ];
  } catch (error) {
    game.error = error instanceof Error ? error.message : String(error);
    return [];
  }
}

async function loadBoxscore(gameId) {
  const localPath = join(cacheDir, 'boxscores', `${gameId}.json`);
  const legacyPath = join(legacyBoxscoreDir, `${gameId}.json`);
  const local = await readJson(localPath);
  if (local?.teams) return local;
  const legacy = await readJson(legacyPath);
  if (legacy?.teams) {
    await writeJson(localPath, legacy);
    return legacy;
  }
  const boxscore = await fetchJson(`${MLB_BASE_URL}/game/${gameId}/boxscore`);
  await writeJson(localPath, boxscore);
  return boxscore;
}

function evaluateSide(game, boxscore, side) {
  const projected = game.sim?.[side]?.batters || [];
  const actualPlayers = Object.values(boxscore?.teams?.[side]?.players || {});
  const actualIndex = new Map(actualPlayers
    .filter((player) => player?.stats?.batting)
    .map((player) => [normalizeName(player.person?.fullName), player]));
  const opponentSide = side === 'away' ? 'home' : 'away';
  return projected.map((player, index) => {
    const actualPlayer = actualIndex.get(normalizeName(player.name));
    const actual = actualPlayer ? actualHitterLine(actualPlayer.stats.batting) : null;
    const projectedLine = projectedHitterLine(player.average || {});
    const projection = projectedHitterPoints(player.average || {});
    return {
      date: game.date,
      mlbGameId: game.mlbGameId,
      simFile: game.fileId,
      simLoadDate: game.sim?.loadDate || '',
      side,
      team: game.sim?.[side]?.name || '',
      opponent: game.sim?.[opponentSide]?.name || '',
      lineupSlot: index + 1,
      fangraphsPlayerId: String(player.playerId || ''),
      projectedPlayerName: player.name || '',
      mlbPlayerId: actualPlayer?.person?.id ? String(actualPlayer.person.id) : '',
      actualPlayerName: actualPlayer?.person?.fullName || '',
      playerMatched: Boolean(actualPlayer),
      projectedDraftKingsPoints: round(projection),
      actualDraftKingsPoints: actual == null ? '' : round(actual.draftKingsPoints),
      projectedPlateAppearances: round(projectedLine.plateAppearances, 4),
      projectedSingles: round(projectedLine.singles, 4),
      projectedDoubles: round(projectedLine.doubles, 4),
      projectedTriples: round(projectedLine.triples, 4),
      projectedHomeRuns: round(projectedLine.homeRuns, 4),
      projectedRuns: round(projectedLine.runs, 4),
      projectedRunsBattedIn: round(projectedLine.runsBattedIn, 4),
      projectedWalks: round(projectedLine.walks, 4),
      projectedHitByPitch: round(projectedLine.hitByPitch, 4),
      projectedStolenBases: round(projectedLine.stolenBases, 4),
      actualSingles: actual?.singles ?? '',
      actualDoubles: actual?.doubles ?? '',
      actualTriples: actual?.triples ?? '',
      actualHomeRuns: actual?.homeRuns ?? '',
      actualRuns: actual?.runs ?? '',
      actualRunsBattedIn: actual?.runsBattedIn ?? '',
      actualWalks: actual?.walks ?? '',
      actualHitByPitch: actual?.hitByPitch ?? '',
      actualStolenBases: actual?.stolenBases ?? '',
      actualPlateAppearances: actual?.plateAppearances ?? '',
      error: actualPlayer ? '' : 'Projected hitter did not appear in the MLB box score.',
    };
  });
}

function projectedHitterLine(average) {
  return {
    plateAppearances: average.PA,
    singles: average['1B'], doubles: average['2B'], triples: average['3B'],
    homeRuns: average.HR, runs: average.R, runsBattedIn: average.RBI,
    walks: average.BB, hitByPitch: average.HBP, stolenBases: average.SB,
  };
}

function projectedHitterPoints(average) {
  return scoreDraftKingsHitterLine(projectedHitterLine(average));
}

function actualHitterLine(stats = {}) {
  const hits = numberOr(stats.hits, 0);
  const doubles = numberOr(stats.doubles, 0);
  const triples = numberOr(stats.triples, 0);
  const homeRuns = numberOr(stats.homeRuns, 0);
  const line = {
    singles: Math.max(0, hits - doubles - triples - homeRuns), doubles, triples, homeRuns,
    runs: numberOr(stats.runs, 0), runsBattedIn: numberOr(stats.rbi, 0),
    walks: numberOr(stats.baseOnBalls, 0), hitByPitch: numberOr(stats.hitByPitch, 0),
    stolenBases: numberOr(stats.stolenBases, 0),
    plateAppearances: numberOr(stats.plateAppearances, 0),
  };
  line.draftKingsPoints = scoreDraftKingsHitterLine(line);
  return line;
}

function summarize({ simulations, assigned, rows, matched, gameErrors }) {
  const overall = directMetrics(matched);
  const projectedTiers = [
    ['under-6', (row) => row.projectedDraftKingsPoints < 6],
    ['6-to-8', (row) => row.projectedDraftKingsPoints >= 6 && row.projectedDraftKingsPoints < 8],
    ['8-to-10', (row) => row.projectedDraftKingsPoints >= 8 && row.projectedDraftKingsPoints < 10],
    ['10-plus', (row) => row.projectedDraftKingsPoints >= 10],
  ];
  return {
    start, end,
    savedGameSimulations: simulations.length,
    matchedGameSimulations: assigned.filter((game) => game.mlbGameId && !game.error).length,
    gameErrors: gameErrors.map((game) => ({ date: game.date, simFile: game.fileId, error: game.error })),
    projectedHitterRows: rows.length,
    matchedHitters: matched.length,
    unmatchedHitters: rows.length - matched.length,
    matchRate: rows.length ? round(matched.length / rows.length, 4) : null,
    metrics: overall,
    byDate: Object.fromEntries([...new Set(matched.map((row) => row.date))].sort()
      .map((date) => [date, directMetrics(matched.filter((row) => row.date === date))])),
    byProjectionTier: Object.fromEntries(projectedTiers.map(([label, test]) => [label, directMetrics(matched.filter(test))])),
    byLineupSlot: Object.fromEntries(Array.from({ length: 9 }, (_, index) => {
      const slot = index + 1;
      return [String(slot), directMetrics(matched.filter((row) => row.lineupSlot === slot))];
    })),
  };
}

function directMetrics(rows) {
  if (!rows.length) return { hitters: 0 };
  const errors = rows.map((row) => row.actualDraftKingsPoints - row.projectedDraftKingsPoints);
  const absoluteErrors = errors.map(Math.abs);
  const projected = rows.map((row) => row.projectedDraftKingsPoints);
  const actual = rows.map((row) => row.actualDraftKingsPoints);
  return {
    hitters: rows.length,
    averageProjection: round(mean(projected)),
    averageActual: round(mean(actual)),
    biasActualMinusProjection: round(mean(errors)),
    meanAbsoluteError: round(mean(absoluteErrors)),
    medianAbsoluteError: round(median(absoluteErrors)),
    rootMeanSquaredError: round(Math.sqrt(mean(errors.map((value) => value ** 2)))),
    correlation: round(correlation(projected, actual), 4),
  };
}

function correlation(xs, ys) {
  const xMean = mean(xs);
  const yMean = mean(ys);
  let numerator = 0;
  let xSum = 0;
  let ySum = 0;
  for (let index = 0; index < xs.length; index += 1) {
    const x = xs[index] - xMean;
    const y = ys[index] - yMean;
    numerator += x * y;
    xSum += x ** 2;
    ySum += y ** 2;
  }
  return xSum && ySum ? numerator / Math.sqrt(xSum * ySum) : null;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'dfs-baseball-hitter-direct-backtest/1.0' } });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value), 'utf8');
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

function teamsMatch(left, right) {
  const a = normalizeName(left).replace(/^oaklandathletics$/, 'athletics');
  const b = normalizeName(right).replace(/^oaklandathletics$/, 'athletics');
  return a === b;
}

function normalizeName(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function mean(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function numberOr(value, fallback) { const number = Number(value); return Number.isFinite(number) ? number : fallback; }
function round(value, digits = 2) { return value == null ? null : Number(Number(value).toFixed(digits)); }
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

function toCsv(rows) {
  if (!rows.length) return '';
  const columns = Object.keys(rows[0]);
  return `${columns.join(',')}\n${rows.map((row) => columns.map((column) => csvCell(row[column])).join(',')).join('\n')}\n`;
}
function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function printSummary(summary) {
  console.log(`Saved games: ${summary.savedGameSimulations}; matched games: ${summary.matchedGameSimulations}`);
  console.log(`Matched hitters: ${summary.matchedHitters}/${summary.projectedHitterRows}`);
  console.table({ overall: summary.metrics, ...summary.byProjectionTier });
  console.log(`Wrote ${outputPrefix}-hitters.csv`);
  console.log(`Wrote ${outputPrefix}-summary.json`);
}
