# Commit: Implementation of --rpc-socket (pi-tee)

Intent: support the tee use case with minimal changes to pi itself by adding `pi --rpc-socket <path>` as an interactive-mode sidecar RPC socket.

Main spec/work log: `docs/pi-rpc-socket-mode.md`.

## Expected conflict surface

- CLI parsing/help for `--rpc-socket`
  - `packages/coding-agent/src/cli/args.ts`
- runtime lifecycle listener fan-out
  - `packages/coding-agent/src/core/agent-session-runtime.ts`
  - `packages/coding-agent/src/modes/print-mode.ts`
  - `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
  - `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- interactive startup wiring
  - `packages/coding-agent/src/main.ts`
- mode exports
  - `packages/coding-agent/src/modes/index.ts`
- RPC socket implementation and command sharing
  - `packages/coding-agent/src/modes/rpc/rpc-command-handler.ts`
  - `packages/coding-agent/src/modes/rpc/rpc-socket-mode.ts`
  - `packages/coding-agent/src/modes/rpc/rpc-types.ts`
- docs and smoke-test example
  - `docs/pi-rpc-socket-mode.md`
  - `packages/coding-agent/docs/rpc.md`
  - `packages/coding-agent/examples/README.md`
  - `packages/coding-agent/examples/rpc-socket-tee.ts`

Treat conflicts outside this surface as suspicious and explain them before editing.

## Semantic invariants

- `--rpc-socket` is interactive-only and incompatible with:
  - `--mode rpc`
  - `--mode json`
  - `--print` / `-p`
- `--rpc-socket` must fail instead of falling back to print mode when TTY interaction is unavailable.
- Interactive mode remains the sole owner of extension UI.
- Socket clients do not handle `extension_ui_request` / `extension_ui_response`.
- Socket clients receive `ui_wait_start` / `ui_wait_end` visibility events instead.
- Human editor state must not be clobbered by socket-originated prompts.
- Runtime/session replacement must keep socket clients connected and rebound.
- The socket server should remain a sidecar helper, not a broad transport refactor.

## Typical `main.ts` conflict pattern

`packages/coding-agent/src/main.ts` is likely to conflict because upstream often changes startup flow while this commit wires in `runRpcSocketServer`.

Preferred resolution pattern:

- Keep upstream imports and startup/project-trust behavior.
- Add `runRpcSocketServer` to the existing modes import.
- Keep upstream helpers such as `isPlainRuntimeMetadataCommand(...)`.
- Keep or re-add `validateRpcSocketFlags(...)`.
- Validate both `process.stdin.isTTY` and `process.stdout.isTTY` if upstream app-mode resolution considers both.
- Do not duplicate app-mode initialization. Use upstream's latest `resolveAppMode(...)` call.
- Insert RPC socket validation immediately before final app-mode calculation.
- In the interactive branch, keep the socket server wiring:
  - create `rpcSocketServer` when `parsed.rpcSocket` is present
  - pass `sideChannelEventSink` to `InteractiveMode`
  - pass `beforeShutdown` to close/unlink the socket on graceful shutdown
  - close it in startup benchmark cleanup paths

## Typical `rpc-mode.ts` conflict pattern

Upstream may keep a large inline RPC command switch while this commit extracts command handling to `rpc-command-handler.ts` so stdin/stdout RPC mode and socket RPC mode can share command semantics.

Preferred resolution:

- Keep transport-specific code in `rpc-mode.ts`.
- Keep shared command semantics in `rpc-command-handler.ts`.
- Ensure `rpc-command-handler.ts` includes upstream behavior changes from the inline switch.
- Preserve unknown-command behavior from upstream, including whether the response id is `undefined`.
- Ensure session replacement commands keep RPC transports rebound through `AgentSessionRuntime` rebind listeners.

If it is not obvious whether an upstream command behavior belongs in the shared handler or only stdio RPC mode, stop and ask the user.
