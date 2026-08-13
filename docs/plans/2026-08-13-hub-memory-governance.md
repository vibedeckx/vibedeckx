# Hub memory governance — measurement plan and decision gates

**Status:** Phase 1 (instrumentation) shipped in `92e8ba2`. Phases 2-4 are gated on
the data this document says to collect. Nothing below should be built before the
numbers exist.

## 1. Why

On a SaaS hub, `RemotePatchCache` (`src/remote-patch-cache.ts`) keeps one
`messages: string[]` per remote agent session ever opened — every raw JSON patch
frame. It has **no size cap, no TTL, and no eviction**; the only release is
`forgetRemoteSession()` (user deletes the session, or reconciliation finds the
worker no longer has it). It also holds a persistent virtual WS per session that
keeps appending frames with no browser attached, by design.

Executor output is *not* a hub-side memory concern: `attachRemoteProcessStream()`
forwards frames without buffering, so hub memory tracks concurrent viewers, not
worker count. The worker-side `ProcessManager` buffer is a separate track (§6).

Every threshold discussed so far (2MB per session, 512MB global) was invented on
the spot. The point of Phase 1 is to replace them with measurements.

## 2. What is already collected

`92e8ba2` added one snapshot, exposed two ways:

- **`GET /api/admin/memory-stats`** — operator-gated point read (same
  `isOperatorRequest` gate as `worker-version-stats`: requires
  `VIBEDECKX_API_KEY`, 404 otherwise). Aggregate-only, no session/server/user
  identifiers, because the endpoint spans tenants.
- **A pino line every 5 minutes**, `mod: "memory-stats"`, into the rotating logs
  (`MemoryStatsReporter` in `src/memory-stats.ts`, started from
  `shared-services.ts`). pino already stamps `time`, `pid` and `hostname`, so the
  snapshot itself carries no instance identity.

Fields (`MemoryStatsSnapshot`):

| Field | Meaning |
| --- | --- |
| `process.{rss,heap_used,heap_total,external,array_buffers}` | Node's own accounting — the ceiling everything else must fit under |
| `process.uptime_s` | Which incarnation this line belongs to |
| `patch_cache.sessions` / `.messages` / `.approx_bytes` | Cache size, three ways |
| `patch_cache.with_remote_ws` | Sessions still holding a virtual channel to a worker |
| `patch_cache.with_subscribers` / `.subscribers` | Sessions a browser is actually watching |
| `patch_cache.finished_sessions` / `.finished_approx_bytes` | Memory for sessions that will never receive another frame |
| `patch_cache.unwatched_sessions` / `.unwatched_approx_bytes` | Memory held with nobody watching |
| `patch_cache.per_session_approx_bytes.{p50,p95,p99,max}` | Distribution — decides per-session budgets |
| `process_manager.*` | Hub-local process log buffers; expected near-zero on a hub |

**`approx_bytes` is UTF-16 code units, not bytes.** Non-ASCII conversation text
(CJK is 3 UTF-8 bytes per unit) and V8's per-string/per-object overhead are both
excluded, so the real heap cost of the cache is some unknown multiple — likely
between 1× and 4× — of this number. Every threshold below is therefore stated in
the same unit, and no gate compares it to `rss` as a ratio.

### Calibrating against RSS, when you need to

One question does need the two in the same unit: *is the patch cache actually
where the memory is going?* Answer it with a differential rather than a ratio,
using two `memory-stats` lines from the same incarnation, far apart:

```
heap_growth  = heap_used(t2) - heap_used(t1)
cache_growth = patch_cache.approx_bytes(t2) - patch_cache.approx_bytes(t1)
implied_multiplier = heap_growth / cache_growth
```

Growth-over-growth cancels the constant baseline (code, connections, storage
handles) that a point-in-time ratio would wrongly attribute to the cache. Read
the result as a *bounding* check, not a measurement:

- multiplier roughly 1-4 → the cache explains the growth; proceed to the gates.
- multiplier ≫ 4 → most growth is elsewhere. **Stop and find the real holder**;
  a cap on this cache would not move RSS.
- multiplier ≈ 0 with the cache still growing → the cache is not yet material.

Pick `t1`/`t2` from a quiet period with no restart between them (same
`uptime_s` monotonic run), and prefer `heap_used` over `rss` — `rss` includes
allocator slack that does not track allocations.

## 3. How to collect

