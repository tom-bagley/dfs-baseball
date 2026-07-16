import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HITTER_COMPONENTS } from './hitter-player-bayesian.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export async function loadSeasonHistories(directory) {
  const histories = new Map();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const playerId = entry.name.slice(0, -5);
    const payload = JSON.parse(await readFile(join(directory, entry.name), 'utf8'));
    const games = (payload?.stats || []).flatMap((stat) => stat.splits || []).map(toGame).filter(Boolean)
      .sort((left, right) => left.date.localeCompare(right.date));
    histories.set(playerId, games);
  }
  return histories;
}

export function predictSeasonBayesian(row, histories, options = {}) {
  const priorPlateAppearances = Number(options.priorPlateAppearances);
  const halfLifeDays = numberOrInfinity(options.halfLifeDays);
  const multiplierCap = Number(options.multiplierCap || 2);
  const adaptiveSensitivity = Number(options.adaptiveSensitivity || 0);
  const disagreementThreshold = Number(options.disagreementThreshold || 0);
  const disagreementMode = options.disagreementMode || 'component';
  const gateUpdates = Boolean(options.gateUpdates);
  const requirePersistentDisagreement = Boolean(options.requirePersistentDisagreement);
  const minimumEvidencePA = Number(options.minimumEvidencePA || 0);
  const projectedPA = Number(row.projectedPlateAppearances);
  if (!(priorPlateAppearances > 0) || !(projectedPA > 0)) return row.projectedDraftKingsPoints;
  const games = histories.get(String(row.mlbPlayerId || '')) || [];
  const evidence = aggregateBefore(games, row.date, halfLifeDays);
  if (!(evidence.plateAppearances > 0)) return row.projectedDraftKingsPoints;
  const fullSeasonEvidence = requirePersistentDisagreement ? aggregateBefore(games, row.date, Infinity) : evidence;

  const totalZ = totalDisagreementZ(row, evidence, projectedPA);
  const fullSeasonTotalZ = totalDisagreementZ(row, fullSeasonEvidence, projectedPA);

  return HITTER_COMPONENTS.reduce((points, component) => {
    const projected = Number(row[`projected${component.key}`] || 0);
    const priorRate = projected / projectedPA;
    const expectedCount = evidence.plateAppearances * priorRate;
    const componentZ = (evidence[component.key] - expectedCount) / Math.sqrt(expectedCount + 0.5);
    const disagreementZ = disagreementMode === 'total' ? totalZ : componentZ;
    const fullExpectedCount = fullSeasonEvidence.plateAppearances * priorRate;
    const fullComponentZ = (fullSeasonEvidence[component.key] - fullExpectedCount) / Math.sqrt(fullExpectedCount + 0.5);
    const confirmationZ = disagreementMode === 'total' ? fullSeasonTotalZ : fullComponentZ;
    const persistent = !requirePersistentDisagreement || (
      fullSeasonEvidence.plateAppearances >= minimumEvidencePA
      && Math.sign(disagreementZ) === Math.sign(confirmationZ)
    );
    const disagreementMagnitude = requirePersistentDisagreement
      ? Math.min(Math.abs(disagreementZ), Math.abs(confirmationZ))
      : Math.abs(disagreementZ);
    const excessZ = persistent ? Math.max(0, disagreementMagnitude - disagreementThreshold) : 0;
    if (gateUpdates && excessZ === 0) return points + component.points * projected;
    const effectivePriorPA = priorPlateAppearances / (1 + adaptiveSensitivity * excessZ ** 2);
    const posteriorRate = (
      effectivePriorPA * priorRate + evidence[component.key]
    ) / (effectivePriorPA + evidence.plateAppearances);
    const rawMultiplier = priorRate > 0 ? posteriorRate / priorRate : 1;
    const multiplier = Math.max(1 / multiplierCap, Math.min(multiplierCap, rawMultiplier));
    return points + component.points * projected * multiplier;
  }, 0);
}

