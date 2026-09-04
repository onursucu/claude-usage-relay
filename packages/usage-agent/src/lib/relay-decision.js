import { config } from './config.js';

/**
 * Claude Code re-renders the status line constantly, so the interesting
 * question is not "did we get data" but "is this worth telling the server".
 *
 * A changed window (a new `resets_at`) is the event this whole project exists
 * for, so that always goes out immediately. Everything else is rate-limited.
 */
export function shouldRelay(report, state, now = Date.now()) {
  const current = report?.windows?.five_hour;
  if (!current) return { relay: false, reason: 'no-window-data' };

  const lastSent = state.last_relayed_window ?? null;

  if (current.resets_at && current.resets_at !== lastSent?.resets_at) {
    return { relay: true, reason: 'window-changed' };
  }

  const lastAt = state.last_relay_at ? new Date(state.last_relay_at).getTime() : 0;
  const elapsedSeconds = (now - lastAt) / 1000;

  if (!Number.isFinite(lastAt) || lastAt === 0) {
    return { relay: true, reason: 'first-report' };
  }

  const previousPct = lastSent?.used_percentage;
  const currentPct = current.used_percentage;
  const movedEnough =
    typeof previousPct === 'number' &&
    typeof currentPct === 'number' &&
    Math.abs(currentPct - previousPct) >= config.relayMinDelta;

  if (movedEnough && elapsedSeconds >= 15) {
    return { relay: true, reason: 'usage-moved' };
  }

  if (elapsedSeconds >= config.relayMinIntervalSeconds) {
    return { relay: true, reason: 'heartbeat' };
  }

  return { relay: false, reason: 'throttled' };
}