Nothing external is required — the log lines are the dataset.

```bash
# One point read (operator)
curl -s -H "x-vibedeckx-api-key: $VIBEDECKX_API_KEY" \
  https://<hub>/api/admin/memory-stats | jq .

# The time series, from the rotating logs. -h is required: without it grep
# prefixes each line with its filename once the glob matches more than one
# file, and jq then chokes on non-JSON input.
grep -h '"mod":"memory-stats"' ~/.vibedeckx/logs/*.log \
  | jq -c '{t: .time, uptime: .process.uptime_s,
            heap: .process.heap_used, rss: .process.rss,
            sessions: .patch_cache.sessions,
            bytes: .patch_cache.approx_bytes,
            finished: .patch_cache.finished_approx_bytes,
            unwatched: .patch_cache.unwatched_approx_bytes,
            p99: .patch_cache.per_session_approx_bytes.p99,
            max: .patch_cache.per_session_approx_bytes.max}'
```

Files are `<dataDir>/logs/vibedeckx.log` plus rotated
`YYYYMMDD-HHMM-NN-vibedeckx.log` siblings — all `.log`, so the glob covers both,
and the date prefix sorts chronologically.

**Window: at least two weeks of production traffic, spanning at least one
week-over-week cycle and one hub restart.** A restart matters because the cache
starts empty and refills only as sessions are re-opened — the refill slope is
the growth rate, and `uptime_s` is what separates one incarnation from the next.

### Make sure the window survives rotation

Rotation is `size: "10M"`, `interval: "1d"`, `maxFiles: 14` (`logger.ts`). Two
weeks is retained **only if daily volume stays under 10M** — the size cap
rotates early and then 14 files can be far less than 14 days. For reference, a
single-user machine currently produces 0.8-2.7 MB/day, so a busy multi-tenant
hub can plausibly exceed the cap.

The `memory-stats` lines themselves are negligible (~600 B × 288/day ≈ 170 KB/day);
it is everything else in the shared log that evicts them. So before starting the
window, tee them out to a file nothing rotates. Set this up as an hourly
**scheduled task** targeting the hub (the logs are local to it), not a crontab
entry, so the export is visible and editable in the product:

```bash
touch "$HOME/memory-stats-series.ndjson"; grep -h '"mod":"memory-stats"' "$HOME"/.vibedeckx/logs/*.log >> "$HOME/memory-stats-series.ndjson"; sort -u -o "$HOME/memory-stats-series.ndjson" "$HOME/memory-stats-series.ndjson"; wc -l < "$HOME/memory-stats-series.ndjson"
```

Append-then-dedup rather than tracking a cursor: re-reading the whole retained
window every hour costs nothing at this volume, and `sort -u` over identical
whole lines makes the job idempotent, so a missed or double run cannot corrupt
the series. Timestamps come from pino's `time`, so ordering survives the sort.
The `;` separators and the leading `touch` matter — until the hub restarts onto
a build with the reporter there are no matching lines, and `grep` exiting 1
would otherwise mark every run failed. The trailing `wc -l` makes each run's
output the running line count, so the schedule history shows the series growing.

Check at the halfway point that the earliest exported line is still older than
the window start; if not, the export is the dataset and the raw logs are not.

Read the series for four things:

1. **Growth shape.** Plot `approx_bytes` against `uptime_s` within one
   incarnation. Linear and unbounded is the assumed case; a plateau would mean
   `forgetRemoteSession()` already keeps up and the whole plan can be shelved.
2. **Retention share.** `finished_approx_bytes / approx_bytes` and
   `unwatched_approx_bytes / approx_bytes`. This is the fraction of memory that
   buys nothing right now.
3. **Distribution.** `p50` vs `p99` vs `max`. A heavy tail argues for a
   per-session budget; a flat distribution argues for global eviction only.
4. **Attribution.** Run the growth-over-growth calibration from §2. It answers
   whether this cache is where the memory is going, without pretending
   `approx_bytes` and `rss` share a unit.

## 4. Decision gates

Evaluate in this order; each gate is independent. Every threshold is in
`approx_bytes` units (UTF-16 code units), never a fraction of RSS.

