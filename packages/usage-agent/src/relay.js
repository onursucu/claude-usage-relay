#!/usr/bin/env node
/**
 * Sends pending usage reports to the notify-server.
 *
 * Runs as a short-lived detached process spawned by the status line, so it can
 * take its time (network timeouts, retries) without ever making Claude Code's
 * status line feel slow.
 *
 * It does not just send once and exit: it keeps draining for a short while.
 * The status line queues a report and only spawns a relay occasionally, so
 * whoever holds the lock is responsible for anything queued behind it -
 * otherwise a report queued right before you quit Claude Code would never be
 * delivered.
 */
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { config, relayEnabled } from './lib/config.js';
import { readState, writeState } from './lib/state.js';

const DATA_DIR = path.dirname(config.statePath);
const PENDING_PATH = path.join(DATA_DIR, 'pending.json');
const LOCK_PATH = path.join(DATA_DIR, 'relay.lock');

const LOCK_STALE_MS = 60_000;
const DRAIN_WINDOW_MS = 12_000;
const DRAIN_POLL_MS = 1500;
const MAX_FAILURES = 3;

/**
 * Cheap single-flight guard. Several status line renders can decide to relay
 * at nearly the same moment; only one of them should actually send.
 */
function acquireLock() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LOCK_PATH, String(Date.now()), { flag: 'wx' });
    return true;
  } catch {
    try {
      const heldSince = Number(fs.readFileSync(LOCK_PATH, 'utf8'));
      if (Number.isFinite(heldSince) && Date.now() - heldSince < LOCK_STALE_MS) return false;
      fs.writeFileSync(LOCK_PATH, String(Date.now()));
      return true;
    } catch {
      return false;
    }
  }
}

function releaseLock() {
  try {
    fs.unlinkSync(LOCK_PATH);
  } catch {
    // nothing to release
  }
}

function takePending() {
  try {
    return JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function recordSuccess(report) {
  const state = readState(config.statePath);
  writeState(config.statePath, {
    ...state,
    last_relay_at: new Date().toISOString(),
    last_relayed_window: report.windows?.five_hour ?? null,
    last_relay_error: null,
  });
}

function recordFailure(message) {
  const state = readState(config.statePath);
  writeState(config.statePath, {
    ...state,
    last_relay_error: { at: new Date().toISOString(), message },
  });
}

async function send(report) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  try {
    const response = await fetch(`${config.relayUrl}/report`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.relayToken}`,
      },
      body: JSON.stringify(report),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status} ${body.slice(0, 200)}`.trim());
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function drain() {
  const deadline = Date.now() + DRAIN_WINDOW_MS;
  let failures = 0;

  for (;;) {
    const report = takePending();

    if (report) {
      try {
        await send(report);
        // Only drop the file once it is safely delivered; a newer render may
        // have overwritten it in the meantime, and that is fine - the next
        // pass picks the fresher copy up.
        try {
          fs.unlinkSync(PENDING_PATH);
        } catch {
          // already replaced or removed
        }
        recordSuccess(report);
      } catch (error) {
        failures += 1;
        recordFailure(error instanceof Error ? error.message : String(error));
        if (failures >= MAX_FAILURES) return; // leave it queued for the next spawn
      }
    }

    if (Date.now() >= deadline) return;
    await sleep(DRAIN_POLL_MS);
  }
}

async function main() {
  if (!relayEnabled) return;
  if (!acquireLock()) return;

  try {
    await drain();
  } finally {
    releaseLock();
  }
}

main().catch((error) => {
  recordFailure(error instanceof Error ? error.message : String(error));
  releaseLock();
});
