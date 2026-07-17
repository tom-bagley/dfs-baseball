import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pmfProbabilityOver, simulateHitterCompositePmfs } from './hitter-outcome-sim.js';
import {
  getSimPlayersForDate,
  histogramProbability,
  normalizePlayerName,
  normalizeTeam,
} from './projections-data.js';
import { decode as decodeTurboStream } from './vendor/turbo-stream.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CACHE_ROOT = resolve(process.env.CACHE_DIR || join(ROOT, 'out', 'cache'));
const PICK6_BOARD_URL = 'https://pick6.draftkings.com/?sport=MLB';
const PICK6_API_BASE = 'https://api.draftkings.com';
const PICK6_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml',
};
const EDGE_THRESHOLD = 0.55;
const MORE_PROPOSITION_ID = 1;
const LESS_PROPOSITION_ID = 2;

// Pick6 market name -> how to evaluate it against the FanGraphs simulation.
// `histogram` stats read P(over line) exactly from the marginal FanGraphs
// histogram for one stat. `composite` stats sum correlated per-game stats, so
// they use the shared-latent Monte Carlo from hitter-outcome-sim.js.
const STAT_CONFIGS = new Map([
  ['strikeouts thrown', { playerType: 'pitcher', kind: 'histogram', key: 'K' }],
  ['hits allowed', { playerType: 'pitcher', kind: 'histogram', key: 'H' }],
  ['walks allowed', { playerType: 'pitcher', kind: 'histogram', key: 'BB' }],
  ['outs recorded', { playerType: 'pitcher', kind: 'histogram', key: 'Outs' }],
  ['hits + runs + rbis', { playerType: 'hitter', kind: 'composite', key: 'hitsRunsRbi' }],
  ['runs + rbis', { playerType: 'hitter', kind: 'composite', key: 'runsRbi' }],
  ['total bases', { playerType: 'hitter', kind: 'composite', key: 'totalBases' }],
  ['total bases (from hits)', { playerType: 'hitter', kind: 'composite', key: 'totalBases' }],
  ['extra base hits', { playerType: 'hitter', kind: 'composite', key: 'extraBaseHits' }],
  ['plate appearances', { playerType: 'hitter', kind: 'histogram', key: 'PA' }],
  ['xbh', { playerType: 'hitter', kind: 'composite', key: 'extraBaseHits' }],
  ['fantasy points', { playerType: 'hitter', kind: 'composite', key: 'fantasyPoints' }],
  ['hits', { playerType: 'hitter', kind: 'histogram', key: 'H' }],
  ['singles', { playerType: 'hitter', kind: 'histogram', key: '1B' }],
  ['doubles', { playerType: 'hitter', kind: 'histogram', key: '2B' }],
  ['home runs', { playerType: 'hitter', kind: 'histogram', key: 'HR' }],
  ['runs', { playerType: 'hitter', kind: 'histogram', key: 'R' }],
  ['rbis', { playerType: 'hitter', kind: 'histogram', key: 'RBI' }],
  ['stolen bases', { playerType: 'hitter', kind: 'histogram', key: 'SB' }],
  ['walks', { playerType: 'hitter', kind: 'histogram', key: 'BB' }],
]);

