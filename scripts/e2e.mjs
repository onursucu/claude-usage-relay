#!/usr/bin/env node
/**
 * End-to-end check of the real chain: status line -> relay -> notify-server ->
 * notification. ntfy is replaced by a local mock so the run stays offline and
 * nobody's phone buzzes; everything else is the actual code.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-relay-e2e-'));

/**
 * Account detection reads whoever is signed in on this machine, which would
 * make the run depend on the developer's own account. Pointing it at a file
 * that does not exist pins every check below to the 'default' fallback; the
 * account checks opt back in explicitly.
 */
const NO_ACCOUNT = path.join(WORK_DIR, 'no-account.json');

const RELAY_TOKEN = 'e2e-token-0000000000';
const DASHBOARD_TOKEN = 'e2e-dashboard-token-00';

/**
 * Deliberately odd ports. This suite is meant to be runnable on the very host
 * that runs the real thing, and 8787/8788 are taken there - 8788 by the
 * window-starter, which this would otherwise fight for the socket and knock
 * over. A test that can take down a production service is a bad test.
 */
const NTFY_PORT = 18899;
const SERVER_PORT = 18788;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '  ok' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`);
};

// --- a stand-in for ntfy ---------------------------------------------------
const pushed = [];
const mockNtfy = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    try { pushed.push(JSON.parse(body)); } catch { pushed.push({ raw: body }); }
    res.writeHead(200).end('{"id":"mock"}');
  });
});
await new Promise((resolve) => mockNtfy.listen(NTFY_PORT, '127.0.0.1', resolve));

// --- the real server -------------------------------------------------------
const server = spawn(process.execPath, [path.join(REPO_ROOT, 'packages/notify-server/src/index.js')], {
  env: {
    ...process.env,
    PORT: String(SERVER_PORT),
    HOST: '127.0.0.1',
    RELAY_TOKEN,
    DASHBOARD_TOKEN,
    DATA_DIR: path.join(WORK_DIR, 'server'),
    NTFY_URL: `http://127.0.0.1:${NTFY_PORT}`,
    NTFY_TOPIC: 'e2e',
    NOTIFY_LANGUAGE: 'en',
    DASHBOARD_URL: 'https://dashboard.invalid/',
    START_ACTION_URL: 'https://dashboard.invalid/start',
    START_TOKEN: 'e2e-start-token',
    LOG_LEVEL: 'warn',
  },
});
server.stderr.on('data', (data) => process.stderr.write(`[server] ${data}`));

const shutdown = () => {
  server.kill();
  mockNtfy.close();
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
};
process.on('exit', shutdown);

await sleep(800);

// --- the real status line --------------------------------------------------
function runStatusline(rateLimits, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(REPO_ROOT, 'packages/usage-agent/src/statusline.js')], {
      env: {
        ...process.env,
        RELAY_URL: `http://127.0.0.1:${SERVER_PORT}`,
        RELAY_TOKEN,
        DEVICE_NAME: 'e2e-desktop',
        LOCAL_STATE_PATH: path.join(WORK_DIR, 'agent', 'state.json'),
        RELAY_MIN_INTERVAL_SECONDS: '0',
        CLAUDE_ACCOUNT_FILE: NO_ACCOUNT,
        ...extraEnv,
      },
    });

    let out = '';
    child.stdout.on('data', (data) => { out += data; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));

    child.stdin.end(JSON.stringify({
      hook_event_name: 'Status',
      session_id: 'e2e',
      model: { id: 'claude-opus-5', display_name: 'Opus 5' },
      cost: { total_cost_usd: 1.23 },
      rate_limits: rateLimits,
    }));
  });
}

const epoch = (ms) => Math.floor(ms / 1000);
const now = Date.now();
const sevenDay = { used_percentage: 18, resets_at: epoch(now + 3 * 86_400_000) };
const titles = () => JSON.stringify(pushed.map((item) => item.title));

// 1. a freshly opened window
const freshReset = epoch(now + 298 * 60_000);
const first = await runStatusline({ five_hour: { used_percentage: 4, resets_at: freshReset }, seven_day: sevenDay });
check('status line renders a widget', first.out.includes('5h') && first.out.includes('4%'), JSON.stringify(first.out));
check('status line exits cleanly', first.code === 0, `code ${first.code}`);

