#!/usr/bin/env bash
# The committed IDLs and TypeScript types in packages/proof/src/idl/ must equal what `anchor build` generates from
# programs/: the web clients and the scripts load the committed copies at runtime. Run it right after `anchor build`
# and before `anchor keys sync` (which changes the program ids in the generated files).
#   CI: workflow programs.yml, and the anchor job of ci.yml.   Locally: anchor build && bash .github/scripts/idl-check.sh
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

fail=0
check() {   # <generated> <committed>
  if [ ! -f "$1" ]; then
    echo "::error::$1 is missing: run anchor build first"
    fail=1
  elif ! diff -u "$2" "$1"; then
    echo "::error::$2 differs from the anchor build output $1: copy it (docs/devnet.md, Commands) and commit it"
    fail=1
  fi
}
for p in flacon escrow; do
  check "target/idl/$p.json" "packages/proof/src/idl/$p.json"
  check "target/types/$p.ts" "packages/proof/src/idl/$p.ts"
done

if [ "$fail" -eq 0 ]; then echo "idl-check: ok"; fi
exit "$fail"
