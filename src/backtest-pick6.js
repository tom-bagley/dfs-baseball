import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreDraftKingsHitterLine } from './hitter-outcome-sim.js';
import { snapshotPath } from './pick6-data.js';
import { normalizePlayerName, normalizeTeam } from './projections-data.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CACHE_ROOT = resolve(process.env.CACHE_DIR || join(ROOT, 'out', 'cache'));
const MLB_STATS_BASE_URL = 'https://statsapi.mlb.com/api/v1';
const DEFAULT_THRESHOLD = 0.55;
const BASE_PAYOUTS = { 2: 3, 3: 6, 4: 12, 5: 20, 6: 35 };
const CALIBRATION_BUCKETS = [
  [0, 0.5], [0.5, 0.55], [0.55, 0.6], [0.6, 0.7], [0.7, 0.85], [0.85, 1.01],
];

// statCategory -> how to read the actual result from an MLB StatsAPI boxscore.
const ACTUAL_STATS = new Map([
  ['hits', { group: 'batting', value: (b) => b.hits }],
  ['singles', { group: 'batting', value: (b) => b.hits - b.doubles - b.triples - b.homeRuns }],
  ['doubles', { group: 'batting', value: (b) => b.doubles }],
  ['home runs', { group: 'batting', value: (b) => b.homeRuns }],
  ['runs', { group: 'batting', value: (b) => b.runs }],
  ['rbis', { group: 'batting', value: (b) => b.rbi }],
  ['walks', { group: 'batting', value: (b) => b.baseOnBalls }],
  ['stolen bases', { group: 'batting', value: (b) => b.stolenBases }],
  ['plate appearances', { group: 'batting', value: (b) => b.plateAppearances }],
  ['hits + runs + rbis', { group: 'batting', value: (b) => b.hits + b.runs + b.rbi }],
  ['runs + rbis', { group: 'batting', value: (b) => b.runs + b.rbi }],
  ['total bases', { group: 'batting', value: totalBases }],
  ['total bases (from hits)', { group: 'batting', value: totalBases }],
  ['extra base hits', { group: 'batting', value: (b) => b.doubles + b.triples + b.homeRuns }],
  ['xbh', { group: 'batting', value: (b) => b.doubles + b.triples + b.homeRuns }],
  ['fantasy points', { group: 'batting', value: fantasyPoints }],
  ['strikeouts thrown', { group: 'pitching', value: (p) => p.strikeOuts }],
  ['hits allowed', { group: 'pitching', value: (p) => p.hits }],
  ['walks allowed', { group: 'pitching', value: (p) => p.baseOnBalls }],
  ['outs recorded', { group: 'pitching', value: (p) => p.outs }],
]);

function totalBases(b) {
  return b.hits + b.doubles + 2 * b.triples + 3 * b.homeRuns;
}

function fantasyPoints(b) {
  return scoreDraftKingsHitterLine({
    singles: b.hits - b.doubles - b.triples - b.homeRuns,
    doubles: b.doubles,
    triples: b.triples,
    homeRuns: b.homeRuns,
    runs: b.runs,
    runsBattedIn: b.rbi,
    walks: b.baseOnBalls,
    hitByPitch: b.hitByPitch,
    stolenBases: b.stolenBases,
  });
}

const options = parseArgs(process.argv.slice(2));
await main(options);

async function main({ dates, projectionSystem, threshold, outputPrefix }) {
  const gradedRows = [];
  const entryResults = [];

  for (const date of dates) {
    let snapshot;
    try {
      snapshot = JSON.parse(await readFile(snapshotPath(date, projectionSystem), 'utf8'));
    } catch {
      console.log(`No Pick6 snapshot for ${date} (${projectionSystem}); skipping. The viewer saves one whenever the board is refreshed pregame.`);
      continue;
    }

    const games = await loadScheduleGames(date);
    const dateRows = [];
    for (const row of snapshot.rows) {
      dateRows.push(await gradeRow({ date, row, games }));
    }
    gradedRows.push(...dateRows);
    entryResults.push(...simulateGreedyEntries(date, dateRows, threshold));
  }

  if (!gradedRows.length) {
    console.log('Nothing to grade.');
    return;
  }

  const summary = summarize(gradedRows, entryResults, threshold);
  printSummary(summary, gradedRows, entryResults);

  await mkdir(dirname(resolve(`${outputPrefix}-rows.csv`)), { recursive: true });
  await writeFile(`${outputPrefix}-rows.csv`, toCsv(gradedRows));
  await writeFile(`${outputPrefix}-summary.json`, `${JSON.stringify({ ...summary, entries: entryResults }, null, 2)}\n`);
  console.log(`\nWrote ${outputPrefix}-rows.csv and ${outputPrefix}-summary.json`);
}

