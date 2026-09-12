# Deployment

By default omp-deck is loopback-only with network access gated by something
else — Tailscale, an SSH tunnel, or a reverse proxy with its own auth. Since
0.7.0 it also ships an optional **access-token layer**
(`OMP_DECK_ACCESS_TOKEN`) that protects every `/api`, `/ws` and `/uploads`
request with a bearer token — use it for any public-ish binding, and
combine it with the network-level gates below for defense in depth.

Multi-machine deployments (a center deck on a VPS + omp agent hosts on your
other machines) are covered in [multi-machine.md](multi-machine.md).

## Patterns

- [Tailscale-gated (recommended)](#tailscale-gated-recommended)
- [SSH tunnel](#ssh-tunnel)
- [Access token](#access-token)
- [Docker](#docker)
- [Multi-machine](#multi-machine)
- [Hardening checklist](#hardening-checklist)

## Tailscale-gated (recommended)

Bind the deck to loopback. Tailscale Serve exposes it to your tailnet over
HTTPS with mTLS-style identity.

```sh
# Run the deck loopback-only — the default
OMP_DECK_HOST=127.0.0.1 OMP_DECK_PORT=8787 bun run start

# Then on the same host:
tailscale serve --bg --https=443 http://127.0.0.1:8787

# Open from any tailnet device — including your phone:
open https://<hostname>.<tailnet>.ts.net
```

Tailscale handles the TLS termination + identity check. Only devices on your
tailnet can reach the deck.

**Sharing externally** — use Tailscale Funnel:

```sh
tailscale funnel --bg --https=443 http://127.0.0.1:8787
```

Funnel exposes the URL to the public internet. Anyone with the link can
reach the deck. Set `OMP_DECK_ACCESS_TOKEN` (see
[Access token](#access-token)) before sharing a Funnel URL — without it the
deck is fully open to whoever has the link.

## SSH tunnel

If you don't run Tailscale on the host:

```sh
# On the deck host:
bun run start                                        # bound to 127.0.0.1:8787

# On your local box:
ssh -L 8787:127.0.0.1:8787 user@deck-host
# Then open http://localhost:8787 in your laptop browser
```

Stick it in `~/.ssh/config` for a persistent tunnel:

```
Host deck-host
  HostName <ip-or-hostname>
  User <user>
  LocalForward 8787 127.0.0.1:8787
```

## Access token (login)

Since 0.7.0, setting `OMP_DECK_ACCESS_TOKEN` turns on authentication for
every `/api`, `/ws` and `/uploads` request:

```sh
OMP_DECK_ACCESS_TOKEN="$(openssl rand -hex 32)" bun run start
```

The web client treats it as a **login**: the first visit (or any 401)
shows a full-screen sign-in form. Entering the token calls
`POST /api/auth/login`; the server validates it (constant-time) and issues
an **HttpOnly, SameSite=Strict session cookie** (Secure under https;
"Remember me" extends it to 30 days). The token never reaches
JS-readable storage — after login the browser simply carries the cookie on
every request and WebSocket upgrade. `POST /api/auth/logout` clears it, and
**Settings → Access** shows the session state with a Sign-out button.

API clients and admin scripts can still authenticate with
`Authorization: Bearer <token>` — both paths are accepted, the cookie is
what the browser uses.

This layer is **not** a substitute for the network gates: it protects the
deck's own surface but adds no identity story (no per-user accounts — the
token is a shared site key). Put Tailscale/SSH in front for identity; use
the token when the deck must be reachable from more than one machine.
Serving over **HTTPS** is strongly recommended so the cookie's `Secure`
attribute engages.

## Multi-machine

One center deck on a VPS + `omp-agent-host` extensions on each of your other
machines: session aggregation with machine labels, per-machine session
create/switch, remote env editing, and kanban task assignment to machines.
Full walkthrough (center systemd/Docker, host extension install, systemd
unit, security notes): **[multi-machine.md](multi-machine.md)**.

## Docker

A `Dockerfile` and `docker-compose.yml` ship in the repo root. The image
build does an end-to-end Bun build of the server + web bundle, then runs the
server in production mode (loopback by default).

```sh
docker build -t omp-deck .
docker run -d --name omp-deck \
  -p 127.0.0.1:8787:8787 \
  -v omp-deck-agent:/data/omp-agent \
  -v /srv/work:/workspace \
  -e OMP_AGENT_DIR=/data/omp-agent \
  -e OMP_DECK_DEFAULT_CWD=/workspace \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  omp-deck
```

Compose:

```sh
docker compose up -d
```

The compose file binds `127.0.0.1:8787` on the host and mounts a named volume
for omp's session+auth state. Sit Tailscale on top of the host port — same
recipe as above.

**Auth state**: the named volume `/data/omp-agent` is critical. Without it,
every container restart starts from a blank `~/.omp/agent` and you'll be asked
to re-authenticate.

## Production knobs worth setting

```sh
OMP_DECK_DB_PATH=/var/lib/omp-deck/deck.db    # outside the container fs
OMP_DECK_DATA_DIR=/var/lib/omp-deck           # managed .env + audit + bridge db
OMP_AGENT_DIR=/var/lib/omp/agent              # SDK session + auth
OMP_DECK_DEFAULT_CWD=/workspace               # mount your code here
OMP_DECK_ACCESS_TOKEN=<openssl rand -hex 32>  # bearer gate for /api + /ws
OMP_DECK_MACHINES_FILE=/var/lib/omp-deck/machines.json  # remote hosts (default)
LOG_LEVEL=warn                                # quieter in steady state

OMP_DECK_PUBLIC_URL=https://deck.example.com  # what the deck calls itself in text
OMP_DECK_AUTH_USERNAME=you                    # bootstrap account
OMP_DECK_AUTH_PASSWORD_HASH='$argon2id$...'   # digest, so no plaintext in env
```

Generate the digest with:

```sh
bun -e 'console.log(await Bun.password.hash(process.argv[1], "argon2id"))' 'your password'
```

## Hardening checklist

Before exposing the deck on a network anyone else can reach:

- [ ] Decide which perimeter you are using. Binding `0.0.0.0` turns the deck's
      own authentication on automatically, so a public bind is no longer
      unprotected by default — but a network perimeter (Tailscale Serve, an SSH
      tunnel, a reverse proxy that enforces auth) is still the stronger option,
      and the two compose. Prefer `OMP_DECK_HOST=127.0.0.1` when possible
      (confirm with `ss -tlnp` or `netstat`).
- [ ] A password is configured (`OMP_DECK_AUTH_PASSWORD_HASH`, or completed
      first-run setup). Check the boot log: the deck warns loudly while no
      account exists.
- [ ] `OMP_DECK_AUTH_SETUP_TOKEN` is set if the deck will be publicly reachable
      before you have created the account.
- [ ] TLS terminates in front of the deck, so the session cookie gets `Secure`.
      If your proxy doesn't set `X-Forwarded-Proto`, set
      `OMP_DECK_AUTH_SECURE_COOKIE=1`.
- [ ] If the deck is reachable from more than one machine / remote agent hosts,
      set `OMP_DECK_ACCESS_TOKEN` (and set it in the browser's localStorage —
      the indicator shows "unauthorized" until it matches).
- [ ] Provider API keys live in env vars (via shell profile or the deck's
      managed `.env`) — never committed in the repo or shipped in an image.
- [ ] The data dir (`OMP_DECK_DATA_DIR`) is user-only readable. `chmod 700` on
      Unix; Windows `%LOCALAPPDATA%` is per-user by default.
- [ ] The audit log (`env-audit.log`) is rotated or archived if the deck runs
      for a long time. Today it grows unbounded.
- [ ] If Telegram bridge is in use, `TELEGRAM_ALLOWED_USERS` is set. The
      bridge refuses to start without it.
- [ ] If exposing via Funnel, the deck's sign-in is the only thing between the
      public internet and an agent with a shell. Confirm the password is a
      real one, and consider a reverse-proxy auth layer in front of it too.

## Updating

The deck embeds the omp SDK as a workspace dep. To pull a newer SDK:

```sh
bun update @oh-my-pi/pi-coding-agent
bun run typecheck
bun run build
```

Then restart the deck (Settings → Env → Restart, or kill+respawn).
