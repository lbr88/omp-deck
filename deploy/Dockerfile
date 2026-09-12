# syntax=docker/dockerfile:1.7
#
# omp-deck — production image. Single-image production build. Vite needs the entire workspace
# (server + web + protocol + bridges + gholam + agent-host) so the
# build context is the repo root (`docker build -f deploy/Dockerfile .`).
# Identical to ./Dockerfile at the repo root; keep the two in sync.

# ─── Stage 1: build web ───────────────────────────────────────────────────
FROM oven/bun:1.3.14 AS web-build
WORKDIR /app

# Workspace manifests first for cache-friendly install. All five must be
# present so bun's frozen-lockfile resolver sees the same workspace graph
# the lockfile was generated against — including the telegram bridge,
# whose runtime is opt-in but whose manifest is part of the lockfile.
COPY package.json bun.lock* tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
COPY apps/bridges/telegram/package.json apps/bridges/telegram/
COPY apps/gholam/package.json apps/gholam/
RUN bun install --frozen-lockfile

# Web sources + protocol (referenced as workspace:*).
COPY packages/protocol packages/protocol
COPY apps/web apps/web

WORKDIR /app/apps/web
RUN bun run build

# ─── Stage 2: runtime ──────────────────────────────────────────────────────
FROM oven/bun:1.3.14 AS runtime
WORKDIR /app

# git: the git cockpit and GitHub-clone flow shell out to the real binary
# rather than reimplement it (see git-service.ts's docblock for why).
# zip/unzip: the agent-config import/export flow round-trips a whole
# ~/.omp/agent directory as a single archive; shelling out avoids pulling in
# a JS zip library for something the OS already does well.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates git zip unzip \
	&& rm -rf /var/lib/apt/lists/*

# Re-install with only server-relevant workspace (still pulls protocol).
COPY package.json bun.lock* tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/bridges/telegram/package.json apps/bridges/telegram/
COPY apps/gholam/package.json apps/gholam/

RUN bun install --frozen-lockfile --production

# Sources for runtime (Bun executes TS natively — no transpile step).
COPY packages/protocol packages/protocol
COPY apps/server apps/server
COPY apps/gholam apps/gholam

# Built web assets.
COPY --from=web-build /app/apps/web/dist /app/apps/web/dist

# Entrypoint helper: ensure ~/.omp/agent <-> $OMP_AGENT_DIR stay linked.
#
# This image ships with no bundled agent personality. Config lives on the
# OMP_AGENT_DIR volume. The seed script still runs so slash-commands / skills /
# agent-host that resolve ~/.omp/agent directly hit the same persistent tree.
# Optionally mount your own seed and set OMP_DECK_AGENT_DEFAULTS to copy it in
# on first boot (never overwrites unless OMP_DECK_SEED_FORCE=1).
COPY scripts/seed-agent-dir.sh /app/scripts/seed-agent-dir.sh
RUN chmod +x /app/scripts/seed-agent-dir.sh

# Server resolves OMP_DECK_WEB_DIST or auto-discovers ../web/dist relative to
# its cwd. Pin it explicitly here.
ENV OMP_DECK_WEB_DIST=/app/apps/web/dist \
    OMP_DECK_HOST=0.0.0.0 \
    OMP_DECK_PORT=8787 \
    NODE_ENV=production

WORKDIR /app/apps/server
EXPOSE 8787

# Link/seed the agent directory, then exec the server so it keeps PID 1 and still
# receives SIGTERM directly (the compose file relies on that for clean shutdown).
ENTRYPOINT ["/bin/sh", "-c", "/app/scripts/seed-agent-dir.sh; exec \"$@\"", "--"]
CMD ["bun", "src/index.ts"]
