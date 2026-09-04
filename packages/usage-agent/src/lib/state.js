import fs from 'node:fs';
import path from 'node:path';

/**
 * The agent's local memory: what we last saw and what we last relayed.
 * Written atomically because the statusline can run several times a second
 * and a half-written file would break the next render.
 */
export function readState(statePath) {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return {};
  }
}

export function writeState(statePath, state) {
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true });

  const tmp = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, statePath);
}