| Gate | Condition | Action |
| --- | --- | --- |
| **G0 — do nothing** | `approx_bytes` plateaus within an incarnation, **or** the §2 calibration says growth is not coming from this cache | Stop. Re-check after the next traffic step-change. |
| **G1 — global LRU** | `approx_bytes` grows monotonically within an incarnation and the calibration attributes heap growth to it | Build it. Cheapest bound: evict whole entries, no protocol change, no frontend change. Ceiling = observed two-week peak `approx_bytes` × 1.5, rounded — an absolute number, fixed in config, not a share of anything. |
| **G2 — per-session budget** | With G1 in place, `p99` (or `max`) is large enough that a handful of sessions dominate the ceiling and force useful ones out | Build head-drop + `truncatedBefore`, frontend pages the head back via the existing windowed history (`buildHistoryWindow`, `previousCursor`/`hasMore`). Budget = observed p95, rounded up. |
| **G3 — finished-session release** | `finished_approx_bytes` is a large, persistent share | Close the virtual channel and drop `messages` for finished sessions. **Prerequisite:** `finished` is currently reset to `false` by `replaceAll()`; using it to decide "release everything" needs reconnect-semantics regression tests first. |

### Why G1 does not need hit-rate data

The collected fields prove the cache *grows*; they say nothing about how many
useful sessions an LRU would evict. `with_subscribers` is an instantaneous
watching count, not a recency distribution, and there is no per-entry
last-access age or re-open counter. That is a deliberate omission, on three
grounds:

1. **A wrong eviction is not an error.** The entry is a cache of frames the
   worker still holds; on the next open, `hasCachedData` is false and the
   existing cold-start path re-seeds it from the worker. That path runs today on
   every new session and every hub restart. The cost of a miss is one worker
   round-trip, not a failure — so the usual reason to measure hit rate before
   evicting (correctness or a cliff in user-visible behaviour) does not apply.
2. **The ceiling is sized to the peak, not tuned to a hit rate.** At
   peak × 1.5, eviction only fires in territory the fleet has never reached, so
   in steady state the hit rate is unchanged by construction. Hit-rate data
   would matter for choosing a *tight* ceiling; it does not for a headroom one.
3. **Adding it is not free.** A last-access timestamp per entry plus a re-open
   counter means touching the read paths and carrying more per-entry state — for
   a decision that (1) and (2) already settle.

The one real cost of a miss is that **a re-seed needs the worker online**: evict
a session whose worker is a closed laptop and its history is unreadable until
that worker returns, where today it would have been served from cache. That is
the same trade already accepted in "not doing disk spill" below. If support
reports it, the fix is to bias eviction away from sessions whose worker is
currently offline — which needs no new metric, just `isConnected()` at eviction
time.

Revisit if G1 ships and eviction turns out to fire in steady state (log the
eviction rate when building it — that is the cheap signal, and it is a
by-product of the implementation rather than something to collect now).

Not doing, decided 2026-08-13: **hub-side disk spill of the patch cache.** Any
truncated history is re-fetchable from the worker through paths that already
exist, so a spill buys only "readable while the worker is offline" — at the cost
of persisting tenant conversation content on the hub, plus file lifecycle and a
second source of truth to keep consistent with `historyEpoch` resets. If offline
readability matters, keep the *tail* in memory and surface an explicit "older
history needs the worker" state instead.

## 5. What is deliberately not measured

- **Per-session/user/server attribution.** The endpoint spans tenants and the
  aggregate is enough to size a cap. If a single tenant is ever suspected of
  dominating, that is a separate, access-controlled investigation.
- **True heap footprint per entry.** Would need a heap snapshot; the UTF-16
  count is a stable proxy, thresholds are stated in it, and §2's
  growth-over-growth check bounds the multiplier well enough to tell whether
  this cache is the right target.
- **Per-entry last-access age and re-open rate.** See "Why G1 does not need
  hit-rate data" above.
- **How often a session is read while its worker is offline.** This is the one
  number that would settle the disk-spill question empirically, and it is not
  collected. Revisit only if users report it.

## 6. Adjacent, not gated on this data

Worker-side `ProcessManager` log buffers are capped by **entry count only**
(`TERMINAL_MAX_LOG_ENTRIES = 5000`, 30-minute retention after exit), with no byte
budget — a high-throughput process can hold hundreds of MB on a user's machine.
That work needs no hub measurements and can proceed independently: per-process
byte budget, chunk coalescing, a real ring buffer instead of `slice(-N)`, and a
cleanup timer on the `childProcess.on("error")` path.
