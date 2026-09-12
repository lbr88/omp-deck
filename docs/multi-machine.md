# Multi-machine: one center deck + remote omp agent hosts

Run one omp-deck **center** on a public VPS and connect it to **agent hosts**
on your other machines. The center aggregates every machine's sessions into
one sidebar (labeled with the machine), can create/switch sessions per
machine, edits each machine's omp env, and kanban tasks can be **assigned to
a machine** and opened as a session on that machine.

```
                  headscale / tailnet (or SSH tunnel)
┌─────────────────────────────┐        ┌─────────────────────────────┐
│  VPS — center omp-deck      │  WS +  │  machine B — omp agent host │
│  OMP_DECK_ACCESS_TOKEN      │  REST  │  omp --mode rpc             │
│  machines.json              │◄──────►│  omp-agent-host extension   │
│  sessions: local + remote   │        │  OMP_AGENT_HOST_TOKEN       │
└─────────────────────────────┘        └─────────────────────────────┘
```

## How it works

- Each machine runs the **omp-agent-host** omp extension inside a
  long-lived `omp --mode rpc` process. The extension starts a small HTTP+WS
  server (`Bun.serve`) exposing `/host/health`, `/host/sessions`,
  `/host/models`, `/host/env` and the deck session protocol over
  `/host/ws`. No binary, no build step, no node_modules on the machine.
- The center's **machines registry** (`machines.json`) lists every host
  (`id`, `name`, `baseUrl`, `token`, optional `defaultCwd`). The registry is
  editable through Settings → Machines (add/edit/remove) and persists to
  `<dataDir>/machines.json` (`OMP_DECK_MACHINES_FILE` to relocate).
- The center routes sessions by `agentId`: `"local"`/absent = the deck's own
  in-process bridge; anything else = the registered machine. Session events
  stream host → deck → browser with the same protocol as local sessions
  (queues, context usage, plan mode, extension-UI dialogs included).
- Kanban tasks carry `assigned_agent`; the task modal assigns a machine and
  "Open in chat" creates the session **on that machine**.

## 1. Center (VPS)

### Option A — Docker

```dockerfile
# Dockerfile (from the repo root)
FROM oven/bun:1.3
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
# Web bundle only — the server runs TS directly (its `bun build` bundle is
# blocked by a known mupdf top-level-await issue; dev/start are unaffected).
RUN bun run --filter '@omp-deck/web' build
EXPOSE 8787
CMD ["bun", "run", "start"]
```

```bash
docker build -t omp-deck .
docker run -d --name omp-deck \
  --restart unless-stopped \
  -p 100.64.0.1:8787:8787 \
  -e OMP_DECK_HOST=0.0.0.0 \
  -e OMP_DECK_DB_PATH=/data/deck.db \
  -e OMP_DECK_DATA_DIR=/data \
  -e OMP_DECK_ACCESS_TOKEN="$(openssl rand -hex 32)" \
  -e OMP_DECK_LANG=zh \
  -v omp-deck-data:/data \
  omp-deck
```

### Option B — plain bun (systemd)

