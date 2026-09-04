#!/usr/bin/env node
import http from 'node:http';
import crypto from 'node:crypto';

import { config, notificationsConfigured } from './lib/config.js';
import { log } from './lib/log.js';
import { loadState, saveState, accountKey } from './lib/store.js';
import { ingestReport, checkWindowReset } from './lib/detector.js';
import { dispatch } from './lib/notify.js';

const MAX_BODY_BYTES = 64 * 1024;
const RESET_CHECK_INTERVAL_MS = 30_000;

const detectorOptions = {
  onWindowStart: config.notify.onWindowStart,
  onWindowReset: config.notify.onWindowReset,
  onSourceError: config.notify.onSourceError,
  thresholds: config.notify.thresholds,
  sourceErrorCooldownMinutes: config.notify.sourceErrorCooldownMinutes,
  resetGraceMinutes: config.resetGraceMinutes,
  freshWindowMinutes: config.freshWindowMinutes,
};

function isAuthorized(req) {
  const header = req.headers.authorization ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';

  const a = Buffer.from(provided);
  const b = Buffer.from(config.relayToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });

    req.on('error', reject);
  });
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** Fire and forget: a slow push must never slow down the reporting agent. */
function dispatchInBackground(events) {
  if (events.length === 0) return;

  dispatch(events).catch((error) => {
    log.error('dispatch failed', { message: error instanceof Error ? error.message : String(error) });
  });
}

function handleReport(report) {
  if (!report || typeof report !== 'object' || typeof report.windows !== 'object') {
    return { status: 400, payload: { ok: false, error: 'report must include a windows object' } };
  }

  const key = accountKey(report.provider, report.account);
  const state = loadState();
  const existing = state.accounts[key];

  // Guard against out-of-order deliveries. A stale report carrying an old
  // `resets_at` would otherwise look like a brand new window and fire a bogus
  // notification.
  if (existing?.collected_at && report.collected_at && report.collected_at < existing.collected_at) {
    return { status: 200, payload: { ok: true, ignored: 'stale report' } };
  }

  const { state: nextAccount, events } = ingestReport({
    accountState: existing,
    report,
    options: detectorOptions,
    now: Date.now(),
  });

  state.accounts[key] = nextAccount;
  saveState(state);

  if (events.length > 0) {
    log.info('events detected', { account: key, events: events.map((event) => event.type) });
  }
  dispatchInBackground(events);

  return { status: 200, payload: { ok: true, events: events.map((event) => event.type) } };
}

function buildStateResponse() {
  const state = loadState();

  return {
    ok: true,
    now: new Date().toISOString(),
    accounts: Object.fromEntries(
      Object.entries(state.accounts).map(([key, account]) => [
        key,
        {
          provider: account.provider,
          account: account.account,
          windows: account.windows,
          tracking: account.tracking,
          devices: account.devices,
          updated_at: account.updated_at,
          source: account.source,
          source_error: account.source_error,
        },
      ]),
    ),
  };
}

function runResetCheck() {
  const state = loadState();
  const events = [];
  let changed = false;

  for (const [key, account] of Object.entries(state.accounts)) {
    const result = checkWindowReset({ accountState: account, options: detectorOptions, now: Date.now() });
    if (result.state !== account) {
      state.accounts[key] = result.state;
      changed = true;
    }
    events.push(...result.events);
  }

  if (changed) saveState(state);
  if (events.length > 0) log.info('reset check produced events', { count: events.length });
  dispatchInBackground(events);
}

async function handleRequest(req, res) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, { ok: true, notifications: notificationsConfigured });
    return;
  }

  if (!isAuthorized(req)) {
    json(res, 401, { ok: false, error: 'unauthorized' });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/report') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      json(res, 400, { ok: false, error: error instanceof Error ? error.message : 'bad request' });
      return;
    }

    const { status, payload } = handleReport(body);
    json(res, status, payload);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/state') {
    json(res, 200, buildStateResponse());
    return;
  }

  json(res, 404, { ok: false, error: 'not found' });
}

async function main() {
  if (process.argv.includes('--test-notification')) {
    const results = await dispatch([{ type: 'test' }]);
    const ok = results.every((result) => result.sent);
    if (!ok) log.error('test notification failed', { results });
    process.exit(ok ? 0 : 1);
  }

  if (!config.relayToken) {
    log.error('RELAY_TOKEN is required - copy .env.example to .env and set one');
    process.exit(1);
  }

  if (!notificationsConfigured) {
    log.warn('NTFY_TOPIC is not set: reports will be recorded but nothing will be pushed');
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      log.error('request failed', { message: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) json(res, 500, { ok: false, error: 'internal error' });
    });
  });

  server.listen(config.port, config.host, () => {
    log.info('notify-server listening', {
      host: config.host,
      port: config.port,
      thresholds: config.notify.thresholds,
      language: config.notify.language,
    });
  });

  runResetCheck();
  setInterval(runResetCheck, RESET_CHECK_INTERVAL_MS);
}

main().catch((error) => {
  log.error('failed to start', { message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
