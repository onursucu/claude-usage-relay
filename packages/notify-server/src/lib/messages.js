import { config } from './config.js';

function formatClock(iso) {
  if (!iso) return '—';

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';

  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(config.displayTimeZone ? { timeZone: config.displayTimeZone } : {}),
  }).format(date);
}

function formatRemaining(iso, now = Date.now()) {
  if (!iso) return null;

  const target = new Date(iso).getTime();
  if (Number.isNaN(target) || target <= now) return null;

  const totalMinutes = Math.round((target - now) / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) return { hours: 0, minutes, en: `${minutes}m`, tr: `${minutes} dk` };
  if (minutes === 0) return { hours, minutes: 0, en: `${hours}h`, tr: `${hours} saat` };
  return { hours, minutes, en: `${hours}h ${minutes}m`, tr: `${hours} sa ${minutes} dk` };
}

const PACKS = {
  en: {
    window_start(event) {
      const remaining = formatRemaining(event.resets_at);
      const where = event.device ? ` on ${event.device}` : '';
      const until = remaining ? ` (in ${remaining.en})` : '';
      return {
        title: 'Claude · new 5-hour window',
        message: `Window opened${where}. Resets at ${formatClock(event.resets_at)}${until}.`,
      };
    },
    window_reset(event) {
      const used = typeof event.used_percentage === 'number' ? Math.floor(event.used_percentage) : null;
      const tail = used === null ? '' : ` You ended the window at ${used}%.`;
      return {
        title: 'Claude · limit reset',
        message: `Your 5-hour window just reset — full quota again.${tail}`,
      };
    },
    threshold(event) {
      const remaining = formatRemaining(event.resets_at);
      const until = remaining ? ` (in ${remaining.en})` : '';
      return {
        title: `Claude · ${event.threshold}% of the 5-hour window used`,
        message: `Now at ${Math.floor(event.used_percentage)}%. Resets at ${formatClock(event.resets_at)}${until}.`,
      };
    },
    source_error(event) {
      const where = event.device ? `${event.device}: ` : '';
      return {
        title: 'Claude · usage data unavailable',
        message: `${where}${event.message}`,
      };
    },
    test() {
      return {
        title: 'Claude usage relay · test',
        message: 'Notifications are wired up correctly.',
      };
    },
  },

  tr: {
    window_start(event) {
      const remaining = formatRemaining(event.resets_at);
      const where = event.device ? ` (${event.device})` : '';
      const until = remaining ? ` — ${remaining.tr} sonra` : '';
      return {
        title: 'Claude · yeni 5 saatlik periyot',
        message: `Periyot başladı${where}. Sıfırlanma: ${formatClock(event.resets_at)}${until}.`,
      };
    },
    window_reset(event) {
      const used = typeof event.used_percentage === 'number' ? Math.floor(event.used_percentage) : null;
      const tail = used === null ? '' : ` Periyodu %${used} ile kapattın.`;
      return {
        title: 'Claude · limit sıfırlandı',
        message: `5 saatlik periyot doldu, kotan yeniden tam.${tail}`,
      };
    },
    threshold(event) {
      const remaining = formatRemaining(event.resets_at);
      const until = remaining ? ` — ${remaining.tr} sonra` : '';
      return {
        title: `Claude · 5 saatlik kotanın %${event.threshold}'i kullanıldı`,
        message: `Şu an %${Math.floor(event.used_percentage)}. Sıfırlanma: ${formatClock(event.resets_at)}${until}.`,
      };
    },
    source_error(event) {
      const where = event.device ? `${event.device}: ` : '';
      return {
        title: 'Claude · kullanım verisi okunamıyor',
        message: `${where}${event.message}`,
      };
    },
    test() {
      return {
        title: 'Claude usage relay · test',
        message: 'Bildirimler doğru şekilde kurulmuş.',
      };
    },
  },
};

const PRESENTATION = {
  // ntfy priority: 1 min, 3 default, 5 max. The reset alert is the one worth
  // interrupting someone for - it is the moment they can start working again.
  window_start: { priority: 3, tags: ['hourglass_flowing_sand'] },
  window_reset: { priority: 4, tags: ['white_check_mark'] },
  threshold: { priority: 3, tags: ['warning'] },
  source_error: { priority: 2, tags: ['rotating_light'] },
  test: { priority: 3, tags: ['bell'] },
};

export function composeNotification(event) {
  const pack = PACKS[config.notify.language] ?? PACKS.en;
  const build = pack[event.type] ?? PACKS.en[event.type];
  if (!build) return null;

  const presentation = PRESENTATION[event.type] ?? { priority: 3, tags: [] };
  const { title, message } = build(event);

  const priority =
    event.type === 'threshold' && event.threshold >= 95 ? 4 : presentation.priority;

  return { title, message, priority, tags: presentation.tags };
}
