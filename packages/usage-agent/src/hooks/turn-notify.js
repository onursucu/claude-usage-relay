#!/usr/bin/env node
/**
 * Pushes a notification when a long Claude Code turn ends.
 *
 * The usage relay answers "when does my limit come back". This answers the
 * other question you have while away from the desk: "is that hour-long job
 * done yet". Same server, same phone, same ntfy topic.
 *
 * Installed as three hooks by `scripts/install-hooks.mjs`:
 *
 *   UserPromptSubmit   stamps when the turn started
 *   Stop               the turn ended - push if it ran long enough to matter
 *   StopFailure        the turn died on an API error - always worth knowing
 *   Notification       Claude is waiting on you, and you are not at the desk
 *
 * All three are registered with `"async": true`, so Claude Code starts this
 * process and carries on without waiting: a slow or unreachable server can
 * never make the editor feel stuck. For the same reason nothing is written to
 * stdout - an async hook's stdout is parsed as a JSON response and handed back
 * to Claude on the next turn, which is not what we want from a notifier.
 *
 * The split of responsibility matches the rest of the project: the hook is the
 * only place that knows how long the turn took, so it decides *whether* to
 * notify; the server still decides *what the message says*.
 */
import fs from 'node:fs';
import path from 'node:path';

import { config, relayEnabled } from '../lib/config.js';

const DATA_DIR = path.dirname(config.statePath);
const MARK_DIR = path.join(DATA_DIR, 'turns');
const STATUS_PATH = path.join(DATA_DIR, 'turn-notify.json');

/** A turn abandoned mid-flight (terminal closed) would leave its mark forever. */
const MARK_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STDIN_TIMEOUT_MS = 5000;
const SUMMARY_MAX_CHARS = 220;

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }

    let data = '';
    let timer;
    const done = () => {
      clearTimeout(timer);
      resolve(data);
    };

    // Nothing enforces a timeout on an async hook, so this process has to make
    // sure it can never linger on a stdin that never closes.
    timer = setTimeout(done, STDIN_TIMEOUT_MS);

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

function markPath(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  return path.join(MARK_DIR, `${safe}.json`);
}

/** Returns null when there is no mark - the hook was installed mid-session. */
function readMark(sessionId) {
  try {
    const mark = JSON.parse(fs.readFileSync(markPath(sessionId), 'utf8'));
    return mark && typeof mark === 'object' ? mark : null;
  } catch {
    return null;
  }
}

function writeMark(sessionId, mark) {
  try {
    fs.mkdirSync(MARK_DIR, { recursive: true });
    fs.writeFileSync(markPath(sessionId), JSON.stringify(mark));
  } catch {
    // A mark we failed to write costs one notification, nothing more.
  }
}

function markStart(sessionId, startedAt) {
  writeMark(sessionId, { started_at: startedAt });
}

function readStart(sessionId) {
  const startedAt = readMark(sessionId)?.started_at;
  return Number.isFinite(startedAt) ? startedAt : null;
}

function clearStart(sessionId) {
  try {
    fs.unlinkSync(markPath(sessionId));
  } catch {
    // already gone
  }
}

function pruneMarks(now) {
  let entries;
  try {
    entries = fs.readdirSync(MARK_DIR);
  } catch {
    return;
  }

  for (const entry of entries) {
    const file = path.join(MARK_DIR, entry);
    try {
      if (now - fs.statSync(file).mtimeMs > MARK_MAX_AGE_MS) fs.unlinkSync(file);
    } catch {
      // raced with another session, fine either way
    }
  }
}

/**
 * A phone notification full of fenced code is unreadable, and only the first
 * couple of lines ever fit on a lock screen anyway.
 */
function summarize(text) {
  if (typeof text !== 'string') return '';

  const flat = text
    .replace(/```[\s\S]*?```/g, ' […] ')
    .replace(/\s+/g, ' ')
    .trim();

  if (flat.length <= SUMMARY_MAX_CHARS) return flat;
  return `${flat.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…`;
}

