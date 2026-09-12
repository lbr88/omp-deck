# omp-agent-host

An omp extension that turns any machine with `omp` into a **remote agent
host** for an omp-deck center: the center creates sessions on this machine,
streams them over WebSocket, lists models, and edits this machine's omp env —
all through a small HTTP+WS server started inside the omp process.

No binary, no build step, **no node_modules on the target machine**. The
extension runs inside `omp --mode rpc` and reuses the same SDK wiring the
deck's own in-process bridge uses (`session-core.ts`).

## Install (on the target machine)

```bash
# From a checkout of omp-deck (src/ is the whole deployable unit):
EXT=~/.omp/agent/extensions/omp-agent-host
mkdir -p "$EXT"
cp -r apps/agent-host/src/* "$EXT/"

# Token: openssl rand -hex 32
OMP_AGENT_HOST_TOKEN=<token> omp --mode rpc
```

`OMP_AGENT_HOST_TOKEN` is required — without it the extension logs a warning
and does not start the server. Other knobs:

| Env | Default | Meaning |
|---|---|---|
| `OMP_AGENT_HOST_PORT` | `8790` | HTTP/WS port |
| `OMP_AGENT_HOST_BIND` | `127.0.0.1` | Bind address (use the tailnet IP for remote access) |
| `OMP_AGENT_HOST_TOKEN` | — | Bearer token (required) |
| `OMP_AGENT_DIR` | `~/.omp/agent` | omp SDK session/auth dir |
| `OMP_AGENT_HOST_IDLE_TIMEOUT_MS` | `900000` | Reap unsubscribed idle sessions; `0` disables |
| `OMP_AGENT_HOST_DEFAULT_CWD` | `$HOME` | cwd when `POST /host/sessions` omits it |

`omp --mode rpc` with stdin closed (systemd) may exit immediately; keep it
alive with `tail -f /dev/null | omp --mode rpc` or run it under a PTY. See
`docs/multi-machine.md` for a systemd user unit.

## API

All REST endpoints except `GET /host/health` require
`Authorization: Bearer <token>`.

- `GET  /host/health` — liveness (no auth)
- `POST /host/sessions` — `{cwd, model?, suppressAutoStart?}` → `{sessionId, cwd}`
- `GET  /host/sessions` — persisted session summaries
- `DELETE /host/sessions/:id` — dispose
- `POST /host/sessions/:id/abort|compact|name|model|slash-dispatch|plan-response`
- `GET  /host/models` — model list with availability
- `GET  /host/env` / `PATCH /host/env` — managed env (`~/.config/omp-agent-host/host.env`)
- `WS   /host/ws` — deck session protocol; first frame must be
  `{"type":"auth","token":"…"}`, then `host_ready` confirms.

## How it works

- The factory starts `Bun.serve` once per process (nested sessions re-load the
  extension; a `globalThis` guard makes repeat factory calls no-ops).
- Sessions are `pi.createAgentSession` sessions wired through the shared
  `session-core.ts` — extension runner, synthetic events, shadow queue,
  plan-mode + extension-UI bridges all work exactly like deck-local sessions.
- Events fan out to every deck WS connection subscribed to the session;
  `subscribed` replies carry authoritative snapshots; the center forwards
  everything to its web clients.
- Idle sessions (no subscribers, no in-flight turn) are reaped after
  `OMP_AGENT_HOST_IDLE_TIMEOUT_MS`.
