# Commit: feat(coding-agent): add get_entries and get_tree RPC commands

Intent: expose session entry and tree state over RPC for external clients.

## Expected conflict surface

- `packages/coding-agent/src/modes/rpc/rpc-types.ts`
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
- `packages/coding-agent/src/modes/rpc/rpc-command-handler.ts` if the shared handler exists in the rebased stack
- RPC docs/tests that enumerate commands

## Resolution guidance

- Preserve upstream RPC command shapes and naming conventions.
- Add or retain `get_entries` and `get_tree` in the canonical RPC command type definitions.
- If command handling has been extracted to `rpc-command-handler.ts`, put command semantics there rather than duplicating them in transports.
- `get_entries` should support incremental reads with `since` when that exists in the fork side.
- `get_tree` should return tree data plus current leaf id when available.
- Keep response shapes stable for existing sidecar clients.

If upstream has added a newer session tree API with different naming or semantics, stop and ask the user before adapting the fork commands.
