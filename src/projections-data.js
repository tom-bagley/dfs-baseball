import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CACHE_ROOT = resolve(process.env.CACHE_DIR || join(ROOT, 'out', 'cache'));
const FANGRAPHS_BASE_URL = 'https://www.fangraphs.com';
const SIM_BASE_URL = `${FANGRAPHS_BASE_URL}/api-baseball-sim/Simulation`;
const ESPN_SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard';
const ESPN_CORE_BASE_URL = 'https://sports.core.api.espn.com/v2/sports/baseball/leagues/mlb';
const DEFAULT_PROJECTION_SYSTEM = 'rSteamer';
const DEFAULT_LINE_TYPE = 'current';
const DISPLAY_TIME_ZONE = 'America/Chicago';
const DK_LOBBY_URL = 'https://www.draftkings.com/lobby/getcontests?sport=MLB';
const DK_DRAFTABLES_BASE_URL = 'https://api.draftkings.com/draftgroups/v1/draftgroups';
// MLB Classic (2 P, C, 1B, 2B, 3B, SS, 3 OF) — the format the lineup optimizer builds.
const DK_CLASSIC_CONTEST_TYPE_ID = 28;
const DK_FPPG_STAT_ID = 408;
const DK_ROSTER_SLOT_NAMES = new Map([
  [110, 'P'],
  [111, 'C'],
  [112, '1B'],
  [113, '2B'],
  [114, '3B'],
  [115, 'SS'],
  [116, 'OF'],
]);
const DK_HEADERS = {
  accept: 'application/json, text/plain, */*',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
};

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

export async function getProjectionSlate({
  date,
  projectionSystem = DEFAULT_PROJECTION_SYSTEM,
  providerName = '',
  lineType = DEFAULT_LINE_TYPE,
} = {}) {
  validateDate(date);

  const cacheStats = {
    schedule: 'network',
    simsHit: 0,
    simsMiss: 0,
  };

  const games = await fetchFangraphsGames(date);
  const gameRows = [];

  for (const game of games) {
    const schedule = game.schedule || {};
    const scores = game.scores || {};
    const simId = getSimId(schedule, date);
    let sim = null;
    let error = '';

    if (simId) {
      const cached = await getCachedJson(simCachePath(projectionSystem, simId));
      if (cached) {
        sim = cached;
        cacheStats.simsHit += 1;
      } else {
        try {
          sim = await fetchGameSimulation(simId, projectionSystem);
          await writeCachedJson(simCachePath(projectionSystem, simId), sim);
          cacheStats.simsMiss += 1;
        } catch (fetchError) {
          error = formatError(fetchError);
        }
      }
    } else {
      error = 'No MLBGameId or team ids were available for this schedule row.';
    }

    const gameRow = buildGameRow({ date, game, simId, projectionSystem, sim, error, schedule, scores });
    if (sim) {
      gameRow.customInput = buildCustomInput({ date, game, simId, projectionSystem, sim, schedule });
    }
    gameRows.push(gameRow);
  }

  const teamRows = gameRows.flatMap(gameToTeamRows);
  const oddsRows = await getOddsRows({
    date,
    games: buildGamesPayload(teamRows),
    providerName,
    lineType,
    cacheStats,
  });

  mergeOdds(teamRows, oddsRows);

  return {
    ok: true,
    date,
    projectionSystem,
    rows: teamRows,
    games: gameRows,
    cache: cacheStats,
    refreshedAt: new Date().toISOString(),
  };
}

export async function getPlayerProjectionSlate({
  date,
  projectionSystem = DEFAULT_PROJECTION_SYSTEM,
} = {}) {
  validateDate(date);

  const cacheStats = {
    schedule: 'network',
    simsHit: 0,
    simsMiss: 0,
  };

  const games = await fetchFangraphsGames(date);
  const rows = [];

  for (const game of games) {
    const schedule = game.schedule || {};
    const scores = game.scores || {};
    const simId = getSimId(schedule, date);

    if (!simId) continue;

    try {
      const cached = await getCachedJson(simCachePath(projectionSystem, simId));
      let sim = cached;
      if (sim) {
        cacheStats.simsHit += 1;
      } else {
        sim = await fetchGameSimulation(simId, projectionSystem);
        await writeCachedJson(simCachePath(projectionSystem, simId), sim);
        cacheStats.simsMiss += 1;
      }

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
        displayTime: formatDisplayTime(schedule.GameDateTimeUTC),
        playerType: 'error',
        playerId: '',
        playerName: '',
        team: schedule.AwayTeamAbbName && schedule.HomeTeamAbbName
          ? `${schedule.AwayTeamAbbName} @ ${schedule.HomeTeamAbbName}`
          : '',
        expectedPoints: null,
        error: formatError(error),
      });
    }
  }

  const draftKings = await loadDraftKingsSalaries(date);
  if (draftKings?.rows?.length) {
    const salaryStats = mergeDraftKingsSalaries(rows, draftKings.rows);
    cacheStats.draftKingsSalaries = 'hit';
    cacheStats.draftKingsRows = draftKings.rows.length;
    cacheStats.draftKingsMatched = salaryStats.matched;
  } else {
    cacheStats.draftKingsSalaries = 'missing';
    cacheStats.draftKingsRows = 0;
    cacheStats.draftKingsMatched = 0;
  }

  rows.sort((a, b) => Number(b.expectedPoints ?? -9999) - Number(a.expectedPoints ?? -9999));

  return {
    ok: true,
    date,
    projectionSystem,
    rows,
    cache: cacheStats,
    refreshedAt: new Date().toISOString(),
  };
}

