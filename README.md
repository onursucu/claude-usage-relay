# claude-usage-relay

Get a push notification the moment your Claude 5-hour usage window resets — even
while every one of your computers is switched off — and another when the
hour-long job you walked away from is finally done.

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
| **The weekly limit too** | The 7-day window gets its own thresholds and its own reset alert. It warns earlier (50% by default), because by the time a weekly limit reads 80% on a Thursday the rest of your week is already decided. |
| **Limit reset** | The one that matters when you are away from the desk. Fires from the server. |
| **A long turn finished** | Walk away from a job that takes an hour and hear about it when it ends, with the first lines of the answer. Short turns stay silent. |
| **A long turn died** | A rate limit or an overloaded API killed the job after forty minutes. You find out now, not at midnight. |
| **A long turn is stuck** | The job you walked away from stopped at minute three for a permission prompt. Without this it would simply sit there. |
| **Several machines** | Every machine reports the same account-level figures, so they simply agree. No syncing between your computers. |
| **Several accounts** | Switch between a personal and a work account and each keeps its own window, thresholds and reset alert — fired from the server's clock, so you hear that a limit came back on an account you are not currently signed in to. Every alert says which account it is for, once there is more than one. |
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
> privacy, self-host ntfy as described below.

### Optional: self-hosting ntfy

