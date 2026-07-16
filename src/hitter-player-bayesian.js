const DAY_MS = 24 * 60 * 60 * 1000;

export const HITTER_COMPONENTS = Object.freeze([
  { key: 'Singles', points: 3 },
  { key: 'Doubles', points: 5 },
  { key: 'Triples', points: 8 },
  { key: 'HomeRuns', points: 10 },
  { key: 'RunsBattedIn', points: 2 },
  { key: 'Runs', points: 2 },
  { key: 'Walks', points: 2 },
  { key: 'HitByPitch', points: 2 },
  { key: 'StolenBases', points: 5 },
]);

export function fitPlayerBayesianModel(rows, options = {}) {
  const mode = options.mode || 'components';
  const priorStrength = Number(options.priorStrength);
  const halfLifeDays = numberOrInfinity(options.halfLifeDays);
  const multiplierCap = Number(options.multiplierCap || 2);
  const asOfDate = options.asOfDate || [...new Set(rows.map((row) => row.date))].sort().at(-1);
  if (!['components', 'points'].includes(mode)) throw new Error(`Unknown player Bayesian mode: ${mode}`);
  if (!(priorStrength > 0)) throw new Error('priorStrength must be positive.');
  if (!(multiplierCap > 1)) throw new Error('multiplierCap must exceed one.');

  const histories = new Map();
  for (const row of rows) {
    const playerId = playerKey(row);
    if (!playerId) continue;
    const history = histories.get(playerId) || blankHistory();
    const weight = recencyWeight(row.date, asOfDate, halfLifeDays);
    history.games += weight;
    history.actualPoints += weight * row.actualDraftKingsPoints;
    history.projectedPoints += weight * row.projectedDraftKingsPoints;
    for (const component of HITTER_COMPONENTS) {
      history.actual[component.key] += weight * Number(row[`actual${component.key}`] || 0);
      history.projected[component.key] += weight * Number(row[`projected${component.key}`] || 0);
    }
    histories.set(playerId, history);
  }
  return { mode, priorStrength, halfLifeDays, multiplierCap, asOfDate, histories };
}

export function predictPlayerBayesian(row, model) {
  const history = model.histories.get(playerKey(row));
  if (!history) return row.projectedDraftKingsPoints;
  if (model.mode === 'points') {
    const multiplier = posteriorMultiplier(
      history.actualPoints,
      history.projectedPoints,
      model.priorStrength,
      model.multiplierCap,
    );
    return Math.max(0, row.projectedDraftKingsPoints * multiplier);
  }
  return HITTER_COMPONENTS.reduce((points, component) => {
    const multiplier = posteriorMultiplier(
      history.actual[component.key],
      history.projected[component.key],
      model.priorStrength,
      model.multiplierCap,
    );
    return points + component.points * Number(row[`projected${component.key}`] || 0) * multiplier;
  }, 0);
}

export function playerBayesianCandidates() {
  const candidates = [];
  for (const halfLifeDays of [14, 35, Infinity]) {
    for (const multiplierCap of [1.5, 2, 3]) {
      for (const priorStrength of [0.25, 0.5, 1, 2, 5, 10]) {
        candidates.push({ mode: 'components', priorStrength, halfLifeDays, multiplierCap });
      }
      for (const priorStrength of [20, 50, 100, 200, 400]) {
        candidates.push({ mode: 'points', priorStrength, halfLifeDays, multiplierCap });
      }
    }
  }
  return candidates;
}

function posteriorMultiplier(actual, projected, priorStrength, cap) {
  // Gamma-Poisson conjugacy for a latent player multiplier theta:
  // theta ~ Gamma(k, k), E(theta)=1; actual counts ~ Poisson(theta * projected).
  const posteriorMean = (priorStrength + actual) / (priorStrength + projected);
  return Math.max(1 / cap, Math.min(cap, posteriorMean));
}

function blankHistory() {
  return {
    games: 0,
    actualPoints: 0,
    projectedPoints: 0,
    actual: Object.fromEntries(HITTER_COMPONENTS.map(({ key }) => [key, 0])),
    projected: Object.fromEntries(HITTER_COMPONENTS.map(({ key }) => [key, 0])),
  };
}

function playerKey(row) { return String(row.fangraphsPlayerId || row.mlbPlayerId || '').trim(); }
function numberOrInfinity(value) { return Number.isFinite(Number(value)) ? Number(value) : Infinity; }
function recencyWeight(date, asOfDate, halfLifeDays) {
  if (!Number.isFinite(halfLifeDays)) return 1;
  const elapsed = Math.max(0, (Date.parse(`${asOfDate}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / DAY_MS);
  return 0.5 ** (elapsed / halfLifeDays);
}
