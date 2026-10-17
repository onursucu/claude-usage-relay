#!/usr/bin/env node
import http from 'node:http';
import crypto from 'node:crypto';

import { config, notificationsConfigured, startConfigured } from './lib/config.js';
import { log } from './lib/log.js';
import { loadState, saveState, accountKey } from './lib/store.js';
import { ingestReport, checkWindowReset, evaluateStartRequest, recordStartResult } from './lib/detector.js';
import { dispatch } from './lib/notify.js';

const MAX_BODY_BYTES = 64 * 1024;
const RESET_CHECK_INTERVAL_MS = 30_000;

/**
 * Event types a client may publish directly through POST /notify.
 *
 * Deliberately an allowlist rather than "anything with a template": the window
 * events are the detector's to decide, and a leaked relay token should not be
 * able to fake a reset. These are the ones only the client can know about.
 */
const CLIENT_EVENT_TYPES = new Set(['turn_done', 'turn_failed', 'test']);

const detectorOptions = {
  onWindowStart: config.notify.onWindowStart,
  onWindowReset: config.notify.onWindowReset,
  onSourceError: config.notify.onSourceError,
  thresholds: config.notify.thresholds,
  sourceErrorCooldownMinutes: config.notify.sourceErrorCooldownMinutes,
  resetGraceMinutes: config.resetGraceMinutes,
  freshWindowMinutes: config.freshWindowMinutes,
  onStartOk: config.notify.onStartOk,
  onStartFailed: config.notify.onStartFailed,
  pendingStartTtlMinutes: config.start.pendingTtlMinutes,
};

function isAuthorized(req, expected) {
  if (!expected) return false;

  const header = req.headers.authorization ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
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

/**
 * Asks the window-starter service to send one prompt. This server never holds
 * a Claude credential itself - it only knows a loopback address and a token,
 * so a compromise here cannot be turned into access to the account.
 */
async function callStarter() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.start.starterTimeoutMs);

  try {
    const response = await fetch(`${config.start.starterUrl}/ping`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.start.starterToken}` },
      signal: controller.signal,
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
      return { ok: false, error: String(payload.error ?? `starter returned HTTP ${response.status}`) };
    }
    return { ok: true, usage: payload.usage };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: reason === 'This operation was aborted' ? 'starter timed out' : reason };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Which account a start request applies to. One install reports one account
 * today, so the single tracked account is the unambiguous answer; the explicit
 * fallback keeps the behaviour defined for a state file that is still empty.
 */
function startAccountKey(state) {
  const keys = Object.keys(state.accounts);
  return keys.length === 1 ? keys[0] : accountKey('claude', 'default');
}

async function handleStart() {
  // The scheduled start fires the moment a window expires, which can beat the
  // periodic reset check to it - and then the phone is told the new window
  // opened before it is told the old one closed. Settling any due reset first
  // keeps the two in the order they actually happened.
  runResetCheck();

  const state = loadState();
  const key = startAccountKey(state);
  const existing = state.accounts[key];

  const decision = evaluateStartRequest({
    accountState: existing,
    options: detectorOptions,
    now: Date.now(),
  });

  // Nothing to do is a success, not an error: the caller asked for a window to
  // be open and one is. This is what makes the cron and the phone button safe
  // to press in any order, or twice.
  if (!decision.allowed) {
    log.info('start request declined', { account: key, reason: decision.reason });
    return {
      status: 200,
      payload: {
        ok: true,
        started: false,
        reason: decision.reason,
        ...(decision.resets_at ? { resets_at: decision.resets_at } : {}),
        ...(decision.requested_at ? { requested_at: decision.requested_at } : {}),
      },
    };
  }

  const ping = await callStarter();
  const { state: nextAccount, events } = recordStartResult({
    accountState: existing,
    report: { provider: 'claude', account: 'default' },
    ok: ping.ok,
    error: ping.error,
    options: detectorOptions,
    now: Date.now(),
  });

  state.accounts[key] = nextAccount;
  saveState(state);

  log[ping.ok ? 'info' : 'error']('start request finished', {
    account: key,
    ok: ping.ok,
    ...(ping.ok ? { usage: ping.usage } : { error: ping.error }),
  });
  dispatchInBackground(events);

  return {
    status: ping.ok ? 200 : 502,
    payload: ping.ok ? { ok: true, started: true, usage: ping.usage } : { ok: false, error: ping.error },
  };
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

  if (req.method === 'POST' && url.pathname === '/start') {
    req.resume(); // the notification button posts a body we have no use for

    if (!startConfigured) {
      json(res, 503, { ok: false, error: 'start is not configured' });
      return;
    }
    if (!isAuthorized(req, config.start.token)) {
      json(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }

    const { status, payload } = await handleStart();
    json(res, status, payload);
    return;
  }

  if (!isAuthorized(req, config.relayToken)) {
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

  /**
   * Notifications the client decides on by itself - today, a Claude Code turn
   * that ran long enough to be worth a push, or one that died on an API error.
   * The client decides *whether*; the message is still composed here, so the
   * language and timezone settings keep applying.
   */
  if (req.method === 'POST' && url.pathname === '/notify') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      json(res, 400, { ok: false, error: error instanceof Error ? error.message : 'bad request' });
      return;
    }

    if (!body || typeof body !== 'object' || !CLIENT_EVENT_TYPES.has(body.type)) {
      json(res, 400, { ok: false, error: 'type must be one of: ' + [...CLIENT_EVENT_TYPES].join(', ') });
      return;
    }

    log.info('client notification', { type: body.type, device: body.device });
    dispatchInBackground([body]);

    // Accepted, not delivered: the push happens after this response, so the
    // hook on the other end never waits for ntfy.
    json(res, 202, { ok: true, type: body.type });
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
      start: startConfigured ? 'enabled' : 'disabled',
    });
  });

  runResetCheck();
  setInterval(runResetCheck, RESET_CHECK_INTERVAL_MS);
}

main().catch((error) => {
  log.error('failed to start', { message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
