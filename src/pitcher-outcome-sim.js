const DEFAULT_SIMULATIONS = 10000;

export function simulatePitcherOutcomes({
  playerId = '',
  date = '',
  average = {},
  histograms = {},
  simulations = DEFAULT_SIMULATIONS,
  experience = null,
  uncertaintyStrength = 0.10,
} = {}) {
  const count = Math.max(1000, Math.floor(Number(simulations) || DEFAULT_SIMULATIONS));
  const random = mulberry32(hashString(`${date}|${playerId}|${count}|pitcher-outcomes-v1`));
  const sampler = histogramSamplers(histograms);
  const avg = {
    outs: stat(average, 'Outs'),
    strikeouts: stat(average, 'K'),
    runs: stat(average, 'R'),
    earnedRuns: stat(average, 'ER'),
    hits: stat(average, 'H'),
    walks: stat(average, 'BB'),
    hitBatsmen: stat(average, 'HBP'),
    win: clamp(stat(average, 'W'), 0, 1),
  };
  const varianceMultiplier = experienceVarianceMultiplier(experience, uncertaintyStrength);
  const scenarios = new Array(count);

  for (let index = 0; index < count; index += 1) {
    const quality = normal(random);
    const contactTrouble = -0.72 * quality + Math.sqrt(1 - 0.72 ** 2) * normal(random);
    const controlTrouble = -0.45 * quality + Math.sqrt(1 - 0.45 ** 2) * normal(random);

    const outs = sampleMarginal(sampler.Outs, correlatedUniform(quality, normal(random), 0.68), avg.outs, varianceMultiplier);
    const strikeouts = Math.min(
      outs,
      sampleMarginal(sampler.K, correlatedUniform(quality, normal(random), 0.55), avg.strikeouts, varianceMultiplier),
    );
    const hits = sampleMarginal(sampler.H, normalCdf(contactTrouble), avg.hits, varianceMultiplier);
    const walks = sampleMarginal(sampler.BB, normalCdf(controlTrouble), avg.walks, varianceMultiplier);
    const hitBatsmen = sampleMarginal(sampler.HBP, normalCdf(controlTrouble * 0.55 + normal(random) * 0.835), avg.hitBatsmen, varianceMultiplier);
    const runs = sampleMarginal(sampler.R, normalCdf(contactTrouble * 0.82 + normal(random) * 0.572), avg.runs, varianceMultiplier);
    const earnedRunRatio = avg.runs > 0 ? clamp(avg.earnedRuns / avg.runs, 0, 1) : 1;
    const earnedRuns = binomial(runs, earnedRunRatio, random);

    scenarios[index] = {
      outs,
      strikeouts,
      hits,
      walks,
      hitBatsmen,
      runs,
      earnedRuns,
      quality,
      winRandom: random(),
    };
  }

  const winIntercept = calibrateWinIntercept(scenarios, avg.win, avg.earnedRuns);
  const scores = new Float64Array(count);
  let scoreSum = 0;
  let winSum = 0;

  for (let index = 0; index < count; index += 1) {
    const scenario = scenarios[index];
    const winProbability = scenario.outs >= 15
      ? sigmoid(winIntercept + scenario.quality * 0.38 - (scenario.earnedRuns - avg.earnedRuns) * 0.28)
      : 0;
    const win = scenario.winRandom < winProbability ? 1 : 0;
    const completeGame = scenario.outs >= 27 ? 1 : 0;
    const completeGameShutout = completeGame && scenario.runs === 0 ? 1 : 0;
    const noHitter = completeGame && scenario.hits === 0 ? 1 : 0;
    const score =
      scenario.outs * 0.75 +
      scenario.strikeouts * 2 +
      win * 4 -
      scenario.earnedRuns * 2 -
      scenario.hits * 0.6 -
      scenario.walks * 0.6 -
      scenario.hitBatsmen * 0.6 +
      completeGame * 2.5 +
      completeGameShutout * 2.5 +
      noHitter * 5;
    scores[index] = score;
    scoreSum += score;
    winSum += win;
  }

  // Preserve the projection as the center of the distribution. Widening a
  // skewed marginal for an inexperienced pitcher otherwise moves its mean,
  // which would mix uncertainty with a change in expected ability.
  const rawMean = scoreSum / count;
  const projectedMean = projectedPitcherMean(avg, histograms);
  const centerShift = projectedMean - rawMean;
  if (Math.abs(centerShift) > 1e-9) {
    for (let index = 0; index < scores.length; index += 1) scores[index] += centerShift;
  }
  scores.sort();
  const mean = projectedMean;
  let squaredError = 0;
  let thirtyPlus = 0;
  for (const score of scores) {
    squaredError += (score - mean) ** 2;
    if (score >= 30) thirtyPlus += 1;
  }

  return {
    simulationCount: count,
    simulationMean: round(mean),
    simulationStdDev: round(Math.sqrt(squaredError / count)),
    p10: round(quantileSorted(scores, 0.10)),
    p20: round(quantileSorted(scores, 0.20)),
    p50: round(quantileSorted(scores, 0.50)),
    p80: round(quantileSorted(scores, 0.80)),
    p90: round(quantileSorted(scores, 0.90)),
    probability30Plus: round(thirtyPlus / count, 4),
    simulatedWinProbability: round(winSum / count, 4),
    experienceVarianceMultiplier: round(varianceMultiplier, 4),
    experienceConfidence: experienceConfidence(experience),
  };
}

