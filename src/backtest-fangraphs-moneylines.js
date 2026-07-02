import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const FANGRAPHS_BASE_URL = 'https://www.fangraphs.com';
const SIM_BASE_URL = `${FANGRAPHS_BASE_URL}/api-baseball-sim/Simulation`;
const ESPN_SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard';
const ESPN_CORE_BASE_URL = 'https://sports.core.api.espn.com/v2/sports/baseball/leagues/mlb';
const DEFAULT_PROJECTION_SYSTEM = 'rSteamer';
const DEFAULT_LINE = 'close';

const TEAM_ALIASES = new Map([
  ['AZ', 'ARI'],
  ['ARI', 'ARI'],
  ['ATH', 'ATH'],
  ['OAK', 'ATH'],
  ['CWS', 'CHW'],
  ['CHW', 'CHW'],
  ['KC', 'KCR'],
  ['KCR', 'KCR'],
  ['LA', 'LAD'],
  ['LAD', 'LAD'],
  ['SD', 'SDP'],
  ['SDP', 'SDP'],
  ['SF', 'SFG'],
  ['SFG', 'SFG'],
  ['TB', 'TBR'],
  ['TBR', 'TBR'],
  ['WAS', 'WSN'],
  ['WSH', 'WSN'],
  ['WSN', 'WSN'],
]);

const args = parseArgs(process.argv.slice(2));
const today = localDateString();
const end = args.end || addDays(today, -1);
const start = args.start || `${end.slice(0, 4)}-03-01`;
const projectionSystem = args.projection || DEFAULT_PROJECTION_SYSTEM;
const providerName = args.provider || '';
const lineType = args.line || DEFAULT_LINE;
const minEv = args.minEv ?? 0;
const requestDelayMs = args.requestDelayMs ?? 250;
const retries = args.retries ?? 4;
const outputPrefix = resolve(args.outputPrefix || `out/fangraphs-moneyline-backtest-${start}-to-${end}`);

