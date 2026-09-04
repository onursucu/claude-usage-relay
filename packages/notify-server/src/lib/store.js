import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const STATE_FILE = path.join(config.dataDir, 'state.json');
const EMPTY_STATE = { version: 1, accounts: {} };

let cache = null;

export function loadState() {
  if (cache) return cache;

  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    cache = { ...EMPTY_STATE, ...parsed, accounts: parsed.accounts ?? {} };
  } catch {
    cache = structuredClone(EMPTY_STATE);
  }
  return cache;
}

export function saveState(state) {
  cache = state;

  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

/** Accounts are tracked per provider so Codex and friends can join later. */
export function accountKey(provider, account) {
  return `${provider || 'claude'}:${account || 'default'}`;
}
