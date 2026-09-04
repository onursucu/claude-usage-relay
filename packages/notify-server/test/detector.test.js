import test from 'node:test';
import assert from 'node:assert/strict';

import { ingestReport, checkWindowReset } from '../src/lib/detector.js';

const OPTIONS = {
  onWindowStart: true,
  onWindowReset: true,
  onSourceError: true,
  thresholds: [80, 95],
  sourceErrorCooldownMinutes: 180,
  resetGraceMinutes: 30,
  freshWindowMinutes: 10,
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
