import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Which Claude account is signed in.
 *
 * The status line payload does not say. It carries the window numbers but no
 * identity at all, so without this the server files every account's windows
 * under one key - and the moment you switch accounts you stop being told when
 * the previous one's limit comes back, which is the one thing this project
 * exists to tell you.
 *
 * Note what is *not* read here: `~/.claude/.credentials.json` is never opened.
 * `~/.claude.json` is Claude Code's own config file, and the `accountUuid` in
 * it is an opaque identifier rather than a secret - which is all the server
 * needs to keep two accounts apart. The no-credentials rule still holds.
 */

/** Claude Code's config accumulates history; refuse to parse an absurd one. */
const MAX_CONFIG_BYTES = 8 * 1024 * 1024;

function configPath() {
  // An explicit path exists so the tests can point this somewhere harmless.
  if (process.env.CLAUDE_ACCOUNT_FILE) return process.env.CLAUDE_ACCOUNT_FILE;
  if (process.env.CLAUDE_CONFIG_DIR) return path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json');
  return path.join(os.homedir(), '.claude.json');
}

export function detectAccount() {
  try {
    const file = configPath();
    if (fs.statSync(file).size > MAX_CONFIG_BYTES) return null;

    const uuid = JSON.parse(fs.readFileSync(file, 'utf8'))?.oauthAccount?.accountUuid;
    if (typeof uuid !== 'string') return null;

    // Eight hex characters tell two accounts apart as surely as thirty-six do,
    // and keep the server's state keys and logs readable.
    const short = uuid.replace(/[^0-9a-f]/gi, '').slice(0, 8).toLowerCase();
    return short.length === 8 ? short : null;
  } catch {
    // Signed out, config moved, unreadable, malformed - 'default' still works,
    // it just cannot tell two accounts apart. Never throw from here.
    return null;
  }
}
