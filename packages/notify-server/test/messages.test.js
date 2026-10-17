import test from 'node:test';
import assert from 'node:assert/strict';

// Set before the import: config.js reads the environment at module load, and
// its .env loader leaves anything already present alone.
process.env.NOTIFY_LANGUAGE = 'en';
process.env.START_ACTION_URL = 'https://example.invalid/start';
process.env.START_TOKEN = 'start-token';
process.env.DASHBOARD_URL = 'https://example.invalid/';

const { composeNotification } = await import('../src/lib/messages.js');

const labels = (event) => composeNotification(event).actions.map((action) => action.action);

test('a five-hour reset offers to open a window', () => {
  const notification = composeNotification({ type: 'window_reset', window: 'five_hour', used_percentage: 70 });
  const start = notification.actions.find((action) => action.action === 'http');

  assert.ok(start, 'the reset is the moment you can start working again');
  assert.equal(start.url, 'https://example.invalid/start');
  assert.equal(start.headers.Authorization, 'Bearer start-token');
});

test('a weekly reset does not, because a week is not something you start', () => {
  assert.deepEqual(labels({ type: 'window_reset', window: 'seven_day', used_percentage: 88 }), ['view']);
});

test('quota alerts link to the dashboard', () => {
  for (const type of ['window_start', 'window_reset', 'threshold', 'source_error']) {
    assert.ok(labels({ type, window: 'five_hour', threshold: 80, used_percentage: 81, message: 'x' }).includes('view'), type);
  }
});

test('turn notifications carry no buttons at all', () => {
  for (const type of ['turn_done', 'turn_failed', 'turn_waiting']) {
    assert.deepEqual(labels({ type, duration_seconds: 120, error: 'rate_limit', reason: 'permission_prompt' }), [], type);
  }
});

test('no notification carries more buttons than ntfy accepts', () => {
  for (const type of ['window_reset', 'start_failed', 'threshold', 'window_start', 'turn_done']) {
    assert.ok(composeNotification({ type, window: 'five_hour', message: 'x', threshold: 95, used_percentage: 96 }).actions.length <= 3, type);
  }
});

test('the account is named in the title only once there is another to confuse it with', () => {
  const alone = composeNotification({ type: 'window_reset', window: 'five_hour', used_percentage: 70 });
  const named = composeNotification({ type: 'window_reset', window: 'five_hour', used_percentage: 70, account_label: 'Work' });

  assert.ok(!alone.title.includes('·') || !alone.title.endsWith('Work'));
  assert.ok(named.title.endsWith('· Work'));
});
