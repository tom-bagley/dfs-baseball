const DEFAULT_SIMULATIONS = 10000;
const DEFAULT_CALIBRATION_OFFSET = 0;

export function simulateHitterOutcomes({
  playerId = '',
  date = '',
  average = {},
  histograms = {},
  simulations = DEFAULT_SIMULATIONS,
  calibrationOffset = DEFAULT_CALIBRATION_OFFSET,
} = {}) {
  const count = Math.max(1000, Math.floor(Number(simulations) || DEFAULT_SIMULATIONS));
  const random = mulberry32(hashString(`${date}|${playerId}|${count}|hitter-outcomes-v1`));
  const samplers = histogramSamplers(histograms);
  const avg = {
    singles: stat(average, '1B'),
    doubles: stat(average, '2B'),
    triples: stat(average, '3B'),
    homeRuns: stat(average, 'HR'),
    walks: stat(average, 'BB'),
    hitByPitch: stat(average, 'HBP'),
    runs: stat(average, 'R'),
    runsBattedIn: stat(average, 'RBI'),
    stolenBases: stat(average, 'SB'),
  };
  const scores = new Float64Array(count);
  let scoreSum = 0;

  for (let index = 0; index < count; index += 1) {
    // Shared latent factors retain realistic positive correlation between a
    // hitter's scoring events while every stat still follows its FanGraphs
    // marginal histogram for this particular matchup and batting-order slot.
    const gameQuality = normal(random);
    const power = 0.45 * gameQuality + Math.sqrt(1 - 0.45 ** 2) * normal(random);
    const speed = 0.20 * gameQuality + Math.sqrt(1 - 0.20 ** 2) * normal(random);

    const singles = sampleMarginal(samplers['1B'], latentUniform(gameQuality, random, 0.42), avg.singles);
    const doubles = sampleMarginal(samplers['2B'], latentUniform(0.72 * gameQuality + 0.28 * power, random, 0.38), avg.doubles);
    const triples = sampleMarginal(samplers['3B'], latentUniform(0.45 * gameQuality + 0.55 * speed, random, 0.30), avg.triples);
    const homeRuns = sampleMarginal(samplers.HR, latentUniform(power, random, 0.48), avg.homeRuns);
    const walks = sampleMarginal(samplers.BB, latentUniform(gameQuality, random, 0.25), avg.walks);
    const hitByPitch = sampleMarginal(samplers.HBP, latentUniform(gameQuality, random, 0.10), avg.hitByPitch);
    const runs = sampleMarginal(samplers.R, latentUniform(0.82 * gameQuality + 0.18 * speed, random, 0.58), avg.runs);
    const runsBattedIn = sampleMarginal(samplers.RBI, latentUniform(0.68 * gameQuality + 0.32 * power, random, 0.58), avg.runsBattedIn);
    const stolenBases = sampleMarginal(samplers.SB, latentUniform(0.45 * gameQuality + 0.55 * speed, random, 0.42), avg.stolenBases);

    const rawScore = scoreDraftKingsHitterLine({
      singles,
      doubles,
      triples,
      homeRuns,
      runs,
      runsBattedIn,
      walks,
      hitByPitch,
      stolenBases,
    });
    // Historical calibration is applied only to nonzero outcomes. Hitter
    // scoring has a real zero floor, so an additive shift must not create
    // impossible negative DraftKings scores.
    const score = rawScore > 0 ? Math.max(0, rawScore + Number(calibrationOffset || 0)) : 0;
    scores[index] = score;
    scoreSum += score;
  }

  scores.sort();
  const simulationMean = scoreSum / count;
  let squaredError = 0;
  for (const score of scores) squaredError += (score - simulationMean) ** 2;

  return {
    simulationCount: count,
    simulationMean: round(simulationMean),
    simulationStdDev: round(Math.sqrt(squaredError / count)),
    calibrationOffset: round(Number(calibrationOffset || 0)),
    p10: round(quantileSorted(scores, 0.10)),
    p20: round(quantileSorted(scores, 0.20)),
    p50: round(quantileSorted(scores, 0.50)),
    p80: round(quantileSorted(scores, 0.80)),
    p90: round(quantileSorted(scores, 0.90)),
  };
}

export function scoreDraftKingsHitterLine({
  singles = 0,
  doubles = 0,
  triples = 0,
  homeRuns = 0,
  runs = 0,
  runsBattedIn = 0,
  walks = 0,
  hitByPitch = 0,
  stolenBases = 0,
} = {}) {
  return round(
    Number(singles) * 3
    + Number(doubles) * 5
    + Number(triples) * 8
    + Number(homeRuns) * 10
    + Number(runsBattedIn) * 2
    + Number(runs) * 2
    + Number(walks) * 2
    + Number(hitByPitch) * 2
    + Number(stolenBases) * 5,
  );
}

function histogramSamplers(histograms) {
  return Object.fromEntries(Object.entries(histograms || {}).map(([key, value]) => [key, buildHistogramSampler(value)]));
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

function sampleMarginal(sampler, uniform, fallbackMean) {
  if (!sampler) return poisson(Math.max(0, fallbackMean), uniform);
  for (const [value, cumulative] of sampler) {
    if (uniform <= cumulative) return value;
  }
  return sampler[sampler.length - 1][0];
}

function latentUniform(latent, random, correlation) {
  return normalCdf(correlation * latent + Math.sqrt(1 - correlation ** 2) * normal(random));
}

function poisson(lambda, uniform) {
  if (!(lambda > 0)) return 0;
  let probability = Math.exp(-lambda);
  let cumulative = probability;
  let value = 0;
  while (uniform > cumulative && value < 20) {
    value += 1;
    probability *= lambda / value;
    cumulative += probability;
  }
  return value;
}

function stat(average, key) {
  const value = Number(average?.[key]);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function quantileSorted(values, probability) {
  const position = (values.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return values[lower];
  return values[lower] + (values[upper] - values[lower]) * (position - lower);
}

function normal(random) {
  const u = Math.max(Number.EPSILON, random());
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function normalCdf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return Math.min(1, Math.max(0, 0.5 * (1 + sign * erf)));
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
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

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}
