# Handoff: make `RpcSessionState` foldable from the RPC event stream

## Goal

RPC socket clients currently re-poll `get_state` on every
boundary event because the event stream does not carry enough information to
maintain `RpcSessionState` locally. Two changes fix this:

1. **Emit the missing events** so every `RpcSessionState` field change is
   observable on the socket.
2. **Ship the fold in this repo**: a pure function
   `nextSessionState(state, event)` that clients run over the broadcast
   stream after one initial `get_state`, so the state-tracking logic lives
   next to the state machine it encodes instead of being reverse-engineered
   by every client.

Full field-by-field derisking (which events change which field, payload
sufficiency, silent-mutation paths, with file:line refs) was done in a
downstream client repo ("Derisking findings (2026-07-15)").
That analysis was done against the fork's shipped dist
(0.80.6-fork.0); the upstream source refs below were spot-verified in this
repo. Do not duplicate that table here — read it.

## Current state (verified in this repo's source)

`RpcSessionState` is defined at
`packages/coding-agent/src/modes/rpc/rpc-types.ts:103` and built by the
`get_state` handler at
`packages/coding-agent/src/modes/rpc/rpc-command-handler.ts:131`.

Foldable today: `isStreaming` (`agent_start` → true, `agent_settled` → false
— NOT `agent_end`, which fires mid-run on retries; `agent-session.ts:544`),
`thinkingLevel` (`thinking_level_changed`, `agent-session.ts:1651`),
`sessionName` (`session_info_changed`, `agent-session.ts:2785`),
`sessionId`/`sessionFile` (`session_changed`, emitted by rpc-socket-mode),
`pendingMessageCount` (`queue_update` carries full arrays,
`agent-session.ts:515`), and `isCompacting` via paired
`compaction_start`/`compaction_end` — except during `navigate_tree` branch
summarization, which sets the compacting flag with no compaction events.

Silent — change with NO socket event:

- `model`: `_emitModelSelect` (`agent-session.ts:1525`) goes only to the
  extension runner, never `_emit`. TUI Ctrl+P / `/model` and RPC
  `set_model`/`cycle_model` are all invisible to other socket clients.
- `steeringMode` / `followUpMode`: plain setters, no emit
  (`agent-session.ts:1719`, `:1728`); settings reload re-syncs silently.
- `autoCompactionEnabled`: settings write only (`agent-session.ts:2173`).
- `messageCount`: bash results push to `state.messages` with no event
  (`recordBashResult`/`_flushPendingBashMessages`,
  `agent-session.ts:2715,2762`, call `sessionManager.appendMessage`
  directly); compaction replaces the message list wholesale and
  `compaction_end` carries no count; retry/overflow drop the trailing error
  message; `tree_navigated` rebuilds messages but carries only leaf ids.
  Note `entry_appended` does NOT cover this today: its only emit site is the
  extension runner's `appendEntry` binding (`agent-session.ts:2334`), i.e.
  extension custom entries only — and session entries are not context
  messages, so even a widened `entry_appended` covers appends but not the
  rewrite paths.

Ordering is already fold-safe: `_emit` enqueues synchronously into each
client's FIFO, so broadcast order equals emit order. A `get_state` response
can be ~one microtask stale vs. events already on the wire (async handler
gap in `rpc-socket-mode.ts`), so the fold must tolerate re-applying an event
already reflected in the seed — keep all event payloads absolute values, not
deltas, and this is harmless.

## Work item 1: new/changed events

- Broadcast model changes: either `_emit` a new
  `{ type: "model_changed", model }` alongside `_emitModelSelect`, or
  promote `model_select` to `_emit`. Payload must carry the new model value
  (note `RpcSessionState.model` is `Model<any>` — decide what serializes;
  clients mostly want provider/id).
- `{ type: "steering_mode_changed", mode }` and
  `{ type: "follow_up_mode_changed", mode }` from the setters and from the
  settings-reload resync path.
- `{ type: "auto_compaction_changed", enabled }`.
- `messageCount`: pick one —
  (a) widen `entry_appended` (today emitted only for extension custom
  entries, `agent-session.ts:2334`) to fire on every session append
  including bash results — that covers the append side — AND include the
  new message count on the state-rewriting events (`compaction_end`,
  `tree_navigated`), since rewrites bypass appends entirely; or
  (b) drop `messageCount` from the foldable contract (documented staleness,
  refresh on `compaction_end`/`tree_navigated`). Check what consumers
  actually need before choosing (a) — it is the only expensive item.
- Decide whether `navigate_tree` branch summarization should emit
  `compaction_start`/`compaction_end` (it holds `isCompacting` true today
  with no events).
- Known caveat to preserve or fix: steering via `sendCustomMessage` bypasses
  the queue arrays, so it never appears in `queue_update`.

## Work item 2: the fold, in this repo

```ts
export const INITIAL_RPC_SESSION_STATE_SEED: /* decide: seed comes from get_state, so maybe none */;
export function nextSessionState(
  state: RpcSessionState,
  event: RpcSocketBroadcastEvent,
): RpcSessionState;
```

Design rules (learned in clauctl's daemon refactor,
`../clauctl/docs/specs/daemon-architecture.md`, and directly applicable):

- Free function over a plain readonly wire type — classes don't survive
  JSON; server-side and client-side values must be the same kind of thing.
- Seed-then-fold contract: client calls `get_state` once at connect, then
  folds every subsequent broadcast event. Document the microtask-staleness
  tolerance (absolute payloads ⇒ idempotent re-application).
- The fold's transition table belongs in the spec as a table, not prose.
- Fold tests prove bookkeeping, not external-world facts — state test
  claims honestly.
- Consider having the server assert (in tests or a debug mode) that folding
  its own emitted stream reproduces `get_state` — that pins the events and
  the fold together and catches drift when new state/events are added.

Where it lives: next to `rpc-types.ts` (it is protocol, not session
internals). Export it from the package so TS clients import it rather than
copying. Clients in other languages maintain their own ports of the
state-tracking logic; shared test vectors (JSON in / JSON out) would let
those ports prove equivalence — worth exporting the fold tests' vectors as
data.

## Suggested skills

- `/spec` — start with a spec in this repo before implementing; the type
  design (event shapes, fold signature) should be agreed before code.
- `/reviewer` — critique the spec; the transition-table completeness and
  the messageCount decision are where a reviewer earns their keep.
