#!/usr/bin/env bash
# Repository hygiene checks. Runs in CI (job "hygiene") and locally: bash .github/scripts/hygiene.sh
#  1. local tooling config (.claude/) is not tracked
#  2. real env files are ignored, *.example templates are not
#  3. no key material or real env files are tracked
#  4. no machine-specific absolute home-directory paths are tracked
#  5. no PATH exports for one machine's custom tool locations (e.g. $HOME/.local/node/bin) in docs or scripts
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

fail=0
err() { echo "::error::$*"; fail=1; }
self=".github/scripts/hygiene.sh"

# 1. local tooling config
if [ -n "$(git ls-files -- .claude)" ]; then
  err ".claude/ is tracked (machine-specific local config): git rm -r --cached .claude"
fi

# 2. env files (--no-index: evaluate the ignore rules even for paths that are already tracked)
for p in .env .env.local apps/verify/.env apps/web/.env.local apps/web/.env.production; do
  git check-ignore -q --no-index -- "$p" || err "$p is not ignored by .gitignore"
done
for p in apps/verify/.env.example apps/web/.env.example; do
  if git check-ignore -q --no-index -- "$p"; then
    err "$p is ignored; env templates named *.example must stay trackable (keep !*.example after .env* in .gitignore)"
  fi
done

# 3. key material and real env files
tracked=$(git ls-files | grep -E '(^|/)(id\.json|[^/]*keypair[^/]*\.json|\.env(\.[^/]*)?)$' | grep -v -E '\.example$' || true)
if [ -n "$tracked" ]; then
  err "key or env files are tracked: $(echo "$tracked" | tr '\n' ' ')"
fi
if git grep -n -I -E -e '-----BEGIN [A-Z ]*PRIVATE KEY-----' -- . ":(exclude)$self"; then
  err "private key material is tracked (see the lines above)"
fi

# 4. absolute home-directory paths (/Users/<name>, /home/<name>/, C:\Users\)
if git grep -n -I -E -e '/Users/[A-Za-z]|/home/[a-z][a-z0-9_-]*/|[A-Za-z]:\\Users\\' -- . \
    ':(exclude)package-lock.json' ':(exclude)**/package-lock.json' ':(exclude)**/uv.lock' ':(exclude)Cargo.lock' ":(exclude)$self"; then
  err "machine-specific absolute paths are tracked (see the lines above); use \$HOME, ~ or relative paths"
fi

# 5. machine-specific toolchain PATH lines ($HOME-relative, so check 4 does not see them). Docs name the tools instead
#    ("Node 22.18 or newer, the Solana CLI and Anchor via avm on PATH"); CI adds its own install paths via $GITHUB_PATH.
if git grep -n -I -E -e 'PATH=.*\.local/node/bin' -- '*.md' '*.sh' '*.toml' '*.json' '*.example' ":(exclude)$self"; then
  err "machine-specific PATH export is tracked (see the lines above); say which tools must be on PATH instead"
fi

if [ "$fail" -eq 0 ]; then echo "hygiene: ok"; fi
exit "$fail"
