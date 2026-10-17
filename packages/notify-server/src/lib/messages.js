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

/** Turn durations, unlike window resets, arrive as a plain count of seconds. */
function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;

  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;

  if (hours > 0) {
    return minutes
      ? { en: `${hours}h ${minutes}m`, tr: `${hours} sa ${minutes} dk` }
      : { en: `${hours}h`, tr: `${hours} saat` };
  }
  if (minutes > 0) {
    return rest
      ? { en: `${minutes}m ${rest}s`, tr: `${minutes} dk ${rest} sn` }
      : { en: `${minutes}m`, tr: `${minutes} dk` };
  }
  return { en: `${rest}s`, tr: `${rest} sn` };
}

function where(event) {
  return [event.device, event.project].filter(Boolean).join(' · ');
}

/**
 * The error types Claude Code reports on StopFailure. Anything unlisted falls
 * through to the raw string, which still beats "unknown error".
 */
const ERROR_LABELS = {
  en: {
    rate_limit: 'the usage limit was reached',
    overloaded: 'the API was overloaded',
    authentication_failed: 'authentication failed',
    oauth_org_not_allowed: 'the organisation does not allow this login',
    account_on_hold: 'the account is on hold',
    billing_error: 'a billing problem',
    invalid_request: 'an invalid request',
    model_not_found: 'the model was not found',
    server_error: 'a server error',
    max_output_tokens: 'the response hit the output limit',
    cloud_credential_error: 'a cloud credential problem',
  },
  tr: {
    rate_limit: 'kullanım limitine takıldı',
    overloaded: 'API aşırı yüklü',
    authentication_failed: 'kimlik doğrulama başarısız',
    oauth_org_not_allowed: 'kurum bu girişe izin vermiyor',
    account_on_hold: 'hesap askıda',
    billing_error: 'ödeme sorunu',
    invalid_request: 'geçersiz istek',
    model_not_found: 'model bulunamadı',
    server_error: 'sunucu hatası',
    max_output_tokens: 'yanıt çıktı sınırına dayandı',
    cloud_credential_error: 'bulut kimlik bilgisi sorunu',
  },
};