function record(patch) {
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8'));
  } catch {
    // first run
  }

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATUS_PATH, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`, 'utf8');
  } catch {
    // losing the breadcrumb must never break the hook
  }
}

async function post(event) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  try {
    const response = await fetch(`${config.relayUrl}/notify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.relayToken}`,
      },
      body: JSON.stringify(event),
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

async function deliver(event) {
  if (!relayEnabled) return;

  try {
    await post(event);
    record({ last_sent_at: new Date().toISOString(), last_type: event.type, last_error: null });
  } catch (error) {
    record({
      last_error: {
        at: new Date().toISOString(),
        type: event.type,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

/**
 * Claude is waiting on you. The installer only subscribes to the notification
 * types that mean that - a permission prompt, or an agent asking for input -
 * and deliberately not to `idle_prompt`, which fires about a minute after
 * Claude *finished* and would duplicate the turn_done push.
 *
 * Two gates keep this quiet. A turn younger than the threshold means you are
 * almost certainly still at the keyboard, watching the prompt that just
 * appeared; and a cooldown stops a job that stalls for an hour from buzzing
 * every six seconds.
 */
async function handleWaiting(input, { now, project }) {
  if (!config.turnNotify.onWaiting) return;

  const kind = input.notification_type;
  if (kind && kind !== 'permission_prompt' && kind !== 'agent_needs_input') return;

  const sessionId = input.session_id;
  const mark = readMark(sessionId);
  const startedAt = mark?.started_at;
  // Without a mark there is no way to tell a job you walked away from apart
  // from one you are sitting in front of, so say nothing.
  if (!Number.isFinite(startedAt)) return;

  const runningSeconds = Math.round((now - startedAt) / 1000);
  if (runningSeconds < config.turnNotify.waitingAfterSeconds) return;

  const notifiedAt = mark?.waiting_notified_at;
  if (Number.isFinite(notifiedAt) && (now - notifiedAt) / 1000 < config.turnNotify.waitingCooldownSeconds) {
    return;
  }

  writeMark(sessionId, { ...mark, waiting_notified_at: now });

  await deliver({
    type: 'turn_waiting',
    device: config.device,
    account: config.account,
    project,
    duration_seconds: runningSeconds,
    reason: typeof kind === 'string' ? kind : 'unknown',
    detail: summarize(input.message),
  });
}

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return; // not a hook payload
  }
  if (!input || typeof input !== 'object') return;

  const now = Date.now();
  const sessionId = input.session_id;
  const project = typeof input.cwd === 'string' && input.cwd ? path.basename(input.cwd) : '';

  if (input.hook_event_name === 'UserPromptSubmit') {
    markStart(sessionId, now);
    pruneMarks(now);
    return;
  }

  if (input.hook_event_name === 'Notification') {
    await handleWaiting(input, { now, project });
    return;
  }

  if (input.hook_event_name !== 'Stop' && input.hook_event_name !== 'StopFailure') return;

  const startedAt = readStart(sessionId);
  const durationSeconds = startedAt === null ? null : Math.round((now - startedAt) / 1000);

  if (input.hook_event_name === 'StopFailure') {
    // The mark is deliberately left in place: Claude Code may recover and
    // finish the same turn, and that Stop should still know when it began.
    if (!config.turnNotify.onFailure) return;

    await deliver({
      type: 'turn_failed',
      device: config.device,
      account: config.account,
      project,
      duration_seconds: durationSeconds,
      error: typeof input.error === 'string' ? input.error : 'unknown',
      detail: summarize(input.error_details ?? input.last_assistant_message),
    });
    return;
  }

  clearStart(sessionId);

  if (!config.turnNotify.enabled) return;
  // No mark means we cannot tell a one-liner from an hour of work. Staying
  // quiet is the right call: every alternative notifies on short turns.
  if (durationSeconds === null || durationSeconds < config.turnNotify.minSeconds) return;

  await deliver({
    type: 'turn_done',
    device: config.device,
    account: config.account,
    project,
    duration_seconds: durationSeconds,
    summary: summarize(input.last_assistant_message),
  });
}

main().catch(() => {
  // A notifier must never be the reason a session misbehaves.
});
