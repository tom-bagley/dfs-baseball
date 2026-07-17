import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fetchDraftKingsSalaries,
  getActiveTeamRoster,
  getDraftKingsSlates,
  getPlayerProjectionSlate,
  getProjectionSlate,
  runCustomProjection,
} from './projections-data.js';
import { getPick6Analysis } from './pick6-data.js';

const PORT = Number(process.env.PORT || 8000);
const MAX_PORT_ATTEMPTS = 10;
const MAX_JSON_BODY_BYTES = 2_500_000;
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const MIME_TYPES = {
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

    if (request.method === 'OPTIONS') {
      sendNoContent(response);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/refresh-projections') {
      await handleRefreshProjections(request, response);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/refresh-player-projections') {
      await handleRefreshPlayerProjections(request, response);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/draftkings-slates') {
      await handleDraftKingsSlates(url, response);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/pick6-board') {
      await handlePick6Board(url, response);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/team-roster') {
      await handleTeamRoster(url, response);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/fetch-draftkings-salaries') {
      await handleFetchDraftKingsSalaries(request, response);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/run-custom-projection') {
      await handleRunCustomProjection(request, response);
      return;
    }

    if (request.method === 'GET' || request.method === 'HEAD') {
      await serveStatic(url.pathname, request, response);
      return;
    }

    sendJson(response, 405, { error: 'Method not allowed.' });
  } catch (error) {
    sendJson(response, 500, { error: formatError(error) });
  }
});

let currentPort = PORT;
let portAttempts = 0;

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE' && portAttempts < MAX_PORT_ATTEMPTS) {
    portAttempts += 1;
    currentPort += 1;
    server.listen(currentPort);
    return;
  }

  throw error;
});

server.listen(currentPort, () => {
  console.log(`Team projections viewer running at http://localhost:${currentPort}/`);
});

async function handleRefreshProjections(request, response) {
  const body = await readJsonBody(request);
  const date = String(body.date || '').trim();
  const projectionSystem = String(body.projectionSystem || 'rSteamer').trim();
  const providerName = String(body.provider || '').trim();
  const lineType = String(body.lineType || 'current').trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    sendJson(response, 400, { error: 'Use a date in YYYY-MM-DD format.' });
    return;
  }

  try {
    const slate = await getProjectionSlate({ date, projectionSystem, providerName, lineType });
    sendJson(response, 200, slate);
  } catch (error) {
    sendJson(response, 502, {
      error: formatError(error),
      phase: 'refresh',
      hint: 'The server is running, but an upstream FanGraphs or ESPN request failed.',
    });
  }
}

async function handleRefreshPlayerProjections(request, response) {
  const body = await readJsonBody(request);
  const date = String(body.date || '').trim();
  const projectionSystem = String(body.projectionSystem || 'rSteamer').trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    sendJson(response, 400, { error: 'Use a date in YYYY-MM-DD format.' });
    return;
  }

  try {
    const slate = await getPlayerProjectionSlate({ date, projectionSystem });
    sendJson(response, 200, slate);
  } catch (error) {
    sendJson(response, 502, {
      error: formatError(error),
      phase: 'player-refresh',
      hint: 'The server is running, but an upstream FanGraphs request failed.',
    });
  }
}

async function handleDraftKingsSlates(url, response) {
  const date = String(url.searchParams.get('date') || '').trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    sendJson(response, 400, { error: 'Use a date in YYYY-MM-DD format.' });
    return;
  }

  try {
    const result = await getDraftKingsSlates({ date });
    sendJson(response, 200, result);
  } catch (error) {
    sendJson(response, 502, {
      error: formatError(error),
      phase: 'draftkings-slates',
      hint: 'The server is running, but the DraftKings lobby request failed.',
    });
  }
}

