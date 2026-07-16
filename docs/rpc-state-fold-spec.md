# Spec: foldable `RpcSessionState` from the RPC event stream

Supersedes `handoff-rpc-state-fold.md` (kept for the original derisking
context, including the field-by-field event analysis from 2026-07-15).

# SPEC

## Problem

RPC socket clients re-poll `get_state` on every boundary
event because the broadcast stream does not carry enough information to
maintain `RpcSessionState` locally. Two changes fix this:

1. Emit events for the state mutations that are silent today.
2. Ship a pure fold `nextSessionState(state, event)` in this repo, exported
   from the package, so the state-tracking logic lives next to the state
   machine it encodes instead of being reverse-engineered by every client.

## Contract

- **Seed-then-fold**: a client seeds from the `session_changed` event
  delivered right after the hello record (its payload is a full
  `RpcSessionState`), then folds every subsequent broadcast event over the
  result. Calling `get_state` yields an equivalent seed at any time.
- **Session replacement is a pushed re-seed**: `session_changed` fires on
  every session rebind and carries the complete state of the new session, so
  the fold survives `/new`, `/resume`, fork, and clone without a round-trip.
- **Idempotent re-application**: a `get_state` response can be ~one microtask
  stale relative to events already on the wire, so the fold must tolerate
  re-applying an event already reflected in the seed. All event payloads
  carry absolute values, never deltas.
- **Consistency invariant**: `fold(get_state seed, event stream)` equals what
  `get_state` would return at any later quiescent point — for every field
  except `messageCount` (below).
- **`messageCount` is excluded from the foldable contract.** The fold never
  updates it except via the full-state `session_changed` payload; under
  folding it reflects the most recent seed only. Documented via doc comments
  on both the fold and `RpcSessionState.messageCount`. Clients that need a
  fresh count re-poll `get_state`.

## Success criteria

1. Every `RpcSessionState` field except `messageCount` is observable on the
   socket: no code path changes such a field without a broadcast event
   carrying the new absolute value.
2. `nextSessionState` is exported from the `@mariozechner/pi-coding-agent`
   package and implements the transition table below.
3. A server-side consistency test drives a session through representative
   operations (model change, thinking level, mode toggles, auto-compaction
   toggle, queueing, compaction, tree navigation with summarization, session
   rename), folds the emitted stream from an initial `get_state`, and asserts
   the result deep-equals a final `get_state` (modulo `messageCount`).
4. Fold unit tests are driven by JSON test vectors (`{state, event,
   expected}` triples) stored as a data file that downstream ports of the
   fold can consume to prove equivalence.
5. Extensions can observe steering-mode, follow-up-mode, and auto-compaction
   changes via `pi.on(...)`.
6. TUI behavior is unchanged except that branch summarization now reports
   compaction status (no double display — audited during implementation).

## Type design

### New `AgentSessionEvent` members (`core/agent-session.ts`)

```ts
| { type: "model_changed"; model: Model<any> }
| { type: "steering_mode_changed"; mode: "all" | "one-at-a-time" }
| { type: "follow_up_mode_changed"; mode: "all" | "one-at-a-time" }
| { type: "auto_compaction_changed"; enabled: boolean }
```

Naming follows the existing paired-event precedent: extension
`thinking_level_select` alongside session `thinking_level_changed`, emitted
from the same site. `model_changed` is the session-event twin of the existing
extension `model_select`.

Emit sites (emit only when the value actually changes):

| Event | Sites |
|---|---|
| `model_changed` | `_emitModelSelect` (after the `modelsAreEqual` guard) — covers `setModel`, `cycleModel`, and session restore |
| `steering_mode_changed` | `setSteeringMode`; `syncQueueModesFromSettings` (settings-reload resync) |
| `follow_up_mode_changed` | `setFollowUpMode`; `syncQueueModesFromSettings` |
| `auto_compaction_changed` | `setAutoCompactionEnabled`; settings reload (the getter reads settings directly, so `reload()` can change the value with no setter call) |

### Widened compaction reason

`"branch-summary"` is added to the compaction reason union on
`compaction_start` and `compaction_end`:

```ts
| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" | "branch-summary" }
```

