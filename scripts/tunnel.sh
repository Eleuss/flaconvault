#!/bin/zsh
# HTTPS for the phone: WebNFC and the camera only work in a secure context.
# Starts two Cloudflare quick tunnels (no account needed) for web :3000 and verify :8787 and prints the env lines.
# Usage: scripts/tunnel.sh   (leave it running; Ctrl-C stops both)
set -e
CF="${CLOUDFLARED:-$HOME/.local/bin/cloudflared}"
[ -x "$CF" ] || { echo "cloudflared not found at $CF (download: https://github.com/cloudflare/cloudflared/releases)"; exit 1; }
LOG=$(mktemp -d)
"$CF" tunnel --url http://localhost:3000 --no-autoupdate > "$LOG/web.log" 2>&1 &
W=$!
"$CF" tunnel --url http://localhost:8787 --no-autoupdate > "$LOG/verify.log" 2>&1 &
V=$!
trap 'kill $W $V 2>/dev/null' EXIT INT TERM
for i in $(seq 1 30); do
  WEB=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$LOG/web.log" | head -1)
  VER=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$LOG/verify.log" | head -1)
  [ -n "$WEB" ] && [ -n "$VER" ] && break
  sleep 1
done
echo "web     $WEB"
echo "verify  $VER"
echo
echo "apps/verify/.env:"
echo "  FV_WEB_URL=$WEB"
echo "  FV_VERIFIER_HOST=$VER"
echo "  FV_CORS_ORIGINS=$WEB,http://localhost:3000"
echo "apps/web/.env.local:"
echo "  NEXT_PUBLIC_VERIFY_URL=$VER"
echo
echo "Then restart both servers. Tag URL template for TagWriter: $WEB/t?uid=00000000000000&ctr=000000&cmac=0000000000000000"
echo "(the web app forwards /t?uid… to the verifier exactly once, so tags stay valid when the verifier URL changes)"
wait
