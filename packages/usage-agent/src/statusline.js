#!/usr/bin/env node
/**
 * Claude Code status line command.
 *
 * Claude Code runs this on every render and shows whatever it prints, so two
 * rules drive the design here:
 *   1. Always print something, never throw. A broken status line is worse than
 *      a status line that says "no data yet".
 *   2. Never block. The relay is handed to a detached child process; this
 *      script's only job is to render and record.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { config, relayEnabled, PACKAGE_ROOT } from './lib/config.js';
import { readState, writeState } from './lib/state.js';
import { buildReport, isEmptyReport } from './lib/normalize.js';
import { renderWidget } from './lib/format.js';
import { shouldRelay } from './lib/relay-decision.js';

const STDIN_TIMEOUT_MS = 2000;
const RELAY_WARNING_AFTER_MS = 30 * 60 * 1000;

/**
 * Keep this shorter than the relay's drain window (12s): a running relay picks
 * up anything queued while it holds the lock, so overlapping spawns cost
 * nothing and the two windows together leave no gap where a queued report
 * could sit undelivered.
 */
const RELAY_SPAWN_COOLDOWN_MS = 8000;

const DATA_DIR = path.dirname(config.statePath);
const PENDING_PATH = path.join(DATA_DIR, 'pending.json');

/**
 * Read the whole payload, but give up quickly: if we are ever run outside
 * Claude Code (a user testing the command by hand, say) there may be no stdin
 * at all, and hanging would freeze the status line.
 */
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }

    let data = '';
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(data);
    };

    const timer = setTimeout(finish, STDIN_TIMEOUT_MS);
    timer.unref?.();

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

function relayWarning(state) {
  if (!relayEnabled || !state.last_relay_error) return null;

  const failedAt = new Date(state.last_relay_error.at ?? 0).getTime();
  if (!Number.isFinite(failedAt)) return null;

  const succeededAt = state.last_relay_at ? new Date(state.last_relay_at).getTime() : 0;
  if (succeededAt > failedAt) return null;

  return Date.now() - failedAt < RELAY_WARNING_AFTER_MS ? 'relay' : null;
}

function queueRelay(report, state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Only the newest reading matters: usage is a current value, not an event
  // stream, so a single pending file replaces any queue.
  const tmp = `${PENDING_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, PENDING_PATH);

  const lastSpawn = state.last_relay_spawn_at ? new Date(state.last_relay_spawn_at).getTime() : 0;
  if (Date.now() - lastSpawn < RELAY_SPAWN_COOLDOWN_MS) return false;

  const relayScript = path.join(PACKAGE_ROOT, 'src', 'relay.js');
  const child = spawn(process.execPath, [relayScript], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  return true;
}

async function main() {
  const raw = await readStdin();

  let input = {};
  try {
    input = raw ? JSON.parse(raw) : {};
  } catch {
    input = {};
  }

  // Escape hatch for inspecting exactly what Claude Code sends us.
  if (process.env.STATUSLINE_DUMP_PATH && raw) {
    try {
      fs.mkdirSync(path.dirname(process.env.STATUSLINE_DUMP_PATH), { recursive: true });
      fs.writeFileSync(process.env.STATUSLINE_DUMP_PATH, raw, 'utf8');
    } catch {
      // never let debugging break the status line
    }
  }

  const report = buildReport(input);
  const state = readState(config.statePath);

  process.stdout.write(`${renderWidget(report, { warning: relayWarning(state) })}\n`);

  if (isEmptyReport(report)) return; // nothing worth recording or sending yet

  const nextState = { ...state, last_report: report, last_seen_at: report.collected_at };

  if (relayEnabled) {
    const decision = shouldRelay(report, state);
    if (decision.relay) {
      const spawned = queueRelay(report, state);
      nextState.last_relay_reason = decision.reason;
      if (spawned) nextState.last_relay_spawn_at = new Date().toISOString();
    }
  }

  writeState(config.statePath, nextState);
}

main().catch(() => {
  // Last line of defence: still give Claude Code something to render.
  process.stdout.write('5h —\n');
});
