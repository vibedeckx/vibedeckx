# Live Event Stream: Connection Status Indicator

How the app surfaces the health of its single shared `/api/events` SSE
connection in the header — and **why** it exists: a silently-dead stream used to
fail invisibly, so the user assumed "no agent finished" when really their live
updates had stopped.

Frontend: `apps/vibedeckx-ui/hooks/global-event-stream.tsx`,
`apps/vibedeckx-ui/components/layout/connection-status-indicator.tsx`,
wired into the header in `apps/vibedeckx-ui/app/page.tsx`.
Backend: `packages/vibedeckx/src/routes/event-routes.ts`.

---

## 1. The bug that motivated this

Symptom: an agent finishes in project A while the user is viewing project B, and
the top-right completion bell (`CompletionNotificationsMenu`) shows nothing. **A
page refresh fixes it.**

It is **not** a frontend scoping bug (the bell hook listens to the global stream
with no `projectId` filter) and **not** the backend `branch:activity` dedupe.
The decisive evidence is "refresh fixes it": the backend `BranchActivityDedupe`
is process-level and survives a frontend refresh, so if it were the dedupe a
refresh would change nothing. A refresh only rebuilds the SSE `EventSource` —
which proves the backend emit path is healthy and **the dead connection is the
problem**.

### Why the one shared stream silently dies and never self-heals

Commit `906daf1` (*share one SSE stream across global event hooks*) consolidated
the 3–4 independent `EventSource`s that each global consumer used to open (branch
activity, completion sounds/notifications, task refresh, executor lifecycle)
into **one shared stream** owned by `GlobalEventStreamProvider`. Those old
independent streams relied on the browser's **native** `EventSource`
auto-reconnect. The shared stream replaced that with a custom
`onerror → es.close() → manual reconnect`.

The gap: `es.close()` permanently disables native reconnect, so recovery now
depends entirely on `onerror` firing. But a **zombie socket** — TCP "open" yet
delivering nothing, the usual aftermath of laptop sleep, a network change, or a
NAT/proxy half-close — **never fires `onerror`**. With no client-side liveness
watchdog, the single shared stream goes permanently silent (taking *all* global
events with it: the bell, sidebar activity dots, executors, tasks) until a manual
refresh.

The backend already sent a 15s `:keepalive`, but that only stops **idle-timeout**
reaping by intermediaries — it cannot prevent network-level death, and as an SSE
*comment* line `EventSource` never even delivers it to `onmessage`, so the client
could not observe heartbeats at all.

> Note: there is a separate, *latent* bug where the commander's remote
> `sendToRemoteAgentSession` / `spawnRemoteAgentSession` never emit
> `branch:activity:working` (unlike the UI `/message` route at
> `agent-session-routes.ts:698`), so the backend dedupe can suppress a *repeat*
> remote completion. That is real but is **not** this bug (a refresh wouldn't fix
> it) and is left for later.

---

## 2. What the user sees

A small indicator in the header, just left of the completion bell. Quiet when
healthy, loud only when it matters:

| State | Display | Meaning |
|-------|---------|---------|
| `live` | calm **emerald** dot | stream open and receiving frames (events or heartbeats) |
| `connecting` | muted **pulsing** dot | opening, or auto-reconnecting after a clean drop (usually brief) |
| `stale` | **amber, clickable pill** "实时更新已断开" | stream went silent past the heartbeat deadline (zombie); **click = manual reconnect** |

Hovering shows "上次更新 N 秒前". The product intent is explicit: turn a *silent*
failure into a *visible* one with a one-click remedy, because the cost of this
bug is not "a missing notification" — it is the user's **false confidence** that
nothing happened.

---

## 3. How liveness is detected

The only reliable way to detect a zombie (open-but-silent) connection is an
**application-level heartbeat**: transport-level signals (`readyState`,
`onerror`) report nothing when nothing flows end-to-end. So:

1. **Backend** sends a real heartbeat **event** (not a comment) every 15s:
   `data: {"type":"ping"}`. Now `EventSource.onmessage` fires for it, so the
   client can observe the stream is alive. Consumers filter by their own `type`,
   so a `ping` is ignored everywhere downstream.

2. **Frontend** records `lastEventAt` on **every** frame — real event *or* ping
   (even an unparseable frame counts: bytes arriving is proof of life).

3. A **5s watchdog** flags `stale` when no frame has arrived for **>40s**
   (≈2.5× the 15s heartbeat, so a single delayed packet never trips it). This is
   the zombie path that `onerror` misses.