export async function importDraftKingsSalaries({
  date,
  csvText,
} = {}) {
  validateDate(date);
  const rows = parseDraftKingsSalaryCsv(csvText);
  if (!rows.length) {
    throw new Error('No DraftKings salary rows were found in that CSV.');
  }

  const payload = {
    date,
    source: 'DraftKings',
    rows,
    importedAt: new Date().toISOString(),
  };
  await writeCachedJson(draftKingsSalaryCachePath(date), payload);

  return {
    ok: true,
    date,
    source: 'DraftKings',
    rows: rows.length,
    importedAt: payload.importedAt,
  };
}

export async function getDraftKingsSlates({ date } = {}) {
  validateDate(date);

  const data = await fetchJson(DK_LOBBY_URL, DK_HEADERS);
  const groups = Array.isArray(data?.DraftGroups) ? data.DraftGroups : [];
  const slates = groups
    .filter((group) => group?.ContestTypeId === DK_CLASSIC_CONTEST_TYPE_ID)
    .filter((group) => String(group?.StartDateEst || '').slice(0, 10) === date)
    .map(buildDraftKingsSlateOption)
    .sort((a, b) => a.sortOrder - b.sortOrder
      || b.gameCount - a.gameCount
      || a.startTimeEst.localeCompare(b.startTimeEst));

  return {
    ok: true,
    date,
    sport: 'MLB',
    slates,
    fetchedAt: new Date().toISOString(),
  };
}

export async function fetchDraftKingsSalaries({ date, draftGroupId } = {}) {
  validateDate(date);
  const groupId = Number(draftGroupId);
  if (!Number.isInteger(groupId) || groupId <= 0) {
    throw new Error('Select a DraftKings slate first.');
  }

  const url = `${DK_DRAFTABLES_BASE_URL}/${groupId}/draftables?format=json`;
  const data = await fetchJson(url, DK_HEADERS);
  const rows = parseDraftKingsDraftables(data);
  if (!rows.length) {
    throw new Error('DraftKings returned no priced players for that slate.');
  }

  const payload = {
    date,
    source: 'DraftKings',
    draftGroupId: groupId,
    rows,
    importedAt: new Date().toISOString(),
  };
  await writeCachedJson(draftKingsSalaryCachePath(date), payload);

  return {
    ok: true,
    date,
    source: 'DraftKings',
    draftGroupId: groupId,
    rows: rows.length,
    importedAt: payload.importedAt,
  };
}

async function getOddsRows({ date, games, providerName, lineType, cacheStats }) {
  if (!games.length) return [];

  const events = await fetchEspnEvents(date);
  const eventIndex = indexEspnEvents(events);
  const rows = [];

  for (const game of games) {
    const espnEvent = takeMatchingEspnEvent(eventIndex, {
      awayTeamAbbrev: game.awayTeamAbbrev,
      homeTeamAbbrev: game.homeTeamAbbrev,
      startUtc: game.gameTime,
    });

    if (!espnEvent) {
      rows.push({
        gameKey: game.gameKey,
        awayTeamAbbrev: normalizeTeam(game.awayTeamAbbrev),
        homeTeamAbbrev: normalizeTeam(game.homeTeamAbbrev),
        error: 'No matching ESPN event.',
      });
      continue;
    }

    try {
      const odds = await fetchEspnOdds(espnEvent.id, espnEvent.competitionId, providerName);
      rows.push({
        gameKey: game.gameKey,
        espnEventId: espnEvent.id,
        espnCompetitionId: espnEvent.competitionId,
        awayTeamAbbrev: espnEvent.awayTeamAbbrev,
        homeTeamAbbrev: espnEvent.homeTeamAbbrev,
        provider: odds?.provider?.name || '',
        lineType,
        awayMoneyline: getTeamMoneyline(odds?.awayTeamOdds, lineType),
        homeMoneyline: getTeamMoneyline(odds?.homeTeamOdds, lineType),
        error: '',
      });
    } catch (error) {
      rows.push({
        gameKey: game.gameKey,
        espnEventId: espnEvent.id,
        awayTeamAbbrev: espnEvent.awayTeamAbbrev,
        homeTeamAbbrev: espnEvent.homeTeamAbbrev,
        error: formatError(error),
      });
    }
  }

  return rows;
}

