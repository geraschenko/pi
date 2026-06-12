# Gap: no RPC equivalent of `/tree` navigation

> **Status (2026-06-11): implemented.** The `navigate_tree` command, the `tree_navigated` session event (with TUI consolidation onto it), and the streaming/compacting guard in `AgentSession.navigateTree` are in place. The companion fixes below (fork/clone guards, `session.prompt` compaction handling) remain open.

## The problem

The interactive TUI's `/tree` command lets a user reset the tip of the conversational branch *within the current session*: it calls `AgentSession.navigateTree(targetId)`, which moves the leaf inside the existing `SessionManager` (optionally appending a branch-summary entry) and rebuilds agent state. Same session file, same `sessionId` — no session replacement.

There is currently no way to do this over RPC. The session-rewind commands RPC does offer all *replace* the session:

- `fork` (`runtimeHost.fork(entryId)`, position `"before"`) — creates a new session file branched from the chosen point.
- `clone` (`runtimeHost.fork(leafId, { position: "at" })`) — same, branched at the current leaf.

For persisted sessions both always mint a new session id and file (`createBranchedSession` / `SessionManager.create` in `session-manager.ts`). So an RPC client that wants `/tree` semantics — "rewind/move the tip, keep the same session file and lineage" — cannot get them; the closest available operations fragment the history into new files and (in tee mode) trigger `session_changed` churn for every observer.

This matters for tee-mode (`--rpc-socket`) clients in particular: `get_tree` and `get_entries` already expose the full session tree, so a client can *display* tree navigation but cannot *perform* it.

## The fix

Add a `navigate_tree` RPC command that calls `AgentSession.navigateTree` and mirrors it exactly — same options, same result:

```json
{ "id": "1", "type": "navigate_tree", "targetId": "<entry id>", "summarize": true, "customInstructions": "...", "replaceInstructions": false, "label": "..." }
```

All options besides `targetId` are optional passthroughs to `navigateTree`. The response `data` is the full `NavigateTreeResult`: `{ editorText?, cancelled, aborted?, summaryEntry? }`. `editorText` is what the TUI uses to prefill the editor when the target is a user message; an RPC client can use or ignore it. `cancelled: true` can come from an extension's `session_before_tree` handler, `aborted: true` from summarization being aborted.

### Valid target ids

`navigateTree` accepts any entry id resolvable by `sessionManager.getEntry(targetId)` — i.e. any `SessionEntry.id` in the current session. RPC already exposes these: `get_entries` returns `SessionEntry[]` and `get_tree` returns `SessionTreeNode[]` (each node wrapping a `SessionEntry`), so clients already have everything needed to choose a target. Semantics by entry type:

- **User message or `custom_message`**: the new leaf becomes the entry's *parent* (the conversation rewinds to just before the message), and the message text is returned as `editorText` so it can be edited and re-sent.
- **Any other entry**: the new leaf becomes the entry itself.

Navigating to the current leaf is a no-op.

## Implementation notes

### Both directions of the visibility problem must be solved

`navigateTree` today notifies nobody: it emits only the `session_tree` *extension* event, nothing via `session.subscribe`. This cuts both ways in tee mode:

- **RPC → TUI**: a socket-initiated `navigate_tree` changes `agent.state.messages` underneath the interactive TUI, which keeps rendering the stale branch. The TUI currently re-renders only inside its own `/tree` handler (`interactive-mode.ts`, `showTreeSelector`).
- **TUI → RPC**: an interactive `/tree` is invisible to socket clients. Navigation appends no entry (unless summarizing), so clients cannot even infer it until the next prompt lands with an unexpected parent.

Design: emit a new `AgentSessionEvent` from `navigateTree`:

```json
{ "type": "tree_navigated", "oldLeafId": "<id|null>", "newLeafId": "<id|null>", "summaryEntry": { } }
```

The payload mirrors the `session_tree` extension event minus `fromExtension`: that flag records whether the branch summary text came from an extension's `session_before_tree` handler, and it is already persisted on the summary entry as `fromHook`, so `summaryEntry` carries it.

Socket mode forwards all session events, so broadcast comes for free. Interactive mode handles the event — regardless of who triggered the navigation — by re-rendering the conversation (`chatContainer.clear()` + `renderInitialMessages()`) and flushing its compaction message queue (messages the user typed while the branch summary was streaming; `isCompacting` is true then, so the TUI queues rather than sends). The two existing explicit re-render sites (the `/tree` selector handler and the TUI's `commandContextActions.navigateTree` wrapper for extensions) drop their re-render and flush calls — one code path for the interactive, extension, and RPC cases. Interaction-specific behavior (editor prefill, status message, summary loader) stays in the TUI's `/tree` handler.

**Ordering:** `AgentSession._emit` is synchronous and fires inside `navigateTree` before it returns (after agent state is rebuilt and the `session_tree` extension emit has completed). The TUI must perform its re-render in the synchronous part of its subscribe listener so it completes before code following `await navigateTree(...)` runs — same ordering as today's explicit re-render, with no race and no double render. The listener currently dispatches through an async `handleEvent`; the `tree_navigated` re-render needs to be handled synchronously (with a comment stating the ordering requirement) rather than relying on the async function happening to have no await before the switch. The compaction-queue flush stays fire-and-forget, as it is today.

`navigate_tree` must **not** emit `session_changed`: the session id and file are unchanged.

Because the handler is shared, `navigate_tree` is also available in stdio `--mode rpc`, and `tree_navigated` appears on stdout there like any other session event. This is intended: command and event semantics are identical across both transports, matching the compatibility objective in `docs/pi-rpc-socket-mode.md`.

### Streaming/compacting guard

Navigation rewrites agent state in place, which is undefined behavior while a stream or compaction is rewriting it too. The guard belongs in `AgentSession.navigateTree` itself, not the RPC handler: it must throw at entry when `isStreaming || isCompacting`, covering all callers at once — RPC, the TUI `/tree` path (which currently has no streaming guard of its own), and extensions via `ctx.navigateTree`. The error surfaces to RPC clients as a failure response through the existing catch in both transports. Note `isCompacting` includes a branch summary in flight; the guard runs before `navigateTree` sets its own summary abort controller, so it doesn't block itself.

### Companion fixes (separate commits, not part of this change)

- The RPC `fork`/`clone` handlers (`rpc-command-handler.ts`) have no streaming/compacting guard and will tear down a live session mid-stream.
- `session.prompt` has no `isCompacting` handling: an RPC `prompt` sent during compaction proceeds immediately and races with compaction's state rewrite. (The interactive TUI sidesteps this by checking `isCompacting` itself and holding messages in its own queue — RPC clients get no such courtesy. The eventual fix should likely live in `AgentSession` so all channels are treated alike.)

### Where the pieces go

- Guard and `tree_navigated` event: `AgentSession.navigateTree` and the `AgentSessionEvent` union in `agent-session.ts`.
- TUI event handling (re-render + compaction-queue flush): the session subscribe listener in `interactive-mode.ts`; remove the explicit re-render/flush from the `/tree` selector handler and `commandContextActions.navigateTree`.
- Command/response types: the `RpcCommand` / `RpcResponse` unions in `rpc-types.ts`.
- Handler: `rpc-command-handler.ts`, which is shared by `--mode rpc` (stdio) and `--rpc-socket` — one handler covers both transports. `fork` / `get_entries` / `get_tree` are the precedent to copy.
- Docs to update: `packages/coding-agent/docs/rpc.md`, `docs/pi-rpc-socket-mode.md` (the `tree_navigated` broadcast and its non-interaction with `session_changed`), and this file once the gap is closed.