4. The existing `onerror → reconnect` is **kept** for clean drops (it
   auto-reconnects with a fresh token and exponential backoff up to 5s). The
   watchdog deliberately does **not** auto-reconnect — for now, `stale` recovery
   is the user clicking the pill (`reconnect()`).

State transitions:

```
            onopen / onmessage            watchdog: silent >40s
 connecting ──────────────────▶ live ───────────────────────▶ stale
     ▲                           │                              │
     │      onerror (clean drop) │            click pill        │
     └───────────────────────────┴──────────────────────────────┘
                         reconnect() → connecting
```

Note `connecting` is *not* overridden to `stale` by the watchdog — an active
reconnect (e.g. a clean drop, or server-down auto-retry) keeps showing the muted
pulsing dot rather than the alarm. (Escalating a *prolonged* `connecting`, i.e.
the server is genuinely down, to a visible state is a deliberate, unimplemented
follow-up — see §6.)

---

## 4. Implementation map

| Piece | Where |
|-------|-------|
| Heartbeat as a real `ping` event | `routes/event-routes.ts` (the 15s `setInterval`) |
| Stream ownership, `lastEventAt`, watchdog, `reconnect()` | `hooks/global-event-stream.tsx` (`GlobalEventStreamProvider`) |
| Listener subscription (unchanged API) | `useGlobalEventStream(listener)` |
| Liveness read for the indicator | `useConnectionStatus()` → `{ state, lastEventAt, reconnect }` |
| Header indicator UI | `components/layout/connection-status-indicator.tsx` |
| Placement (header, before the bell) | `app/page.tsx` |

### Why two contexts

The provider exposes **two** contexts:

- `GlobalEventStreamContext` → `{ subscribe, reconnect }`, value **memoized** so
  its identity is stable across re-renders.
- `ConnectionStatusContext` → `{ state, lastEventAt }`, which changes on every
  frame.

This split matters: `lastEventAt` updates on every event (and every 15s ping), so
the provider re-renders often. If `subscribe` lived on a value that changed each
render, every `useGlobalEventStream` consumer's `[ctx]` effect would tear down and
re-subscribe its listener on every heartbeat. Keeping `subscribe`/`reconnect` on a
stable, memoized value means only the **indicator** (the sole
`ConnectionStatusContext` consumer) re-renders on heartbeats; the data listeners
stay put. (`{children}` is a stable prop reference, so the provider's frequent
re-render does not re-render the app subtree — only context consumers do.)

### Other notes

- The indicator runs a 5s self-tick so its "上次更新 N 秒前" label stays current
  even while the stream is silent (a stale stream sends nothing, so it would not
  otherwise re-render).
- All `setState` calls live inside event handlers / interval callbacks, never
  synchronously in an effect body (keeps `react-hooks/set-state-in-effect`
  happy).

---

## 5. Why a heartbeat, and not something "more accurate"

For the specific failure (open-but-silent), a heartbeat + idle-timeout is
**fundamentally the only accurate method** — `EventSource` abstracts the socket
away and emits no event when nothing happens. The other available signals are
either coarse hints or proactive triggers, not health proofs:

- `EventSource.readyState` — accurate for "stuck `CONNECTING`" / "unexpected
  `CLOSED`", but a zombie stays `OPEN(1)`, so it misses the case we care about.
- `onopen`/`onerror` — accurate *state transitions*, but a zombie fires neither.
- `navigator.onLine` + `online`/`offline`, `visibilitychange`, `pageshow`
  (`persisted`), `navigator.connection.change` — good **triggers** to re-check /
  reconnect (network return, tab focus, sleep wake), but `onLine === true` only
  means "an interface exists", not "the server is reachable".
- A `/health` probe — can *disambiguate* "server unreachable" vs "this stream
  stalled", at the cost of extra requests.

The accurate core is the heartbeat; everything else only makes recovery *faster*
or the diagnosis *finer*.

---

## 6. Deliberately not done (follow-ups)

- **Watchdog-driven auto-reconnect.** Today `stale` recovery is a manual click.
- **Proactive reconnect triggers**: `online` / `visibilitychange` /
  `pageshow(persisted)` — the cheapest catch for the most common real-world
  causes (sleep wake, network return, tab refocus).
- **Escalate a prolonged `connecting`** (server genuinely down / repeated
  reconnect failures) to the visible amber state, instead of an indefinitely
  quiet pulsing dot.
- **`/health` probe** to distinguish server-down from stream-stalled (better UX
  copy + diagnostics).
- The separate **commander `working`-emit dedupe** latent bug (see §1 note).
