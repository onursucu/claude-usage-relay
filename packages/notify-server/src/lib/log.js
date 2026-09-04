import { config } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function emit(level, message, extra) {
  if (LEVELS[level] < threshold) return;

  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;

  stream.write(extra === undefined ? `${line}\n` : `${line} ${JSON.stringify(extra)}\n`);
}

export const log = {
  debug: (message, extra) => emit('debug', message, extra),
  info: (message, extra) => emit('info', message, extra),
  warn: (message, extra) => emit('warn', message, extra),
  error: (message, extra) => emit('error', message, extra),
};
