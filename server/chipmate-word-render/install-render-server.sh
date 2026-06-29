#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-chipmate-word-render}"
PORT="${PORT:-6001}"
PACKAGE_ROOT_ON_HOST="${PACKAGE_ROOT_ON_HOST:-$(pwd)/packages}"
ARCHIVE="${1:-}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required but was not found in PATH." >&2
  exit 1
fi

if [[ -z "$ARCHIVE" ]]; then
  ARCHIVE="$(find . -maxdepth 1 \( -name 'chipmate-word-render-*-linux-amd64.docker.tar.gz' -o -name 'chipmate-word-render-*-linux-amd64.docker.tar' \) | sort | tail -n 1)"
fi

if [[ -z "$ARCHIVE" || ! -f "$ARCHIVE" ]]; then
  echo "Could not find chipmate-word-render docker archive. Pass the .tar.gz or .tar path as the first argument." >&2
  exit 1
fi

workdir="$(mktemp -d)"
cleanup() {
  rm -rf "$workdir"
}
trap cleanup EXIT

image_tar="$ARCHIVE"
if [[ "$ARCHIVE" == *.gz ]]; then
  image_tar="$workdir/image.tar"
  gzip -dc "$ARCHIVE" > "$image_tar"
fi

echo "[chipmate-render] loading image from $ARCHIVE"
docker load -i "$image_tar" | tee "$workdir/docker-load.out"
IMAGE_REF="$(awk -F': ' '/Loaded image:/ { value=$2 } END { print value }' "$workdir/docker-load.out")"

if [[ -z "$IMAGE_REF" ]]; then
  IMAGE_REF="$(docker images --format '{{.Repository}}:{{.Tag}}' | grep '^chipmate-word-render:' | head -n 1 || true)"
fi

if [[ -z "$IMAGE_REF" ]]; then
  echo "Could not determine loaded image tag." >&2
  exit 1
fi

mkdir -p "$PACKAGE_ROOT_ON_HOST"
docker rm -f "$SERVICE_NAME" >/dev/null 2>&1 || true

echo "[chipmate-render] starting $SERVICE_NAME on port $PORT with image $IMAGE_REF"
docker run -d \
  --restart unless-stopped \
  --name "$SERVICE_NAME" \
  -p "$PORT:6001" \
  -v "$PACKAGE_ROOT_ON_HOST:/packages:ro" \
  "$IMAGE_REF"

echo "[chipmate-render] waiting for health check"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/tmp/chipmate-render-health.json 2>/dev/null; then
    cat /tmp/chipmate-render-health.json
    echo
    echo "[chipmate-render] ready: http://127.0.0.1:$PORT"
    exit 0
  fi
  sleep 1
done

echo "Render server started but health check did not pass in time." >&2
docker logs --tail 80 "$SERVICE_NAME" >&2 || true
exit 1
