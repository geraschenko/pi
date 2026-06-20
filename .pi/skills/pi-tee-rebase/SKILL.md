---
name: pi-tee-rebase
description: Resolve and verify rebases of Anton's long-lived anton/pi-tee branch for interactive --rpc-socket support. Use when a user asks for help after rebasing pi-tee on upstream/main, especially to inspect or resolve merge conflicts while preserving minimal fork drift.
---

# Pi Tee Rebase Skill

Use this skill when working on Anton's long-lived `anton/pi-tee` branch, whose purpose is to keep a minimal fork patch for interactive pi plus an out-of-band RPC socket (`pi --rpc-socket <path>`).

## Fixed facts for this branch

- Current repo path: `/home/anton/git/earendil-works/pi`
- Branch intent: support the "tee" use case with minimal changes to pi itself.
- The main spec/work log is `docs/pi-rpc-socket-mode.md`.
- The implementation is intentionally narrow and should remain easy to rebase.
- The user may want to run `git rebase --continue` themselves. Do not run it unless explicitly asked.
- Ignore unrelated untracked local files unless the user asks about them.

## Important upstream conventions

Upstream has moved to:

- package names such as `@earendil-works/pi-ai`
- relative TypeScript imports ending in `.ts`, not `.js`

When resolving conflicts, do **not** resurrect older fork-side imports like:

- `@mariozechner/...`
- relative imports ending in `.js`

Preserve upstream's newer surrounding architecture unless the socket feature specifically needs a hook.

## Pi-tee change surface

The branch is expected to touch these areas:

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
- final fork packaging commit
  - `packages/coding-agent/package.json`
  - `packages/coding-agent/npm-shrinkwrap.json`
  - `package-lock.json`
  - `.pi/skills/publish-pi-coding-agent-fork/`

Treat conflicts outside this surface as suspicious and explain them before editing.

## Rebase conflict workflow

Always start with:

```bash
cd /home/anton/git/earendil-works/pi
git status --short
git diff --name-only --diff-filter=U
rg -n '<<<<<<<|=======|>>>>>>>' .
```

Then:

1. Read each conflicted file completely enough to understand upstream context.
2. Explain the conflict to the user before editing if the user asked for explanation or if the resolution is non-obvious.
3. Prefer upstream structure and add the smallest pi-tee hook needed.
4. Resolve conflict markers with precise edits.
5. Run:

```bash
cd /home/anton/git/earendil-works/pi
rg -n '<<<<<<<|=======|>>>>>>>' .
git diff --name-only --diff-filter=U
```

6. Run checks:

```bash
cd /home/anton/git/earendil-works/pi
npm run check
```

7. If checks pass, stage only the resolved conflicted files:

```bash
git add <resolved-files>
```

8. Report status and remind the user to run `git rebase --continue` themselves unless they asked you to do it.

## Final fork packaging commit conflicts

The last fork-only commit may conflict with upstream release metadata. For `packages/coding-agent/package.json`, keep upstream package contents and dependency versions, then reapply only the fork identity:

- `name`: `@geraschenko/pi-coding-agent`
- `version`: `<current-upstream-version>-fork.N`

Do not hand-merge large generated metadata conflicts. For `package-lock.json` and `packages/coding-agent/npm-shrinkwrap.json`, resolve enough to continue by taking upstream as the temporary base, update `package.json`, then regenerate using the publish skill script after the rebase:

```bash
.pi/skills/publish-pi-coding-agent-fork/verify-before-publish.sh
```

Before publishing, verify the package name spelling exactly: `@geraschenko/pi-coding-agent`.

## Typical `main.ts` conflict pattern

`packages/coding-agent/src/main.ts` is likely to conflict because upstream often changes startup flow while pi-tee wires in `runRpcSocketServer`.

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

## Semantic invariants to preserve

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

## Verification commands

After resolving conflicts and running `npm run check`, a useful manual smoke test is:

```bash
cd /home/anton/git/earendil-works/pi
sock=/tmp/pi-rpc-test.sock
rm -f "$sock"
tmux kill-session -t pi-rpc-test 2>/dev/null || true
tmux new-session -d -s pi-rpc-test -x 80 -y 24 \
  'cd /home/anton/git/earendil-works/pi && node --import tsx packages/coding-agent/src/cli.ts --offline --no-session --rpc-socket /tmp/pi-rpc-test.sock'
sleep 5
ls -l "$sock"
python - <<'PY'
import socket
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.connect('/tmp/pi-rpc-test.sock')
file = sock.makefile('rwb', buffering=0)
print(file.readline().decode().strip())
file.write(b'{"id":"1","type":"get_state"}\n')
print(file.readline().decode().strip())
sock.close()
PY
tmux kill-session -t pi-rpc-test 2>/dev/null || true
rm -f "$sock"
```

Expected:

- socket path exists while pi is running
- permissions look like `srw-------`
- first record is `{"type":"hello","protocol":"pi-rpc-socket","version":1}`
- `get_state` returns a successful response

Sidecar example smoke test:

```bash
cd /home/anton/git/earendil-works/pi
sock=/tmp/pi-rpc-test.sock
rm -f "$sock"
tmux kill-session -t pi-rpc-test 2>/dev/null || true
tmux new-session -d -s pi-rpc-test -x 80 -y 24 \
  'cd /home/anton/git/earendil-works/pi && node --import tsx packages/coding-agent/src/cli.ts --offline --no-session --rpc-socket /tmp/pi-rpc-test.sock'
sleep 5
timeout 3s node --import tsx packages/coding-agent/examples/rpc-socket-tee.ts /tmp/pi-rpc-test.sock || true
tmux kill-session -t pi-rpc-test 2>/dev/null || true
rm -f "$sock"
```

Expected: the sidecar prints the hello record.

## Reporting format

When done, report concisely:

- conflicted files found
- how each conflict was resolved
- whether `npm run check` passed
- whether files were staged
- that the user can now run `git rebase --continue`
