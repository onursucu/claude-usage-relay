# Working notes for Claude Code

Context for picking this project up on another machine or in a fresh session.
Read `README.md` first for what the project does; this file is about *why it is
built the way it is* and *what is left*.

## The problem this exists to solve

Claude Code knows your 5-hour usage window, but only tells you while you are
sitting in front of it. The goal was: a live widget, plus a phone notification
when a new window starts and — the important one — when the window resets,
**while the computer is off**, consistently across several machines.

## What the research found (so nobody redoes it)

Two rounds of searching GitHub and the web established:

- **No existing project does this.** The closest are ClaudeKit (a Chrome
  extension: desktop notification on reset, but only while that browser is open,
  no cross-device sync — stated in their own docs), and TokenTracker /
  jimdawdy-hub/claude-usage-tracker (cross-device usage *dashboards* with no
  alerting at all). Every Telegram/Discord integration for Claude Code
  (`ccgram`, `Claude-Code-Remote`, `claude-notifications-go`) is driven by local
  shell hooks, which fire on task-complete / permission-needed events while
  Claude Code runs — never on "a usage window opened".
- **There is no hook for rate-limit events.** Confirmed in
  `anthropics/claude-code` issues #34817 and #47276. Do not go looking for one.
- **The status line is the only official source of window data**, and it is
  enough. See `docs/PROTOCOL.md`.

## Key decisions

**1. The status line, not the undocumented usage API.**
Community tools (Maciek-roboblog/Claude-Code-Usage-Monitor, several macOS menu
bar apps) read an undocumented OAuth usage endpoint using the token from
`~/.claude/.credentials.json`. It has already changed shape twice, is
rate-limited in surprising ways, and requires handling a rotating refresh token.
Even the projects that use it prefer the status line when a session is live.

So this project reads only the documented `statusLine` stdin JSON. Consequences
worth remembering:

- No credentials are read, so there is nothing to leak and nothing to refresh.
- Data only arrives while Claude Code is running — which is fine, because a
  window can only *start* while you are using Claude, and the *reset* is derived
  from `resets_at` by the server.
- If a standalone poller is ever added (see roadmap), it must be opt-in and must
  not become the primary source.

**2. `resets_at` is the window's identity.** Not a counter, not a start time.
A changed `resets_at` means a new window. This single comparison drives every
notification (`packages/notify-server/src/lib/detector.js`).

**3. The server holds the truth, the agent is dumb.** The agent reads, renders
and forwards; it makes no decisions about notifications. That is what lets the
reset alert fire with every machine switched off, and what makes several
machines reporting the same account trivially consistent — the numbers are
account-level, so they agree by construction.

**4. Adoption is silent.** First time the server sees an account mid-window it
records the window without announcing it, otherwise starting the server would
greet you with a stale "new window started". Threshold and reset alerts still
work for that window.

**5. Zero dependencies, on both sides.** `node:http` instead of a framework, a
15-line `.env` parser instead of dotenv. The status line runs on every render so
startup cost is real, and a server you host yourself is easier to trust with no
supply chain behind it. Keep it this way.

## Conventions

- ESM, Node 20+, no build step, no TypeScript.
- The detector is pure: state + report in, new state + events out. No I/O, no
  `Date.now()` inside — the clock is always passed in. This is why the tests can
  drive months of scenarios in milliseconds. Keep new logic pure and test it.
- Anything Claude-Code-shaped is confined to
  `packages/usage-agent/src/lib/normalize.js`. If Claude Code changes its status
  line JSON, that is the only file to touch.
- Never let the status line throw. It prints something no matter what.
- Nothing personal in the repo: no domains, hostnames, tokens, or usernames.
  Placeholders only (`your-domain.example`), everything real lives in `.env`.

## Status

Phase 1 is complete and verified:

```bash
npm test     # 11 detector unit tests
npm run e2e  # 13 checks, real chain, mock ntfy, offline
```

The e2e check includes a window reset fired purely from the server's clock with
the agent silent — the behaviour the whole project exists for.

Not yet done: nothing is deployed. The server has never run anywhere but
localhost, and the status line has not been installed into `settings.json` on a
real machine (`node scripts/install-statusline.mjs --apply` does that, with a
backup and a `--revert`).

## Roadmap

1. **Deploy** — server on an always-on host behind a reverse proxy, agent
   installed on each machine with a distinct `DEVICE_NAME`.
2. **Web dashboard** on top of `GET /state`. The endpoint already returns
   everything a dashboard needs.
3. **Multiple accounts** — the wire format already carries `provider` and
   `account`, and the server keys state by `provider:account`. The missing piece
   is agent-side: one install currently reports one account.
4. **Other CLIs (Codex and friends)** — same protocol, a different collector.
   Each tool needs its own source of numbers; the server does not care.
5. **Optional standalone poller** — for usage data while Claude Code is not
   running. Must be opt-in, clearly marked as unofficial, and must never
   outrank a fresh status line reading.