export async function getPick6Board({ date } = {}) {
  const warnings = [];
  let pickables = [];
  let source = 'network-state';
  let fetchedAt = new Date().toISOString();

  try {
    // The lobby defaults to whichever pick group DraftKings currently
    // features (after a slate goes final that is the NEXT day's board), so
    // the requested date has to drive which pick groups are read.
    const primaryHtml = await fetchBoardPage();
    let state = null;
    try {
      state = await parsePick6BoardState(primaryHtml);
    } catch (stateError) {
      pickables = parsePick6BoardHtml(primaryHtml);
      source = 'network-cards';
      warnings.push(
        `Could not decode the full Pick6 board state (${formatError(stateError)}); ` +
        'fell back to the featured cards, so alternate lines, non-featured stats, and date filtering are missing.',
      );
    }

    if (state) {
      pickables = filterPickablesToDate(
        await fetchGroupBoard(state.selectedPickGroupId, state, warnings),
        date,
      );
      const seenGroups = new Set([String(state.selectedPickGroupId)]);
      for (const group of state.pickGroups) {
        const groupId = String(group.pickGroupId);
        if (seenGroups.has(groupId) || !groupCoversDate(group, date)) continue;
        seenGroups.add(groupId);
        try {
          const groupState = await parsePick6BoardState(await fetchBoardPage(groupId));
          pickables.push(...filterPickablesToDate(
            await fetchGroupBoard(groupId, groupState, warnings),
            date,
          ));
        } catch (error) {
          warnings.push(`Could not load Pick6 pick group ${groupId}: ${formatError(error)}`);
        }
      }
      pickables = dedupePickables(pickables);
    }

    // Lines for games that already started are live re-centered lines even
    // when DraftKings does not flag them as live.
    for (const pickable of pickables) {
      if (pickable.startTime && Date.parse(pickable.startTime) < Date.parse(fetchedAt)) {
        pickable.isLive = true;
      }
    }

    if (!pickables.length) {
      const cached = await readBoardCache(date);
      if (cached?.pickables?.length) {
        warnings.push(`DraftKings no longer lists a Pick6 board for ${date}; showing the cached board.`);
        return { date, source: 'cache', fetchedAt: cached.fetchedAt || '', pickables: cached.pickables, warnings };
      }
      warnings.push(`No Pick6 pickables were found for ${date}.`);
      return { date, source, fetchedAt, pickables, warnings };
    }

    // Once a game starts, DraftKings replaces its lines with live re-centered
    // ones, which pregame simulations cannot grade. Prefer the cached pregame
    // board for the date over a live-only fetch.
    const allLive = pickables.every((pickable) => pickable.isLive);
    const cachedPregame = allLive ? await readBoardCache(date) : null;
    if (allLive && cachedPregame?.pickables?.some((pickable) => !pickable.isLive)) {
      pickables = cachedPregame.pickables;
      fetchedAt = cachedPregame.fetchedAt || fetchedAt;
      source = 'cache-pregame';
      warnings.push(
        'The games have started and DraftKings now shows live re-centered lines; '
        + 'displaying the pregame board instead.',
      );
    } else {
      if (allLive) {
        warnings.push('Only live in-game lines are available; pregame simulations cannot grade them reliably.');
      }
      await writeBoardCache(date, { fetchedAt, pickables });
    }
  } catch (error) {
    const cached = await readBoardCache(date);
    if (!cached) throw error;
    pickables = cached.pickables || [];
    fetchedAt = cached.fetchedAt || '';
    source = 'cache';
    warnings.push(`Live Pick6 fetch failed (${formatError(error)}); showing the last cached board for ${date}.`);
  }

  return { date, source, fetchedAt, pickables, warnings };
}

async function fetchBoardPage(pickGroupId) {
  const url = new URL(PICK6_BOARD_URL);
  if (pickGroupId) url.searchParams.set('pickGroup', pickGroupId);
  const response = await fetch(url, { headers: PICK6_HEADERS });
  if (!response.ok) throw new Error(`Pick6 board request failed with HTTP ${response.status}.`);
  return response.text();
}

// The page only embeds the featured cards, but DraftKings' public pickcards
// API serves each category tab's full card set as JSON. Union every category
// (skipping Featured, which duplicates lines under different pickable ids) to
// reconstruct the complete board; fall back to the featured cards if the API
// is unavailable.
async function fetchGroupBoard(pickGroupId, groupState, warnings) {
  const categories = (groupState.categories || []).filter(
    (category) => Number.isFinite(category.pickCategoryId) && !/^featured$/i.test(category.filterKey || ''),
  );

  const pickables = [];
  let failures = 0;
  for (const category of categories) {
    try {
      const data = await fetchCategoryCardData(pickGroupId, category.pickCategoryId);
      pickables.push(...buildPickables({
        cards: data.pickCardByPickableId || {},
        markets: data.pickSixMarketById || {},
        entities: data.entityInfoByDkId || {},
        competitions: data.competitionById || {},
      }));
    } catch {
      failures += 1;
    }
  }

  if (failures) {
    warnings.push(`${failures} of ${categories.length} Pick6 category requests failed for pick group ${pickGroupId}.`);
  }
  if (!pickables.length) {
    if (categories.length) {
      warnings.push(`The Pick6 pickcards API returned nothing for pick group ${pickGroupId}; showing the featured cards only.`);
    }
    return groupState.pickables;
  }
  return pickables;
}

