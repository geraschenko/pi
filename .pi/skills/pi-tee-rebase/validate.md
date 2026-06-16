# End-of-rebase validation

Run after the rebase is complete and conflicts have been resolved.

## Required checks

```bash
cd /home/anton/git/earendil-works/pi
npm run check
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
- `get_state` returns a successful response

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
