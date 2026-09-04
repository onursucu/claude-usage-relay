import { config } from '../config.js';

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Publishes through ntfy's JSON API rather than its header-based one: titles
 * and messages here contain non-ASCII text, which does not survive HTTP
 * headers reliably.
 */
export async function sendNtfy({ title, message, priority = 3, tags = [] }) {
  if (!config.ntfy.topic) {
    return { sent: false, reason: 'ntfy topic not configured' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(config.ntfy.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.ntfy.token ? { authorization: `Bearer ${config.ntfy.token}` } : {}),
      },
      body: JSON.stringify({
        topic: config.ntfy.topic,
        title,
        message,
        priority,
        tags,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { sent: false, reason: `HTTP ${response.status} ${body.slice(0, 200)}`.trim() };
    }

    return { sent: true };
  } catch (error) {
    return { sent: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}
