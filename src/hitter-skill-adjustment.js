import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStatcastHitterDays, statcastFeaturesBefore } from './statcast-hitter-features.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const MODEL = Object.freeze({
  version: 'forward-xwoba-7d-v1',
  seasonCoefficient: 0.246244,
  recentCoefficient: -0.021526,
  reliabilityPA: 400,
  maxAdjustmentRate: 0.25,
});
let statcastPromise = null;
let playerIdIndexPromise = null;

export async function applyHitterSkillAdjustments(rows, { date, statcastDir } = {}) {
  const directory = resolve(statcastDir || process.env.STATCAST_CACHE_DIR || `${ROOT}/out/cache/statcast/chunks`);
  const seasonHistoryDir = resolve(process.env.HITTER_SEASON_HISTORY_DIR || `${ROOT}/out/cache/hitter-season-histories/2026`);
  statcastPromise ||= loadStatcastHitterDays(directory);
  playerIdIndexPromise ||= loadPlayerIdIndex(seasonHistoryDir);
  const [histories, playerIdByName] = await Promise.all([statcastPromise, playerIdIndexPromise]);
  let matched = 0;
  let adjusted = 0;

  for (const row of rows) {
    row.baselineExpectedPoints = row.expectedPoints;
    row.skillAdjustedPoints = row.expectedPoints;
    row.skillAdjustment = 0;
    row.skillModelVersion = row.playerType === 'hitter' ? MODEL.version : null;
    if (row.playerType !== 'hitter' || !Number.isFinite(row.expectedPoints)) continue;

    const mlbPlayerId = row.mlbPlayerId || playerIdByName.get(normalizePlayerName(row.playerName));
    if (!mlbPlayerId) continue;
    matched += 1;
    const projectedPlateAppearances = Number(row.plateAppearances);
    if (!(projectedPlateAppearances > 0)) continue;
    const features = statcastFeaturesBefore({
      date, mlbPlayerId, projectedPlateAppearances,
      projectedSingles: row.singles, projectedDoubles: row.doubles, projectedTriples: row.triples,
      projectedHomeRuns: row.homeRuns, projectedRuns: row.runs,
      projectedRunsBattedIn: row.runsBattedIn, projectedWalks: row.walks,
      projectedHitByPitch: row.hitByPitch, projectedStolenBases: row.stolenBases,
    }, histories, { recentDays: 30 });
    if (!(features.seasonPlateAppearances > 0) || features.seasonXwobaDifference == null) continue;

    const adjustment = calculateHitterSkillAdjustment(features, projectedPlateAppearances);
    row.mlbPlayerId = String(mlbPlayerId);
    row.skillAdjustedPoints = round(Math.max(0, row.expectedPoints + adjustment));
    row.skillAdjustment = round(row.skillAdjustedPoints - row.expectedPoints);
    row.skillDisagreementScore = round(Math.abs(features.seasonXwobaDifference), 4);
    row.projectedWoba = round(features.projectedWoba, 4);
    row.seasonXwoba = round(features.seasonXwoba, 4);
    row.recentXwoba = round(features.recentXwoba, 4);
    row.skillEvidencePlateAppearances = features.seasonPlateAppearances;
    if (Math.abs(row.skillAdjustment) >= 0.005) adjusted += 1;
  }
  return { status: 'ready', modelVersion: MODEL.version, matched, adjusted, totalHitters: rows.filter((row) => row.playerType === 'hitter').length };
}

export function calculateHitterSkillAdjustment(features, projectedPlateAppearances) {
  if (!(projectedPlateAppearances > 0) || !(features?.seasonPlateAppearances > 0) || features.seasonXwobaDifference == null) return 0;
  const seasonReliability = features.seasonPlateAppearances / (features.seasonPlateAppearances + MODEL.reliabilityPA);
  const recentReliability = features.recentPlateAppearances / (features.recentPlateAppearances + MODEL.reliabilityPA / 2);
  const rawRateAdjustment = MODEL.seasonCoefficient * 10 * features.seasonXwobaDifference * seasonReliability
    + MODEL.recentCoefficient * 10 * Number(features.recentXwobaDifference || 0) * recentReliability;
  return clamp(rawRateAdjustment, -MODEL.maxAdjustmentRate, MODEL.maxAdjustmentRate) * projectedPlateAppearances;
}

export function resetHitterSkillAdjustmentCache() { statcastPromise = null; playerIdIndexPromise = null; }
async function loadPlayerIdIndex(directory) {
  const index = new Map();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const payload = JSON.parse(await readFile(join(directory, entry.name), 'utf8'));
    const name = payload?.stats?.flatMap((stat) => stat.splits || []).find((split) => split?.player?.fullName)?.player?.fullName;
    if (name) index.set(normalizePlayerName(name), entry.name.slice(0, -5));
  }
  return index;
}
function normalizePlayerName(value = '') {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
function clamp(value, low, high) { return Math.max(low, Math.min(high, value)); }
function round(value, digits = 2) { return Number(Number(value).toFixed(digits)); }