async function fetchCategoryCardData(pickGroupId, pickCategoryId) {
  const url = new URL(
    `${PICK6_API_BASE}/pick6/v1/pickgroups/${encodeURIComponent(pickGroupId)}`
    + `/category/${encodeURIComponent(pickCategoryId)}/pickcards`,
  );
  url.searchParams.set('format', 'json');
  const response = await fetch(url, { headers: { ...PICK6_HEADERS, accept: 'application/json' } });
  if (!response.ok) throw new Error(`Pick6 pickcards API failed with HTTP ${response.status}.`);
  return response.json();
}

function filterPickablesToDate(pickables, date) {
  return pickables.filter((pickable) => pickable.startTime && easternDate(pickable.startTime) === date);
}

function groupCoversDate(group, date) {
  return easternDate(group.minStartTime) === date || easternDate(group.maxStartTime) === date;
}

// MLB slates are dated by US Eastern local time (a 10 PM ET start is still
// that day's game even though it is past midnight UTC).
function easternDate(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(time);
}

// Dedupe by content, not pickable id: the featured view lists the same lines
// under different pickable ids than the category views.
function dedupePickables(pickables) {
  const seen = new Map();
  for (const pickable of pickables) {
    const key = [
      pickable.dkId ?? pickable.playerName,
      pickable.statCategory,
      pickable.line,
      pickable.startTime,
    ].join('|');
    const existing = seen.get(key);
    if (!existing || (pickable.isDefault && !existing.isDefault)) seen.set(key, pickable);
  }
  return [...seen.values()];
}

// The Pick6 lobby is a React Router v7 app that serializes its full loader
// state into the HTML via window.__reactRouterContext.streamController
// .enqueue(...) calls in turbo-stream format. That state carries every
// pickable with every stat market, alternate line, and payout multiplier —
// including the categories the featured tab never renders.
export async function parsePick6BoardState(html) {
  const payloads = [];
  const enqueuePattern = /streamController\.enqueue\(("(?:[^"\\]|\\.)*")\)/g;
  let match;
  while ((match = enqueuePattern.exec(String(html || ''))) !== null) {
    payloads.push(JSON.parse(match[1]));
  }
  if (!payloads.length) throw new Error('No turbo-stream payloads found in the page.');

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const payload of payloads) controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
  const decoded = await decodeTurboStream(stream);

  const shared = decoded.value?.loaderData?.['routes/_homeShared'];
  const lookups = shared?.pickCardLookups || {};
  const pickables = buildPickables({
    cards: shared?.pickCardData?.pickCardsByPickGroup?.pickCardByPickableId
      || shared?.pickableIdToPickCardMap
      || {},
    markets: lookups.pickSixMarketById || {},
    entities: lookups.entityInfoByDkId || {},
    competitions: lookups.competitionById || {},
  });

  if (!pickables.length) throw new Error('Decoded state contained no pick cards.');

  const pickGroups = (Array.isArray(shared?.pickGroups) ? shared.pickGroups : []).map((group) => ({
    pickGroupId: String(group.pickGroupId ?? ''),
    minStartTime: group.minStartTime || '',
    maxStartTime: group.maxStartTime || '',
  }));
  const selectedPickGroupId = String(shared?.selectedPickGroup?.pickGroupId ?? shared?.pickGroupId ?? '');

  // Category tabs (Featured, Batters, Pitcher Strikeouts, ...). Their exact
  // location in the store moves around, so scan the serialized state for the
  // category objects themselves.
  const categories = [...JSON.stringify(shared)
    .matchAll(/\{"pickCategoryId":(\d+),"categoryName":"([^"]+)","filterKey":"([^"]+)"/g)]
    .map((match) => ({ pickCategoryId: Number(match[1]), categoryName: match[2], filterKey: match[3] }));

  return { pickables, pickGroups, selectedPickGroupId, categories };
}

