# Commit: Add navigate_tree rpc command

Intent: allow an RPC client to navigate the session tree, optionally summarizing or applying custom instructions.

## Expected conflict surface

- `packages/coding-agent/src/core/agent-session-runtime.ts`
- `packages/coding-agent/src/modes/rpc/rpc-types.ts`
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
- `packages/coding-agent/src/modes/rpc/rpc-command-handler.ts` if present
- `docs/rpc-navigate-tree.md`
- `docs/rpc-session-tree-commands.md`
- RPC docs/tests that enumerate commands

## Resolution guidance

- Prefer upstream's latest session/navigation architecture.
- Keep the RPC command as a small wrapper over the session/runtime navigation API.
- If shared RPC command handling exists, put `navigate_tree` in `rpc-command-handler.ts` and keep transports thin.
- Preserve options for summarization, custom instructions, replacement instructions, and labels when present.
- Preserve cancellation semantics; response data should distinguish success from user cancellation.
- Ensure runtime/session replacement or rebinding still leaves socket clients connected where socket mode exists.

If upstream changed navigation semantics or session tree storage, stop and ask before translating the RPC command to the new API.