(`compaction_end` payload otherwise unchanged.) `navigateTree` branch
summarization emits the pair around the summarization it runs; today it holds
`isCompacting` true with no events. `CompactionStatusReason`
(`modes/interactive/components/status-indicator.ts`) widens to match, with
display text for the new variant. The extension compaction events
(`session_before_compact`, `session_compact`) keep their narrower reason
union — branch summarization already has dedicated extension hooks
(`session_before_tree`/`session_tree`).

### `session_changed` carries full state (`modes/rpc/rpc-types.ts`)

`RpcSocketSessionChangedEvent` is fork-only, so this is a coordinated
protocol change on the fork:

```ts
export interface RpcSocketSessionChangedEvent {
  type: "session_changed";
  state: RpcSessionState;
}
```

`sessionId`/`sessionFile` move inside `state`. The rebind listener keeps its
existing `sessionId !== previousSessionId` guard — no redundant broadcasts.
A same-id rebind that changes other fields is covered by the per-field
events, not by `session_changed`.

### `buildRpcSessionState` helper (`modes/rpc/`)

```ts
export function buildRpcSessionState(session: AgentSession): RpcSessionState;
```

Single source of truth for constructing `RpcSessionState` from a live
session, used by the `get_state` handler, `sessionChangedEvent()` in
`rpc-socket-mode.ts`, and the consistency test — so producers can't drift.

### New extension events (`core/extensions/types.ts`)

Same names and payloads as the session events (precedent:
`session_info_changed` exists identically on both channels):

```ts
export interface SteeringModeChangedEvent {
  type: "steering_mode_changed";
  mode: "all" | "one-at-a-time";
}
export interface FollowUpModeChangedEvent {
  type: "follow_up_mode_changed";
  mode: "all" | "one-at-a-time";
}
export interface AutoCompactionChangedEvent {
  type: "auto_compaction_changed";
  enabled: boolean;
}
```

Plus the corresponding `on(event, handler)` overloads on the extension API
and emits from the same sites as the session events. No new extension event
for model changes — `model_select` already exists.

### The fold (`modes/rpc/rpc-state-fold.ts`, new file)

```ts
export function nextSessionState(
  state: RpcSessionState,
  event: RpcSocketBroadcastEvent,
): RpcSessionState;
```

Pure function over plain readonly wire types. Returns `state` by reference
when the event changes no field (cheap change detection for clients); a fresh
object otherwise. No seed constant — the seed is always a `get_state`
response. Exported through the existing `modes/index.ts` re-export block in
the package index (where `RpcSessionState` already lives); add
`RpcSocketBroadcastEvent` to that block too so clients can type the fold's
input.

Transition table:

| Event | Field update |
|---|---|
| `agent_start` | `isStreaming = true` |
| `agent_settled` | `isStreaming = false` |
| `model_changed` | `model = event.model` |
| `thinking_level_changed` | `thinkingLevel = event.level` |
| `session_info_changed` | `sessionName = event.name` |
| `session_changed` | entire state replaced by `event.state` |
| `queue_update` | `pendingMessageCount = event.steering.length + event.followUp.length` |
| `compaction_start` | `isCompacting = true` |
| `compaction_end` | `isCompacting = false` |
| `steering_mode_changed` | `steeringMode = event.mode` |
| `follow_up_mode_changed` | `followUpMode = event.mode` |
| `auto_compaction_changed` | `autoCompactionEnabled = event.enabled` |
| anything else | unchanged (same reference) |

Note `isStreaming` clears on `agent_settled`, NOT `agent_end` — `agent_end`
fires mid-run on retries.

## Edge cases