// One row per (player, stat, line) from a DraftKings pick-card map plus its
// lookup tables — the same shapes appear in the page's serialized state and in
// the pickcards JSON API.
function buildPickables({ cards, markets, entities, competitions }) {
  const pickables = [];
  for (const entry of Object.values(cards || {})) {
    const card = entry?.pickCard || entry;
    if (!card?.pickableId) continue;

    const dkId = card.entities?.[0]?.dkId;
    const entity = entities[dkId] || {};
    const competitionId = card.entities?.[0]?.compIds?.[0];
    const competition = competitions[competitionId] || {};

    // A card can expose the same stat at the same line through several market
    // records (a paused symmetric More/Less market plus an active multiplier
    // ladder). Merge them so each (stat, line) appears once with whichever
    // multiplier is actually purchasable per side.
    const merged = new Map();
    for (const market of card.activePickableMarkets || []) {
      const statCategory = markets[market.pickSixMarketId]?.name || String(market.pickSixMarketId);
      const key = `${statCategory}|${market.targetValue}`;
      if (!merged.has(key)) {
        merged.set(key, {
          statCategory,
          line: Number(market.targetValue),
          multiplierMore: null,
          multiplierLess: null,
          isDefault: false,
          isLive: false,
          hasActiveSide: false,
        });
      }
      const group = merged.get(key);
      if (market.pickableMarketId === card.defaultPickableMarketId) group.isDefault = true;
      // Paused markets are not purchasable (a card can render a More/Less
      // button whose market is paused), so only unpaused selections count
      // toward a side existing.
      if (market.isPaused) continue;
      for (const selection of market.activeSelections || []) {
        const side = selection.statLinePropositionId === LESS_PROPOSITION_ID ? 'multiplierLess'
          : selection.statLinePropositionId === MORE_PROPOSITION_ID ? 'multiplierMore'
            : null;
        if (!side) continue;
        group[side] = selection.formattedStandingsMultiplier || group[side];
        group.hasActiveSide = true;
        if (market.isLive) group.isLive = true;
      }
    }

    for (const group of merged.values()) {
      if (!group.hasActiveSide) continue;
      pickables.push({
        pickableId: String(card.pickableId),
        dkId: dkId ?? null,
        playerName: entity.fullName || entity.name || '',
        statCategory: group.statCategory,
        line: group.line,
        multiplierMore: group.multiplierMore,
        multiplierLess: group.multiplierLess,
        hasMore: group.multiplierMore != null,
        hasLess: group.multiplierLess != null,
        isDefault: group.isDefault,
        isLive: group.isLive,
        awayTeamAbbrev: competition.awayTeam?.abbreviation || '',
        homeTeamAbbrev: competition.homeTeam?.abbreviation || '',
        startTime: competition.startTime || '',
      });
    }
  }
  return pickables;
}

// Fallback: scrape the server-rendered featured cards. Only default lines are
// visible this way, with no multipliers.
export function parsePick6BoardHtml(html) {
  const text = String(html || '');
  const boundaries = [];
  const cardPattern = /data-pickable-id="(\d+)" data-testid="playerStatCard"/g;
  let match;
  while ((match = cardPattern.exec(text)) !== null) {
    boundaries.push({ pickableId: match[1], index: match.index });
  }

  const seen = new Set();
  const pickables = [];
  for (let index = 0; index < boundaries.length; index += 1) {
    const { pickableId } = boundaries[index];
    if (seen.has(pickableId)) continue;
    const end = boundaries[index + 1] ? boundaries[index + 1].index : boundaries[index].index + 20000;
    const chunk = decodeHtmlEntities(text.slice(boundaries[index].index, end));

    const pickLabel = chunk.match(/aria-label="Pick (.+?) for More than ([\d.]+) (.+?)"/);
    if (!pickLabel) continue;

    seen.add(pickableId);
    const teamAbbrev = chunk.match(/aria-label="Player's team">([A-Z]{2,3})</)?.[1] || '';
    const opponentAbbrev = chunk.match(/aria-label="Player's opposing team">([A-Z]{2,3})</)?.[1] || '';
    pickables.push({
      pickableId,
      dkId: null,
      playerName: pickLabel[1],
      statCategory: pickLabel[3],
      line: Number(pickLabel[2]),
      multiplierMore: null,
      multiplierLess: null,
      // The featured cards render both More and Less buttons; multipliers are
      // simply unknown from this fallback view.
      hasMore: true,
      hasLess: true,
      isDefault: true,
      isLive: false,
      awayTeamAbbrev: opponentAbbrev,
      homeTeamAbbrev: teamAbbrev,
      startTime: '',
    });
  }

  return pickables;
}

