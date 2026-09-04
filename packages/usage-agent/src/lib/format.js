// Escape character built from its code point so this source file stays free
// of raw control characters (they are easy to mangle when editing).
const ESC = String.fromCharCode(27);

const ANSI = {
  reset: `${ESC}[0m`,
  dim: `${ESC}[2m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  red: `${ESC}[31m`,
};

const colorsEnabled = !process.env.NO_COLOR;

function paint(text, color) {
  if (!colorsEnabled || !color) return text;
  return `${ANSI[color]}${text}${ANSI.reset}`;
}

function severityColor(percentage) {
  if (percentage >= 90) return 'red';
  if (percentage >= 70) return 'yellow';
  return 'green';
}

/** "2h 14m" / "47m" / "now" - short enough to sit in a status line. */
export function formatRemaining(fromIso, now = Date.now()) {
  if (!fromIso) return null;

  const target = new Date(fromIso).getTime();
  if (Number.isNaN(target)) return null;

  const remainingMs = target - now;
  if (remainingMs <= 0) return 'now';

  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** Clock time of the reset, in the viewer's own timezone. */
export function formatClock(iso, timeZone) {
  if (!iso) return null;

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

function bar(percentage, width = 10) {
  const filled = Math.max(0, Math.min(width, Math.round((percentage / 100) * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/**
 * The status line itself - this is the "widget" half of the project. It has to
 * survive missing data without ever looking broken, because Claude Code shows
 * whatever this prints, on every render.
 */
export function renderWidget(report, { warning = null } = {}) {
  const fiveHour = report?.windows?.five_hour;
  const sevenDay = report?.windows?.seven_day;
  const segments = [];

  if (typeof fiveHour?.used_percentage === 'number') {
    const pct = Math.floor(fiveHour.used_percentage);
    const color = severityColor(pct);
    const remaining = formatRemaining(fiveHour.resets_at);

    let segment = `5h ${paint(bar(pct), color)} ${paint(`${pct}%`, color)}`;
    if (remaining) segment += ` ${paint(`↻ ${remaining}`, 'dim')}`;
    segments.push(segment);
  } else {
    segments.push(paint('5h —', 'dim'));
  }

  if (typeof sevenDay?.used_percentage === 'number') {
    const pct = Math.floor(sevenDay.used_percentage);
    segments.push(`7d ${paint(`${pct}%`, severityColor(pct))}`);
  }

  if (warning) segments.push(paint(`⚠ ${warning}`, 'yellow'));

  return segments.join(paint(' │ ', 'dim'));
}