async function fetchFangraphsGames(date) {
  const url = new URL('/api/scores/live', FANGRAPHS_BASE_URL);
  url.searchParams.set('gamedate', date);

  const data = await fetchJson(url, {
    accept: 'application/json, text/plain, */*',
    'user-agent': 'dfs-baseball-projections/1.0',
    referer: `${FANGRAPHS_BASE_URL}/lab/baseball-sim`,
  });

  if (!Array.isArray(data)) {
    throw new Error(`Expected FanGraphs schedule to be an array for ${date}.`);
  }

  return data;
}

async function fetchGameSimulation(simId, projectionSystem) {
  const url = new URL(`${SIM_BASE_URL}/sim-game-json/${encodeURIComponent(simId)}`);
  url.searchParams.set('idType', 'upid');
  url.searchParams.set('projectionSystem', projectionSystem);
  return fetchJson(url, {
    accept: 'application/json, text/plain, */*',
    'user-agent': 'dfs-baseball-projections/1.0',
    referer: `${FANGRAPHS_BASE_URL}/lab/baseball-sim`,
  });
}

export async function runCustomProjection({
  date,
  gameKey,
  payload,
  providerName = '',
  lineType = DEFAULT_LINE_TYPE,
} = {}) {
  validateDate(date);
  if (!payload || typeof payload !== 'object') {
    throw new Error('Custom simulation payload is required.');
  }

  const games = await fetchFangraphsGames(date);
  const game = findGameByKey(games, gameKey, date);
  if (!game) {
    throw new Error('Could not find the selected game for that date.');
  }

  const schedule = game.schedule || {};
  const scores = game.scores || {};
  const projectionSystem = payload.projectionSystem || DEFAULT_PROJECTION_SYSTEM;
  const payloadHash = hashJson(payload);
  const cachePath = customSimCachePath(projectionSystem, payloadHash);
  const cached = await getCachedJson(cachePath);
  const sim = cached || await fetchCustomSimulation(payload);
  if (!cached) {
    await writeCachedJson(cachePath, sim);
  }

  const simId = sim?.shortCode || sim?.simId || `custom-${payloadHash.slice(0, 12)}`;
  const gameRow = buildGameRow({ date, game, simId, projectionSystem, sim, error: '', schedule, scores });
  gameRow.custom = true;
  gameRow.customHash = payloadHash;

  const rows = gameToTeamRows(gameRow);
  rows.forEach((row) => {
    row.lineupSource = 'custom';
    row.custom = true;
  });

  const oddsRows = await getOddsRows({
    date,
    games: buildGamesPayload(rows),
    providerName,
    lineType,
    cacheStats: {},
  });
  mergeOdds(rows, oddsRows);

  return {
    ok: true,
    date,
    gameKey,
    projectionSystem,
    simId,
    rows,
    game: {
      ...gameRow,
      customInput: buildCustomInput({ date, game, simId, projectionSystem, sim, schedule }),
    },
    cache: { customSim: cached ? 'hit' : 'miss' },
    refreshedAt: new Date().toISOString(),
  };
}