export async function getPick6Analysis({ date, projectionSystem = 'rSteamer' } = {}) {
  const board = await getPick6Board({ date });
  const warnings = [...board.warnings];

  let simData = { games: [], players: [] };
  try {
    simData = await getSimPlayersForDate({ date, projectionSystem });
    if (simData.cache?.simsStale) {
      warnings.push(
        `${simData.cache.simsStale} FanGraphs simulation(s) could not be refreshed; `
        + 'their projected lineups and starters may be outdated.',
      );
    }
  } catch (error) {
    warnings.push(`FanGraphs simulations unavailable for ${date}: ${formatError(error)}`);
  }

  const playersByName = new Map();
  for (const player of simData.players) {
    const key = `${player.playerType}|${normalizePlayerName(player.playerName)}`;
    if (!playersByName.has(key)) playersByName.set(key, []);
    playersByName.get(key).push(player);
  }
  const gameTimeByKey = new Map(
    (simData.games || []).map((game) => [game.gameKey, Date.parse(game.gameTimeUtc || '')]),
  );

  const compositeCache = new Map();
  const rows = board.pickables.map((pickable) => {
    const config = STAT_CONFIGS.get(String(pickable.statCategory || '').trim().toLowerCase());
    const base = {
      ...pickable,
      playerType: config?.playerType || '',
      matched: false,
      matchedPlayerId: '',
      teamAbbrev: '',
      opponentAbbrev: '',
      lineupSlot: null,
      lineupSource: '',
      projectedMean: null,
      probOver: null,
      probUnder: null,
      probPush: null,
      evMore: null,
      evLess: null,
      probabilitySource: '',
      unmatchedReason: '',
    };

    if (!config) {
      return { ...base, unmatchedReason: `No probability model for stat category "${pickable.statCategory}".` };
    }

    const player = findSimPlayer(playersByName, config.playerType, pickable, gameTimeByKey);
    if (!player) {
      return {
        ...base,
        unmatchedReason: simData.players.length
          ? 'Player not found in the FanGraphs simulations for this date.'
          : 'No FanGraphs simulations were available for this date.',
      };
    }

    const matchedFields = {
      matched: true,
      matchedPlayerId: player.playerId,
      teamAbbrev: player.teamAbbrev,
      opponentAbbrev: player.opponentAbbrev,
      lineupSlot: player.lineupSlot,
      lineupSource: player.lineupSource,
    };

    const probabilities = config.kind === 'histogram'
      ? histogramLineProbabilities(player.histograms?.[config.key], pickable.line)
      : compositeLineProbabilities(compositeCache, player, date, config.key, pickable.line);

    if (!probabilities) {
      return {
        ...base,
        ...matchedFields,
        unmatchedReason: `The FanGraphs simulation has no ${pickable.statCategory} distribution for this player.`,
      };
    }

    return {
      ...base,
      ...matchedFields,
      ...probabilities,
      evMore: expectedMultiple(probabilities.probOver, pickable.multiplierMore),
      evLess: expectedMultiple(probabilities.probUnder, pickable.multiplierLess),
    };
  });

  rows.sort((a, b) => (b.isDefault - a.isDefault)
    || ((bestPlayValue(b) ?? -1) - (bestPlayValue(a) ?? -1))
    || a.line - b.line);

  if (rows.some((row) => row.isLive && row.probOver != null)) {
    warnings.push(
      'Some lines are live (in-game) and re-centered by DraftKings; pregame simulations do not '
      + 'account for the current game state, so treat their probabilities as invalid.',
    );
  }

  try {
    await savePick6Snapshot({ date, projectionSystem, rows });
  } catch {
    // Snapshots are best effort; the live response is still returned.
  }

  const playable = rows.filter((row) => !row.isLive && row.probOver != null);
  const edges = playable.filter((row) => {
    const value = bestPlayValue(row);
    return value != null && value > EDGE_THRESHOLD;
  });
  const bestEdge = playable.reduce((max, row) => {
    const value = bestPlayValue(row);
    return value != null && (max == null || value > max) ? value : max;
  }, null);

  return {
    ok: true,
    date,
    projectionSystem,
    edgeThreshold: EDGE_THRESHOLD,
    board: {
      source: board.source,
      fetchedAt: board.fetchedAt,
      pickableCount: board.pickables.length,
    },
    games: simData.games,
    rows,
    summary: {
      pickables: rows.length,
      defaultLines: rows.filter((row) => row.isDefault).length,
      matched: rows.filter((row) => row.probOver != null).length,
      edges: edges.length,
      bestEdge: bestEdge == null ? null : round4(bestEdge),
    },
    warnings,
    refreshedAt: new Date().toISOString(),
  };
}

