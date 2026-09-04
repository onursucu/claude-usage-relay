import { config } from './config.js';

const WINDOW_KEYS = ['five_hour', 'seven_day', 'spend_limit'];

/**
 * Claude Code hands the statusline a Unix timestamp in seconds; everything
 * downstream of here speaks ISO-8601 so the wire format stays readable and
 * timezone-proof.
 */
function toIso(epochSeconds) {
  if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds)) return null;
  const date = new Date(epochSeconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeWindow(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const used = Number(raw.used_percentage);
  return {
    used_percentage: Number.isFinite(used) ? used : null,
    resets_at: toIso(raw.resets_at),
  };
}

/**
 * Turn Claude Code's statusline payload into the report shape this project
 * speaks everywhere (see docs/PROTOCOL.md). Keeping this translation in one
 * small function is deliberate: if Claude Code ever reshapes its statusline
 * JSON, this is the only file that needs to change.
 */
export function buildReport(statuslineInput, { source = 'statusline' } = {}) {
  const rateLimits = statuslineInput?.rate_limits ?? {};

  const windows = {};
  for (const key of WINDOW_KEYS) {
    const normalized = normalizeWindow(rateLimits[key]);
    if (normalized) windows[key] = normalized;
  }

  const report = {
    schema_version: 1,
    provider: 'claude',
    account: config.account,
    device: config.device,
    source,
    collected_at: new Date().toISOString(),
    windows,
  };

  const costUsd = Number(statuslineInput?.cost?.total_cost_usd);
  const model = statuslineInput?.model?.display_name ?? statuslineInput?.model?.id;
  if (Number.isFinite(costUsd) || model) {
    report.session = {
      ...(Number.isFinite(costUsd) ? { cost_usd: costUsd } : {}),
      ...(model ? { model } : {}),
    };
  }

  return report;
}

/**
 * True when the payload carries no usable window data. Claude Code only fills
 * `rate_limits` for Pro/Max accounts, and only after the first API response of
 * a session, so an empty payload early in a session is expected, not an error.
 */
export function isEmptyReport(report) {
  return Object.values(report.windows).every((w) => w.used_percentage === null && w.resets_at === null)
    || Object.keys(report.windows).length === 0;
}
