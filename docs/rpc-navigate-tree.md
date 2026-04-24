# Gap: no RPC equivalent of `/tree` navigation

## The problem

The interactive TUI's `/tree` command lets a user reset the tip of the conversational branch *within the current session*: it calls `AgentSession.navigateTree(targetId)`, which moves the leaf inside the existing `SessionManager` (optionally appending a branch-summary entry) and rebuilds agent state. Same session file, same `sessionId` — no session replacement.

There is currently no way to do this over RPC. The session-rewind commands RPC does offer all *replace* the session:

- `fork` (`runtimeHost.fork(entryId)`, position `"before"`) — creates a new session file branched from the chosen point.
- `clone` (`runtimeHost.fork(leafId, { position: "at" })`) — same, branched at the current leaf.

For persisted sessions both always mint a new session id and file (`createBranchedSession` / `SessionManager.create` in `session-manager.ts`). So an RPC client that wants `/tree` semantics — "rewind/move the tip, keep the same session file and lineage" — cannot get them; the closest available operations fragment the history into new files and (in tee mode) trigger `session_changed` churn for every observer.

This matters for tee-mode (`--rpc-socket`) clients in particular: `get_tree` and `get_entries` already expose the full session tree, so a client can *display* tree navigation but cannot *perform* it.

## The fix

Add a `navigate_tree` RPC command that calls `AgentSession.navigateTree`:

```json
{ "id": "1", "type": "navigate_tree", "targetId": "<entry id>" }
```

with optional `summarize` / `customInstructions` passthrough, and a response carrying `navigateTree`'s result (notably `editorText`, which the TUI uses to prefill the editor; an RPC client can use or ignore it).

### Valid target ids

`navigateTree` accepts any entry id resolvable by `sessionManager.getEntry(targetId)` — i.e. any `SessionEntry.id` in the current session. RPC already exposes these: `get_entries` returns `SessionEntry[]` and `get_tree` returns `SessionTreeNode[]` (each node wrapping a `SessionEntry`), so clients already have everything needed to choose a target. Semantics by entry type:

- **User message or `custom_message`**: the new leaf becomes the entry's *parent* (the conversation rewinds to just before the message), and the message text is returned as `editorText` so it can be edited and re-sent.
- **Any other entry**: the new leaf becomes the entry itself.

Navigating to the current leaf is a no-op.
