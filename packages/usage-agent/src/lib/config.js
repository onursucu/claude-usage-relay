import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './env.js';
import { detectAccount } from './account.js';

export const PACKAGE_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');

loadEnvFile(path.join(PACKAGE_ROOT, '.env'));

function num(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(value, fallback = '') {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? fallback : trimmed;
}

function bool(value, fallback) {
  const trimmed = (value ?? '').trim().toLowerCase();
  if (trimmed === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(trimmed);
}

export const config = {
  relayUrl: str(process.env.RELAY_URL).replace(/\/+$/, ''),
  relayToken: str(process.env.RELAY_TOKEN),

  device: str(process.env.DEVICE_NAME, os.hostname()),
  /**
   * Which account the numbers belong to. The server keys its state by this, so
   * it is what keeps two accounts' windows from overwriting each other when
   * you switch. Detected from the signed-in account; ACCOUNT_LABEL overrides
   * it when you would rather give an account a name of your own.
   */
  account: str(process.env.ACCOUNT_LABEL) || detectAccount() || 'default',

  statePath: str(process.env.LOCAL_STATE_PATH, path.join(PACKAGE_ROOT, 'data', 'state.json')),

  /**
   * The statusline is re-rendered constantly, but the numbers behind it barely
   * move. These two knobs keep us from hammering the relay: we send when the
   * usage window itself changes, when utilization moved enough to matter, or
   * when this much time has passed - whichever comes first.
   */
  relayMinIntervalSeconds: num(process.env.RELAY_MIN_INTERVAL_SECONDS, 120),
  relayMinDelta: num(process.env.RELAY_MIN_DELTA, 1),

  /**
   * Settings for the turn notifier (src/hooks/turn-notify.js). It is installed
   * separately from the status line, and can be switched off here without
   * touching ~/.claude/settings.json.
   */
  turnNotify: {
    enabled: bool(process.env.NOTIFY_ON_TURN_DONE, true),
    onFailure: bool(process.env.NOTIFY_ON_TURN_FAILURE, true),

    /**
     * The Stop hook fires at the end of every turn, and most turns are short.
     * Only a turn that outlasted this earns a push: the point is to hear about
     * the long job you walked away from, not about every answer.
     */
    minSeconds: num(process.env.NOTIFY_MIN_TURN_SECONDS, 300),
  },

  requestTimeoutMs: num(process.env.RELAY_TIMEOUT_MS, 8000),
  logLevel: str(process.env.LOG_LEVEL, 'info'),
};

export const relayEnabled = Boolean(config.relayUrl && config.relayToken);
