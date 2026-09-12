# omp-deck production deploy

This directory holds the self-contained production deployment artifact set for
omp-deck. The repo root's `Dockerfile` and `docker-compose.yml` are dev
artifacts; everything an operator needs to ship a fresh box lives here.

See also [docs/deployment.md](../docs/deployment.md) and
[docs/multi-machine.md](../docs/multi-machine.md).

## What ships

| File | Purpose |
| --- | --- |
| `Dockerfile` | Multi-stage production image. Mirrors `./Dockerfile` so this dir is self-describing. |
| `docker-compose.yml` | Loopback-only service definition, named volume for agent state, `/workspace` mount, healthcheck. |
| `.env.example` | Documents every secret. Copy to `.env`, fill, pass via `--env-file`. |
| `README.md` | This file. |

## Bare-metal / VM via Docker

```bash
cp deploy/.env.example deploy/.env
# Fill at least one provider key (and OMP_DECK_ACCESS_TOKEN if the box is reachable).
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
curl http://127.0.0.1:8787/api/health
```

The server binds to `127.0.0.1:8787` by default. Front it with `tailscale serve`,
an SSH tunnel, or a real reverse proxy with auth.

## Smoke-test command set

```bash
# Server health.
curl -sS http://127.0.0.1:8787/api/health

# Overview dashboard payload (real local stats + cached news).
curl -sS 'http://127.0.0.1:8787/api/overview?window=7d'
```

## What this directory deliberately does not do

- It does not push to GitHub. The operator owns the push workflow.
- It does not manage TLS. Terminate at `tailscale serve` or your reverse proxy.