Worth it if you would rather no third party saw your notifications at all. On
Debian/Ubuntu, [install ntfy from its apt repository](https://docs.ntfy.sh/install/),
then keep `/etc/ntfy/server.yml` this small:

```yaml
base-url: "https://ntfy.your-domain.example"
listen-http: "127.0.0.1:2586"       # only your reverse proxy reaches it
cache-file: "/var/cache/ntfy/cache.db"
cache-duration: "12h"
auth-file: "/var/lib/ntfy/user.db"
auth-default-access: "deny-all"     # this line is the privacy
behind-proxy: true                  # trust X-Forwarded-For for rate limiting
```

Then give each side only the access it needs — the server publishes, the phone
reads, and nobody else can do either:

```bash
ntfy user add relay                 # notify-server publishes as this user
ntfy access relay <topic> write
ntfy token add relay                # put the token in NTFY_TOKEN

ntfy user add phone                 # your phone reads as this user
ntfy access phone <topic> read
```

Point `NTFY_URL` at your own instance and you are done. Two things that are
easy to get wrong:

- **`deny-all` really means all.** Confirm it: an unauthenticated
  `curl https://ntfy.your-domain.example/<topic>/json?poll=1` must return `403`.
  A write-only token failing to *read* is also correct, not a bug.
- **The subscription is a long-lived stream.** Whatever proxies ntfy needs
  `proxy_http_version 1.1`, the `Upgrade`/`Connection` headers, a long
  `proxy_read_timeout` (default 60s will cut the connection repeatedly) and
  `proxy_buffering off`, or messages arrive late.

#### If you are behind aaPanel

aaPanel can host both services, with one trap: when you add a reverse proxy it
prefills **Proxy directory** with the domain name. That is a URL *path*, so the
proxy then only answers on `https://your-domain.example/your-domain.example/…`
and everything else falls through to the empty site root as a 404. Set it to `/`.

Its proxy template does include the WebSocket headers, but not the timeouts, so
append these to the generated file in
`/www/server/panel/vhost/nginx/proxy/<domain>/`:

```nginx
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
proxy_buffering off;
proxy_cache off;
```

Re-editing the proxy in the aaPanel UI regenerates that file and drops them.

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

Leave `ACCOUNT_LABEL` empty. The agent then works out which Claude account is
signed in, so each account gets its own window tracked on the server instead of
overwriting the last one's. Set it only to give an account a name you prefer.

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

### 4. Optional: be told when a long turn ends

The usage relay answers *when does my limit come back*. This answers the other
question you have once you have left the desk: *is that hour-long job done yet*.

```bash
node scripts/install-hooks.mjs          # shows what it would change
node scripts/install-hooks.mjs --apply  # writes it (backs up first)
```

That registers one script on three of Claude Code's hooks:

| | |
| --- | --- |
| `UserPromptSubmit` | Stamps when the turn started. |
| `Stop` | The turn ended. Pushes only if it ran past `NOTIFY_MIN_TURN_SECONDS`, with the opening lines of Claude's answer. |
| `StopFailure` | The turn died on an API error — a rate limit, an overloaded API. Pushes whatever the duration. |
| `Notification` | Claude stopped to ask you something. Subscribed to `permission_prompt` and `agent_needs_input` only — **not** `idle_prompt`, which fires a minute after Claude finishes and would double up on the turn-finished push. |

All three are registered with `"async": true`, so Claude Code starts the hook
and carries straight on. A slow server, an unreachable one, a hung request —
none of it can make the editor feel stuck.

Sessions already running usually pick this up on their next turn; if nothing
arrives, open a new one.

To check it works without waiting an hour, start a turn in a real session and
let it run past the threshold. Note that `claude -p` is **not** a useful test:
Claude Code kills async hooks that are still running when a headless session
tears down, so the push is cut off before it leaves the machine. For the same
reason, headless runs do not notify.

The threshold is the setting that matters. `Stop` fires at the end of *every*
turn and most turns take seconds, so the default 5 minutes is what keeps your
phone quiet while you work. Lower it and you will regret it.

## Configuration

Every option lives in the two `.env.example` files, which document themselves.
The ones worth knowing about:

| Server | Default | |
| --- | --- | --- |
| `USAGE_THRESHOLDS` | `80,95` | Percentages that trigger a warning on the 5-hour window. Empty disables them. |
| `USAGE_THRESHOLDS_SEVEN_DAY` | `50,80,95` | The same for the weekly window, warning earlier because it fills far more slowly. |
| `NOTIFY_ON_WINDOW_RESET` | `true` | The away-from-desk alert. |
| `NOTIFY_LANGUAGE` | `en` | `en` or `tr`. |
| `ACCOUNT_LABELS` | — | `key:Name,key:Name`. Human names for your accounts, so an alert says which limit just came back. Ignored while only one account is tracked. |
| `RESET_GRACE_MINUTES` | `30` | If the server was down when a window expired, do not announce it hours late. |
| `RESET_GRACE_MINUTES_SEVEN_DAY` | `180` | The same for the week, on a longer leash: "your five hours are back" goes stale fast, "your week turned over" does not. |

| Agent | Default | |
| --- | --- | --- |
| `RELAY_MIN_INTERVAL_SECONDS` | `180` | The status line re-renders constantly; this is how often it may actually report. A new window always reports immediately. |
| `DEVICE_NAME` | hostname | Shown in notifications. |
| `ACCOUNT_LABEL` | the signed-in account | Which account the numbers belong to. Leave empty to detect it; set it to name an account yourself. |
| `NOTIFY_MIN_TURN_SECONDS` | `300` | How long a turn must run to earn a push. |
| `NOTIFY_ON_TURN_FAILURE` | `true` | Push when a turn dies on an API error, however short. |
| `NOTIFY_WAITING_AFTER_SECONDS` | `120` | How long a turn must have been running before "Claude is waiting on you" counts as news. Below it you are probably still watching the screen. |
| `NOTIFY_WAITING_COOLDOWN_SECONDS` | `600` | Stops a job stalled for an hour from buzzing every few seconds. |

## Design notes

**The status line must never be slow or broken.** Claude Code runs it on every
render and shows whatever it prints. So `statusline.js` always prints something
(even with no data, bad JSON, or no stdin at all), and never waits on the
network: it writes the report to a file and hands it to a detached `relay.js`
process, which does the talking.

**`resets_at` is the window's identity.** A new value means a new window opened —
that single comparison is the core of the whole project
(`packages/notify-server/src/lib/detector.js`), and it is per window: the 5-hour
and 7-day windows are tracked side by side and never overwrite each other.

**Only the 5-hour window announces its start.** A weekly window opening is the
same news as the previous one resetting, and nobody needs to hear it twice.

**Adopting an account is quiet.** If the server sees an account for the first
time mid-window, it records the window without announcing it. Otherwise starting
the server would greet you with a "new window started" that is hours old.

**Everything notification-related is pure.** The detector takes state and a
report and returns new state plus events, with no I/O and no clock of its own,
which is why the test suite can drive months of scenarios in milliseconds.

**The account is detected, not configured.** The status line payload carries the
window numbers but no identity at all, so a fixed label would file every account
under one key — and the first time you switched accounts you would stop being
told when the previous one's limit came back. So the agent reads `accountUuid`
from `~/.claude.json`, Claude Code's own config. That is not the credentials
file: `~/.claude/.credentials.json` is still never opened, the identifier is
opaque rather than secret, and the read costs about half a millisecond against a
node startup of thirty.

**The turn notifier is the one client that decides for itself.** Everywhere else
the agent is dumb and the server rules, because the server is the only thing
still awake when a window expires. A turn is the opposite: only the machine
running Claude Code knows how long it took, so the hook decides *whether* to
notify. The server still composes the message, so `NOTIFY_LANGUAGE` and
`DISPLAY_TIMEZONE` keep applying — and `POST /notify` takes an allowlist of
event types, so a leaked relay token still cannot fake a window reset.

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