await sleep(3000);
const state = await (await fetch(`http://127.0.0.1:${SERVER_PORT}/state`, {
  headers: { authorization: `Bearer ${RELAY_TOKEN}` },
})).json();
const account = state.accounts['claude:default'];

check('server stored the report', Boolean(account));
check('server tracks the window', account?.tracking?.five_hour?.window_id === new Date(freshReset * 1000).toISOString());
check('server recorded the device', Boolean(account?.devices?.['e2e-desktop']));
check('new window was announced', pushed.some((item) => item.title?.includes('new 5-hour window')), titles());

// 2. crossing a threshold
pushed.length = 0;
await runStatusline({ five_hour: { used_percentage: 84, resets_at: freshReset }, seven_day: sevenDay });
await sleep(3000);
check('threshold warning pushed', pushed.some((item) => item.title?.includes('80%')), titles());

// 3. the same window again
pushed.length = 0;
await runStatusline({ five_hour: { used_percentage: 85, resets_at: freshReset }, seven_day: sevenDay });
await sleep(3000);
check('same window stays quiet', pushed.length === 0, titles());

// 4. a new window
pushed.length = 0;
await runStatusline({ five_hour: { used_percentage: 3, resets_at: epoch(now + 600 * 60_000) }, seven_day: sevenDay });
await sleep(3000);
check('a new window is announced again', pushed.some((item) => item.title?.includes('new 5-hour window')), titles());

// 5. the reset, fired by the server alone
pushed.length = 0;
await runStatusline(
  { five_hour: { used_percentage: 71, resets_at: epoch(now - 60_000) }, seven_day: sevenDay },
  { ACCOUNT_LABEL: 'expired', LOCAL_STATE_PATH: path.join(WORK_DIR, 'agent2', 'state.json') },
);

let resetPushed = false;
for (let attempt = 0; attempt < 45 && !resetPushed; attempt += 1) {
  await sleep(1000);
  resetPushed = pushed.some((item) => item.title?.includes('limit reset'));
}
check('reset pushed by the server clock alone', resetPushed, titles());

const resetPush = pushed.find((item) => item.title?.includes('limit reset'));
check(
  'the reset carries both buttons onto the wire',
  JSON.stringify((resetPush?.actions ?? []).map((action) => action.action)) === '["http","view"]',
  JSON.stringify(resetPush?.actions),
);

// 6. the weekly window, on its own schedule
pushed.length = 0;
await runStatusline(
  {
    // Mid-window, so the five-hour side is adopted in silence and anything
    // pushed here can only have come from the weekly window.
    five_hour: { used_percentage: 5, resets_at: epoch(now + 100 * 60_000) },
    seven_day: { used_percentage: 57, resets_at: epoch(now + 4 * 86_400_000) },
  },
  { ACCOUNT_LABEL: 'weekly', LOCAL_STATE_PATH: path.join(WORK_DIR, 'agent-weekly', 'state.json') },
);
await sleep(3000);
check('a weekly threshold fires on its own schedule', pushed.some((item) => item.title?.includes('weekly limit used')), titles());
check('a weekly window opening is never announced', pushed.length === 1, titles());
// By now the server tracks several accounts, so every alert has to say which
// one it is about - a bare "limit reset" cannot be acted on with two accounts.
check('an alert names its account once there are several', pushed.every((item) => item.title?.endsWith('· weekly')), titles());

// 7. the basics
check('unauthorized request rejected', (await fetch(`http://127.0.0.1:${SERVER_PORT}/state`)).status === 401);

const page = await fetch(`http://127.0.0.1:${SERVER_PORT}/`);
const pageBody = await page.text();
check('the dashboard page needs no token to load', page.status === 200 && pageBody.includes('<!doctype html'), `status ${page.status}`);
check('the dashboard page carries no secret of its own', !pageBody.includes(RELAY_TOKEN) && !pageBody.includes(DASHBOARD_TOKEN));

const readOnly = await fetch(`http://127.0.0.1:${SERVER_PORT}/state`, {
  headers: { authorization: `Bearer ${DASHBOARD_TOKEN}` },
});
check('the dashboard token can read state', readOnly.status === 200, `status ${readOnly.status}`);