async function fetchCustomSimulation(payload) {
  const url = new URL(`${SIM_BASE_URL}/custom-game`);
  url.searchParams.set('idType', 'upid');

  const data = await fetchJson(url, {
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/json',
    'user-agent': 'dfs-baseball-projections/1.0',
    referer: `${FANGRAPHS_BASE_URL}/lab/baseball-sim`,
  }, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  if (data?.shortCode && (data.homeWinPct == null || !data.home || !data.away)) {
    return fetchCustomSimulationResult(data.shortCode);
  }

  return data;
}

async function fetchCustomSimulationResult(shortCode) {
  const url = new URL(`${SIM_BASE_URL}/custom-game-json/${encodeURIComponent(shortCode)}`);
  url.searchParams.set('idType', 'upid');
  return fetchJson(url, {
    accept: 'application/json, text/plain, */*',
    'user-agent': 'dfs-baseball-projections/1.0',
    referer: `${FANGRAPHS_BASE_URL}/lab/baseball-sim`,
  });
}

async function fetchEspnEvents(date) {
  const url = new URL(ESPN_SCOREBOARD_URL);
  url.searchParams.set('dates', date.replaceAll('-', ''));
  url.searchParams.set('limit', '100');

  const data = await fetchJson(url);
  return Array.isArray(data.events) ? data.events : [];
}

async function fetchEspnOdds(eventId, competitionId, providerName) {
  const url = new URL(`${ESPN_CORE_BASE_URL}/events/${eventId}/competitions/${competitionId}/odds`);
  url.searchParams.set('lang', 'en');
  url.searchParams.set('region', 'us');

  const data = await fetchJson(url);
  const items = Array.isArray(data.items) ? data.items : [];
  if (!items.length) {
    throw new Error('ESPN odds payload had no providers.');
  }

  return providerName
    ? items.find((item) => item?.provider?.name === providerName) || items[0]
    : items[0];
}

async function fetchJson(url, headers = {}, options = {}) {
  const response = await fetch(url, { headers, ...options });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Request failed (${response.status}) for ${url}: ${body.slice(0, 240)}`);
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

function buildCustomInput({ date, game, simId, projectionSystem, sim, schedule }) {
  const gameRow = buildGameRow({
    date,
    game,
    simId,
    projectionSystem,
    sim,
    error: '',
    schedule,
    scores: game.scores || {},
  });

  return {
    gameKey: gameRow.mlbGameId || gameRow.gameId || `${date}-${gameRow.awayTeamAbbrev}-${gameRow.homeTeamAbbrev}`,
    date,
    gameId: gameRow.gameId,
    mlbGameId: gameRow.mlbGameId,
    projectionSystem,
    homeTeamId: String(gameRow.homeTeamId || sim?.homeTeam?.id || ''),
    awayTeamId: String(gameRow.awayTeamId || sim?.awayTeam?.id || ''),
    homeTeamName: gameRow.homeTeam,
    awayTeamName: gameRow.awayTeam,
    homeTeamAbbrev: gameRow.homeTeamAbbrev,
    awayTeamAbbrev: gameRow.awayTeamAbbrev,
    home: lineupFromSimSide(sim?.home),
    away: lineupFromSimSide(sim?.away),
    players: playersFromSim(sim),
  };
}

function lineupFromSimSide(side = {}) {
  const batters = Array.isArray(side?.batters) ? side.batters : [];
  const pitchers = Array.isArray(side?.pitchers) ? side.pitchers : [];
  const starter = getStartingPitcher(side);
  const opener = pitchers.find((pitcher) => String(pitcher.role || '').toLowerCase() === 'opener') || {};
  const bullpen = pitchers
    .filter((pitcher) => {
      const role = String(pitcher.role || '').toLowerCase();
      return role !== 'starter' && role !== 'primary pitcher' && role !== 'opener';
    })
    .map((pitcher) => ({
      role: pitcher.role || 'Middle Reliever',
      playerId: stringifyId(pitcher.playerId),
      name: pitcher.name || '',
    }));

  return {
    lineupSource: side.lineupSource || '',
    battingOrder: batters.slice(0, 9).map((batter, index) => ({
      position: batter.position || defaultPositions()[index] || '',
      playerId: stringifyId(batter.playerId),
      name: batter.name || '',
    })),
    startingPitcher: stringifyId(starter.playerId),
    startingPitcherName: starter.name || '',
    opener: stringifyId(opener.playerId),
    openerName: opener.name || '',
    bullpen,
  };
}

function playersFromSim(sim = {}) {
  return {
    batters: [
      ...sidePlayers(sim?.away, 'batter', sim?.awayTeam, sim?.homeTeam),
      ...sidePlayers(sim?.home, 'batter', sim?.homeTeam, sim?.awayTeam),
    ],
    pitchers: [
      ...sidePlayers(sim?.away, 'pitcher', sim?.awayTeam, sim?.homeTeam),
      ...sidePlayers(sim?.home, 'pitcher', sim?.homeTeam, sim?.awayTeam),
    ],
    all: [
      ...sidePlayers(sim?.away, 'batter', sim?.awayTeam, sim?.homeTeam),
      ...sidePlayers(sim?.home, 'batter', sim?.homeTeam, sim?.awayTeam),
      ...sidePlayers(sim?.away, 'pitcher', sim?.awayTeam, sim?.homeTeam),
      ...sidePlayers(sim?.home, 'pitcher', sim?.homeTeam, sim?.awayTeam),
    ],
  };
}

function buildGamePlayerRows({ date, game, schedule, scores, simId, sim, projectionSystem }) {
  const context = {
    date,
    gameId: schedule.GameId ?? game.GameId ?? '',
    mlbGameId: schedule.MLBGameId ?? game.MLBGameId ?? '',
    simId,
    gameKey: schedule.MLBGameId ?? game.MLBGameId ?? schedule.GameId ?? game.GameId ?? '',
    projectionSystem: sim?.projectionSystem || projectionSystem,
    gameTimeUtc: schedule.GameDateTimeUTC || '',
    gameTimeLocal: formatLocalTime(schedule.GameDateTimeUTC),
    displayTime: formatDisplayTime(schedule.GameDateTimeUTC),
    status: scores.isFinal ? 'Final' : scores.Inning ? `${scores.IH || ''} ${scores.Inning}`.trim() : '',
    simulations: numberOrNull(sim?.simulations),
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
    const lineupSource = side.team?.lineupSource || '';
    const isConfirmedLineup = String(lineupSource).toLowerCase() === 'confirmed';

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
        lineupSource,
        confirmedLineup: isConfirmedLineup,
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
        lineupSource,
        confirmedLineup: false,
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
    hitterPoints: roundStat(hitterPoints),
    pitcherPoints: null,
    expectedPoints: roundStat(hitterPoints),
  };
}

function pitcherStats(average = {}, histograms = {}) {
  const outs = stat(average, 'Outs');
  const inningsPitched = roundStat(outs / 3);
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
    completeGamePct: roundStat(completeGamePct),
    cgShutoutPctEstimate: roundStat(cgShutoutPctEstimate),
    noHitterPctEstimate: roundStat(noHitterPctEstimate),
    pitcherPoints: roundStat(pitcherPoints),
    expectedPoints: roundStat(pitcherPoints),
  };
}

function blankHittingStats() {
  return {
    singles: null,
    doubles: null,
    triples: null,
    homeRuns: null,
    runsBattedIn: null,
    runs: null,
    walks: null,
    hitByPitch: null,
    stolenBases: null,
    hitterPoints: null,
  };
}

function blankPitchingStats() {
  return {
    inningsPitched: null,
    outs: null,
    strikeouts: null,
    win: null,
    earnedRunsAllowed: null,
    hitsAgainst: null,
    walksAgainst: null,
    hitBatsmen: null,
    completeGamePct: null,
    cgShutoutPctEstimate: null,
    noHitterPctEstimate: null,
  };
}

async function loadDraftKingsSalaries(date) {
  return getCachedJson(draftKingsSalaryCachePath(date));
}

function mergeDraftKingsSalaries(rows, salaries) {
  const salaryIndex = indexDraftKingsSalaries(salaries);
  let matched = 0;

  for (const row of rows) {
    if (!row.playerName || !row.teamAbbrev) continue;
    const salary = salaryIndex.get(draftKingsMatchKey(row.playerName, row.teamAbbrev));
    if (!salary) continue;

    row.dkSalary = salary.salary;
    row.dkPosition = salary.position;
    row.dkRosterPosition = salary.rosterPosition;
    row.dkGameInfo = salary.gameInfo;
    row.dkName = salary.name;
    row.dkId = salary.id;
    row.dkAvgPointsPerGame = salary.avgPointsPerGame;
    row.dkValue = typeof row.expectedPoints === 'number' && typeof salary.salary === 'number' && salary.salary > 0
      ? roundStat(row.expectedPoints / (salary.salary / 1000))
      : null;
    row.dkDollarsPerPoint = typeof row.expectedPoints === 'number'
      && row.expectedPoints > 0
      && typeof salary.salary === 'number'
      ? roundStat(salary.salary / row.expectedPoints, 2)
      : null;
    matched += 1;
  }

  return { matched };
}

function indexDraftKingsSalaries(salaries) {
  const index = new Map();
  for (const salary of salaries) {
    const key = draftKingsMatchKey(salary.name, salary.teamAbbrev);
    if (key && !index.has(key)) index.set(key, salary);
  }
  return index;
}

function parseDraftKingsSalaryCsv(csvText) {
  const table = parseCsv(csvText);
  if (table.length < 2) return [];

  const headers = table[0].map(normalizeHeader);
  return table.slice(1)
    .map((cells) => {
      const row = rowFromCsvCells(headers, cells);
      const name = cleanDraftKingsName(csvCell(row, ['name', 'nameandid']));
      const teamAbbrev = normalizeTeam(csvCell(row, ['teamabbrev', 'team', 'teamabbr']));
      const salary = parseSalary(csvCell(row, ['salary']));

      return {
        name,
        normalizedName: normalizePlayerName(name),
        id: csvCell(row, ['id', 'playerid']),
        rosterPosition: csvCell(row, ['rosterposition']),
        position: csvCell(row, ['position']),
        salary,
        gameInfo: csvCell(row, ['gameinfo', 'game']),
        teamAbbrev,
        avgPointsPerGame: parseNullableNumber(csvCell(row, ['avgpointspergame', 'fppg'])),
      };
    })
    .filter((row) => row.name && row.teamAbbrev && typeof row.salary === 'number');
}

function buildDraftKingsSlateOption(group) {
  const startTimeEst = String(group?.StartDateEst || '');
  const suffix = String(group?.ContestStartTimeSuffix || '').trim();
  const gameCount = Number(group?.GameCount) || 0;
  const timeLabel = formatSlateTimeLabel(startTimeEst);
  const parts = [];
  if (timeLabel) parts.push(`${timeLabel} ET`);
  if (gameCount) parts.push(`${gameCount} game${gameCount === 1 ? '' : 's'}`);

  return {
    draftGroupId: group?.DraftGroupId,
    label: `${parts.join(' · ')}${suffix ? ` ${suffix}` : ''}`.trim() || `Slate ${group?.DraftGroupId}`,
    startTimeEst,
    gameCount,
    suffix,
    tag: String(group?.DraftGroupTag || ''),
    sortOrder: Number(group?.SortOrder) || 999,
  };
}

function formatSlateTimeLabel(startTimeEst) {
  const match = /T(\d{2}):(\d{2})/.exec(startTimeEst);
  if (!match) return '';
  const hours = Number(match[1]);
  const suffix = hours >= 12 ? 'PM' : 'AM';
  return `${hours % 12 || 12}:${match[2]} ${suffix}`;
}

function parseDraftKingsDraftables(data) {
  const stats = Array.isArray(data?.draftStats) ? data.draftStats : [];
  const fppgStatId = stats.find((entry) => String(entry?.abbr || '').toUpperCase() === 'FPPG')?.id
    ?? DK_FPPG_STAT_ID;
  const draftables = Array.isArray(data?.draftables) ? data.draftables : [];
  const byPlayer = new Map();

  // Multi-eligible players repeat once per roster slot; collapse to one row
  // with the slot names joined the way the salary CSV formats them.
  for (const raw of draftables) {
    const name = cleanDraftKingsName(raw?.displayName || `${raw?.firstName || ''} ${raw?.lastName || ''}`);
    const teamAbbrev = normalizeTeam(raw?.teamAbbreviation);
    const salary = Number(raw?.salary);
    if (!name || !teamAbbrev || !Number.isFinite(salary) || salary <= 0 || raw?.isDisabled) continue;

    const key = raw?.playerId ?? raw?.playerDkId ?? `${name}|${teamAbbrev}`;
    let entry = byPlayer.get(key);
    if (!entry) {
      entry = {
        row: {
          name,
          normalizedName: normalizePlayerName(name),
          id: stringifyId(raw?.draftableId ?? raw?.playerDkId ?? raw?.playerId),
          rosterPosition: '',
          position: String(raw?.position || '').trim(),
          salary,
          gameInfo: formatDraftKingsGameInfo(raw?.competition),
          teamAbbrev,
          avgPointsPerGame: parseDraftKingsFppg(raw?.draftStatAttributes, fppgStatId),
        },
        slotIds: new Set(),
      };
      byPlayer.set(key, entry);
    }
    if (raw?.rosterSlotId != null) entry.slotIds.add(raw.rosterSlotId);
  }

  return [...byPlayer.values()].map(({ row, slotIds }) => {
    const slotNames = [...slotIds].map((slotId) => DK_ROSTER_SLOT_NAMES.get(slotId)).filter(Boolean);
    row.rosterPosition = slotNames.join('/') || row.position;
    return row;
  });
}

function formatDraftKingsGameInfo(competition) {
  const matchup = String(competition?.name || '').replace(/\s*@\s*/, '@').trim();
  const startTime = competition?.startTime ? new Date(competition.startTime) : null;
  if (!startTime || Number.isNaN(startTime.getTime())) return matchup;

  const datePart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(startTime);
  const timePart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(startTime).replace(/\s/g, '');

  return `${matchup} ${datePart} ${timePart} ET`.trim();
}

function parseDraftKingsFppg(attributes, fppgStatId) {
  const list = Array.isArray(attributes) ? attributes : [];
  const match = list.find((attr) => attr?.id === fppgStatId);
  return parseNullableNumber(match?.value);
}

function parseCsv(text = '') {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let index = 0; index < String(text).length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }

    cell += char;
  }

  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }

  return rows.filter((cells) => cells.some((value) => String(value).trim()));
}

function rowFromCsvCells(headers, cells) {
  const row = {};
  headers.forEach((header, index) => {
    row[header] = String(cells[index] ?? '').trim();
  });
  return row;
}

function csvCell(row, names) {
  for (const name of names) {
    const key = normalizeHeader(name);
    if (row[key]) return row[key];
  }
  return '';
}

function normalizeHeader(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function cleanDraftKingsName(value) {
  return String(value || '').replace(/\s+\(\d+\)\s*$/, '').trim();
}

function draftKingsMatchKey(name, teamAbbrev) {
  const normalizedName = normalizePlayerName(name);
  const normalizedTeam = normalizeTeam(teamAbbrev);
  return normalizedName && normalizedTeam ? `${normalizedName}|${normalizedTeam}` : '';
}

function normalizePlayerName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/gi, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
}

function parseSalary(value) {
  const number = Number(String(value || '').replace(/[$,]/g, '').trim());
  return Number.isFinite(number) && number > 0 ? number : null;
}

function parseNullableNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(String(value).replace(/[$,]/g, '').trim());
  return Number.isFinite(number) ? number : null;
}

function stat(average, key) {
  return roundStat(average?.[key] ?? 0);
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

function roundStat(value, places = 6) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Number(number.toFixed(places));
}

function sidePlayers(side = {}, type, teamInfo = {}, opponentInfo = {}) {
  const list = type === 'pitcher' ? side?.pitchers : side?.batters;
  if (!Array.isArray(list)) return [];
  return list
    .filter((player) => player?.playerId)
    .map((player) => ({
      playerId: stringifyId(player.playerId),
      name: player.name || '',
      position: player.position || '',
      role: player.role || '',
      type,
      teamId: stringifyId(teamInfo?.id || side?.teamId),
      team: teamInfo?.name || side?.name || '',
      opponentId: stringifyId(opponentInfo?.id),
      opponent: opponentInfo?.name || '',
    }));
}

function gameToTeamRows(game) {
  const gameKey = game.mlbGameId || game.gameId || `${game.date}-${game.awayTeamAbbrev}-${game.homeTeamAbbrev}`;
  const common = {
    date: game.date,
    gameKey,
    gameTime: game.gameTimeUtc || game.gameTimeLocal || '',
    displayTime: formatDisplayTime(game.gameTimeUtc || game.gameTimeLocal),
    projectedTotalRuns: numberOrNull(game.projectedTotalRuns),
    projectionSystem: game.projectionSystem || '',
    status: game.status || (game.isFinal === true || game.isFinal === 'true' ? 'Final' : ''),
    simulations: numberOrNull(game.simulations),
    simId: game.simId,
    error: game.error || '',
  };

  return [
    {
      ...common,
      side: 'Away',
      teamName: game.awayTeam || game.awayTeamAbbrev || '',
      teamAbbrev: game.awayTeamAbbrev || '',
      lineupSource: game.awayLineupSource || '',
      startingPitcherId: game.awayStartingPitcherId || '',
      startingPitcher: game.awayStartingPitcher || '',
      opponentName: game.homeTeam || game.homeTeamAbbrev || '',
      opponentAbbrev: game.homeTeamAbbrev || '',
      projectedRuns: numberOrNull(game.awayProjectedRuns),
      winPct: numberOrNull(game.awayWinPct),
      moneyline: numberOrNull(game.awayMoneyline),
    },
    {
      ...common,
      side: 'Home',
      teamName: game.homeTeam || game.homeTeamAbbrev || '',
      teamAbbrev: game.homeTeamAbbrev || '',
      lineupSource: game.homeLineupSource || '',
      startingPitcherId: game.homeStartingPitcherId || '',
      startingPitcher: game.homeStartingPitcher || '',
      opponentName: game.awayTeam || game.awayTeamAbbrev || '',
      opponentAbbrev: game.awayTeamAbbrev || '',
      projectedRuns: numberOrNull(game.homeProjectedRuns),
      winPct: numberOrNull(game.homeWinPct),
      moneyline: numberOrNull(game.homeMoneyline),
    },
  ].filter((row) => row.teamName);
}

function findGameByKey(games, gameKey, date) {
  const target = String(gameKey || '');
  return games.find((game) => {
    const schedule = game.schedule || {};
    const key = schedule.MLBGameId ?? game.MLBGameId ?? schedule.GameId ?? game.GameId
      ?? `${date}-${schedule.AwayTeamAbbName || ''}-${schedule.HomeTeamAbbName || ''}`;
    return String(key) === target;
  });
}

function buildGamesPayload(rows) {
  const games = new Map();

  for (const row of rows) {
    if (!games.has(row.gameKey)) {
      games.set(row.gameKey, {
        gameKey: row.gameKey,
        gameTime: row.gameTime,
        awayTeamAbbrev: '',
        homeTeamAbbrev: '',
      });
    }

    const game = games.get(row.gameKey);
    if (row.side === 'Away') {
      game.awayTeamAbbrev = row.teamAbbrev;
    } else if (row.side === 'Home') {
      game.homeTeamAbbrev = row.teamAbbrev;
    }
  }

  return [...games.values()].filter((game) => game.awayTeamAbbrev && game.homeTeamAbbrev);
}

function mergeOdds(rows, oddsRows) {
  const oddsByGameKey = new Map(oddsRows.map((row) => [row.gameKey, row]));

  for (const row of rows) {
    const odds = oddsByGameKey.get(row.gameKey);
    if (!odds) continue;

    const marketMoneyline = row.side === 'Away' ? numberOrNull(odds.awayMoneyline) : numberOrNull(odds.homeMoneyline);
    const marketImpliedPct = americanToImpliedPct(marketMoneyline);
    row.marketMoneyline = marketMoneyline;
    row.marketImpliedPct = marketImpliedPct;
    row.edgePct = row.winPct == null || marketImpliedPct == null ? null : round6(row.winPct - marketImpliedPct);
    row.expectedRoi = expectedRoiFromAmerican(row.winPct, marketMoneyline);
    row.oddsProvider = odds.provider || '';
    row.oddsError = odds.error || '';
  }
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
      awayTeamAbbrev: normalizeTeam(away.team?.abbreviation),
      homeTeamAbbrev: normalizeTeam(home.team?.abbreviation),
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

function getTeamMoneyline(teamOdds, preferredLineType) {
  return parseAmericanOdds(
    teamOdds?.[preferredLineType]?.moneyLine?.american
      ?? teamOdds?.[preferredLineType]?.moneyLine?.alternateDisplayValue
      ?? teamOdds?.moneyLine
      ?? teamOdds?.current?.moneyLine?.american
      ?? teamOdds?.close?.moneyLine?.american
      ?? teamOdds?.open?.moneyLine?.american,
  );
}

async function getCachedJson(path) {
  if (!existsSync(path)) return null;

  try {
    const text = await readFile(path, 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function writeCachedJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, 'utf8');
}

function simCachePath(projectionSystem, simId) {
  return join(CACHE_ROOT, 'fangraphs-sims', safeSegment(projectionSystem), `${safeSegment(simId)}.json`);
}

function customSimCachePath(projectionSystem, hash) {
  return join(CACHE_ROOT, 'fangraphs-custom-sims', safeSegment(projectionSystem), `${safeSegment(hash)}.json`);
}

function draftKingsSalaryCachePath(date) {
  return join(CACHE_ROOT, 'draftkings-salaries', `${safeSegment(date)}.json`);
}

function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function safeSegment(value) {
  return encodeURIComponent(String(value || 'unknown')).replaceAll('%', '_');
}

function stringifyId(value) {
  return value == null || value === '' ? '' : String(value);
}

function defaultPositions() {
  return ['CF', 'SS', 'RF', '1B', 'DH', '3B', 'C', 'LF', '2B'];
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? round6(number) : null;
}

function sumNullable(a, b) {
  return a == null || b == null ? null : round6(a + b);
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

function americanToImpliedPct(value) {
  if (typeof value !== 'number') return null;
  return value < 0 ? round6(Math.abs(value) / (Math.abs(value) + 100)) : round6(100 / (value + 100));
}

function expectedRoiFromAmerican(winPct, odds) {
  if (typeof winPct !== 'number' || typeof odds !== 'number') return null;
  const profit = odds > 0 ? odds / 100 : 100 / Math.abs(odds);
  return round6(winPct * profit - (1 - winPct));
}

function normalizeTeam(abbrev = '') {
  const upper = String(abbrev).trim().toUpperCase();
  return TEAM_ALIASES.get(upper) || upper;
}

function matchupKey(awayTeamAbbrev, homeTeamAbbrev) {
  return `${normalizeTeam(awayTeamAbbrev)}@${normalizeTeam(homeTeamAbbrev)}`;
}

function round6(value) {
  if (value == null) return null;
  return Number(Number(value).toFixed(6));
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

function formatDisplayTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString('en-US', {
    timeZone: DISPLAY_TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit',
  }) + ' CT';
}

function validateDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    throw new Error('Use a date in YYYY-MM-DD format.');
  }
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