async function handlePick6Board(url, response) {
  const date = String(url.searchParams.get('date') || '').trim();
  const projectionSystem = String(url.searchParams.get('projectionSystem') || 'rSteamer').trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    sendJson(response, 400, { error: 'Use a date in YYYY-MM-DD format.' });
    return;
  }

  try {
    const result = await getPick6Analysis({ date, projectionSystem });
    sendJson(response, 200, result);
  } catch (error) {
    sendJson(response, 502, {
      error: formatError(error),
      phase: 'pick6-board',
      hint: 'The server is running, but the DraftKings Pick6 board request failed.',
    });
  }
}

async function handleTeamRoster(url, response) {
  const teamAbbrev = String(url.searchParams.get('team') || '').trim();
  if (!teamAbbrev) {
    sendJson(response, 400, { error: 'Choose a team first.' });
    return;
  }

  try {
    sendJson(response, 200, await getActiveTeamRoster({ teamAbbrev }));
  } catch (error) {
    sendJson(response, 502, { error: formatError(error), phase: 'team-roster' });
  }
}

async function handleFetchDraftKingsSalaries(request, response) {
  const body = await readJsonBody(request);
  const date = String(body.date || '').trim();
  const draftGroupId = Number(body.draftGroupId);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    sendJson(response, 400, { error: 'Use a date in YYYY-MM-DD format.' });
    return;
  }

  if (!Number.isInteger(draftGroupId) || draftGroupId <= 0) {
    sendJson(response, 400, { error: 'Select a DraftKings slate first.' });
    return;
  }

  try {
    const result = await fetchDraftKingsSalaries({ date, draftGroupId });
    sendJson(response, 200, result);
  } catch (error) {
    sendJson(response, 502, {
      error: formatError(error),
      phase: 'draftkings-fetch',
      hint: 'The server is running, but the DraftKings draftables request failed.',
    });
  }
}

async function handleRunCustomProjection(request, response) {
  const body = await readJsonBody(request);
  const date = String(body.date || '').trim();
  const gameKey = String(body.gameKey || '').trim();
  const providerName = String(body.provider || '').trim();
  const lineType = String(body.lineType || 'current').trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    sendJson(response, 400, { error: 'Use a date in YYYY-MM-DD format.' });
    return;
  }

  if (!gameKey) {
    sendJson(response, 400, { error: 'Select a game before running a custom projection.' });
    return;
  }

  try {
    const result = await runCustomProjection({
      date,
      gameKey,
      payload: body.payload,
      providerName,
      lineType,
    });
    sendJson(response, 200, result);
  } catch (error) {
    sendJson(response, 502, {
      error: formatError(error),
      phase: 'custom-projection',
      hint: 'The server is running, but FanGraphs did not return a custom simulation.',
    });
  }
}

async function serveStatic(pathname, request, response) {
  const requested = pathname === '/' ? '/team-projections.html' : decodeURIComponent(pathname);
  const normalized = normalize(requested).replace(/^(\.\.[/\\])+/, '');
  const filePath = resolve(ROOT, `.${normalized.startsWith('/') ? normalized : `/${normalized}`}`);

  if (!filePath.startsWith(ROOT) || !existsSync(filePath)) {
    sendJson(response, 404, { error: 'Not found.' });
    return;
  }

  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    sendJson(response, 404, { error: 'Not found.' });
    return;
  }

  response.writeHead(200, {
    ...corsHeaders(),
    'content-type': MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream',
    'content-length': fileStat.size,
    'cache-control': 'no-store',
  });

  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  createReadStream(filePath).pipe(response);
}

function readJsonBody(request) {
  return new Promise((resolvePromise, reject) => {
    let body = '';

    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_JSON_BODY_BYTES) {
        reject(new Error('Request body is too large.'));
        request.destroy();
      }
    });

    request.on('end', () => {
      if (!body) {
        resolvePromise({});
        return;
      }

      try {
        resolvePromise(JSON.parse(body));
      } catch {
        reject(new Error('Request body must be valid JSON.'));
      }
    });

    request.on('error', reject);
  });
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    ...corsHeaders(),
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(`${JSON.stringify(data)}\n`);
}

function sendNoContent(response) {
  response.writeHead(204, corsHeaders());
  response.end();
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-private-network': 'true',
  };
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
