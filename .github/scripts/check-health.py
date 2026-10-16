#!/usr/bin/env python3
"""
Wait for a verifier's GET /health and check what a deployment must report. Used by docker-smoke.sh (CI job "docker");
also works against a running verifier:
  python3 .github/scripts/check-health.py http://127.0.0.1:8787 [--build <commit>] [--simulator true|false] [--timeout 90]
Exit code 0 = healthy and as expected; 1 = a check failed or /health never answered.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request


def fetch(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=5) as r:   # noqa: S310 — the URL comes from the command line
        return json.loads(r.read().decode())


def problems(h: dict, build: str | None, simulator: bool | None) -> list[str]:
    out = []
    if h.get("ok") is not True:
        out.append(f"ok is {h.get('ok')!r}, expected true")
    if not re.fullmatch(r"[0-9a-f]{64}", str(h.get("pubkeyHex") or "")):
        out.append(f"pubkeyHex {h.get('pubkeyHex')!r} is not 32 bytes hex")
    if not isinstance(h.get("keyId"), int):
        out.append(f"keyId {h.get('keyId')!r} is not an integer")
    if simulator is not None and h.get("simulator") is not simulator:
        out.append(f"simulator is {h.get('simulator')!r}, expected {simulator}")
    if build is not None and h.get("build") != build:
        out.append(f"build is {h.get('build')!r}, expected {build!r} (FV_BUILD_SHA / RAILWAY_GIT_COMMIT_SHA)")
    return out


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("base", help="verifier base URL, e.g. http://127.0.0.1:8787")
    ap.add_argument("--build", help="expected commit in `build`")
    ap.add_argument("--simulator", choices=["true", "false"], help="expected `simulator` flag")
    ap.add_argument("--timeout", type=float, default=90, help="seconds to wait for /health (default 90)")
    a = ap.parse_args(argv)
    url = a.base.rstrip("/") + "/health"
    deadline = time.monotonic() + a.timeout
    while True:
        try:
            h = fetch(url)
            break
        except (urllib.error.URLError, ConnectionError, TimeoutError, json.JSONDecodeError) as exc:
            if time.monotonic() >= deadline:
                print(f"::error::{url} did not answer within {a.timeout:.0f} s ({exc})")
                return 1
            time.sleep(1)
    print(json.dumps(h, indent=2, sort_keys=True))
    found = problems(h, a.build, None if a.simulator is None else a.simulator == "true")
    for p in found:
        print(f"::error::{p}")
    if not found:
        print("health: ok")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