export function experienceVarianceMultiplier(experience, strength = 0.10) {
  if (!experience || typeof experience !== 'object') return 1;
  const seasonInnings = nonnegative(experience.seasonInnings);
  const priorMlbInnings = nonnegative(experience.priorMlbInnings);
  const minorLeagueInnings = nonnegative(experience.minorLeagueInnings);
  const recentStarts = nonnegative(experience.recentStarts);
  const effectiveInnings = seasonInnings
    + Math.min(priorMlbInnings, 450) * 0.28
    + Math.min(minorLeagueInnings, 250) * 0.10
    + Math.min(recentStarts, 8) * 2;
  const uncertainty = 1 / Math.sqrt(1 + effectiveInnings / 18);
  return 1 + Math.max(0, Number(strength) || 0) * uncertainty;
}

export function scoreDraftKingsPitcherLine({
  outs = 0,
  strikeouts = 0,
  win = 0,
  earnedRuns = 0,
  hits = 0,
  walks = 0,
  hitBatsmen = 0,
  runs = earnedRuns,
} = {}) {
  const completeGame = Number(outs) >= 27 ? 1 : 0;
  const completeGameShutout = completeGame && Number(runs) === 0 ? 1 : 0;
  const noHitter = completeGame && Number(hits) === 0 ? 1 : 0;
  return round(
    Number(outs) * 0.75 +
    Number(strikeouts) * 2 +
    Number(win) * 4 -
    Number(earnedRuns) * 2 -
    Number(hits) * 0.6 -
    Number(walks) * 0.6 -
    Number(hitBatsmen) * 0.6 +
    completeGame * 2.5 +
    completeGameShutout * 2.5 +
    noHitter * 5,
  );
}

function histogramSamplers(histograms) {
  return Object.fromEntries(Object.entries(histograms || {}).map(([key, histogram]) => [key, buildHistogramSampler(histogram)]));
}

function buildHistogramSampler(histogram) {
  const entries = Object.entries(histogram?.buckets || {})
    .map(([value, frequency]) => [Number(value), Number(frequency)])
    .filter(([value, frequency]) => Number.isFinite(value) && Number.isFinite(frequency) && frequency > 0)
    .sort((a, b) => a[0] - b[0]);
  const total = entries.reduce((sum, entry) => sum + entry[1], 0);
  if (!entries.length || total <= 0) return null;
  let cumulative = 0;
  return entries.map(([value, frequency]) => {
    cumulative += frequency / total;
    return [value, cumulative];
  });
}

