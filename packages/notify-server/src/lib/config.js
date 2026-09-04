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

function bool(value, fallback) {
  const trimmed = (value ?? '').trim().toLowerCase();
  if (trimmed === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(trimmed);
}

function list(value, fallback) {
  const trimmed = (value ?? '').trim();
  if (trimmed === '') return fallback;

  return trimmed
    .split(',')
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((entry) => Number.isFinite(entry) && entry > 0 && entry <= 100)
    .sort((a, b) => a - b);
}

export const config = {
  port: num(process.env.PORT, 8787),
  host: str(process.env.HOST, '127.0.0.1'),
  relayToken: str(process.env.RELAY_TOKEN),

  dataDir: str(process.env.DATA_DIR, path.join(PACKAGE_ROOT, 'data')),

  ntfy: {
    url: str(process.env.NTFY_URL, 'https://ntfy.sh').replace(/\/+$/, ''),
    topic: str(process.env.NTFY_TOPIC),
    token: str(process.env.NTFY_TOKEN),
  },

  notify: {
    onWindowStart: bool(process.env.NOTIFY_ON_WINDOW_START, true),
    onWindowReset: bool(process.env.NOTIFY_ON_WINDOW_RESET, true),
    onSourceError: bool(process.env.NOTIFY_ON_SOURCE_ERROR, true),
    thresholds: list(process.env.USAGE_THRESHOLDS, [80, 95]),
    sourceErrorCooldownMinutes: num(process.env.SOURCE_ERROR_COOLDOWN_MINUTES, 180),
    language: str(process.env.NOTIFY_LANGUAGE, 'en').toLowerCase(),
  },

  displayTimeZone: str(process.env.DISPLAY_TIMEZONE) || undefined,
  logLevel: str(process.env.LOG_LEVEL, 'info'),

  /**
   * How late a reset notification may still be sent. If the server was down
   * when a window expired, firing the alert hours later is noise, so anything
   * older than this is marked handled without notifying.
   */
  resetGraceMinutes: num(process.env.RESET_GRACE_MINUTES, 30),

  /**
   * A brand new account is adopted silently unless its window looks like it
   * only just opened - otherwise starting the server mid-window would greet
   * you with a bogus "new window started".
   */
  freshWindowMinutes: num(process.env.FRESH_WINDOW_MINUTES, 10),
};

export const notificationsConfigured = Boolean(config.ntfy.topic);