const stateBody = await readOnly.json();
check('state carries what the meters need', Boolean(stateBody.thresholds?.five_hour && stateBody.thresholds?.seven_day && stateBody.language), JSON.stringify(stateBody.thresholds));

// The whole reason for a second token: it must not be able to write.
const forged = await fetch(`http://127.0.0.1:${SERVER_PORT}/report`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${DASHBOARD_TOKEN}` },
  body: JSON.stringify({ provider: 'claude', account: 'forged', windows: { five_hour: { used_percentage: 1, resets_at: new Date().toISOString() } } }),
});
check('the dashboard token cannot write a report', forged.status === 401, `status ${forged.status}`);

const notifyForged = await fetch(`http://127.0.0.1:${SERVER_PORT}/notify`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${DASHBOARD_TOKEN}` },
  body: JSON.stringify({ type: 'test' }),
});
check('the dashboard token cannot push a notification', notifyForged.status === 401, `status ${notifyForged.status}`);
check('health endpoint is open', (await fetch(`http://127.0.0.1:${SERVER_PORT}/health`)).status === 200);

// 8. the turn notifier, driven exactly as Claude Code drives it
const HOOK = path.join(REPO_ROOT, 'packages/usage-agent/src/hooks/turn-notify.js');
const HOOK_DATA = path.join(WORK_DIR, 'hooks', 'state.json');

function runHook(payload, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], {
      env: {
        ...process.env,
        RELAY_URL: `http://127.0.0.1:${SERVER_PORT}`,
        RELAY_TOKEN,
        DEVICE_NAME: 'e2e-desktop',
        LOCAL_STATE_PATH: HOOK_DATA,
        CLAUDE_ACCOUNT_FILE: NO_ACCOUNT,
        ...extraEnv,
      },
    });

    let out = '';
    child.stdout.on('data', (data) => { out += data; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify(payload));
  });
}

const turn = (event, extra = {}) => ({
  hook_event_name: event,
  session_id: 'e2e-session',
  cwd: '/home/e2e/my-project',
  ...extra,
});

pushed.length = 0;
const stopped = await runHook(turn('Stop', { last_assistant_message: 'done' }));
await sleep(800);
check('a turn with no recorded start stays quiet', pushed.length === 0, titles());
check('the hook prints nothing on stdout', stopped.out === '', JSON.stringify(stopped.out));

await runHook(turn('UserPromptSubmit', { prompt: 'go' }));
await runHook(turn('Stop', { last_assistant_message: 'done' }));
await sleep(800);
check('a short turn is below the threshold', pushed.length === 0, titles());

const longAnswer = 'Refactored the parser.\n\n```js\nsecretcode\n```';
await runHook(turn('UserPromptSubmit', { prompt: 'go' }));
await runHook(turn('Stop', { last_assistant_message: longAnswer }), { NOTIFY_MIN_TURN_SECONDS: '0' });
await sleep(800);
const done = pushed.find((item) => item.title?.includes('done after'));
check('a long turn is pushed', Boolean(done), titles());
check('the push names the device and project', done?.message?.includes('e2e-desktop · my-project') === true, JSON.stringify(done?.message));
check('the summary keeps the prose', done?.message?.includes('Refactored the parser.') === true, JSON.stringify(done?.message));
check('the summary drops fenced code', done?.message?.includes('secretcode') === false, JSON.stringify(done?.message));

pushed.length = 0;
await runHook(turn('UserPromptSubmit', { prompt: 'go' }));
await runHook(turn('StopFailure', { error: 'rate_limit', error_details: '429 Too Many Requests' }));
await sleep(800);
check('a failed turn is pushed whatever its length', pushed.some((item) => item.title?.includes('did not finish')), titles());
check('the failure says why', pushed.some((item) => item.message?.includes('usage limit')), JSON.stringify(pushed.map((item) => item.message)));

// A Notification with no turn on record cannot tell "away" from "at the desk".
// Its own session id matters: StopFailure above deliberately leaves its mark.
pushed.length = 0;
await runHook(
  { hook_event_name: 'Notification', session_id: 'e2e-never-prompted', cwd: '/home/e2e/my-project', notification_type: 'permission_prompt', message: 'needs permission' },
  { NOTIFY_WAITING_AFTER_SECONDS: '0' },
);
await sleep(800);
check('waiting with no turn on record stays quiet', pushed.length === 0, titles());

