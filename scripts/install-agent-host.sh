#!/bin/sh
# install-agent-host.sh — one-line install of the omp-agent-host extension.
#
# Installs the extension source into ~/.omp/agent/extensions/omp-agent-host/
# (or --dir), fetching it from (in priority order):
#   1. --source <dir>        a local omp-deck checkout (or any dir whose
#                            apps/agent-host/src exists)
#   2. --tag <tag>           a GitHub release asset `omp-agent-host-<tag>.tar.gz`
#   3. (default)             the repository's default branch tarball
#
# Usage:
#   curl -sfL https://raw.githubusercontent.com/cnlimiter/omp-deck/main/scripts/install-agent-host.sh | sh
#   sh install-agent-host.sh --source /path/to/omp-deck
#   sh install-agent-host.sh --tag v0.7.0
#
# After installing, follow the printed steps: set OMP_AGENT_HOST_TOKEN,
# run `omp --mode rpc` (systemd unit below), and register the machine in the
# center deck's Settings → Machines.
set -eu

REPO="${OMP_DECK_REPO:-cnlimiter/omp-deck}"
TAG=""
SOURCE_DIR=""
TARGET_DIR="${OMP_AGENT_HOST_DIR:-$HOME/.omp/agent/extensions/omp-agent-host}"

while [ "$#" -gt 0 ]; do
	case "$1" in
		--source)
			SOURCE_DIR="$2"
			shift 2
			;;
		--tag)
			TAG="$2"
			shift 2
			;;
		--dir)
			TARGET_DIR="$2"
			shift 2
			;;
		-h | --help)
			sed -n '2,20p' "$0"
			exit 0
			;;
		*)
			echo "unknown argument: $1" >&2
			exit 2
			;;
	esac
done

fetch_http() {
	# curl preferred, wget fallback; 60s cap so restricted networks fail
	# loudly instead of hanging (use --source there instead).
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL --max-time 60 "$1"
	elif command -v wget >/dev/null 2>&1; then
		wget -qO- --timeout=60 "$1"
	else
		echo "need curl or wget to download" >&2
		exit 2
	fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ -n "$SOURCE_DIR" ]; then
	SRC="$SOURCE_DIR/apps/agent-host/src"
	if [ ! -f "$SRC/index.ts" ]; then
		echo "no apps/agent-host/src/index.ts under: $SOURCE_DIR" >&2
		exit 2
	fi
	echo "using local source: $SRC"
	mkdir -p "$TARGET_DIR"
	cp -R "$SRC/." "$TARGET_DIR/"
else
	if [ -n "$TAG" ]; then
		URL="https://github.com/$REPO/releases/download/$TAG/omp-agent-host-$TAG.tar.gz"
		echo "downloading release asset: $URL"
		fetch_http "$URL" > "$TMP/agent-host.tar.gz"
	else
		URL="https://codeload.github.com/$REPO/tar.gz/refs/heads/main"
		echo "downloading repository tarball: $URL"
		fetch_http "$URL" > "$TMP/repo.tar.gz"
		tar xzf "$TMP/repo.tar.gz" -C "$TMP"
		# codeload root is `omp-deck-main` for the default branch
		mv "$TMP"/omp-deck-* "$TMP/repo" 2>/dev/null || true
		# build the same asset layout from the checkout
		tar czf "$TMP/agent-host.tar.gz" -C "$TMP/repo/apps/agent-host/src" .
	fi
	mkdir -p "$TARGET_DIR"
	tar xzf "$TMP/agent-host.tar.gz" -C "$TARGET_DIR"
fi

if [ ! -f "$TARGET_DIR/index.ts" ] || [ ! -f "$TARGET_DIR/bridge/session-core.ts" ]; then
	echo "install failed: extension files missing in $TARGET_DIR" >&2
	exit 1
fi

echo
echo "omp-agent-host installed to: $TARGET_DIR"
echo
echo "Next steps:"
echo "  1. Generate a token:  OMP_AGENT_HOST_TOKEN=\$(openssl rand -hex 32)"
echo "  2. Run the host (keep stdin fed — rpc mode exits on EOF):"
echo "       OMP_AGENT_HOST_TOKEN=\$OMP_AGENT_HOST_TOKEN \\"
echo "       OMP_AGENT_HOST_BIND=<tailnet-ip> \\"
echo "       tail -f /dev/null | omp --mode rpc"
echo "  3. Verify:  curl -s http://127.0.0.1:8790/host/health"
echo "  4. Persist with a systemd user unit — see docs/multi-machine.md."
echo "  5. Register the machine in the center deck: Settings -> Machines"
echo "     (baseUrl http://<tailnet-ip>:8790, the token from step 1)."
