#!/usr/bin/env bash
# Build Dockerfile.verify (the image Railway deploys) and start it with a throwaway local-development configuration:
# simulator on, factory keys, a random signing seed and admin token, no program id, no reconcile loop, no volume.
# Then check that GET /health answers with this commit (FV_BUILD_SHA) and that the verifier runs as the unprivileged
# user fv (uid 10001), not as root. Nothing here touches a cluster or a real key.
#   CI: job "docker" in ci.yml.   Locally (needs Docker): bash .github/scripts/docker-smoke.sh
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

image="${FV_SMOKE_IMAGE:-flaconvault-verify:smoke}"
port="${FV_SMOKE_PORT:-18787}"
sha="$(git rev-parse HEAD)"
rand_hex() { python3 -c 'import secrets, sys; print(secrets.token_hex(int(sys.argv[1])))' "$1"; }

docker build -f Dockerfile.verify -t "$image" .

cid="$(docker run -d -p "127.0.0.1:${port}:8787" \
  -e FV_DEV_SIMULATOR=true -e FV_KEY_MODE=factory \
  -e FV_SERVER_ED25519_SEED="$(rand_hex 32)" -e FV_ADMIN_TOKEN="$(rand_hex 24)" \
  -e FV_RECONCILE_INTERVAL_S=0 -e FV_BUILD_SHA="$sha" \
  "$image")"
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then docker logs "$cid" || true; fi
  docker rm -f "$cid" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

python3 .github/scripts/check-health.py "http://127.0.0.1:${port}" --build "$sha" --simulator true --timeout 90

uid="$(docker exec "$cid" cat /proc/1/status | awk '/^Uid:/ { print $2 }')"
if [ "$uid" != "10001" ]; then
  echo "::error::the verifier runs as uid ${uid:-?}, expected 10001 (fv)"
  exit 1
fi
echo "docker-smoke: ok (build $sha, uid $uid)"
