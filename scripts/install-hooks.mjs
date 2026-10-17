#!/usr/bin/env node
/**
 * Registers the turn notifier in Claude Code's hook settings.
 *
 * Three events, one script (packages/usage-agent/src/hooks/turn-notify.js):
 *
 *   UserPromptSubmit   stamps when a turn started
 *   Stop               the turn ended - push if it ran past the threshold
 *   StopFailure        the turn died on an API error (a rate limit, say)
 *   Notification       Claude is waiting on you, during a job you left running
 *
 * Every entry is registered with "async": true, so Claude Code never waits for
 * the hook - the notification goes out while you carry on working.
 *
 * As conservative as the status line installer: it backs the settings file up,
 * shows you the change first, and merges with hooks you already have instead
 * of replacing them.
 *
 *   node scripts/install-hooks.mjs            # show what would change
 *   node scripts/install-hooks.mjs --apply    # write it
 *   node scripts/install-hooks.mjs --revert   # restore the last backup
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const HOOK = path.join(REPO_ROOT, 'packages', 'usage-agent', 'src', 'hooks', 'turn-notify.js');

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const SETTINGS = path.join(CONFIG_DIR, 'settings.json');
const BACKUP = path.join(CONFIG_DIR, 'settings.json.hooks-backup');

const COMMAND = `node "${HOOK}"`;
const ENTRY = { type: 'command', command: COMMAND, async: true };

/**
 * Which groups we want on each event. Notification is the only one that needs
 * matchers: it fires for a dozen kinds of notification and we want exactly the
 * two that mean "Claude has stopped and needs you". `idle_prompt` is pointedly
 * absent - it fires about a minute after Claude finished, so subscribing to it
 * would double up on the turn_done push.
 */
const PLAN = {
  UserPromptSubmit: [{ hooks: [ENTRY] }],
  Stop: [{ hooks: [ENTRY] }],
  StopFailure: [{ hooks: [ENTRY] }],
  Notification: [
    { matcher: 'permission_prompt', hooks: [ENTRY] },
    { matcher: 'agent_needs_input', hooks: [ENTRY] },
  ],
};

const EVENTS = Object.keys(PLAN);

const apply = process.argv.includes('--apply');
const revert = process.argv.includes('--revert');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`${file} is not valid JSON: ${error.message}`);
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

if (revert) {
  const backup = readJson(BACKUP);
  if (!backup) {
    console.error(`No backup found at ${BACKUP}`);
    process.exit(1);
  }
  writeJson(SETTINGS, backup);
  console.log(`Restored ${SETTINGS} from the backup.`);
  process.exit(0);
}

const settings = readJson(SETTINGS) ?? {};
const hooks = settings.hooks ?? {};

/** Drops our own entries so re-running is idempotent, and keeps everyone else's. */
function withoutOurs(groups) {
  return (Array.isArray(groups) ? groups : [])
    .map((group) => ({
      ...group,
      hooks: (Array.isArray(group?.hooks) ? group.hooks : []).filter((hook) => hook?.command !== COMMAND),
    }))
    .filter((group) => group.hooks.length > 0);
}

const nextHooks = { ...hooks };
for (const event of EVENTS) {
  nextHooks[event] = [...withoutOurs(hooks[event]), ...PLAN[event]];
}

const next = { ...settings, hooks: nextHooks };

console.log(`Claude Code settings: ${SETTINGS}`);
console.log(`Hook command:         ${COMMAND}`);
console.log(`Events:               ${EVENTS.join(', ')}\n`);

if (JSON.stringify(settings.hooks ?? {}) === JSON.stringify(nextHooks)) {
  console.log('Already installed - nothing to do.');
  process.exit(0);
}

const kept = EVENTS.flatMap((event) => withoutOurs(hooks[event]).map((group) => ({ event, group })));
if (kept.length > 0) {
  console.log('You already have hooks on these events. They are kept, ours is added alongside:\n');
  for (const { event, group } of kept) {
    for (const hook of group.hooks) console.log(`  ${event}: ${hook.command ?? hook.type}`);
  }
  console.log('');
}

if (!apply) {
  console.log('Dry run. This is what would be written:\n');
  console.log(JSON.stringify({ hooks: nextHooks }, null, 2));
  console.log('\nRe-run with --apply to write it.');
  process.exit(0);
}

fs.mkdirSync(CONFIG_DIR, { recursive: true });
if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, BACKUP);
writeJson(SETTINGS, next);

console.log('Installed. Sessions already running usually pick this up on their');
console.log('next turn; if nothing arrives, open a new one.');
if (fs.existsSync(BACKUP)) console.log(`Previous settings: ${BACKUP}`);