function findSimPlayer(playersByName, playerType, pickable, gameTimeByKey) {
  const candidates = playersByName.get(`${playerType}|${normalizePlayerName(pickable.playerName)}`) || [];
  if (candidates.length <= 1) return candidates[0] || null;

  // Doubleheaders put the same player in two sims, and DraftKings issues a
  // separate card per game — bind each card to the sim whose start time is
  // nearest the card's competition start time.
  const pickableStart = Date.parse(pickable.startTime || '');
  if (Number.isFinite(pickableStart)) {
    const timed = candidates
      .map((candidate) => ({
        candidate,
        distance: Math.abs((gameTimeByKey?.get(candidate.gameKey) ?? Number.NaN) - pickableStart),
      }))
      .filter((entry) => Number.isFinite(entry.distance))
      .sort((a, b) => a.distance - b.distance);
    if (timed.length) return timed[0].candidate;
  }

  const boardTeams = new Set(
    [pickable.awayTeamAbbrev, pickable.homeTeamAbbrev].map(normalizeTeam).filter(Boolean),
  );
  return candidates.find((candidate) => boardTeams.has(normalizeTeam(candidate.teamAbbrev))) || candidates[0];
}

function histogramLineProbabilities(histogram, line) {
  if (!histogram?.buckets || !Number.isFinite(Number(line))) return null;
  const probOver = histogramProbability(histogram, (value) => value > line);
  const probPush = histogramProbability(histogram, (value) => value === line);
  return {
    probOver: round4(probOver),
    probUnder: round4(Math.max(0, 1 - probOver - probPush)),
    probPush: round4(probPush),
    projectedMean: Number.isFinite(Number(histogram.mean)) ? round4(histogram.mean) : null,
    probabilitySource: 'fangraphs-histogram',
  };
}

function compositeLineProbabilities(compositeCache, player, date, compositeKey, line) {
  if (!Number.isFinite(Number(line))) return null;
  const cacheKey = `${player.playerId}|${player.playerName}`;
  if (!compositeCache.has(cacheKey)) {
    compositeCache.set(cacheKey, simulateHitterCompositePmfs({
      playerId: player.playerId,
      date,
      average: player.average,
      histograms: player.histograms,
    }));
  }
  const composite = compositeCache.get(cacheKey);
  const pmf = composite.pmfs[compositeKey];
  if (!pmf) return null;

  const probOver = pmfProbabilityOver(pmf, line);
  const wholeLine = Number.isInteger(Number(line));
  const probPush = wholeLine ? (pmf[Number(line)] || 0) : 0;
  return {
    probOver: round4(probOver),
    probUnder: round4(Math.max(0, 1 - probOver - probPush)),
    probPush: round4(probPush),
    projectedMean: round4(composite.means[compositeKey]),
    probabilitySource: 'correlated-monte-carlo',
  };
}

// Per-pick expected multiple: probability the side hits times its payout
// multiplier. Pick6 entry multipliers are the product of the selected picks'
// multipliers, so above 1.0 is the break-even direction for a single slot.
function expectedMultiple(probability, formattedMultiplier) {
  const multiplier = parseMultiplier(formattedMultiplier);
  if (probability == null || multiplier == null) return null;
  return round4(probability * multiplier);
}