async function gradeRow({ date, row, games }) {
  const graded = {
    date,
    playerName: row.playerName,
    teamAbbrev: row.teamAbbrev,
    opponentAbbrev: row.opponentAbbrev,
    statCategory: row.statCategory,
    line: row.line,
    isDefault: row.isDefault,
    startTime: row.startTime,
    probOver: row.probOver,
    probUnder: row.probUnder,
    multiplierMore: row.multiplierMore,
    multiplierLess: row.multiplierLess,
    projectedMean: row.projectedMean,
    ...bestSide(row),
    actual: null,
    result: 'no-game',
  };

  const config = ACTUAL_STATS.get(String(row.statCategory || '').trim().toLowerCase());
  if (!config) {
    graded.result = 'no-stat-model';
    return graded;
  }

  const game = matchGame(games, row);
  if (!game) return graded;

  const box = await loadBoxscore(game.gamePk);
  const player = findBoxscorePlayer(box, row);
  const stats = player?.stats?.[config.group];
  const appeared = config.group === 'batting'
    ? Number(stats?.plateAppearances) > 0
    : Number(stats?.battersFaced) > 0 || Number(stats?.outs) > 0;
  if (!stats || !appeared) {
    graded.result = 'void-dnp';
    return graded;
  }

  const actual = Number(config.value(numericStats(stats)));
  graded.actual = actual;
  if (!Number.isFinite(actual)) {
    graded.result = 'void-dnp';
  } else if (actual === row.line) {
    graded.result = 'void-push';
  } else {
    const hit = graded.bestSideName === 'higher' ? actual > row.line : actual < row.line;
    graded.result = hit ? 'win' : 'loss';
    graded.realizedMultiple = hit ? graded.bestMult : 0;
  }
  return graded;
}

// Best purchasable side by probability x multiplier — the same play the
// Higher/Lower page recommends and flags.
function bestSide(row) {
  const candidates = [];
  if (row.hasMore && row.probOver != null) {
    candidates.push({ bestSideName: 'higher', bestProb: row.probOver, bestMult: parseMultiplier(row.multiplierMore) ?? 1 });
  }
  if (row.hasLess && row.probUnder != null) {
    candidates.push({ bestSideName: 'lower', bestProb: row.probUnder, bestMult: parseMultiplier(row.multiplierLess) ?? 1 });
  }
  if (!candidates.length) return { bestSideName: '', bestProb: null, bestMult: null, bestPm: null };
  const best = candidates.sort((a, b) => b.bestProb * b.bestMult - a.bestProb * a.bestMult)[0];
  return { ...best, bestPm: round4(best.bestProb * best.bestMult) };
}

function matchGame(games, row) {
  const pair = new Set([normalizeTeam(row.teamAbbrev), normalizeTeam(row.opponentAbbrev)].filter(Boolean));
  if (pair.size < 2) return null;
  const rowStart = Date.parse(row.startTime || '');
  const matches = games.filter((game) => pair.has(game.away) && pair.has(game.home));
  if (matches.length <= 1 || !Number.isFinite(rowStart)) return matches[0] || null;
  return matches.sort((a, b) =>
    Math.abs(Date.parse(a.gameDate) - rowStart) - Math.abs(Date.parse(b.gameDate) - rowStart))[0];
}

function findBoxscorePlayer(box, row) {
  const wanted = normalizePlayerName(row.playerName);
  const team = normalizeTeam(row.teamAbbrev);
  const sides = ['away', 'home']
    .map((side) => box?.teams?.[side])
    .sort((a, b) => Number(normalizeTeam(b?.team?.abbreviation) === team) - Number(normalizeTeam(a?.team?.abbreviation) === team));
  for (const side of sides) {
    for (const player of Object.values(side?.players || {})) {
      if (normalizePlayerName(player?.person?.fullName) === wanted) return player;
    }
  }
  return null;
}

function numericStats(stats) {
  const clean = {};
  for (const [key, value] of Object.entries(stats)) clean[key] = Number(value) || 0;
  return clean;
}

