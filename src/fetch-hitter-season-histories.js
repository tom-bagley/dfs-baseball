import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseCsv } from './hitter-bayesian-calibration.js';

const args = parseArgs(process.argv.slice(2));
const input = resolve(args.input || 'out/hitter-direct-projections-2026-05-04-to-2026-07-12-hitters.csv');
const outputDir = resolve(args.outputDir || 'out/cache/hitter-season-histories/2026');
const season = args.season || '2026';
const concurrency = positiveInteger(args.concurrency, 6);

const rows = parseCsv(await readFile(input, 'utf8'));
const playerIds = [...new Set(rows.map((row) => String(row.mlbPlayerId || '')).filter(Boolean))];
await mkdir(outputDir, { recursive: true });
let completed = 0;
await mapLimit(playerIds, concurrency, async (playerId) => {
  const path = join(outputDir, `${playerId}.json`);
  try {
    const cached = JSON.parse(await readFile(path, 'utf8'));
    if (Array.isArray(cached?.stats)) return;
  } catch {}
  const url = new URL(`https://statsapi.mlb.com/api/v1/people/${playerId}/stats`);
  url.searchParams.set('stats', 'gameLog');
  url.searchParams.set('group', 'hitting');
  url.searchParams.set('season', season);
  url.searchParams.set('gameType', 'R');
  const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'dfs-baseball-hitter-bayesian/1.0' } });
  if (!response.ok) throw new Error(`HTTP ${response.status} for player ${playerId}`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(await response.json()), 'utf8');
  completed += 1;
  if (completed % 25 === 0) process.stdout.write(`Fetched ${completed}/${playerIds.length} missing histories\n`);
});
console.log(`Season histories ready for ${playerIds.length} hitters in ${outputDir}`);

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) { const index = next++; results[index] = await mapper(items[index], index); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
function positiveInteger(value, fallback) { const number = Number(value); return Number.isInteger(number) && number > 0 ? number : fallback; }
function parseArgs(tokens) {
  const parsed = {};
  for (let index = 0; index < tokens.length; index += 1) {
    if (!tokens[index].startsWith('--')) continue;
    const key = tokens[index].slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    parsed[key] = tokens[index + 1]; index += 1;
  }
  return parsed;
}
