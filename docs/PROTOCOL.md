# Report protocol

The agent and the server only agree on one thing: the shape of a report. Anything
that can produce this shape can feed the server — a different CLI, a different
platform, a shell script.

## `POST /report`

```http
POST /report
Authorization: Bearer <RELAY_TOKEN>
Content-Type: application/json
```

```json
{
  "schema_version": 1,
  "provider": "claude",
  "account": "default",
  "device": "desktop",
  "source": "statusline",
  "collected_at": "2026-09-04T12:00:00.000Z",
  "windows": {
    "five_hour": { "used_percentage": 42, "resets_at": "2026-09-04T17:00:00.000Z" },
    "seven_day": { "used_percentage": 23, "resets_at": "2026-09-08T09:00:00.000Z" }
  },
  "session": { "cost_usd": 1.23, "model": "Opus 5" },
  "error": null
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `provider` | no | Which tool the usage belongs to. Defaults to `claude`. Reserved for tracking other CLIs later. |
| `account` | no | Which account, when you use more than one. Defaults to `default`. |
| `device` | no | Free-form machine label, only used to make notifications readable. |
| `source` | no | Where the numbers came from: `statusline` today. |
| `collected_at` | no | ISO timestamp. Used to drop out-of-order deliveries. |
| `windows.*.used_percentage` | yes¹ | 0–100, or `null` when unknown. |
| `windows.*.resets_at` | yes¹ | ISO timestamp. **This value is the window's identity** — a new one means a new window opened. |
| `error` | no | `{ "message": "..." }` when the sender cannot read usage data at all. |

¹ At least `windows.five_hour` must be present for anything interesting to happen.

Response:

```json
{ "ok": true, "events": ["window_start"] }
```

`events` lists what the report triggered — useful when debugging, and empty most
of the time. Reports older than the last one stored are answered with
`{ "ok": true, "ignored": "stale report" }`.

## `GET /state`

Same bearer token. Returns everything the server currently knows, keyed by
`provider:account`. This is what a dashboard would read.

## `GET /health`

No authentication. `{ "ok": true, "notifications": true }` — `notifications` is
false when no ntfy topic is configured.

## Events

| Event | Fired by | When |
| --- | --- | --- |
| `window_start` | a report | `five_hour.resets_at` differs from the tracked window. On a brand new account only if the window still looks freshly opened, so starting the server mid-window stays quiet. |
| `threshold` | a report | Usage crossed a configured percentage. Once per threshold per window. |
| `window_reset` | the server's clock | The tracked window's `resets_at` passed. Needs no report at all, which is why it still reaches you with every machine switched off. |
| `source_error` | a report | The sender set `error`. Rate-limited by `SOURCE_ERROR_COOLDOWN_MINUTES`. |

## Where the numbers come from

Claude Code passes a JSON object on stdin to the command configured as
`statusLine` in `settings.json`, and that object contains:

```json
{
  "rate_limits": {
    "five_hour":  { "used_percentage": 45, "resets_at": 1693478400 },
    "seven_day":  { "used_percentage": 23, "resets_at": 1693734400 },
    "spend_limit": { "used_percentage": 12, "resets_at": 1693478400 }
  }
}
```

`resets_at` is Unix epoch **seconds**; `packages/usage-agent/src/lib/normalize.js`
converts it to ISO and is the only place that knows Claude Code's shape.

Two things to know about this source:

- `rate_limits` is only populated for Claude Pro/Max accounts, and only after the
  first API response of a session. An empty payload early in a session is normal.
- The numbers are account-level and come from Anthropic's side, so every machine
  you work on reports the same figures. That is what makes multi-device tracking
  work without any syncing between your machines.