try {
  const result = await backtestDateRange({
    start,
    end,
    projectionSystem,
    providerName,
    lineType,
    minEv,
    concurrency: args.concurrency || 6,
    requestDelayMs,
    retries,
  });

  await writeCsv(`${outputPrefix}-games.csv`, result.games);
  await writeCsv(`${outputPrefix}-bets.csv`, result.bets);
  await writeJson(`${outputPrefix}-summary.json`, result.summary);

  printSummary(result.summary, outputPrefix);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

async function backtestDateRange({ start, end, projectionSystem, providerName, lineType, minEv, concurrency, requestDelayMs, retries }) {
  validateDateRange(start, end);

  const games = [];
  const bets = [];

  for (const date of dateRange(start, end)) {
    process.stdout.write(`Fetching ${date}...\n`);
    const [fangraphsGames, espnEvents] = await Promise.all([
      fetchFangraphsGames(date, { requestDelayMs, retries }),
      fetchEspnEvents(date, { requestDelayMs, retries }),
    ]);

    const espnIndex = indexEspnEvents(espnEvents);

    const rowsForDate = await mapLimit(fangraphsGames, concurrency, async (game) => {
      const row = await buildGameBacktestRow({
        date,
        game,
        espnIndex,
        projectionSystem,
      providerName,
      lineType,
      requestDelayMs,
      retries,
    });
      return row;
    });

    for (const row of rowsForDate) {
      games.push(row);
      bets.push(...buildBetsForGame(row, minEv));
    }
  }

  return {
    games,
    bets,
    summary: summarize({ start, end, games, bets, projectionSystem, providerName, lineType, minEv }),
  };
}

async function buildGameBacktestRow({ date, game, espnIndex, projectionSystem, providerName, lineType, requestDelayMs, retries }) {
  const schedule = game.schedule || {};
  const scores = game.scores || {};
  const simId = getSimId(schedule, date);
  const awayTeamAbbrev = normalizeTeam(schedule.AwayTeamAbbName || schedule.awayTeamAbbName || scores.AwayAbb || '');
  const homeTeamAbbrev = normalizeTeam(schedule.HomeTeamAbbName || schedule.homeTeamAbbName || scores.HomeAbb || '');
  const startUtc = schedule.GameDateTimeUTC || schedule.gameDateTimeUTC || '';

  let sim = null;
  let simError = '';
  if (simId) {
    try {
      sim = await fetchGameSimulation(simId, projectionSystem, { requestDelayMs, retries });
    } catch (error) {
      simError = error instanceof Error ? error.message : String(error);
    }
  } else {
    simError = 'No MLB game id or team ids were available for this schedule row.';
  }

  const espnEvent = takeMatchingEspnEvent(espnIndex, { awayTeamAbbrev, homeTeamAbbrev, startUtc });
  let odds = null;
  let oddsError = '';
  if (espnEvent) {
    try {
      odds = await fetchEspnOdds(espnEvent.id, espnEvent.competitionId, providerName, { requestDelayMs, retries });
    } catch (error) {
      oddsError = error instanceof Error ? error.message : String(error);
    }
  } else {
    oddsError = 'No matching ESPN event.';
  }

  const homeWinPct = numberOrNull(sim?.homeWinPct);
  const awayWinPct = homeWinPct == null ? null : numberOrNull(1 - homeWinPct);
  const awayLine = odds ? getTeamMoneyline(odds.awayTeamOdds, lineType) : null;
  const homeLine = odds ? getTeamMoneyline(odds.homeTeamOdds, lineType) : null;
  const awayScore = numberOrNull(scores.AwayScore ?? scores.awayScore ?? getEspnScore(espnEvent, 'away'));
  const homeScore = numberOrNull(scores.HomeScore ?? scores.homeScore ?? getEspnScore(espnEvent, 'home'));
  const winner = getWinner({ awayTeamAbbrev, homeTeamAbbrev, awayScore, homeScore, scores, espnEvent });

  return {
    date,
    gameId: schedule.GameId ?? schedule.gameid ?? game.GameId ?? '',
    mlbGameId: schedule.MLBGameId ?? schedule.mlbgameid ?? game.MLBGameId ?? '',
    simId,
    espnEventId: espnEvent?.id || '',
    espnCompetitionId: espnEvent?.competitionId || '',
    gameTimeUtc: startUtc,
    awayTeam: schedule.AwayTeamName || scores.AwayName || '',
    awayTeamAbbrev,
    homeTeam: schedule.HomeTeamName || scores.HomeName || '',
    homeTeamAbbrev,
    isFinal: Boolean(scores.isFinal || espnEvent?.completed),
    awayScore: awayScore ?? '',
    homeScore: homeScore ?? '',
    winner,
    projectionSystem: sim?.projectionSystem || projectionSystem,
    simulations: sim?.simulations ?? '',
    simLoadDate: sim?.loadDate || '',
    awayWinPct,
    homeWinPct,
    awayFairMoneyline: pctToAmericanOdds(awayWinPct),
    homeFairMoneyline: pctToAmericanOdds(homeWinPct),
    oddsProvider: odds?.provider?.name || '',
    oddsLineType: lineType,
    espnAwayMoneyline: awayLine ?? '',
    espnHomeMoneyline: homeLine ?? '',
    awayMarketImpliedPct: americanToImpliedPct(awayLine),
    homeMarketImpliedPct: americanToImpliedPct(homeLine),
    awayExpectedRoi: expectedRoi(awayWinPct, awayLine),
    homeExpectedRoi: expectedRoi(homeWinPct, homeLine),
    simError,
    oddsError,
  };
}

function buildBetsForGame(row, minEv) {
  const bets = [];
  for (const side of ['away', 'home']) {
    const winPct = row[`${side}WinPct`];
    const moneyline = row[`espn${capitalize(side)}Moneyline`];
    const expected = row[`${side}ExpectedRoi`];
    if (!row.isFinal || row.winner === '' || winPct == null || moneyline === '' || expected == null || expected <= minEv) {
      continue;
    }

    const team = row[`${side}TeamAbbrev`];
    const hit = row.winner === team;
    const profit = hit ? profitForWinningAmericanOdds(Number(moneyline)) : -1;
    bets.push({
      date: row.date,
      gameId: row.gameId,
      mlbGameId: row.mlbGameId,
      espnEventId: row.espnEventId,
      side,
      team,
      opponent: row[`${side === 'away' ? 'home' : 'away'}TeamAbbrev`],
      isHome: side === 'home',
      fanGraphsWinPct: winPct,
      fairMoneyline: row[`${side}FairMoneyline`],
      espnMoneyline: moneyline,
      marketImpliedPct: row[`${side}MarketImpliedPct`],
      edgePct: round6(winPct - row[`${side}MarketImpliedPct`]),
      expectedRoi: expected,
      hit,
      profit: round6(profit),
      awayScore: row.awayScore,
      homeScore: row.homeScore,
      winner: row.winner,
    });
  }
  return bets;
}

async function fetchFangraphsGames(date, options = {}) {
  const url = new URL('/api/scores/live', FANGRAPHS_BASE_URL);
  url.searchParams.set('gamedate', date);

  const data = await fetchJson(url, {
    accept: 'application/json, text/plain, */*',
    'user-agent': 'fangraphs-moneyline-backtest/1.0',
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
    'user-agent': 'fangraphs-moneyline-backtest/1.0',
    referer: `${FANGRAPHS_BASE_URL}/lab/baseball-sim`,
  }, options);
}

async function fetchEspnEvents(date, options = {}) {
  const url = new URL(ESPN_SCOREBOARD_URL);
  url.searchParams.set('dates', date.replaceAll('-', ''));
  url.searchParams.set('limit', '100');

  const data = await fetchJson(url, {}, options);
  return Array.isArray(data.events) ? data.events : [];
}

async function fetchEspnOdds(eventId, competitionId, providerName, options = {}) {
  const url = new URL(`${ESPN_CORE_BASE_URL}/events/${eventId}/competitions/${competitionId}/odds`);
  url.searchParams.set('lang', 'en');
  url.searchParams.set('region', 'us');

  const data = await fetchJson(url, {}, options);
  const items = Array.isArray(data.items) ? data.items : [];
  if (!items.length) {
    throw new Error('ESPN odds payload had no providers.');
  }

  return providerName
    ? items.find((item) => item?.provider?.name === providerName) || items[0]
    : items[0];
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

function indexEspnEvents(events) {
  const index = new Map();
  for (const event of events) {
    const competition = event.competitions?.[0];
    const competitors = competition?.competitors || [];
    const away = competitors.find((competitor) => competitor.homeAway === 'away');
    const home = competitors.find((competitor) => competitor.homeAway === 'home');
    if (!away || !home) continue;

    const entry = {
      id: event.id,
      competitionId: competition.id || event.id,
      startUtc: competition.date || event.date || '',
      completed: Boolean(event.status?.type?.completed || competition.status?.type?.completed),
      awayTeamAbbrev: normalizeTeam(away.team?.abbreviation),
      homeTeamAbbrev: normalizeTeam(home.team?.abbreviation),
      competitors,
    };

    const key = matchupKey(entry.awayTeamAbbrev, entry.homeTeamAbbrev);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(entry);
  }

  for (const entries of index.values()) {
    entries.sort((a, b) => new Date(a.startUtc) - new Date(b.startUtc));
  }

  return index;
}

function takeMatchingEspnEvent(index, { awayTeamAbbrev, homeTeamAbbrev, startUtc }) {
  const candidates = index.get(matchupKey(awayTeamAbbrev, homeTeamAbbrev)) || [];
  if (!candidates.length) return null;

  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  const targetTime = new Date(startUtc).getTime();
  for (let index = 0; index < candidates.length; index += 1) {
    const candidateTime = new Date(candidates[index].startUtc).getTime();
    const distance = Number.isFinite(targetTime) && Number.isFinite(candidateTime)
      ? Math.abs(candidateTime - targetTime)
      : index;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }

  return candidates.splice(bestIndex, 1)[0] || null;
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

function getTeamMoneyline(teamOdds, preferredLineType) {
  const line = teamOdds?.[preferredLineType]?.moneyLine?.american
    ?? teamOdds?.[preferredLineType]?.moneyLine?.alternateDisplayValue
    ?? teamOdds?.moneyLine
    ?? teamOdds?.current?.moneyLine?.american
    ?? teamOdds?.close?.moneyLine?.american
    ?? teamOdds?.open?.moneyLine?.american;
  return parseAmericanOdds(line);
}

function getEspnScore(event, side) {
  const competitor = event?.competitors?.find((item) => item.homeAway === side);
  return competitor?.score;
}

function getWinner({ awayTeamAbbrev, homeTeamAbbrev, awayScore, homeScore, scores, espnEvent }) {
  const winTeamId = scores.WinTeamId ?? scores.winTeamId;
  const awayTeamId = scores.AwayTeamId ?? scores.awayTeamId;
  const homeTeamId = scores.HomeTeamId ?? scores.homeTeamId;
  if (winTeamId != null && awayTeamId != null && String(winTeamId) === String(awayTeamId)) return awayTeamAbbrev;
  if (winTeamId != null && homeTeamId != null && String(winTeamId) === String(homeTeamId)) return homeTeamAbbrev;

  const espnWinner = espnEvent?.competitors?.find((competitor) => competitor.winner);
  if (espnWinner) return normalizeTeam(espnWinner.team?.abbreviation);

  if (awayScore == null || homeScore == null || awayScore === homeScore) return '';
  return awayScore > homeScore ? awayTeamAbbrev : homeTeamAbbrev;
}

function summarize({ start, end, games, bets, projectionSystem, providerName, lineType, minEv }) {
  const wins = bets.filter((bet) => bet.hit).length;
  const losses = bets.length - wins;
  const profit = round6(bets.reduce((sum, bet) => sum + Number(bet.profit || 0), 0));
  const completeGames = games.filter((game) => game.isFinal).length;
  const gamesWithSim = games.filter((game) => game.homeWinPct != null && game.awayWinPct != null).length;
  const gamesWithOdds = games.filter((game) => game.espnAwayMoneyline !== '' && game.espnHomeMoneyline !== '').length;

  return {
    start,
    end,
    projectionSystem,
    oddsProvider: providerName || 'first available',
    oddsLineType: lineType,
    minExpectedRoi: minEv,
    totalGames: games.length,
    completeGames,
    gamesWithSim,
    gamesWithOdds,
    betCount: bets.length,
    wins,
    losses,
    hitPct: bets.length ? round6(wins / bets.length) : null,
    profitUnits: profit,
    roi: bets.length ? round6(profit / bets.length) : null,
    skippedNoSim: games.filter((game) => game.simError || game.homeWinPct == null).length,
    skippedNoOdds: games.filter((game) => game.oddsError || game.espnAwayMoneyline === '' || game.espnHomeMoneyline === '').length,
  };
}

function printSummary(summary, outputPrefix) {
  console.log('\nBacktest summary');
  console.log(`Range: ${summary.start} to ${summary.end}`);
  console.log(`Projection: ${summary.projectionSystem}`);
  console.log(`Odds: ${summary.oddsProvider} provider, ${summary.oddsLineType} line`);
  console.log(`Good-bet rule: expected ROI > ${formatPct(summary.minExpectedRoi)}`);
  console.log(`Games: ${summary.totalGames} (${summary.completeGames} final, ${summary.gamesWithSim} with sims, ${summary.gamesWithOdds} with odds)`);
  console.log(`Bets: ${summary.betCount}`);
  console.log(`Wins/Losses: ${summary.wins}-${summary.losses}`);
  console.log(`Hit rate: ${summary.hitPct == null ? 'n/a' : formatPct(summary.hitPct)}`);
  console.log(`Profit: ${summary.profitUnits} units`);
  console.log(`ROI: ${summary.roi == null ? 'n/a' : formatPct(summary.roi)}`);
  console.log(`Wrote ${outputPrefix}-games.csv`);
  console.log(`Wrote ${outputPrefix}-bets.csv`);
  console.log(`Wrote ${outputPrefix}-summary.json`);
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

function americanToImpliedPct(odds) {
  const number = parseAmericanOdds(odds);
  if (number == null) return null;
  return number < 0 ? round6(Math.abs(number) / (Math.abs(number) + 100)) : round6(100 / (number + 100));
}

function expectedRoi(winPct, odds) {
  const number = parseAmericanOdds(odds);
  if (winPct == null || number == null) return null;
  return round6(winPct * profitForWinningAmericanOdds(number) - (1 - winPct));
}

function profitForWinningAmericanOdds(odds) {
  return odds > 0 ? odds / 100 : 100 / Math.abs(odds);
}

function pctToAmericanOdds(pct) {
  if (pct == null || pct <= 0 || pct >= 1) return null;
  return pct >= 0.5
    ? Math.round((-100 * pct) / (1 - pct))
    : Math.round((100 * (1 - pct)) / pct);
}

function parseAmericanOdds(value) {
  if (value == null || value === '') return null;
  const number = Number(String(value).trim().replace(/^\+/, ''));
  return Number.isFinite(number) && number !== 0 ? number : null;
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? round6(number) : null;
}

function normalizeTeam(abbrev = '') {
  const upper = String(abbrev).trim().toUpperCase();
  return TEAM_ALIASES.get(upper) || upper;
}

function matchupKey(awayTeamAbbrev, homeTeamAbbrev) {
  return `${normalizeTeam(awayTeamAbbrev)}@${normalizeTeam(homeTeamAbbrev)}`;
}

function capitalize(value) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
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
    else if (name === 'projection') parsed.projection = value;
    else if (name === 'provider') parsed.provider = value;
    else if (name === 'line') {
      if (!['open', 'current', 'close'].includes(value)) {
        throw new Error('--line must be open, current, or close.');
      }
      parsed.line = value;
    } else if (name === 'min-ev') {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new Error('--min-ev must be a number.');
      parsed.minEv = number;
    } else if (name === 'concurrency') {
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

  if (parsed.start && !/^\d{4}-\d{2}-\d{2}$/.test(parsed.start)) {
    throw new Error('Use --start in YYYY-MM-DD format.');
  }
  if (parsed.end && !/^\d{4}-\d{2}-\d{2}$/.test(parsed.end)) {
    throw new Error('Use --end in YYYY-MM-DD format.');
  }

  return parsed;
}

function printHelp() {
  console.log(`Usage:
  node src/backtest-fangraphs-moneylines.js --start 2026-03-01 --end 2026-06-29

Options:
  --start YYYY-MM-DD          First game date. Defaults to March 1 of the end year.
  --end YYYY-MM-DD            Last game date. Defaults to yesterday.
  --output-prefix PATH        Output prefix. Defaults to out/fangraphs-moneyline-backtest-START-to-END.
  --projection NAME           FanGraphs projection system. Defaults to rSteamer.
  --provider NAME             ESPN odds provider. Defaults to the first provider in ESPN's odds feed.
  --line open|current|close   ESPN moneyline snapshot. Defaults to close.
  --min-ev NUMBER             Minimum expected ROI for a bet. Defaults to 0.
  --concurrency NUMBER        Per-date game request concurrency. Defaults to 6.
  --request-delay-ms NUMBER   Delay before each HTTP request. Defaults to 250.
  --retries NUMBER            Retry count for 429/5xx responses. Defaults to 4.
`);
}
