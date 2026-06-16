# Commit: Process images sent through rpc mode the same as interactive mode

Intent: make RPC image inputs follow the same preprocessing path as interactive image inputs.

## Expected conflict surface

- RPC command handling files:
  - `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
  - `packages/coding-agent/src/modes/rpc/rpc-command-handler.ts` if present
  - `packages/coding-agent/src/modes/rpc/rpc-types.ts`
- Image processing utilities used by interactive mode
- Tests for prompt response semantics or image inputs

## Resolution guidance

- Prefer upstream's latest image preprocessing helpers.
- Do not create a separate RPC-only image processing path if interactive mode already has one.
- Preserve RPC command payload compatibility for existing clients.
- Ensure `prompt`, `steer`, and `follow_up` image handling stays consistent where those commands support images.
- If shared command handling exists, keep the image preprocessing in the shared handler or shared helper rather than transport code.

If upstream changed image input formats or added new media handling, stop and ask before choosing a compatibility strategy.