export function seasonBayesianCandidates() {
  const candidates = [];
  for (const priorPlateAppearances of [25, 50, 100, 200, 400, 800]) {
    for (const halfLifeDays of [14, 35, Infinity]) {
      for (const multiplierCap of [1.5, 2, 3]) candidates.push({
        priorPlateAppearances, halfLifeDays, multiplierCap,
        adaptiveSensitivity: 0, disagreementThreshold: 0, disagreementMode: 'component',
        gateUpdates: false,
      });
    }
  }
  for (const priorPlateAppearances of [200, 400, 800]) {
    for (const halfLifeDays of [14, 35, Infinity]) {
      for (const multiplierCap of [2, 3]) {
        for (const disagreementMode of ['component', 'total']) {
          for (const adaptiveSensitivity of [0.5, 1, 2]) {
            for (const disagreementThreshold of [1, 2]) candidates.push({
              priorPlateAppearances, halfLifeDays, multiplierCap,
              adaptiveSensitivity, disagreementThreshold, disagreementMode,
              gateUpdates: false,
            });
          }
        }
      }
    }
  }
  for (const priorPlateAppearances of [50, 100, 200]) {
    for (const halfLifeDays of [14, 35, Infinity]) {
      for (const multiplierCap of [1.5, 2]) {
        for (const disagreementMode of ['component', 'total']) {
          for (const adaptiveSensitivity of [1, 2, 4]) {
            for (const disagreementThreshold of [1, 1.5, 2]) candidates.push({
              priorPlateAppearances, halfLifeDays, multiplierCap,
              adaptiveSensitivity, disagreementThreshold, disagreementMode,
              gateUpdates: true,
            });
          }
        }
      }
    }
  }
  for (const priorPlateAppearances of [25, 50, 100]) {
    for (const halfLifeDays of [14, 35]) {
      for (const multiplierCap of [1.5, 2]) {
        for (const adaptiveSensitivity of [2, 4]) {
          for (const disagreementThreshold of [0.5, 1, 1.5]) {
            for (const minimumEvidencePA of [50, 100, 200]) candidates.push({
              priorPlateAppearances, halfLifeDays, multiplierCap,
              adaptiveSensitivity, disagreementThreshold, disagreementMode: 'total',
              gateUpdates: true, requirePersistentDisagreement: true, minimumEvidencePA,
            });
          }
        }
      }
    }
  }
  return candidates;
}

export function seasonBayesianDiagnostics(row, histories, options = {}) {
  const games = histories.get(String(row.mlbPlayerId || '')) || [];
  const halfLifeDays = numberOrInfinity(options.halfLifeDays);
  const evidence = aggregateBefore(games, row.date, halfLifeDays);
  return {
    evidencePlateAppearances: evidence.plateAppearances,
    totalDisagreementZ: totalDisagreementZ(row, evidence, Number(row.projectedPlateAppearances)),
    fullSeasonDisagreementZ: totalDisagreementZ(row, aggregateBefore(games, row.date, Infinity), Number(row.projectedPlateAppearances)),
    baseProjection: row.projectedDraftKingsPoints,
    posteriorProjection: predictSeasonBayesian(row, histories, options),
  };
}

function totalDisagreementZ(row, evidence, projectedPA) {
  if (!(projectedPA > 0) || !(evidence.plateAppearances > 0)) return 0;
  let actualPoints = 0;
  let expectedPoints = 0;
  let variance = 0;
  for (const component of HITTER_COMPONENTS) {
    const priorRate = Number(row[`projected${component.key}`] || 0) / projectedPA;
    const expectedCount = evidence.plateAppearances * priorRate;
    actualPoints += component.points * evidence[component.key];
    expectedPoints += component.points * expectedCount;
    variance += component.points ** 2 * expectedCount;
  }
  return (actualPoints - expectedPoints) / Math.sqrt(variance + 4);
}

function aggregateBefore(games, date, halfLifeDays) {
  const result = Object.fromEntries(HITTER_COMPONENTS.map(({ key }) => [key, 0]));
  result.plateAppearances = 0;
  for (const game of games) {
    if (game.date >= date) break;
    const weight = recencyWeight(game.date, date, halfLifeDays);
    result.plateAppearances += weight * game.plateAppearances;
    for (const component of HITTER_COMPONENTS) result[component.key] += weight * game[component.key];
  }
  return result;
}

function toGame(split) {
  const stat = split?.stat;
  if (!split?.date || !stat) return null;
  const hits = Number(stat.hits || 0);
  const doubles = Number(stat.doubles || 0);
  const triples = Number(stat.triples || 0);
  const homeRuns = Number(stat.homeRuns || 0);
  return {
    date: split.date,
    plateAppearances: Number(stat.plateAppearances || 0),
    Singles: Math.max(0, hits - doubles - triples - homeRuns),
    Doubles: doubles,
    Triples: triples,
    HomeRuns: homeRuns,
    RunsBattedIn: Number(stat.rbi || 0),
    Runs: Number(stat.runs || 0),
    Walks: Number(stat.baseOnBalls || 0),
    HitByPitch: Number(stat.hitByPitch || 0),
    StolenBases: Number(stat.stolenBases || 0),
  };
}

function numberOrInfinity(value) { return Number.isFinite(Number(value)) ? Number(value) : Infinity; }
function recencyWeight(date, asOfDate, halfLifeDays) {
  if (!Number.isFinite(halfLifeDays)) return 1;
  const elapsed = Math.max(0, (Date.parse(`${asOfDate}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / DAY_MS);
  return 0.5 ** (elapsed / halfLifeDays);
}
