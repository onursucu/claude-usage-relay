import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './env.js';

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

export const config = {
  relayUrl: str(process.env.RELAY_URL).replace(/\/+$/, ''),
  relayToken: str(process.env.RELAY_TOKEN),

  device: str(process.env.DEVICE_NAME, os.hostname()),
  account: str(process.env.ACCOUNT_LABEL, 'default'),

  statePath: str(process.env.LOCAL_STATE_PATH, path.join(PACKAGE_ROOT, 'data', 'state.json')),

  /**
   * The statusline is re-rendered constantly, but the numbers behind it barely
   * move. These two knobs keep us from hammering the relay: we send when the
   * usage window itself changes, when utilization moved enough to matter, or
   * when this much time has passed - whichever comes first.
   */
  relayMinIntervalSeconds: num(process.env.RELAY_MIN_INTERVAL_SECONDS, 120),
  relayMinDelta: num(process.env.RELAY_MIN_DELTA, 1),

  requestTimeoutMs: num(process.env.RELAY_TIMEOUT_MS, 8000),
  logLevel: str(process.env.LOG_LEVEL, 'info'),
};

export const relayEnabled = Boolean(config.relayUrl && config.relayToken);