// Recreate the page's greedy best entry per size from pregame data and grade
// it with DraftKings' void rules: voided picks drop the entry to the lower
// pick level; a non-void miss loses the entry.
function simulateGreedyEntries(date, dateRows, threshold) {
  const byPlayer = new Map();
  for (const row of dateRows) {
    if (row.bestPm == null) continue;
    const key = `${row.playerName}|${row.startTime}`;
    if (!byPlayer.has(key) || row.bestPm > byPlayer.get(key).bestPm) byPlayer.set(key, row);
  }
  const candidates = [...byPlayer.values()].sort((a, b) => b.bestPm - a.bestPm);

  const results = [];
  for (const size of [2, 3, 4, 5, 6]) {
    if (candidates.length < size) continue;
    const entry = candidates.slice(0, size);
    if (new Set(entry.map((row) => row.teamAbbrev)).size < 2) {
      const substitute = candidates.slice(size).find((row) => row.teamAbbrev !== entry[0].teamAbbrev);
      if (substitute) entry[size - 1] = substitute;
    }

    const live = entry.filter((row) => row.result === 'win' || row.result === 'loss');
    const wins = live.filter((row) => row.result === 'win');
    let profit;
    let outcome;
    if (live.length < 2) {
      profit = 0;
      outcome = 'refund';
    } else if (wins.length < live.length) {
      profit = -1;
      outcome = 'loss';
    } else {
      const payout = (BASE_PAYOUTS[live.length] ?? 0) * live.reduce((product, row) => product * row.bestMult, 1);
      profit = payout - 1;
      outcome = 'win';
    }

    results.push({
      date,
      size,
      outcome,
      profit: round4(profit),
      predictedWinProbability: round4(entry.reduce((product, row) => product * row.bestProb, 1)),
      picks: entry.map((row) => `${row.playerName} ${row.bestSideName === 'higher' ? '▲' : '▼'}${row.line} ${row.statCategory} (${row.result})`),
    });
  }
  return results;
}

function summarize(gradedRows, entryResults, threshold) {
  const decided = gradedRows.filter((row) => row.result === 'win' || row.result === 'loss');
  const wins = decided.filter((row) => row.result === 'win');

  const buckets = CALIBRATION_BUCKETS.map(([low, high]) => {
    const rows = decided.filter((row) => row.bestProb >= low && row.bestProb < high);
    return {
      bucket: `${Math.round(low * 100)}-${Math.round(Math.min(high, 1) * 100)}%`,
      picks: rows.length,
      predicted: rows.length ? round4(rows.reduce((sum, row) => sum + row.bestProb, 0) / rows.length) : null,
      actual: rows.length ? round4(rows.filter((row) => row.result === 'win').length / rows.length) : null,
    };
  });

  const edges = decided.filter((row) => row.bestPm > threshold);
  const edgeWins = edges.filter((row) => row.result === 'win');
  const brier = decided.length
    ? round4(decided.reduce((sum, row) => sum + (row.bestProb - (row.result === 'win' ? 1 : 0)) ** 2, 0) / decided.length)
    : null;

  return {
    dates: [...new Set(gradedRows.map((row) => row.date))],
    threshold,
    lines: gradedRows.length,
    decided: decided.length,
    voids: gradedRows.filter((row) => row.result.startsWith('void')).length,
    ungraded: gradedRows.filter((row) => row.result === 'no-game' || row.result === 'no-stat-model').length,
    winRate: decided.length ? round4(wins.length / decided.length) : null,
    predictedWinRate: decided.length ? round4(decided.reduce((sum, row) => sum + row.bestProb, 0) / decided.length) : null,
    brier,
    calibration: buckets,
    edges: {
      picks: edges.length,
      wins: edgeWins.length,
      winRate: edges.length ? round4(edgeWins.length / edges.length) : null,
      predictedWinRate: edges.length ? round4(edges.reduce((sum, row) => sum + row.bestProb, 0) / edges.length) : null,
      predictedPerSlotMultiple: edges.length ? round4(edges.reduce((sum, row) => sum + row.bestPm, 0) / edges.length) : null,
      realizedPerSlotMultiple: edges.length
        ? round4(edges.reduce((sum, row) => sum + (row.realizedMultiple ?? 0), 0) / edges.length)
        : null,
    },
    entryProfit: round4(entryResults.reduce((sum, entry) => sum + entry.profit, 0)),
  };
}

