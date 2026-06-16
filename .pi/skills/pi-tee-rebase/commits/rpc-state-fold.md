# Commit: Implement RpcSessionState fold function.

Intent: make `RpcSessionState` foldable from the RPC broadcast stream so
socket clients can maintain state locally instead of re-polling `get_state`.
Two parts: (1) new events for previously-silent state mutations, (2) a pure
fold `nextSessionState(state, event)` exported from the package.

Spec/work log: `docs/rpc-state-fold-spec.md` (supersedes
`docs/handoff-rpc-state-fold.md`). Read the spec's contract and transition
table before resolving non-trivial conflicts.

## Expected conflict surface

- new session events and emit sites
  - `packages/coding-agent/src/core/agent-session.ts`
- new extension events (interfaces, union, `on()` overloads, exports)
  - `packages/coding-agent/src/core/extensions/types.ts`
  - `packages/coding-agent/src/core/extensions/index.ts`
- TUI skip of branch-summary compaction events
  - `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- fold + state builder (new file, conflicts only if upstream adds one nearby)
  - `packages/coding-agent/src/modes/rpc/rpc-state-fold.ts`
- `session_changed` payload and `get_state` construction
  - `packages/coding-agent/src/modes/rpc/rpc-types.ts`
  - `packages/coding-agent/src/modes/rpc/rpc-socket-mode.ts`
  - `packages/coding-agent/src/modes/rpc/rpc-command-handler.ts`
- package exports
  - `packages/coding-agent/src/index.ts`
  - `packages/coding-agent/src/modes/index.ts`
- docs and tests
  - `docs/rpc-state-fold-spec.md`, `docs/handoff-rpc-state-fold.md`
  - `docs/respond-stringify-hardening-handoff.md` (unrelated handoff doc
    that rode along in this commit; fork-only, keep as-is)
  - `docs/pi-rpc-socket-mode.md`
  - `packages/coding-agent/docs/extensions.md`
  - `packages/coding-agent/test/rpc-state-fold.test.ts`
  - `packages/coding-agent/test/rpc-state-fold-vectors.json`
  - `packages/coding-agent/test/rpc-state-fold-consistency.test.ts`

## Semantic invariants

- **Seed-then-fold contract**: `session_changed` carries a full
  `RpcSessionState` (`state` field); `get_state` yields an equivalent seed.
  All event payloads are absolute values, never deltas, so re-applying an
  event already reflected in the seed is idempotent.
- **`buildRpcSessionState` is the single source of truth** for constructing
  `RpcSessionState`. The `get_state` handler, `sessionChangedEvent()` in
  `rpc-socket-mode.ts`, and the consistency test must all use it — do not
  resurrect inline object literals from upstream's `get_state` handler.
- **Fold ≡ get_state**: folding the emitted stream over a seed must match
  `buildRpcSessionState` at quiescent points for every field except
  `messageCount` (deliberately excluded from the contract). The consistency
  test (`rpc-state-fold-consistency.test.ts`) pins this — it must pass after
  resolution.
- `isStreaming` clears on `agent_settled`, NOT `agent_end` (`agent_end`
  fires mid-run on retries). The fold ignores `agent_end` entirely.
- New events emit **only on actual change** (matching the
  `thinking_level_changed` precedent): `model_changed`,
  `steering_mode_changed`, `follow_up_mode_changed`,
  `auto_compaction_changed`. Setters AND the settings-reload resync paths
  emit; mode changes go through `_applySteeringMode`/`_applyFollowUpMode`.
- Compaction reason unions on `compaction_start`/`compaction_end` include
  `"branch-summary"`; `navigateTree` emits the pair around summarization
  (start only when summarizing with entries to summarize; end in a
  `finally`). The extension compaction events keep their narrower reason
  union.
- The TUI's `compaction_start`/`compaction_end` handlers `break` early on
  `reason === "branch-summary"` — the tree-navigation flow has its own
  indicator and escape handling, and the generic handler's escape hijack
  cannot cancel a branch summary. Keep this skip.
- The socket rebind listener keeps its `sessionId !== previousSessionId`
  guard — no redundant `session_changed` broadcasts.
- The fold returns its input **by reference** when an event changes nothing
  (clients rely on this for cheap change detection); models are compared
  with `modelsAreEqual`, not reference equality.

## Typical conflict patterns

- `agent-session.ts` event union and emit sites: upstream frequently adds
  its own `AgentSessionEvent` members and reworks setters. Keep upstream's
  additions and re-add the fork events/emits on top. If an upstream change
  moves or replaces a fork emit site (e.g. restructures
  `syncQueueModesFromSettings`, `setAutoCompactionEnabled`, `reload()`, or
  `navigateTree`), relocate the emit so the invariant "no
  `RpcSessionState` field changes without a broadcast event" still holds.
- `extensions/types.ts`: keep the fork interfaces and `on()` overloads next
  to upstream's current overload block; exports in
  `extensions/index.ts`/`src/index.ts` are alphabetized.
- If upstream adds new `RpcSessionState` fields, extend
  `buildRpcSessionState`, the fold's transition table, the vectors'
  `baseState`, and the spec together — the consistency test will catch a
  missed one, but only if the field is exercised; when in doubt, ask.
- If upstream itself introduces a similar event (e.g. its own
  `model_changed`), stop and ask before choosing which shape wins — the
  wire protocol has downstream consumers.