function parseMultiplier(formatted) {
  if (formatted == null) return null;
  const value = Number(String(formatted).replace(/x$/i, ''));
  return Number.isFinite(value) && value > 0 ? value : null;
}

// The playable value of a line: best purchasable side's probability times its
// payout multiplier. This is the per-slot break-even measure — an edge is a
// line whose value clears roughly basePayout^(-1/n). Sides are only counted
// when purchasable; an unknown multiplier (featured-card fallback) is 1x.
function bestPlayValue(row) {
  const candidates = [];
  if (row.hasMore && row.probOver != null) {
    candidates.push(row.probOver * (parseMultiplier(row.multiplierMore) ?? 1));
  }
  if (row.hasLess && row.probUnder != null) {
    candidates.push(row.probUnder * (parseMultiplier(row.multiplierLess) ?? 1));
  }
  return candidates.length ? Math.max(...candidates) : null;
}

// Persist the graded-odds record for the day: every matched pregame line with
// its model probabilities and payout multipliers. Lines are re-written on each
// refresh until their game starts, then frozen — so the snapshot ends up
// holding the final pregame odds, ready for backtest-pick6.js to grade against
// box scores.
export async function savePick6Snapshot({ date, projectionSystem, rows }) {
  const gradable = (rows || []).filter((row) => row.matched && !row.isLive && row.probOver != null);
  if (!gradable.length) return null;

  const path = snapshotPath(date, projectionSystem);
  let existing = null;
  try {
    existing = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    existing = null;
  }

  const now = Date.now();
  const snapshotAt = new Date(now).toISOString();
  const byKey = new Map((existing?.rows || []).map((row) => [snapshotRowKey(row), row]));
  for (const row of gradable) {
    const key = snapshotRowKey(row);
    const gameStarted = Date.parse(row.startTime || '') <= now;
    if (byKey.has(key) && gameStarted) continue;
    byKey.set(key, {
      playerName: row.playerName,
      dkId: row.dkId ?? null,
      matchedPlayerId: row.matchedPlayerId || '',
      teamAbbrev: row.teamAbbrev || '',
      opponentAbbrev: row.opponentAbbrev || '',
      statCategory: row.statCategory,
      line: row.line,
      startTime: row.startTime || '',
      isDefault: Boolean(row.isDefault),
      multiplierMore: row.multiplierMore ?? null,
      multiplierLess: row.multiplierLess ?? null,
      hasMore: Boolean(row.hasMore),
      hasLess: Boolean(row.hasLess),
      probOver: row.probOver,
      probUnder: row.probUnder,
      probPush: row.probPush ?? 0,
      projectedMean: row.projectedMean ?? null,
      probabilitySource: row.probabilitySource || '',
      snapshotAt,
    });
  }

  const payload = {
    date,
    projectionSystem,
    updatedAt: snapshotAt,
    rows: [...byKey.values()],
  };
  await mkdir(join(CACHE_ROOT, 'pick6'), { recursive: true });
  await writeFile(path, JSON.stringify(payload));
  return payload;
}

export function snapshotPath(date, projectionSystem = 'rSteamer') {
  return join(CACHE_ROOT, 'pick6', `snapshot-${date}-${projectionSystem}.json`);
}

function snapshotRowKey(row) {
  return [row.dkId ?? row.playerName, row.statCategory, row.line, row.startTime].join('|');
}

async function readBoardCache(date) {
  try {
    return JSON.parse(await readFile(boardCachePath(date), 'utf8'));
  } catch {
    return null;
  }
}

async function writeBoardCache(date, value) {
  try {
    await mkdir(join(CACHE_ROOT, 'pick6'), { recursive: true });
    await writeFile(boardCachePath(date), JSON.stringify(value));
  } catch {
    // Cache writes are best effort; the live response is still returned.
  }
}

function boardCachePath(date) {
  return join(CACHE_ROOT, 'pick6', `board-${date}.json`);
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/<!-- -->/g, '');
}

function round4(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.round(number * 10000) / 10000;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
