import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ingestReport,
  checkWindowReset,
  evaluateStartRequest,
  recordStartResult,
} from '../src/lib/detector.js';

const OPTIONS = {
  onWindowStart: true,
  onWindowReset: true,
  onSourceError: true,
  thresholds: [80, 95],
  sourceErrorCooldownMinutes: 180,
  resetGraceMinutes: 30,
  freshWindowMinutes: 10,
  onStartOk: true,
  onStartFailed: true,
  pendingStartTtlMinutes: 300,
};

const NOW = Date.parse('2026-09-04T12:00:00.000Z');
const minutes = (count) => count * 60_000;

function report(overrides = {}) {
  const { five_hour: fiveHour, ...rest } = overrides;
  return {
    schema_version: 1,
    provider: 'claude',
    account: 'default',
    device: 'desktop',
    source: 'statusline',
    collected_at: new Date(NOW).toISOString(),
    windows: {
      five_hour: {
        used_percentage: 5,
        resets_at: new Date(NOW + minutes(298)).toISOString(),
        ...fiveHour,
      },
    },
    ...rest,
  };
}

test('a first sighting of a fresh window is announced', () => {
  const { state, events } = ingestReport({ accountState: null, report: report(), options: OPTIONS, now: NOW });

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'window_start');
  assert.equal(state.tracking.window_id, report().windows.five_hour.resets_at);
});

test('a first sighting of a window already underway is adopted silently', () => {
  const midWindow = report({ five_hour: { used_percentage: 60, resets_at: new Date(NOW + minutes(90)).toISOString() } });

  const { state, events } = ingestReport({ accountState: null, report: midWindow, options: OPTIONS, now: NOW });

  assert.deepEqual(events.map((event) => event.type), []);
  assert.equal(state.tracking.start_notified_at, null);
  assert.equal(state.tracking.window_id, midWindow.windows.five_hour.resets_at);
});

test('a changed resets_at is treated as a new window', () => {
  const first = ingestReport({ accountState: null, report: report(), options: OPTIONS, now: NOW });

  const later = NOW + minutes(310);
  const second = ingestReport({
    accountState: first.state,
    report: report({
      collected_at: new Date(later).toISOString(),
      five_hour: { used_percentage: 2, resets_at: new Date(later + minutes(299)).toISOString() },
    }),
    options: OPTIONS,
    now: later,
  });

  assert.deepEqual(second.events.map((event) => event.type), ['window_start']);
});

test('repeated reports inside the same window stay quiet', () => {
  const first = ingestReport({ accountState: null, report: report(), options: OPTIONS, now: NOW });

  const second = ingestReport({
    accountState: first.state,
    report: report({ five_hour: { used_percentage: 12 } }),
    options: OPTIONS,
    now: NOW + minutes(20),
  });

  assert.deepEqual(second.events, []);
});

test('each threshold fires once per window', () => {
  const base = ingestReport({ accountState: null, report: report(), options: OPTIONS, now: NOW });

  const crossed = ingestReport({
    accountState: base.state,
    report: report({ five_hour: { used_percentage: 83 } }),
    options: OPTIONS,
    now: NOW + minutes(60),
  });
  assert.deepEqual(crossed.events.map((event) => event.type), ['threshold']);
  assert.equal(crossed.events[0].threshold, 80);

  const again = ingestReport({
    accountState: crossed.state,
    report: report({ five_hour: { used_percentage: 88 } }),
    options: OPTIONS,
    now: NOW + minutes(70),
  });
  assert.deepEqual(again.events, []);

  const higher = ingestReport({
    accountState: again.state,
    report: report({ five_hour: { used_percentage: 96 } }),
    options: OPTIONS,
    now: NOW + minutes(80),
  });
  assert.deepEqual(higher.events.map((event) => event.threshold), [95]);
});

test('the reset fires from the clock alone, once', () => {
  const { state } = ingestReport({ accountState: null, report: report(), options: OPTIONS, now: NOW });
  const resetMoment = Date.parse(state.tracking.window_id) + minutes(1);

  const first = checkWindowReset({ accountState: state, options: OPTIONS, now: resetMoment });
  assert.deepEqual(first.events.map((event) => event.type), ['window_reset']);

  const second = checkWindowReset({ accountState: first.state, options: OPTIONS, now: resetMoment + minutes(1) });
  assert.deepEqual(second.events, []);
});

test('a reset missed by hours is marked handled without notifying', () => {
  const { state } = ingestReport({ accountState: null, report: report(), options: OPTIONS, now: NOW });
  const wayLate = Date.parse(state.tracking.window_id) + minutes(300);

  const result = checkWindowReset({ accountState: state, options: OPTIONS, now: wayLate });

  assert.deepEqual(result.events, []);
  assert.ok(result.state.tracking.reset_notified_at);
});

test('a window that has not expired yet produces nothing', () => {
  const { state } = ingestReport({ accountState: null, report: report(), options: OPTIONS, now: NOW });

  const result = checkWindowReset({ accountState: state, options: OPTIONS, now: NOW + minutes(60) });

  assert.deepEqual(result.events, []);
  assert.equal(result.state, state);
});

test('source errors notify once, then respect the cooldown', () => {
  const failing = report({ error: { message: 'usage endpoint returned 404' } });

  const first = ingestReport({ accountState: null, report: failing, options: OPTIONS, now: NOW });
  assert.ok(first.events.some((event) => event.type === 'source_error'));

  const second = ingestReport({
    accountState: first.state,
    report: failing,
    options: OPTIONS,
    now: NOW + minutes(30),
  });
  assert.ok(!second.events.some((event) => event.type === 'source_error'));

  const third = ingestReport({
    accountState: second.state,
    report: failing,
    options: OPTIONS,
    now: NOW + minutes(200),
  });
  assert.ok(third.events.some((event) => event.type === 'source_error'));
});

