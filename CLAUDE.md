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
- **There is no hook for rate-limit *window* events.** Confirmed in
  `anthropics/claude-code` issues #34817 and #47276. Do not go looking for one.
  Note what this does *not* say: `StopFailure` does fire when a turn dies on a
  rate limit, and the turn notifier uses it. What is missing is any hook for a
  window opening or resetting, which is why the status line exists.
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
  `src/lib/account.js` is the one file that opens anything else, and what it
  opens is `~/.claude.json` — Claude Code's config, not its credentials — for
  an opaque `accountUuid`. Keep `.credentials.json` out of this project.
- Data only arrives while Claude Code is running — which is fine, because a
  window can only *start* while you are using Claude, and the *reset* is derived
  from `resets_at` by the server.
- If a standalone poller is ever added (see roadmap), it must be opt-in and must
  not become the primary source.

**2. `resets_at` is the window's identity.** Not a counter, not a start time.
A changed `resets_at` means a new window. This single comparison drives every
notification (`packages/notify-server/src/lib/detector.js`).

It is applied per window. `tracking` is keyed by window name (`five_hour`,
`seven_day`) and `WINDOWS` at the top of the detector says what each one
deserves - only the five-hour one announces its start. Two things to know
before touching this. State written before the split is flat, and
`readTracking()` reshapes it on read rather than migrating anything by hand, so
an upgrade cannot re-announce what the old shape already sent; there is a test
that pins exactly that. And `evaluateStartRequest` deliberately reads
`five_hour` specifically - a weekly window is always open and says nothing
about whether a session can be started.

**Reset alerts cover every account, not just the one you are using.**
`runResetCheck` sweeps all of `state.accounts` on the server's clock, so an
account you have not touched in days still tells you when its limit came back.
That is also why alerts carry `account_label`: it is attached once at dispatch
and only when more than one account is tracked, because a bare "limit reset"
cannot be acted on when you have two. An abandoned account fires exactly one
reset and then goes quiet - no reports means no new window to expire.

**3. The server holds the truth, the agent is dumb.** The agent reads, renders
and forwards; it makes no decisions about notifications. That is what lets the
reset alert fire with every machine switched off, and what makes several
machines reporting the same account trivially consistent — the numbers are
account-level, so they agree by construction.

The turn notifier is the deliberate exception, and it is worth knowing why.
Only the machine running Claude Code knows how long a turn took, so that hook
decides *whether* to notify and posts the result to `POST /notify`. The server
still composes the message, so the language and timezone settings keep applying.
That endpoint takes an **allowlist** of event types (`turn_done`,
`turn_failed`, `test`) rather than anything with a template: window events
belong to the detector, and a leaked relay token must not be able to fake a
reset. Add a client-decided event and it goes in that set, consciously.

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
  `packages/usage-agent/src/lib/normalize.js` for the status line, and to
  `packages/usage-agent/src/hooks/turn-notify.js` for the hook payloads. If
  Claude Code changes either shape, those are the only files to touch.
- Never let the status line throw. It prints something no matter what. The same
  goes for the hook: it swallows everything and exits 0, and it prints nothing
  at all on stdout, because an async hook's stdout is parsed as a JSON response
  and fed back to Claude.
- Hooks are registered with `"async": true`. Claude Code then never waits for
  them and never enforces their timeout, which is why the hook guards its own
  stdin read with a timer — a lingering process is the one way it could hurt.
- Nothing personal in the repo: no domains, hostnames, tokens, or usernames.
  Placeholders only (`your-domain.example`), everything real lives in `.env`.

## Status

Phase 1 is complete, deployed and verified:

```bash
npm test     # 11 detector unit tests
npm run e2e  # 23 checks, real chain, mock ntfy, offline
```

The e2e check includes a window reset fired purely from the server's clock with
the agent silent — the behaviour the whole project exists for — and drives the
turn notifier through the exact payloads Claude Code sends it.

Phase 2, the turn notifier, is written and tested: `src/hooks/turn-notify.js`
plus `POST /notify`, installed with `node scripts/install-hooks.mjs --apply`.
It covers a turn finishing, dying, and stalling on a prompt. The `Notification`
subscription is narrowed to `permission_prompt` and `agent_needs_input` on
purpose: `idle_prompt` fires about a minute after Claude finishes, so taking it
would mean two pushes for one event.

Multiple accounts work as of `src/lib/account.js`: the agent detects the
signed-in account rather than reporting a fixed label, so switching accounts no
longer overwrites the previous one's window. Upgrading an existing install means
clearing `ACCOUNT_LABEL=default` from `.env` **and** renaming that account's key
in the server's `data/state.json` — otherwise the stale `claude:default` entry
keeps its own expiry and fires a duplicate reset alert.

## Roadmap

1. **Web dashboard** on top of `GET /state`. The endpoint already returns
   everything a dashboard needs.
2. **Other CLIs (Codex and friends)** — same protocol, a different collector.
   Each tool needs its own source of numbers; the server does not care.
3. **Optional standalone poller** — for usage data while Claude Code is not
   running. Must be opt-in, clearly marked as unofficial, and must never
   outrank a fresh status line reading.
4. **A dashboard token** — `GET /state` takes the relay token today, which is a
   write credential. A browser should get a read-only one instead.