/** Why Claude stopped to ask. Anything unlisted falls back to a plain wording. */
const WAITING_REASONS = {
  en: {
    permission_prompt: 'it needs permission to continue',
    agent_needs_input: 'an agent is asking for input',
  },
  tr: {
    permission_prompt: 'devam etmek için izin bekliyor',
    agent_needs_input: 'bir ajan girdi bekliyor',
  },
};

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
    start_ok() {
      return {
        title: 'Claude · window opened',
        message: 'A 5-hour window was started. The exact reset time appears once Claude Code reports in.',
      };
    },
    start_failed(event) {
      return {
        title: 'Claude · could not open a window',
        message: `The ping failed: ${event.message}`,
      };
    },
    turn_done(event) {
      const duration = formatDuration(event.duration_seconds);
      return {
        title: duration ? `Claude · done after ${duration.en}` : 'Claude · turn finished',
        message: [where(event), event.summary].filter(Boolean).join('\n') || 'Claude finished its turn.',
      };
    },
    turn_failed(event) {
      const duration = formatDuration(event.duration_seconds);
      const label = ERROR_LABELS.en[event.error] ?? event.error ?? 'an unknown error';
      const ran = duration ? `Stopped after ${duration.en}` : 'Stopped';
      return {
        title: 'Claude · the job did not finish',
        message: [`${ran} — ${label}.`, where(event), event.detail].filter(Boolean).join('\n'),
      };
    },
    turn_waiting(event) {
      const duration = formatDuration(event.duration_seconds);
      const why = WAITING_REASONS.en[event.reason] ?? 'it is waiting on you';
      const ran = duration ? ` after ${duration.en}` : '';
      return {
        title: 'Claude · waiting on you',
        message: [`Stopped${ran} — ${why}.`, where(event), event.detail].filter(Boolean).join('\n'),
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
    start_ok() {
      return {
        title: 'Claude · periyot başlatıldı',
        message: '5 saatlik periyot açıldı. Kesin sıfırlanma saati, Claude Code ilk raporu gönderince netleşecek.',
      };
    },
    start_failed(event) {
      return {
        title: 'Claude · periyot başlatılamadı',
        message: `Ping başarısız: ${event.message}`,
      };
    },
    turn_done(event) {
      const duration = formatDuration(event.duration_seconds);
      return {
        title: duration ? `Claude · iş bitti (${duration.tr})` : 'Claude · iş bitti',
        message: [where(event), event.summary].filter(Boolean).join('\n') || 'Claude yanıtı tamamladı.',
      };
    },
    turn_failed(event) {
      const duration = formatDuration(event.duration_seconds);
      const label = ERROR_LABELS.tr[event.error] ?? event.error ?? 'bilinmeyen hata';
      const ran = duration ? `${duration.tr} çalıştıktan sonra durdu` : 'Durdu';
      return {
        title: 'Claude · iş yarıda kaldı',
        message: [`${ran} — ${label}.`, where(event), event.detail].filter(Boolean).join('\n'),
      };
    },
    turn_waiting(event) {
      const duration = formatDuration(event.duration_seconds);
      const why = WAITING_REASONS.tr[event.reason] ?? 'seni bekliyor';
      const ran = duration ? `${duration.tr} çalıştıktan sonra` : 'Çalışırken';
      return {
        title: 'Claude · seni bekliyor',
        message: [`${ran} durdu — ${why}.`, where(event), event.detail].filter(Boolean).join('\n'),
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
  // ntfy priority: 1 min, 3 default, 5 max. The alerts worth interrupting
  // someone for are the reset - the moment they can start working again - and
  // a long job that died, where an hour of waiting just bought them nothing.
  window_start: { priority: 3, tags: ['hourglass_flowing_sand'] },
  window_reset: { priority: 4, tags: ['white_check_mark'] },
  threshold: { priority: 3, tags: ['warning'] },
  source_error: { priority: 2, tags: ['rotating_light'] },
  // The acknowledgement of a start you asked for; the precise reset time
  // arrives separately as window_start, so this one stays quiet.
  start_ok: { priority: 2, tags: ['rocket'] },
  // A start that silently did nothing is the one failure that defeats the
  // whole point, so it interrupts.
  start_failed: { priority: 4, tags: ['rotating_light'] },
  // Waiting outranks finishing: a job that has stopped to ask is burning your
  // wall clock doing nothing, and only you can unblock it.
  turn_waiting: { priority: 5, tags: ['raised_hand'] },
  // A long job that finished, and the worse case: one that died after an hour
  // of waiting. Both are worth interrupting someone for.
  turn_done: { priority: 4, tags: ['checkered_flag'] },
  turn_failed: { priority: 5, tags: ['x'] },
  test: { priority: 3, tags: ['bell'] },
};

/**
 * The reset alert is the moment someone can start working again, so it is the
 * natural place to hang the button that opens a window - one tap on the phone
 * instead of unlocking a laptop. A failed start gets the same button so the
 * retry is where the bad news is.
 *
 * The token travels inside the notification, which is why START_TOKEN is a
 * separate secret from RELAY_TOKEN: anything that reads your ntfy topic learns
 * only how to open a window, never how to write reports.
 */
function startActions(event) {
  if (!config.start.actionUrl || !config.start.token) return [];
  if (event.type !== 'window_reset' && event.type !== 'start_failed') return [];

  return [
    {
      action: 'http',
      label: config.notify.language === 'tr' ? 'Periyodu başlat' : 'Open a window',
      url: config.start.actionUrl,
      method: 'POST',
      headers: { Authorization: `Bearer ${config.start.token}` },
      body: '{}',
      clear: false,
    },
  ];
}

export function composeNotification(event) {
  const pack = PACKS[config.notify.language] ?? PACKS.en;
  const build = pack[event.type] ?? PACKS.en[event.type];
  if (!build) return null;

  const presentation = PRESENTATION[event.type] ?? { priority: 3, tags: [] };
  const { title, message } = build(event);

  const priority =
    event.type === 'threshold' && event.threshold >= 95 ? 4 : presentation.priority;

  return { title, message, priority, tags: presentation.tags, actions: startActions(event) };
}
