# claude-usage-relay

Get a push notification the moment your Claude 5-hour usage window resets — even
while every one of your computers is switched off.

Claude Code already knows how much of your 5-hour window you have used. It just
has no way to tell you once you walk away from the keyboard. This project fixes
that with two small, independent pieces:

- **`usage-agent`** — a status line for Claude Code that shows the window as a bar
  with a countdown, and quietly relays the numbers to your server.
- **`notify-server`** — a tiny service you host, which watches those numbers and
  pushes a notification to your phone through [ntfy](https://ntfy.sh).

```
   your machines                         your server                    your phone
┌────────────────────┐              ┌──────────────────────┐         ┌────────────┐
│ Claude Code        │              │ notify-server        │         │            │
│  └─ status line ───┼──POST /report┼─▶ tracks the window  │──push──▶│    ntfy    │
│     (the widget)   │              │   fires on its own   │         │            │
└────────────────────┘              │   clock at reset ⏰  │         └────────────┘
   laptop, desktop, …               └──────────────────────┘
```

The reset alert is the point of the whole thing: it comes from the **server's**
clock, not from your machine, so it still reaches you when your laptop is closed.

## What you get

| | |
| --- | --- |
| **A real widget** | `5h ███░░░░░░░ 32% ↻ 3h 24m │ 7d 18%` right in Claude Code's status line, colour-coded as you get closer to the limit. |
| **New window opened** | Told the moment a fresh 5-hour window starts, with the exact reset time. |
| **Approaching the limit** | Configurable thresholds (80% and 95% by default), once each per window. |
| **Limit reset** | The one that matters when you are away from the desk. Fires from the server. |
| **Several machines** | Every machine reports the same account-level figures, so they simply agree. No syncing between your computers. |
| **Nothing to leak** | The server never sees a Claude token — see below. |

## How it gets the numbers

Claude Code passes a JSON object on stdin to whatever command you configure as
`statusLine`, and that object contains the real usage window:

```json
{ "rate_limits": { "five_hour": { "used_percentage": 45, "resets_at": 1693478400 } } }
```

This is a documented Claude Code feature. It means this project needs **no
credentials, no token file, no undocumented API and no scraping** — which is also
why it does not break every time something changes upstream. Your OAuth token
never leaves your machine, because it is never read in the first place.

The trade-off: numbers only arrive while Claude Code is running. That is fine,
because a window can only *start* while you are using Claude — and the reset,
which happens while you are away, is computed by the server from the reset
timestamp it already has.

Requires a Claude Pro or Max subscription (`rate_limits` is empty otherwise), and
appears only after the first response in a session.

## Setup

### 1. The server

On any always-on machine — a VPS, a home server, a Raspberry Pi. Node.js 20+, no
dependencies to install.

```bash
git clone https://github.com/onursucu/claude-usage-relay /opt/claude-usage-relay
cd /opt/claude-usage-relay
bash scripts/setup-server.sh --systemd
```

That generates the two secrets, writes `packages/notify-server/.env`, installs a
systemd unit and starts it. It prints the ntfy topic and the relay token you will
need for the next two steps. Re-running it never overwrites an existing `.env`.

Leave off `--systemd` to only write the config and run the server yourself with
`npm start`. Everything the script sets can be edited afterwards in
`packages/notify-server/.env`, which documents every option — `NOTIFY_LANGUAGE`,
`DISPLAY_TIMEZONE` and `USAGE_THRESHOLDS` are the ones most people change.

Check that notifications actually arrive before going further:

```bash
cd packages/notify-server && npm run test:notify
```

The server listens on `127.0.0.1:8787`, so put your existing reverse proxy in
front of it and give it TLS:

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
}
```

### 2. Your phone

Install the [ntfy app](https://ntfy.sh/app) (Android, iOS, or the web app) and
subscribe to the topic you generated. That is the whole setup.

> On the public `ntfy.sh` instance a topic is readable by anyone who knows its
> name, so treat the name as a secret — hence the random one above. For real
> privacy, [self-host ntfy](https://docs.ntfy.sh/install/) and set `NTFY_TOKEN`.

### 3. Each machine you work on

```bash
git clone <this repo> && cd claude-usage-relay/packages/usage-agent
cp .env.example .env
```

```ini
RELAY_URL=https://your-domain.example
RELAY_TOKEN=<the same token as the server>
DEVICE_NAME=desktop
```

Then point Claude Code's status line at the agent:

```bash
node ../../scripts/install-statusline.mjs          # shows what it would change
node ../../scripts/install-statusline.mjs --apply  # writes it (backs up first)
```

Or do it by hand in `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"/absolute/path/to/packages/usage-agent/src/statusline.js\""
  }
}
```

Open a new Claude Code session; the widget appears once the first response comes
back. Repeat on every machine, with a different `DEVICE_NAME` and the same
`RELAY_URL` and `RELAY_TOKEN`.

The agent works without a server too: leave `RELAY_URL` empty and you still get
the widget, just no notifications.

## Configuration

Every option lives in the two `.env.example` files, which document themselves.
The ones worth knowing about:

| Server | Default | |
| --- | --- | --- |
| `USAGE_THRESHOLDS` | `80,95` | Percentages that trigger a warning. Empty disables them. |
| `NOTIFY_ON_WINDOW_RESET` | `true` | The away-from-desk alert. |
| `NOTIFY_LANGUAGE` | `en` | `en` or `tr`. |
| `RESET_GRACE_MINUTES` | `30` | If the server was down when a window expired, do not announce it hours late. |

| Agent | Default | |
| --- | --- | --- |
| `RELAY_MIN_INTERVAL_SECONDS` | `180` | The status line re-renders constantly; this is how often it may actually report. A new window always reports immediately. |
| `DEVICE_NAME` | hostname | Shown in notifications. |

## Design notes

**The status line must never be slow or broken.** Claude Code runs it on every
render and shows whatever it prints. So `statusline.js` always prints something
(even with no data, bad JSON, or no stdin at all), and never waits on the
network: it writes the report to a file and hands it to a detached `relay.js`
process, which does the talking.

**`resets_at` is the window's identity.** A new value means a new window opened —
that single comparison is the core of the whole project
(`packages/notify-server/src/lib/detector.js`).

**Adopting an account is quiet.** If the server sees an account for the first
time mid-window, it records the window without announcing it. Otherwise starting
the server would greet you with a "new window started" that is hours old.

**Everything notification-related is pure.** The detector takes state and a
report and returns new state plus events, with no I/O and no clock of its own,
which is why the test suite can drive months of scenarios in milliseconds.

## Tests

```bash
npm test    # detector unit tests
npm run e2e # spins up the server and a mock ntfy, drives the real status line
```

The end-to-end check runs the actual chain — status line → relay → server →
notification — including a window reset fired purely from the server's clock.

## Limitations

- Claude Pro/Max only. There is no `rate_limits` data for API-key usage.
- A window's *start* is only noticed while Claude Code is running. Its *reset*
  is not — that is the part the server handles.
- One account per agent install. Multiple accounts are on the roadmap; the wire
  format already carries `provider` and `account` fields for it.

## Roadmap

- A web dashboard on top of `GET /state`
- Multiple accounts, and other CLIs (the protocol is deliberately generic)
- An optional standalone poller for machines where Claude Code is not running

## Not affiliated with Anthropic

This is an unofficial community project. It reads a documented Claude Code
feature and nothing else. "Claude" is a trademark of Anthropic.

MIT licensed.