function printSummary(summary, gradedRows, entryResults) {
  console.log(`\nPick6 backtest — ${summary.dates.join(', ')}`);
  console.log(`Lines: ${summary.lines} | decided: ${summary.decided} | voids: ${summary.voids} | ungraded: ${summary.ungraded}`);
  console.log(`Best-side win rate: ${pct(summary.winRate)} actual vs ${pct(summary.predictedWinRate)} predicted | Brier: ${summary.brier}`);
  console.log('\nCalibration (best purchasable side):');
  for (const bucket of summary.calibration) {
    if (!bucket.picks) continue;
    console.log(`  ${bucket.bucket.padEnd(8)} ${String(bucket.picks).padStart(4)} picks | predicted ${pct(bucket.predicted)} | actual ${pct(bucket.actual)}`);
  }
  const { edges } = summary;
  console.log(`\nEdges (Prob × Mult > ${summary.threshold}): ${edges.picks} picks, ${edges.wins} wins (${pct(edges.winRate)} vs ${pct(edges.predictedWinRate)} predicted)`);
  console.log(`Per-slot multiple: ${edges.realizedPerSlotMultiple} realized vs ${edges.predictedPerSlotMultiple} predicted (break-even ≈ ${summary.threshold})`);
  if (entryResults.length) {
    console.log(`\nGreedy entries ($1 each): total profit ${summary.entryProfit >= 0 ? '+' : ''}$${summary.entryProfit}`);
    for (const entry of entryResults) {
      console.log(`  ${entry.date} ${entry.size}-pick ${entry.outcome.padEnd(6)} ${entry.profit >= 0 ? '+' : ''}$${entry.profit} | win prob ${pct(entry.predictedWinProbability)}`);
      for (const pick of entry.picks) console.log(`      ${pick}`);
    }
  }
}

async function loadScheduleGames(date) {
  const cachePath = join(CACHE_ROOT, 'pick6', `mlb-schedule-${date}.json`);
  let data = await readCachedJson(cachePath);
  if (!data) {
    const url = new URL(`${MLB_STATS_BASE_URL}/schedule`);
    url.searchParams.set('sportId', '1');
    url.searchParams.set('date', date);
    url.searchParams.set('hydrate', 'team');
    data = await fetchJson(url);
    await writeCachedJson(cachePath, data);
  }
  return (data?.dates?.[0]?.games || []).map((game) => ({
    gamePk: game.gamePk,
    gameDate: game.gameDate,
    away: normalizeTeam(game.teams?.away?.team?.abbreviation || ''),
    home: normalizeTeam(game.teams?.home?.team?.abbreviation || ''),
    state: game.status?.abstractGameState || '',
  }));
}

async function loadBoxscore(gamePk) {
  const cachePath = join(CACHE_ROOT, 'pick6', `boxscore-${gamePk}.json`);
  const cached = await readCachedJson(cachePath);
  if (cached) return cached;
  const data = await fetchJson(`${MLB_STATS_BASE_URL}/game/${gamePk}/boxscore`);
  await writeCachedJson(cachePath, data);
  return data;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Request failed with HTTP ${response.status}: ${url}`);
  return response.json();
}

async function readCachedJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function writeCachedJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

function parseMultiplier(formatted) {
  if (formatted == null) return null;
  const value = Number(String(formatted).replace(/x$/i, ''));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function toCsv(rows) {
  const columns = [
    'date', 'playerName', 'teamAbbrev', 'opponentAbbrev', 'statCategory', 'line', 'isDefault',
    'probOver', 'probUnder', 'multiplierMore', 'multiplierLess', 'projectedMean',
    'bestSideName', 'bestProb', 'bestMult', 'bestPm', 'actual', 'result', 'realizedMultiple',
  ];
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => {
      const value = row[column];
      if (value == null) return '';
      const text = String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function pct(value) {
  return value == null ? '–' : `${(value * 100).toFixed(1)}%`;
}

function round4(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.round(number * 10000) / 10000;
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    args.set(argv[index].replace(/^--/, ''), argv[index + 1]);
  }

  const yesterday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })
    .format(Date.now() - 24 * 60 * 60 * 1000);
  const start = args.get('start') || args.get('date') || yesterday;
  const end = args.get('end') || args.get('date') || start;
  const dates = [];
  for (let cursor = new Date(`${start}T12:00:00Z`); dates.length < 400; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = cursor.toISOString().slice(0, 10);
    if (date > end) break;
    dates.push(date);
  }

  return {
    dates,
    projectionSystem: args.get('projection') || 'rSteamer',
    threshold: Number(args.get('threshold')) || DEFAULT_THRESHOLD,
    outputPrefix: args.get('output-prefix') || join(ROOT, 'out', 'pick6-backtest'),
  };
}
