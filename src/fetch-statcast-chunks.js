import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const args = parseArgs(process.argv.slice(2));
const start = args.start || '2026-03-26';
const end = args.end || '2026-07-11';
const chunkDays = positiveInteger(args.chunkDays, 3);
const outputDir = resolve(args.outputDir || 'out/cache/statcast/chunks');
const requestDelayMs = nonnegativeInteger(args.requestDelayMs, 250);
const retries = positiveInteger(args.retries, 4);

validateDate(start);
validateDate(end);
if (start > end) throw new Error('--start must not be after --end.');
await mkdir(outputDir, { recursive: true });

for (const chunk of dateChunks(start, end, chunkDays)) {
  const path = join(outputDir, `${chunk.start}-to-${chunk.end}.csv`);
  try {
    const cached = await readFile(path, 'utf8');
    if (isStatcastCsv(cached)) {
      process.stdout.write(`Cached ${chunk.start} to ${chunk.end}\n`);
      continue;
    }
  } catch {}

  const csv = await fetchCsvWithRetry(statcastUrl(chunk.start, chunk.end), retries, chunk);
  if (!isStatcastCsv(csv)) {
    throw new Error(`Unexpected Statcast response for ${chunk.start} to ${chunk.end}: ${JSON.stringify(csv.slice(0, 160))}`);
  }
  await writeFile(path, csv, 'utf8');
  process.stdout.write(`Fetched ${chunk.start} to ${chunk.end}: ${Math.round(csv.length / 1024)} KB\n`);
  if (requestDelayMs) await delay(requestDelayMs);
}

async function fetchCsvWithRetry(url, attempts, chunk) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'text/csv,*/*', 'user-agent': 'dfs-baseball-statcast-backtest/1.0' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.text()).replace(/^\uFEFF/, '');
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await delay(750 * 2 ** (attempt - 1));
    }
  }
  throw new Error(`Failed ${chunk.start} to ${chunk.end} after ${attempts} attempts: ${lastError?.message || lastError}`);
}

function isStatcastCsv(value) {
  const text = String(value || '').replace(/^\uFEFF/, '');
  return text.startsWith('pitch_type,') || text.startsWith('"pitch_type",');
}

function statcastUrl(startDate, endDate) {
  const url = new URL('https://baseballsavant.mlb.com/statcast_search/csv');
  const params = {
    all: 'true', hfPT: '', hfAB: '', hfBBT: '', hfPR: '', hfZ: '', stadium: '', hfBBL: '', hfNewZones: '',
    hfGT: 'R|', hfSea: '', hfSit: '', player_type: 'pitcher', hfOuts: '', opponent: '', pitcher_throws: '',
    batter_stands: '', hfSA: '', game_date_gt: startDate, game_date_lt: endDate, team: '', position: '', hfRO: '',
    home_road: '', hfFlag: '', metric_1: '', hfInn: '', min_pitches: '0', min_results: '0', group_by: 'name',
    sort_col: 'pitches', player_event_sort: 'h_launch_speed', sort_order: 'desc', min_abs: '0', type: 'details',
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

function dateChunks(startDate, endDate, days) {
  const chunks = [];
  let cursor = parseDate(startDate);
  const last = parseDate(endDate);
  while (cursor <= last) {
    const chunkEnd = new Date(Math.min(last.getTime(), cursor.getTime() + (days - 1) * 86400000));
    chunks.push({ start: formatDate(cursor), end: formatDate(chunkEnd) });
    cursor = new Date(chunkEnd.getTime() + 86400000);
  }
  return chunks;
}

function parseDate(value) { return new Date(`${value}T00:00:00Z`); }
function formatDate(value) { return value.toISOString().slice(0, 10); }
function validateDate(value) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Invalid date: ${value}`); }
function delay(ms) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }
function positiveInteger(value, fallback) { const number = Number(value); return Number.isInteger(number) && number > 0 ? number : fallback; }
function nonnegativeInteger(value, fallback) { const number = Number(value); return Number.isInteger(number) && number >= 0 ? number : fallback; }
function parseArgs(tokens) {
  const parsed = {};
  for (let index = 0; index < tokens.length; index += 1) {
    if (!tokens[index].startsWith('--')) continue;
    const key = tokens[index].slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    parsed[key] = tokens[index + 1]; index += 1;
  }
  return parsed;
}
