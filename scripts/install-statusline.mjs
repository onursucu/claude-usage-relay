#!/usr/bin/env node
/**
 * Points Claude Code's `statusLine` at this repo's agent.
 *
 * Deliberately conservative: it backs the settings file up, shows you the
 * change, and refuses to silently discard a status line you already have.
 *
 *   node scripts/install-statusline.mjs            # show what would change
 *   node scripts/install-statusline.mjs --apply    # write it
 *   node scripts/install-statusline.mjs --revert   # restore the last backup
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const STATUSLINE = path.join(REPO_ROOT, 'packages', 'usage-agent', 'src', 'statusline.js');

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const SETTINGS = path.join(CONFIG_DIR, 'settings.json');
const BACKUP = path.join(CONFIG_DIR, 'settings.json.statusline-backup');

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
const command = `node "${STATUSLINE}"`;
const current = settings.statusLine;

console.log(`Claude Code settings: ${SETTINGS}`);
console.log(`Status line command:  ${command}\n`);

if (current?.command === command) {
  console.log('Already installed - nothing to do.');
  process.exit(0);
}

if (current?.command) {
  console.log('You already have a status line configured:\n');
  console.log(`  ${current.command}\n`);
  console.log(`It will be saved to ${BACKUP} and can be restored with --revert.\n`);
}

const next = { ...settings, statusLine: { type: 'command', command } };

if (!apply) {
  console.log('Dry run. This is what would be written:\n');
  console.log(JSON.stringify({ statusLine: next.statusLine }, null, 2));
  console.log('\nRe-run with --apply to write it.');
  process.exit(0);
}

if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, BACKUP);
fs.mkdirSync(CONFIG_DIR, { recursive: true });
writeJson(SETTINGS, next);

console.log('Installed. Restart Claude Code (or open a new session) to see it.');
if (fs.existsSync(BACKUP)) console.log(`Previous settings: ${BACKUP}`);
