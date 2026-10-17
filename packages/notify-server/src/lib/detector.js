/**
 * All of the "did something notification-worthy happen" logic lives here as
 * pure functions: state in, new state plus events out. No I/O, no clock of its
 * own - which is what makes it straightforward to test and to reason about.
 */

const FIVE_HOUR_WINDOW_MINUTES = 300;

function minutesBetween(laterMs, earlierMs) {
  return (laterMs - earlierMs) / 60_000;
}

function emptyAccount(report) {
  return {
    provider: report.provider ?? 'claude',
    account: report.account ?? 'default',
    windows: {},
    devices: {},
    tracking: null,
    pending_start: null,
    source_error: null,
  };
}

/**
 * Fold a freshly received report into an account's state.
 *
 * The interesting transition is the 5-hour window's `resets_at` changing:
 * that timestamp *is* the window's identity, so a new value means a new
 * window opened - which is exactly the moment worth waking someone's phone.
 */
export function ingestReport({ accountState, report, options, now = Date.now() }) {
  const state = accountState ? structuredClone(accountState) : emptyAccount(report);
  const events = [];

  const fiveHour = report.windows?.five_hour ?? null;
  const nowIso = new Date(now).toISOString();

  state.windows = report.windows ?? {};
  state.updated_at = nowIso;
  state.collected_at = report.collected_at ?? nowIso;
  state.source = report.source ?? 'unknown';

  if (report.device) {
    state.devices[report.device] = {
      last_seen_at: nowIso,
      source: report.source ?? 'unknown',
    };
  }

  // The agent can tell us it lost access to usage data (for example if an
  // upstream response shape changed). Surface that instead of quietly serving
  // stale numbers forever.
  if (report.error) {
    const lastNotified = state.source_error?.notified_at
      ? new Date(state.source_error.notified_at).getTime()
      : 0;
    const cooledDown =
      !Number.isFinite(lastNotified) ||
      minutesBetween(now, lastNotified) >= options.sourceErrorCooldownMinutes;

    state.source_error = {
      message: String(report.error.message ?? report.error),
      at: nowIso,
      notified_at: state.source_error?.notified_at ?? null,
    };

    if (options.onSourceError && cooledDown) {
      state.source_error.notified_at = nowIso;
      events.push({
        type: 'source_error',
        device: report.device,
        message: state.source_error.message,
      });
    }
  } else if (state.source_error) {
    state.source_error = null;
  }

  if (!fiveHour?.resets_at) return { state, events };

  const previous = state.tracking;
  const isNewWindow = previous?.window_id !== fiveHour.resets_at;

  if (isNewWindow) {
    const resetsAtMs = new Date(fiveHour.resets_at).getTime();
    const minutesLeft = minutesBetween(resetsAtMs, now);

    // A window we opened ourselves arrives here for the first time with a real
    // `resets_at`. That is the moment the pending start becomes a fact, and
    // also proof that the window is genuinely new - so announce it even though
    // we may never have seen this account before.
    const confirmsPendingStart = Boolean(state.pending_start);
    if (confirmsPendingStart) state.pending_start = null;

    // With no previous window we cannot tell whether this one just opened or
    // has been running for hours, so only announce it if it still has almost
    // its full length ahead of it.
    const looksJustOpened = minutesLeft > FIVE_HOUR_WINDOW_MINUTES - options.freshWindowMinutes;
    const announce = options.onWindowStart && (previous || confirmsPendingStart ? true : looksJustOpened);

    state.tracking = {
      window_id: fiveHour.resets_at,
      first_seen_at: nowIso,
      start_notified_at: announce ? nowIso : null,
      reset_notified_at: null,
      thresholds_notified: [],
    };

    if (announce) {
      events.push({
        type: 'window_start',
        device: report.device,
        resets_at: fiveHour.resets_at,
        used_percentage: fiveHour.used_percentage,
      });
    }
  }

  const tracking = state.tracking;
  const used = fiveHour.used_percentage;

  if (typeof used === 'number') {
    for (const threshold of options.thresholds) {
      if (used >= threshold && !tracking.thresholds_notified.includes(threshold)) {
        tracking.thresholds_notified.push(threshold);
        events.push({
          type: 'threshold',
          threshold,
          device: report.device,
          used_percentage: used,
          resets_at: tracking.window_id,
        });
      }
    }
  }

  return { state, events };
}

