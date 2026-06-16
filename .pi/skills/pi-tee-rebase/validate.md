# End-of-rebase validation

Run after the rebase is complete and conflicts have been resolved.

## Required checks

```bash
cd /home/anton/git/earendil-works/pi
npm run check
```

## RPC state fold tests

These pin the fold, the emit sites, and `buildRpcSessionState` together;
they are the drift detector for the `Implement RpcSessionState fold
function.` commit.

```bash
cd /home/anton/git/earendil-works/pi/packages/coding-agent
npx vitest run test/rpc-state-fold.test.ts test/rpc-state-fold-consistency.test.ts
```

Expected: all tests pass.

If the consistency test fails at import with `Cannot find module
'./data/<provider>.json'`: the model catalogs are generated, gitignored
files. Run:

```bash
cd /home/anton/git/earendil-works/pi/packages/ai
npm run hydrate-model-data
```

## RPC socket smoke test

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
- second record is a `session_changed` seed carrying a full
  `RpcSessionState` in its `state` field
- `get_state` returns a successful response (read past broadcast records to
  find the `"type":"response"` record)

If pi exits immediately (tmux session gone, no socket), check for extension
load failures by running pi under a pty; if local extensions broke against a
new upstream extension API, add `-ne` to the smoke-test invocations and
report the breakage to the user.

## Sidecar example smoke test

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
