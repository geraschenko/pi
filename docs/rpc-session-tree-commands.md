# Task: Add `get_entries` and `get_tree` RPC commands

Instructions for an implementing agent. You are starting with fresh context; everything you need is in this document plus the referenced source files. A human supervises this work and will personally create the GitHub issue and PR — your job is the code change and draft text for both.

## Background and motivation

pi's RPC mode (`pi --mode rpc`, documented in `packages/coding-agent/docs/rpc.md`) exposes session *messages* but not session *structure*:

- `get_messages` returns the current in-context message list — the root-to-leaf path with compaction applied. Pre-compaction messages and abandoned branches are invisible.
- `get_fork_messages` returns only user messages (`{entryId, text}`) as fork targets.
- There is no way for an RPC client to see the session entry tree that the interactive `/tree` command shows, or to do durable cursor-based catch-up.

Sessions are stored as an append-only tree of entries (`id`/`parentId`), where compaction, model changes, branch summaries, etc. are themselves entries. `SessionManager` already has read methods exposing this: `getEntries()` and `getTree()` (`packages/coding-agent/src/core/session-manager.ts`, search for those names; the `getEntries()` docstring confirms the append-only contract). This task exposes them over RPC.

Why orchestrators need this:

1. **Durable cursors.** An external orchestrator that crashes and resumes needs "all entries since entry X". Because entries are append-only with stable ids, an entry id is a perfect cursor — but only if entries are reachable over RPC. Events alone are ephemeral; `get_messages` loses history to compaction.
2. **Tree visibility.** If a human jumps the session to a different branch via `/tree`, or compaction runs, an RPC client should be able to observe what actually happened rather than inferring it.

This change is intentionally **read-only and minimal** to make upstreaming easy. Do not add tree-mutation commands (jump-to-entry already exists via `fork`).

## Branch strategy

This repo is a fork. `origin` is the fork (`geraschenko/pi`), `upstream` is `earendil-works/pi`. The local branch `anton/pi-tee` contains unrelated, not-yet-upstreamed work that this change must NOT depend on.

1. `git fetch upstream`
2. Create the working branch from upstream main: `git checkout -b rpc-get-entries-tree upstream/main`
3. Implement, test, commit on this branch.
4. After the human approves the change: rebase `anton/pi-tee` onto this branch (see "Rebase step" below).

## Specification

Two new commands, following the existing conventions in `packages/coding-agent/src/modes/rpc/rpc-types.ts` exactly.

### `get_entries`

Command:

```ts
| { id?: string; type: "get_entries"; since?: string }
```

Response:

```ts
| { id?: string; type: "response"; command: "get_entries"; success: true; data: { entries: SessionEntry[]; leafId: string | null } }
```

Semantics:

- Returns session entries in append (file) order, excluding the session header — i.e. exactly `sessionManager.getEntries()`.
- `since` (optional) is an entry id. When present, return only entries strictly **after** that entry in append order. The `since` entry itself is excluded.
- If `since` does not match any entry id, return a normal error response (`success: false` with a clear message). Do not throw.
- `leafId` is the current leaf entry id (`sessionManager.getLeafId()`), so a client can tell in one round trip whether the active branch moved.

### `get_tree`

Command:

```ts
| { id?: string; type: "get_tree" }
```

Response:

```ts
| { id?: string; type: "response"; command: "get_tree"; success: true; data: { tree: SessionTreeNode[]; leafId: string | null } }
```

Semantics:

- `tree` is exactly `sessionManager.getTree()` — an array of roots (a well-formed session has one root; orphaned entries also appear as roots, matching `getTree()`'s documented behavior).
- `leafId` as above.

`SessionEntry` and `SessionTreeNode` are existing exported types in `packages/coding-agent/src/core/session-manager.ts`. Import them as types into `rpc-types.ts` the same way other core types are imported there. Both serialize cleanly to JSON (entries originate from JSONL).

## Files to change

All paths relative to repo root. **Note:** on `upstream/main` the command dispatch lives in `rpc-mode.ts` (a large `switch` starting near line 390). There is no `rpc-command-handler.ts` on main — that file only exists on `anton/pi-tee`.

1. `packages/coding-agent/src/modes/rpc/rpc-types.ts`
   - Add the two commands to the `RpcCommand` union (a natural spot: next to `get_messages` / the Session group).
   - Add the two success responses to the `RpcResponse` union, mirroring the `get_messages` entry.
2. `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
   - Add `case "get_entries"` and `case "get_tree"` to the command switch. Mirror the style of the existing `get_fork_messages` (line ~604) and `clone` (line ~592) cases — `clone` shows how to reach `session.sessionManager`.
   - Keep the handlers trivial: fetch from `sessionManager`, apply `since` filtering for `get_entries`, return via the existing `success(...)`/error helpers.
3. `packages/coding-agent/docs/rpc.md`
   - Document both commands next to the existing `get_fork_messages` section (line ~658). Follow the existing format: short description, example command JSON, example response JSON. State the append-only/cursor property of `since` explicitly — it is the point of the feature.
4. `packages/coding-agent/test/rpc.test.ts`
   - Read the existing tests for `get_messages` / `get_fork_messages` first and follow their conventions and helpers exactly.
   - Cover at minimum:
     - `get_entries` on a session with a few messages returns them in order with stable ids, and `leafId` matches the last entry.
     - `get_entries` with `since` set to an early entry id returns only later entries.
     - `get_entries` with an unknown `since` returns `success: false`.
     - `get_tree` returns a single root whose chain matches the entries.
   - A compaction-spanning test is valuable if the existing test harness makes compaction easy to trigger; if it would require new test infrastructure, skip it and note that in your summary.

## Implementation notes

- `since` filtering: find the index of the entry with `id === since` in the `getEntries()` array, then `slice(index + 1)`. Linear scan is fine; sessions are small.
- Do not copy or transform entries — return what `getEntries()`/`getTree()` give you (they already return defensive copies).
- Keep the diff as small as possible. No refactoring of surrounding code, no extra helpers, no new files. This maximizes the chance of clean upstreaming and a painless `anton/pi-tee` rebase.
- Match the repo's formatting; `npm run check` runs biome with `--write` and will surface violations.

## Verification

From the repo root:

```bash
npm run check        # biome + type checks; this is the repo's main gate
```

From `packages/coding-agent/`:

```bash
npm run test         # vitest --run; or target: npx vitest --run test/rpc.test.ts
```

Both must pass before presenting the change.

## Issue and PR drafts (human will file these)

Issues and PRs for pi are created and managed by the human only. Provide them with this text, adjusted for anything that changed during implementation.

Issue draft:

> **Title:** RPC: expose session entries and tree (`get_entries`, `get_tree`)
>
> RPC clients can read the current in-context messages (`get_messages`) and fork targets (`get_fork_messages`), but not the underlying session entry tree. This makes two things impossible for external orchestrators: (1) durable catch-up — after a client restart, `get_messages` hides pre-compaction history, and events are ephemeral; (2) observing branch structure — `/tree` jumps and abandoned branches are invisible over RPC.
>
> Since sessions are append-only entry trees with stable ids, exposing read-only `get_entries` (with an optional `since` entry-id cursor) and `get_tree` (mirroring `SessionManager.getTree()`) gives clients durable cursors and full structural visibility with a very small change surface.

PR draft:

> **Title:** feat(coding-agent): add `get_entries` and `get_tree` RPC commands
>
> Adds two read-only RPC commands exposing existing `SessionManager` reads:
>
> - `get_entries` — all session entries in append order, with optional `since: entryId` cursor (strictly-after semantics, error on unknown id), plus current `leafId`.
> - `get_tree` — `getTree()` roots plus current `leafId`.
>
> Motivation: durable cursor-based catch-up and branch visibility for external RPC clients (see issue #___).
>
> Changes: `rpc-types.ts` (command/response unions), `rpc-mode.ts` (two switch cases), `docs/rpc.md`, tests in `test/rpc.test.ts`. No behavior changes to existing commands.

## Rebase step (after the change is approved)

`anton/pi-tee` must be rebased onto the new branch:

```bash
git rebase rpc-get-entries-tree anton/pi-tee
```

Expected conflict: `anton/pi-tee` extracts the rpc-mode command switch into `packages/coding-agent/src/modes/rpc/rpc-command-handler.ts`. Resolution: the new `get_entries`/`get_tree` cases must end up in `rpc-command-handler.ts` (the extracted location), using its `rpcSuccess`/`rpcError` helpers, and be removed from wherever the conflict leaves them in `rpc-mode.ts`. After the rebase, rerun `npm run check` and the coding-agent tests, and manually confirm `get_entries` works over a `--rpc-socket` connection (the socket mode shares the same command handler on that branch).

Pause and check in with the human before force-pushing any branch.