```ini
# /etc/systemd/system/omp-deck.service
[Unit]
Description=omp-deck center
After=network-online.target

[Service]
User=deck
WorkingDirectory=/opt/omp-deck
Environment=OMP_DECK_HOST=0.0.0.0
Environment=OMP_DECK_PORT=8787
Environment=OMP_DECK_DB_PATH=/var/lib/omp-deck/deck.db
Environment=OMP_DECK_DATA_DIR=/var/lib/omp-deck
Environment=OMP_DECK_ACCESS_TOKEN=CHANGE_ME_deck_token
Environment=OMP_DECK_WEB_DIST=/opt/omp-deck/apps/web/dist
# repo root `bun run start` = `bun run --filter '@omp-deck/server' start`
ExecStart=/usr/local/bin/bun run start
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Bind the headscale IP (`OMP_DECK_HOST=100.64.0.1`) so only the tailnet can
reach the API, or bind loopback and expose via `tailscale serve`. The
`OMP_DECK_ACCESS_TOKEN` is required for any public-ish binding: every `/api`
and `/ws` request must then authenticate. The web client shows a full-screen
**login** on first visit (or after any 401) — paste the token once; the
server validates it and issues an HttpOnly session cookie (see
docs/deployment.md → Access token). API clients use
`Authorization: Bearer <token>`.

Register machines either by editing `machines.json` before first boot:

```json
[
  {
    "id": "lab",
    "name": "实验室",
    "baseUrl": "http://100.64.0.2:8790",
    "token": "CHANGE_ME_host_token",
    "defaultCwd": "/home/user/projects"
  }
]
```

or via Settings → Machines → Add machine after boot.

## 2. Agent host (each machine)

Requirements: the machine's `omp` binary (any recent version), and a token
`openssl rand -hex 32`.

### One-line install

```sh
curl -sfL https://raw.githubusercontent.com/cnlimiter/omp-deck/main/scripts/install-agent-host.sh | sh
```

Fetches the extension (repository tarball by default; `--tag v0.7.0` prefers
the matching GitHub release asset; `--source <dir>` uses a local checkout —
handy on networks without GitHub access), copies it to
`~/.omp/agent/extensions/omp-agent-host/`, verifies the layout, and prints
the next steps (token, `omp --mode rpc`, systemd unit, deck registration).
On restricted networks set `ALL_PROXY`/`HTTPS_PROXY` for the download.

Manual install (from a checkout of omp-deck):

```bash
EXT=~/.omp/agent/extensions/omp-agent-host
mkdir -p "$EXT"
cp -r apps/agent-host/src/* "$EXT/"
```

### Run

```bash
# 2) systemd user unit
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/omp-agent-host.service <<'EOF'
[Unit]
Description=omp agent host for omp-deck
After=network-online.target

[Service]
# `--mode rpc` with stdin closed may exit immediately; keep it fed.
ExecStart=/bin/sh -c 'tail -f /dev/null | /usr/local/bin/omp --mode rpc'
Restart=on-failure
RestartSec=5
Environment=OMP_AGENT_HOST_TOKEN=CHANGE_ME_host_token
Environment=OMP_AGENT_HOST_BIND=100.64.0.2
Environment=OMP_AGENT_HOST_PORT=8790

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now omp-agent-host
```

Host knobs:

| Env | Default | Meaning |
|---|---|---|
| `OMP_AGENT_HOST_PORT` | `8790` | HTTP/WS port |
| `OMP_AGENT_HOST_BIND` | `127.0.0.1` | Bind address — use the tailnet IP |
| `OMP_AGENT_HOST_TOKEN` | — | **required**; without it the extension warns and does not start |
| `OMP_AGENT_DIR` | `~/.omp/agent` | SDK session/auth dir (the machine's own credentials) |
| `OMP_AGENT_HOST_IDLE_TIMEOUT_MS` | `900000` | Reap unsubscribed idle sessions; `0` disables |
| `OMP_AGENT_HOST_DEFAULT_CWD` | `$HOME` | cwd when the center omits one |

Smoke test from the center (or any tailnet peer):

```bash
curl -s http://100.64.0.2:8790/host/health          # no auth — liveness
curl -s -H "Authorization: Bearer $HOST_TOKEN" \
  http://100.64.0.2:8790/host/models                # model catalog
# wrong/missing token → 401
```

## Release asset

When cutting a release, attach the extension as a standalone tarball so
machines can install without cloning the whole repo:

```bash
# from the repo root — layout matches apps/agent-host/src exactly
tar czf omp-agent-host-<version>.tar.gz -C apps/agent-host/src .
# upload as a GitHub Release asset named omp-agent-host-<version>.tar.gz
```

The install script then works with `sh install-agent-host.sh --tag
v<version>` (it downloads
`https://github.com/<repo>/releases/download/<tag>/omp-agent-host-<tag>.tar.gz`).

## Security notes

- **Headscale/tailscale is the first door**: bind hosts to the tailnet IP
  (`OMP_AGENT_HOST_BIND=100.64.0.2`) and the center to its tailnet IP.
- **Tokens are the second door**: `OMP_DECK_ACCESS_TOKEN` on the center
  (all `/api` + `/ws`), `OMP_AGENT_HOST_TOKEN` on each host (all `/host/*` +
  WS handshake). Use different random values (`openssl rand -hex 32`).
- The deck never stores host credentials; each machine uses its own
  `~/.omp/agent` auth (agent.db). API keys for a machine are set via
  Settings → Machines → Env, which writes `~/.config/omp-agent-host/host.env`
  on that machine.
- Hosts bind loopback by default; keep that for SSH-tunnel setups.

## What stays centralized

- **Routines** still run on the center server (no cross-machine cron).
- **KB / kanban / inbox** stay center-side; only the task's `assigned_agent`
  couples a task to a machine.
- One center manages all machines; no federation between centers.
- **Resume works across machines**: clicking a machine's session in the
  sidebar (or SessionPicker) resumes it on the host — the host's SDK opens
  the session file, loads the full history into the snapshot, and the chat
  hydrates it (verified with 1600+ message sessions). Sessions resume on
  their owning machine; paths no machine knows fall back to the deck's own
  bridge. A resumed session stays live on the host until reaped or deleted.
