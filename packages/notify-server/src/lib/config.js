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
    /**
     * Per window, because they fill at completely different speeds. The
     * five-hour window can go from nothing to spent inside an afternoon, so a
     * warning is only useful late. The weekly one creeps, and by the time it
     * reads 80% on a Thursday the week is already decided - hence the earlier
     * first warning.
     */
    thresholds: {
      five_hour: list(process.env.USAGE_THRESHOLDS, [80, 95]),
      seven_day: list(process.env.USAGE_THRESHOLDS_SEVEN_DAY, [50, 80, 95]),
    },
    sourceErrorCooldownMinutes: num(process.env.SOURCE_ERROR_COOLDOWN_MINUTES, 180),
    language: str(process.env.NOTIFY_LANGUAGE, 'en').toLowerCase(),
    onStartOk: bool(process.env.NOTIFY_ON_START_OK, true),
    onStartFailed: bool(process.env.NOTIFY_ON_START_FAILED, true),
  },

  /**
   * Opening a window on request. The credential that can actually do it lives
   * in the window-starter service, not here - this server only knows a
   * loopback URL and a token for it, so compromising the public-facing
   * process does not hand anyone a Claude credential.
   */
  start: {
    token: str(process.env.START_TOKEN),
    starterUrl: str(process.env.STARTER_URL, 'http://127.0.0.1:8788').replace(/\/+$/, ''),
    starterToken: str(process.env.STARTER_TOKEN),
    starterTimeoutMs: num(process.env.STARTER_TIMEOUT_SECONDS, 150) * 1000,

    /** Public URL the phone's notification button posts to. */
    actionUrl: str(process.env.START_ACTION_URL),

    /**
     * How long a successful ping keeps blocking further starts while we wait
     * for a status line to confirm the new window.
     *
     * This is the window's own length, not a short retry delay. A ping that
     * succeeded opened a window, and nothing can be gained by opening one
     * again before it expires - but the server stays blind until someone
     * actually runs Claude Code, and that gap is routinely longer than a few
     * minutes. At 15 minutes a scheduled 08:30 start that was not confirmed
     * until 09:06 fired a second, useless ping at 08:50.
     *
     * Retrying a *failed* ping does not depend on this: a failure clears
     * pending_start immediately, so the next request tries again.
     */
    pendingTtlMinutes: num(process.env.PENDING_START_TTL_MINUTES, 300),
  },

  displayTimeZone: str(process.env.DISPLAY_TIMEZONE) || undefined,
  logLevel: str(process.env.LOG_LEVEL, 'info'),

  /**
   * How late a reset notification may still be sent. If the server was down
   * when a window expired, firing the alert hours later is noise, so anything
   * older than this is marked handled without notifying.
   */
  resetGraceMinutes: {
    five_hour: num(process.env.RESET_GRACE_MINUTES, 30),

    /**
     * A longer leash for the weekly window. Half an hour is the right limit
     * for "your five hours are back" because the news goes stale fast; being
     * told a couple of hours late that your week turned over is still useful.
     */
    seven_day: num(process.env.RESET_GRACE_MINUTES_SEVEN_DAY, 180),
  },

  /**
   * A brand new account is adopted silently unless its window looks like it
   * only just opened - otherwise starting the server mid-window would greet
   * you with a bogus "new window started".
   */
  freshWindowMinutes: num(process.env.FRESH_WINDOW_MINUTES, 10),
};

export const notificationsConfigured = Boolean(config.ntfy.topic);

/** /start stays switched off until both halves of the link are configured. */
export const startConfigured = Boolean(config.start.token && config.start.starterToken);
