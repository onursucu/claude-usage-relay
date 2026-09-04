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

const RELAY_TOKEN = 'e2e-token-0000000000';
const NTFY_PORT = 8899;
const SERVER_PORT = 8788;

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
    DATA_DIR: path.join(WORK_DIR, 'server'),
    NTFY_URL: `http://127.0.0.1:${NTFY_PORT}`,
    NTFY_TOPIC: 'e2e',
    NOTIFY_LANGUAGE: 'en',
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
check('server tracks the window', account?.tracking?.window_id === new Date(freshReset * 1000).toISOString());
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

// 6. the basics
check('unauthorized request rejected', (await fetch(`http://127.0.0.1:${SERVER_PORT}/state`)).status === 401);
check('health endpoint is open', (await fetch(`http://127.0.0.1:${SERVER_PORT}/health`)).status === 200);

const empty = await runStatusline({});
check('empty payload still renders', empty.code === 0 && empty.out.trim().length > 0, JSON.stringify(empty.out));

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