/**
 * Fires from the server's own clock rather than from an incoming report, so
 * the "your limit is fresh again" alert still arrives while every one of your
 * machines is switched off. That is the whole reason this runs on a server.
 */
export function checkWindowReset({ accountState, options, now = Date.now() }) {
  const tracking = accountState?.tracking;
  if (!tracking?.window_id || tracking.reset_notified_at) {
    return { state: accountState, events: [] };
  }

  const resetsAtMs = new Date(tracking.window_id).getTime();
  if (!Number.isFinite(resetsAtMs) || now < resetsAtMs) {
    return { state: accountState, events: [] };
  }

  const state = structuredClone(accountState);
  state.tracking.reset_notified_at = new Date(now).toISOString();

  // If we were offline when the window expired, announcing it hours later is
  // noise - mark it handled and stay quiet.
  const lateByMinutes = minutesBetween(now, resetsAtMs);
  const withinGrace = lateByMinutes <= options.resetGraceMinutes;

  const events =
    options.onWindowReset && withinGrace
      ? [
          {
            type: 'window_reset',
            resets_at: tracking.window_id,
            used_percentage: state.windows?.five_hour?.used_percentage ?? null,
          },
        ]
      : [];

  return { state, events };
}

/**
 * Decides whether a start request should actually reach the CLI.
 *
 * Two things make a ping pointless, and both are worth catching here rather
 * than burning quota to discover them:
 *
 * - a window is already open, so nothing would be started;
 * - we pinged moments ago and no report has confirmed it yet. Until a status
 *   line tells us the new `resets_at`, the server genuinely cannot tell the
 *   difference between "our ping worked" and "nothing happened", so a second
 *   tap on the notification would otherwise fire a second, wasted ping.
 */
export function evaluateStartRequest({ accountState, options, now = Date.now() }) {
  const windowId = accountState?.tracking?.window_id;

  if (windowId) {
    const resetsAtMs = new Date(windowId).getTime();
    if (Number.isFinite(resetsAtMs) && now < resetsAtMs) {
      return { allowed: false, reason: 'window_active', resets_at: windowId };
    }
  }

  const requestedAt = accountState?.pending_start?.requested_at;
  if (requestedAt) {
    const ageMinutes = minutesBetween(now, new Date(requestedAt).getTime());
    if (Number.isFinite(ageMinutes) && ageMinutes >= 0 && ageMinutes < options.pendingStartTtlMinutes) {
      return { allowed: false, reason: 'start_pending', requested_at: requestedAt };
    }
  }

  return { allowed: true };
}

/**
 * Records the outcome of a ping.
 *
 * On success the window is deliberately left in a "pending" state rather than
 * guessed at: `resets_at` lands on a rounded boundary that `now + 5h` does not
 * reproduce, and since that timestamp is the window's identity, a guess would
 * later be contradicted by the first real report and announced as a second,
 * phantom window. So we record only what we know - that a window was opened -
 * and let the next status line fill in when it ends.
 */
export function recordStartResult({ accountState, report, ok, error, options, now = Date.now() }) {
  const state = accountState ? structuredClone(accountState) : emptyAccount(report ?? {});
  const nowIso = new Date(now).toISOString();

  if (!ok) {
    // A failed ping leaves nothing pending: the next request should try again
    // rather than wait out a TTL for something that never happened.
    state.pending_start = null;
    state.updated_at = nowIso;

    return {
      state,
      events: options.onStartFailed ? [{ type: 'start_failed', message: String(error ?? 'unknown error') }] : [],
    };
  }

  state.pending_start = { requested_at: nowIso, source: 'starter' };
  state.updated_at = nowIso;

  return {
    state,
    events: options.onStartOk ? [{ type: 'start_ok', requested_at: nowIso }] : [],
  };
}