pushed.length = 0;
await runHook(turn('UserPromptSubmit', { prompt: 'go' }));
await runHook(turn('Notification', { notification_type: 'permission_prompt', message: 'needs permission' }));
await sleep(800);
check('waiting on a young turn stays quiet', pushed.length === 0, titles());

pushed.length = 0;

await runHook(
  turn('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission' }),
  { NOTIFY_WAITING_AFTER_SECONDS: '0' },
);
await sleep(800);
const waiting = pushed.find((item) => item.title?.includes('seni bekliyor') || item.title?.includes('waiting on you'));
check('waiting on a long turn is pushed', Boolean(waiting), titles());
check('the waiting push says why', waiting?.message?.includes('permission') === true, JSON.stringify(waiting?.message));

pushed.length = 0;
await runHook(
  turn('Notification', { notification_type: 'permission_prompt', message: 'again' }),
  { NOTIFY_WAITING_AFTER_SECONDS: '0' },
);
await sleep(800);
check('a second waiting push is held back by the cooldown', pushed.length === 0, titles());

await runHook(
  turn('Notification', { notification_type: 'idle_prompt', message: 'idle' }),
  { NOTIFY_WAITING_AFTER_SECONDS: '0', NOTIFY_WAITING_COOLDOWN_SECONDS: '0' },
);
await sleep(800);
check('idle_prompt is ignored, so it cannot double up on turn_done', pushed.length === 0, titles());

const faked = await fetch(`http://127.0.0.1:${SERVER_PORT}/notify`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${RELAY_TOKEN}` },
  body: JSON.stringify({ type: 'window_reset' }),
});
check('/notify refuses to fake a detector event', faked.status === 400, `status ${faked.status}`);

// 9. the account the agent reports under
async function stateNow() {
  const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/state`, {
    headers: { authorization: `Bearer ${RELAY_TOKEN}` },
  });
  return (await response.json()).accounts;
}

const accountFile = path.join(WORK_DIR, 'claude.json');
fs.writeFileSync(accountFile, JSON.stringify({ oauthAccount: { accountUuid: 'ABC12345-dead-beef-0000-111122223333' } }));

const detected = await runStatusline(
  { five_hour: { used_percentage: 2, resets_at: epoch(now + 280 * 60_000) }, seven_day: sevenDay },
  { ACCOUNT_LABEL: '', CLAUDE_ACCOUNT_FILE: accountFile, LOCAL_STATE_PATH: path.join(WORK_DIR, 'agent3', 'state.json') },
);
await sleep(3000);
let accounts = await stateNow();
check('the signed-in account becomes the key', Boolean(accounts['claude:abc12345']), Object.keys(accounts).join(', '));
check('the status line still renders while detecting', detected.code === 0 && detected.out.includes('5h'), JSON.stringify(detected.out));

await runStatusline(
  { five_hour: { used_percentage: 5, resets_at: epoch(now + 275 * 60_000) }, seven_day: sevenDay },
  { ACCOUNT_LABEL: 'by-hand', CLAUDE_ACCOUNT_FILE: accountFile, LOCAL_STATE_PATH: path.join(WORK_DIR, 'agent4', 'state.json') },
);
await sleep(3000);
accounts = await stateNow();
check('an explicit ACCOUNT_LABEL still wins', Boolean(accounts['claude:by-hand']), Object.keys(accounts).join(', '));

const signedOut = await runStatusline(
  { five_hour: { used_percentage: 7, resets_at: epoch(now + 270 * 60_000) }, seven_day: sevenDay },
  { ACCOUNT_LABEL: '', CLAUDE_ACCOUNT_FILE: path.join(WORK_DIR, 'nothing-here.json'), LOCAL_STATE_PATH: path.join(WORK_DIR, 'agent5', 'state.json') },
);
check('a missing config never breaks the status line', signedOut.code === 0 && signedOut.out.includes('5h'), JSON.stringify(signedOut.out));

// 10. a payload with nothing in it
const empty = await runStatusline({});
check('empty payload still renders', empty.code === 0 && empty.out.trim().length > 0, JSON.stringify(empty.out));

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
