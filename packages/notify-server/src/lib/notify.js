import { composeNotification } from './messages.js';
import { sendNtfy } from './notifiers/ntfy.js';
import { log } from './log.js';

/**
 * One place that turns detector events into delivered notifications. Adding a
 * second channel later (Telegram, e-mail, a webhook) means adding a transport
 * to this list - nothing else in the server needs to know.
 */
const TRANSPORTS = [{ name: 'ntfy', send: sendNtfy }];

export async function dispatch(events) {
  const results = [];

  for (const event of events) {
    const notification = composeNotification(event);
    if (!notification) {
      log.warn('no message template for event', { type: event.type });
      continue;
    }

    for (const transport of TRANSPORTS) {
      const result = await transport.send(notification);

      if (result.sent) {
        log.info('notification sent', { via: transport.name, type: event.type, title: notification.title });
      } else {
        log.warn('notification failed', { via: transport.name, type: event.type, reason: result.reason });
      }

      results.push({ event: event.type, transport: transport.name, ...result });
    }
  }

  return results;
}