- **`sendCustomMessage` steering bypass (preserve and document)**: extensions
  steering mid-stream via `pi.sendMessage({deliverAs: "steer"|"followUp"})`
  call `agent.steer()`/`agent.followUp()` directly, bypassing the
  `_steeringMessages`/`_followUpMessages` arrays. Neither `queue_update` nor
  `get_state`'s `pendingMessageCount` sees these messages, so the fold and
  `get_state` agree — the consistency invariant holds. This is an accuracy
  gap in `pendingMessageCount` itself, documented, not fixed here (the
  arrays hold user-typed strings so `clearQueue()` can restore them to the
  editor; machine-generated messages don't fit that model).
- **Retry**: `agent_end` with `willRetry: true` fires mid-run; the fold
  ignores `agent_end` entirely, so `isStreaming` stays true until
  `agent_settled`.
- **`compaction_end.willRetry` is NOT the same trap**: it means the agent
  turn retries after compaction, not that compaction continues. Compaction
  itself is always over at `compaction_end`, so the fold sets
  `isCompacting = false` unconditionally.
- **Unpaired `compaction_end`**: the overflow-recovery-failure path
  (`agent-session.ts:1980`) emits `compaction_end` with no preceding
  `compaction_start`. The fold sets `isCompacting = false` when it is
  already false — harmless by idempotence.
- **Optional fields**: `model`, `sessionFile`, and `sessionName` are
  optional in `RpcSessionState`. The fold assigns event values even when
  they are `undefined` (e.g. `session_info_changed` carries
  `name: undefined` on clear; `session_changed` state omits `sessionFile`
  for in-memory sessions) — it must not skip-on-undefined.
- **No extension `session_changed`**: socket clients need it because they
  live outside the process and survive session replacement; extension
  runtimes are torn down and restarted around replacement
  (`session_shutdown` → `session_start` with reasons `"new"`, `"resume"`,
  `"fork"`), so extensions already observe it.
- **Unchanged-value sets**: setters emit only on actual change, matching the
  `thinking_level_changed` precedent. Redundant emits would be harmless to
  the fold (absolute payloads) but noisy.
- **Settings reload**: `reload()` can change `steeringMode`, `followUpMode`,
  and `autoCompactionEnabled` without their setters running; the resync
  paths compare pre/post values and emit for each change.

## Non-goals

- Folding `messageCount` (dropped from the contract; known clients mostly
  don't use it).
- Fixing the `sendCustomMessage` queue bypass.
- New extension event for model changes (`model_select` already exists).
- Upstreaming: all changes land on this fork; upstream issues (e.g. whether
  branch summarization should emit compaction events) are filed separately
  and don't block this work.
- Ports of the fold to other languages (live in client repos; this repo only
  exports the shared test vectors).

# IMPLEMENTATION IDEAS

- Emit-site mechanics: `syncQueueModesFromSettings`
  (`agent-session.ts:1745`) currently assigns unconditionally; needs
  before/after comparison to emit-on-change. `setAutoCompactionEnabled`
  (`agent-session.ts:2206`) writes settings only; compare
  `settingsManager.getCompactionEnabled()` before/after. Find where
  `syncQueueModesFromSettings` is called relative to `settingsManager.reload()`
  and whether auto-compaction needs its own resync hook there.
- `navigateTree` summarization: abort controller set up around
  `agent-session.ts:2889`; emit `compaction_start` when summarization
  actually begins (only when `options.summarize` and there are entries to
  summarize) and `compaction_end` in a finally. Check `isCompacting`
  consumers and the TUI for double display: the TUI may already render a
  branch-summarization indicator via `tree_navigated`/session-selector
  paths.
- Extension emits for the three new events: `void
  this._extensionRunner.emit({...})` from the same sites, following the
  `thinking_level_changed`/`thinking_level_select` pattern
  (`agent-session.ts:1685-1691`).
- Test vectors as data: keep vectors in a JSON file under the package (e.g.
  `src/modes/rpc/rpc-state-fold.vectors.json` or `test/` equivalent),
  imported by the TS test; downstream ports read the same file from the npm
  tarball or a copied fixture.
- Consistency test seam: `AgentSession` event listeners capture the emitted
  stream; `buildRpcSessionState` (now in the type design) gives the test the
  same construction the `get_state` handler and `sessionChangedEvent()` use.
- Derisking context: `entry_appended` was added upstream (`ba10b60b5`)
  narrowly for extension custom-entry rendering; widening it was only needed
  for `messageCount` and is out of scope now.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

## Tasks

- [x] Type skeleton: new `AgentSessionEvent` members, widened compaction
  reason, extension event interfaces + `on()` overloads + exports,
  `session_changed` full-state payload, `buildRpcSessionState`/`nextSessionState`
  stubs, package exports — compiled before implementation
- [x] Emit sites: `model_changed` in `_emitModelSelect`; mode setters +
  settings-reload resync via `_applySteeringMode`/`_applyFollowUpMode`;
  `setAutoCompactionEnabled` + reload diff via `_emitAutoCompactionChanged`
- [x] `navigateTree` emits `compaction_start`/`compaction_end`
  (`reason: "branch-summary"`) around summarization
- [x] Fold implementation with identity-return change detection
- [x] Vector-driven fold tests (`test/rpc-state-fold-vectors.json`, 21
  vectors) shared for downstream ports
- [x] Offline consistency test (mock stream): fold ≡ `buildRpcSessionState`
  across streaming, steering, thinking level, modes, auto-compaction, model
  change, rename, compaction, summarizing tree navigation; plus
  branch-summary event-pair test and extension-observability test
- [x] Docs: `pi-rpc-socket-mode.md` session_changed payload;
  `extensions.md` new event sections
- [x] `npm run check` clean; full test suite: only pre-existing failures
  (verified identical on clean tree via stash)

## Implementation-Time Decisions

- **TUI double-display fix via skip, not reason widening**: the tree-
  navigation flow already shows `BranchSummaryStatusIndicator` and manages
  its own escape handler, so `interactive-mode.ts`'s `compaction_start`/
  `compaction_end` handlers `break` early on `reason === "branch-summary"`.
  This deviates from the spec's plan to widen `CompactionStatusReason`: the
  early return narrows the type, so the TUI indicator union stays unchanged
  — smaller delta, no unreachable display text. Without the skip, the
  generic handler would also have hijacked the editor escape handler to
  `abortCompaction()`, which cannot cancel a branch summary.
- **`buildRpcSessionState` lives in `rpc-state-fold.ts`** next to the fold
  it must stay in sync with (type-only import of `AgentSession`).
- **Fold compares models with `modelsAreEqual`** (provider + id) for the
  identity-return optimization — wire deserialization makes reference
  equality useless, and it mirrors the emit-site guard.
- **Vector conventions**: input = `baseState` overridden by `state`;
  `expected` lists only changed fields (`null` ⇒ becomes `undefined`; empty
  ⇒ fold must return the input by reference); `expectedFullState` replaces
  the whole comparison (session_changed).
- **Reload resync emits reach the pre-reload extension runner**: in
  `reload()`, the mode/auto-compaction extension events fire after
  `session_shutdown` but before `_buildRuntime` swaps in the new runner, so
  they go to the shutting-down extension instances. Harmless (restarted
  extensions read fresh state via `session_start`), and socket clients —
  the ones that need these events — always get them.
- **Branch-summary compaction pair scope**: emitted only when
  `options.summarize` and there are entries to summarize, per spec. The
  `isCompacting` getter is technically true for all of `navigateTree`
  (abort controller spans it), so brief non-summarizing navigations remain
  eventless — mid-operation staleness the contract already tolerates.

- 2026-07-20: Implementation completed (tasks and decisions above). All new
  tests pass; repo `npm run check` clean; the 6 failing test files in the
  full suite fail identically without these changes (environment-related,
  pre-existing).
- 2026-07-20: Session-replacement decision (Anton): `session_changed` is
  fork-only, so change its payload to a full `RpcSessionState` (pushed
  re-seed) instead of documenting a client-side `get_state` re-seed.
  Consequences folded into SPEC: connect-time seed comes free (event is sent
  after hello) and `buildRpcSessionState` is promoted into the type design.
  Anton: keep the `sessionId !== previousSessionId` broadcast guard — no
  redundant `session_changed`; same-id rebinds rely on the per-field events.
  Also confirmed extensions need no `session_changed` equivalent (runtime
  teardown/restart with `session_shutdown`/`session_start` covers it).
- 2026-07-20: Critique pass: verified `compaction_end.willRetry` is not an
  `agent_end`-style mid-run signal (compaction is always over at
  `compaction_end`); found the unpaired `compaction_end` at
  `agent-session.ts:1980` (harmless under idempotent fold); confirmed
  `RpcSessionState` is already exported via `modes/index.ts` but
  `RpcSocketBroadcastEvent` is not yet.
- 2026-07-20: Spec written after derisking discussion. Decisions: drop
  `messageCount` from foldable contract; `model_changed` session event (not
  `model_select` name reuse) per paired-naming precedent; `"branch-summary"`
  compaction reason; extension visibility for the three mode/toggle events;
  preserve-and-document the `sendCustomMessage` queue bypass.
