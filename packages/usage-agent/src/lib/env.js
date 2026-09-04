import fs from 'node:fs';

/**
 * Minimal .env loader. We deliberately avoid a dependency here: this file is
 * imported by the statusline script, which Claude Code runs on every render,
 * so startup cost matters and a zero-dependency install is a feature.
 *
 * Existing process.env values always win, so you can override anything from
 * the shell or from a service definition.
 */
export function loadEnvFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return false; // no .env is a valid setup - everything has defaults
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
