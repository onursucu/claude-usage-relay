import fs from 'node:fs';

/**
 * Minimal .env loader, intentionally duplicated from the agent package so the
 * two halves of this project stay independently installable - you can deploy
 * this server without ever cloning the agent, and vice versa.
 *
 * Existing process.env values always win.
 */
export function loadEnvFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return false;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    if (!key || key in process.env) continue;

    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
  return true;
}