function sampleMarginal(sampler, uniform, fallbackMean, varianceMultiplier) {
  const widened = widenUniform(clamp(uniform, 1e-9, 1 - 1e-9), varianceMultiplier);
  if (!sampler) return poisson(Math.max(0, fallbackMean), widened);
  for (const [value, cumulative] of sampler) {
    if (widened <= cumulative) return Math.max(0, Math.round(value));
  }
  return Math.max(0, Math.round(sampler[sampler.length - 1][0]));
}

function widenUniform(value, multiplier) {
  if (!(multiplier > 1)) return value;
  const logit = Math.log(value / (1 - value));
  return sigmoid(logit * multiplier);
}

function calibrateWinIntercept(scenarios, target, averageEarnedRuns) {
  if (!(target > 0)) return -30;
  let low = -12;
  let high = 12;
  for (let iteration = 0; iteration < 50; iteration += 1) {
    const midpoint = (low + high) / 2;
    const mean = scenarios.reduce((sum, scenario) => {
      if (scenario.outs < 15) return sum;
      return sum + sigmoid(midpoint + scenario.quality * 0.38 - (scenario.earnedRuns - averageEarnedRuns) * 0.28);
    }, 0) / scenarios.length;
    if (mean < target) low = midpoint;
    else high = midpoint;
  }
  return (low + high) / 2;
}

function projectedPitcherMean(average, histograms) {
  const completeGame = histogramProbability(histograms?.Outs, (value) => value >= 27);
  const shutout = histogramProbability(histograms?.R, (value) => value === 0);
  const noHits = histogramProbability(histograms?.H, (value) => value === 0);
  return round(
    average.outs * 0.75 +
    average.strikeouts * 2 +
    average.win * 4 -
    average.earnedRuns * 2 -
    average.hits * 0.6 -
    average.walks * 0.6 -
    average.hitBatsmen * 0.6 +
    completeGame * 2.5 +
    Math.min(completeGame, shutout) * 2.5 +
    Math.min(completeGame, noHits) * 5,
  );
}

function histogramProbability(histogram, predicate) {
  const entries = Object.entries(histogram?.buckets || {});
  const total = entries.reduce((sum, [, frequency]) => sum + (Number(frequency) || 0), 0);
  if (!(total > 0)) return 0;
  const selected = entries.reduce((sum, [value, frequency]) => (
    predicate(Number(value)) ? sum + (Number(frequency) || 0) : sum
  ), 0);
  return selected / total;
}

function experienceConfidence(experience) {
  if (!experience || typeof experience !== 'object') return 'unknown';
  const weighted = nonnegative(experience.seasonInnings)
    + nonnegative(experience.priorMlbInnings) * 0.28
    + nonnegative(experience.minorLeagueInnings) * 0.10;
  if (weighted >= 100) return 'high';
  if (weighted >= 35) return 'medium';
  return 'low';
}

function correlatedUniform(latent, independent, correlation) {
  return normalCdf(correlation * latent + Math.sqrt(1 - correlation ** 2) * independent);
}

function normal(random) {
  const u1 = Math.max(random(), 1e-12);
  const u2 = random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function normalCdf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

function binomial(trials, probability, random) {
  let successes = 0;
  for (let index = 0; index < Math.max(0, Math.round(trials)); index += 1) {
    if (random() < probability) successes += 1;
  }
  return successes;
}

function poisson(lambda, uniform) {
  if (!(lambda > 0)) return 0;
  // Deterministic inverse CDF using the supplied uniform keeps the fallback
  // path reproducible without consuming an unknown number of random draws.
  let probability = Math.exp(-lambda);
  let cumulative = probability;
  let value = 0;
  while (uniform > cumulative && value < Math.ceil(lambda + 12 * Math.sqrt(lambda + 1))) {
    value += 1;
    probability *= lambda / value;
    cumulative += probability;
  }
  return value;
}

function quantileSorted(values, probability) {
  if (!values.length) return null;
  const index = (values.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return values[lower];
  return values[lower] + (values[upper] - values[lower]) * (index - lower);
}

function stat(object, key) {
  const value = Number(object?.[key]);
  return Number.isFinite(value) ? value : 0;
}

function nonnegative(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < String(value).length; index += 1) {
    hash ^= String(value).charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  return function random() {
    let value = seed += 0x6D2B79F5;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