test('recovering from an error clears it', () => {
  const failed = ingestReport({
    accountState: null,
    report: report({ error: { message: 'boom' } }),
    options: OPTIONS,
    now: NOW,
  });

  const recovered = ingestReport({
    accountState: failed.state,
    report: report(),
    options: OPTIONS,
    now: NOW + minutes(5),
  });

  assert.equal(recovered.state.source_error, null);
});

test('devices are tracked separately while the account state stays shared', () => {
  const first = ingestReport({ accountState: null, report: report(), options: OPTIONS, now: NOW });

  const second = ingestReport({
    accountState: first.state,
    report: report({ device: 'laptop', collected_at: new Date(NOW + minutes(5)).toISOString() }),
    options: OPTIONS,
    now: NOW + minutes(5),
  });

  assert.deepEqual(Object.keys(second.state.devices).sort(), ['desktop', 'laptop']);
  assert.deepEqual(second.events, []); // same window seen from another machine
});

// --- opening a window on request -------------------------------------------

const trackingFor = (resetsAtMs) => ({
  window_id: new Date(resetsAtMs).toISOString(),
  first_seen_at: new Date(NOW).toISOString(),
  start_notified_at: new Date(NOW).toISOString(),
  reset_notified_at: null,
  thresholds_notified: [],
});

test('a start is refused while a window is still open', () => {
  const accountState = { tracking: trackingFor(NOW + minutes(120)) };
  const decision = evaluateStartRequest({ accountState, options: OPTIONS, now: NOW });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'window_active');
  assert.equal(decision.resets_at, accountState.tracking.window_id);
});

test('a start is allowed once the window has expired', () => {
  const accountState = { tracking: trackingFor(NOW - minutes(1)) };
  const decision = evaluateStartRequest({ accountState, options: OPTIONS, now: NOW });

  assert.equal(decision.allowed, true);
});

test('a second start is refused while the first is still unconfirmed', () => {
  const accountState = {
    tracking: trackingFor(NOW - minutes(60)),
    pending_start: { requested_at: new Date(NOW - minutes(5)).toISOString() },
  };

  const decision = evaluateStartRequest({ accountState, options: OPTIONS, now: NOW });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'start_pending');
});

test('a start that was never confirmed stops blocking once it ages out', () => {
  const accountState = {
    tracking: trackingFor(NOW - minutes(60)),
    pending_start: { requested_at: new Date(NOW - minutes(301)).toISOString() },
  };

  const decision = evaluateStartRequest({ accountState, options: OPTIONS, now: NOW });
  assert.equal(decision.allowed, true);
});

// Regression: a scheduled start at 08:30 was not confirmed until 09:06,
// because nobody ran Claude Code in between and the server has no other way to
// see the window. A short TTL expired in that gap and fired a second, useless
// ping at 08:50. A successful ping means a window is open - the only thing
// that should unblock another one is that window ending.
test('an unconfirmed start keeps blocking for as long as the window it opened', () => {
  const started = recordStartResult({ accountState: null, ok: true, options: OPTIONS, now: NOW });

  for (const elapsed of [10, 20, 36, 120, 290]) {
    const decision = evaluateStartRequest({
      accountState: started.state,
      options: OPTIONS,
      now: NOW + minutes(elapsed),
    });
    assert.equal(decision.allowed, false, `a start ${elapsed} minutes in must still be refused`);
    assert.equal(decision.reason, 'start_pending');
  }
});

test('a successful start is recorded as pending, not as a guessed window', () => {
  const { state, events } = recordStartResult({
    accountState: null,
    ok: true,
    options: OPTIONS,
    now: NOW,
  });

  assert.equal(state.pending_start.requested_at, new Date(NOW).toISOString());
  assert.equal(state.tracking, null, 'resets_at must come from a real report, never from a guess');
  assert.deepEqual(
    events.map((event) => event.type),
    ['start_ok'],
  );
});

test('a failed start notifies and leaves nothing pending, so it can be retried', () => {
  const accountState = { pending_start: { requested_at: new Date(NOW - minutes(1)).toISOString() } };
  const { state, events } = recordStartResult({
    accountState,
    ok: false,
    error: 'invalid credential',
    options: OPTIONS,
    now: NOW,
  });

  assert.equal(state.pending_start, null);
  assert.equal(events[0].type, 'start_failed');
  assert.match(events[0].message, /invalid credential/);

  const decision = evaluateStartRequest({ accountState: state, options: OPTIONS, now: NOW });
  assert.equal(decision.allowed, true);
});

test('the first report after a start confirms it and announces the real window', () => {
  const started = recordStartResult({ accountState: null, ok: true, options: OPTIONS, now: NOW });

  // Arrives ten minutes later, and the window ends on a rounded boundary that
  // `now + 5h` would never have produced - which is why nothing was guessed.
  const later = NOW + minutes(10);
  const { state, events } = ingestReport({
    accountState: started.state,
    report: report({ five_hour: { resets_at: new Date(NOW + minutes(290)).toISOString() } }),
    options: OPTIONS,
    now: later,
  });

  assert.equal(state.pending_start, null, 'the pending start is settled by the real report');
  assert.equal(state.tracking.window_id, new Date(NOW + minutes(290)).toISOString());
  assert.deepEqual(
    events.map((event) => event.type),
    ['window_start'],
  );
});

test('an unrelated mid-window account is still adopted silently', () => {
  const { state, events } = ingestReport({
    accountState: null,
    report: report({ five_hour: { resets_at: new Date(NOW + minutes(120)).toISOString() } }),
    options: OPTIONS,
    now: NOW,
  });

  assert.equal(state.tracking.start_notified_at, null);
  assert.deepEqual(events, []);
});
