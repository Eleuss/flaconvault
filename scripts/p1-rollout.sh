#!/bin/zsh
# Public record (P1) rollout on devnet, one owner click per step. The manual commands in docs/deploy.md (Deploying)
# and docs/devnet.md (Public record (P1) rollout; Upgrading devnet, step 2) are the reference this script follows.
#
#   zsh scripts/p1-rollout.sh deploy        verifier, then web app of this commit online; the relay stays OFF
#   zsh scripts/p1-rollout.sh chain         back up both programs, upgrade escrow then flacon, HolderConfig, Holdings
#   zsh scripts/p1-rollout.sh relay         relayer key and funding, FV_RELAY_ENABLED=true, wait for relay.ok
#   zsh scripts/p1-rollout.sh rotate-keys   new FV_ADMIN_TOKEN and server signing key (never FV_MASTER_KEY)
#   zsh scripts/p1-rollout.sh status        read-only overview
#   zsh scripts/p1-rollout.sh <step> --dry-run    checks and plan only, changes nothing
#
# Every step checks first and stops with a German message that says what to do; a re-run skips what is done. Text for
# the owner is German, comments are English. Secrets never reach the screen, a command line or a file outside a private
# temp dir (mode 700) that the EXIT trap deletes on every exit path: they go to Railway with
# `railway variable set NAME --stdin`, and `railway variable list --json`, which carries raw values, is only ever piped
# into the helper `vars` below, which prints derived facts (on/off, present/absent, a public key).
#
# Tools on PATH: git, python3, curl, tar, node/npx, railway, vercel, gh, the Solana CLI and anchor. The default
# folders of the Solana and Rust installers are added when solana or anchor is missing.
#
# Overrides for tests and a local rehearsal:
#   FV_ROLLOUT_RPC          JSON-RPC (default https://api.devnet.solana.com; local http://127.0.0.1:8899)
#   ANCHOR_WALLET           deploy wallet keypair file (default ~/.config/solana/id.json)
#   FV_ROLLOUT_VERIFY_URL   verifier (default https://verify.flaconvault.com; local http://127.0.0.1:8787)
#   FV_ROLLOUT_WEB_URL      web app (default https://app.flaconvault.com; local http://127.0.0.1:3000)
#   FV_ROLLOUT_LOCAL=1      rehearsal on a local validator, verifier and web app, cluster localnet: no Vercel or gh, no
#                           Railway, and the three addresses above must be local (127.0.0.1, localhost, [::1])
#   FV_ROLLOUT_RAILWAY      rehearsal only: absolute path of a Railway stand-in (the subcommands used here: whoami,
#                           variable list --json, variable set) that keeps the local verifier's variables and restarts it
#                           like a redeploy; its `whoami` must print "fv-rollout stand-in". With it, relay, rotate-keys
#                           and status use their Railway path against the local verifier; without it a rehearsal calls
#                           no Railway at all
#   FV_ROLLOUT_WAIT_S       seconds to wait for /health (default 900); FV_ROLLOUT_POLL_S poll interval (default 10)
#   FV_ROLLOUT_KEY_GRACE_S  rotate-keys: seconds between the verifier switch and revoking the old key (default 660)
#   FV_ROLLOUT_STATE_DIR    backups, logs and step markers (default ~/flaconvault-rollout, rehearsal
#                           ~/flaconvault-rollout-local); a folder belongs to one cluster (file "cluster" in it)
set -e
setopt pipefail

DIED=0
SECRET_DIR=""
EXPORT_DIR=""
TMP_DIR=""
NPX_TMP=""
cleanup() {
  local rc=$?
  [[ -n $SECRET_DIR && -d $SECRET_DIR ]] && rm -rf -- "$SECRET_DIR"
  [[ -n $EXPORT_DIR && -d $EXPORT_DIR ]] && rm -rf -- "$EXPORT_DIR"
  [[ -n $TMP_DIR && -d $TMP_DIR ]] && rm -rf -- "$TMP_DIR"
  [[ -n $NPX_TMP && -d $NPX_TMP ]] && rm -rf -- "$NPX_TMP"
  if (( rc != 0 && DIED == 0 )); then
    print -r -- "" >&2
    print -r -- "STOPP: Ein Befehl ist fehlgeschlagen (Meldung oben)." >&2
    print -r -- "  Bitte die letzten Zeilen an Claude schicken. Danach kann der Schritt einfach nochmal laufen: Erledigtes wird übersprungen." >&2
  fi
}
interrupted() {
  DIED=1
  print -r -- "" >&2
  print -r -- "Abgebrochen. Der Schritt kann einfach nochmal laufen: Erledigtes wird übersprungen." >&2
  exit $1
}
trap cleanup EXIT
trap 'interrupted 130' INT
trap 'interrupted 143' TERM
trap 'interrupted 129' HUP

say()   { print -r -- "$*"; }
ok()    { print -r -- "✓ $*"; }
warn()  { print -r -- "! $*"; }
title() { print -r -- ""; print -r -- "== $* =="; }
# die <what happened> [<what to do> ...]: German, to stderr, exit 1. Never call it inside $(...): it would only end
# the subshell; functions used there return non-zero and their caller dies.
die() {
  DIED=1
  print -r -- "" >&2
  print -r -- "STOPP: $1" >&2
  shift
  local line
  for line in "$@"; do print -r -- "  $line" >&2; done
  exit 1
}
usage() {
  DIED=1
  print -r -- "So starten: zsh scripts/p1-rollout.sh <schritt> [--dry-run]" >&2
  print -r -- "Schritte, in dieser Reihenfolge: deploy, chain, relay, rotate-keys. status zeigt nur an." >&2
  exit 1
}

STEP=""
DRY=0
for arg in "$@"; do
  case $arg in
    --dry-run) DRY=1 ;;
    deploy|chain|relay|rotate-keys|status) [[ -z $STEP ]] || usage; STEP=$arg ;;
    *) usage ;;
  esac
done
[[ -n $STEP ]] || usage

SCRIPT=${0:A}
ROOT=${SCRIPT:h:h}
cd "$ROOT"

FLACON_ID=7dCr825ibTyE6Y5oPHP2RCmUi5qFPCaKdZmE9TYeAcWL
ESCROW_ID=9vabByStbAqKH6sM6fuf8HhfGZbV3993Ncp3uZScexKL
REGISTRY=4JPPCBA7DpbmfDsq1oHDuiJD1zL8VhfuJSoWQyYZXZWt   # flacon PDA ["registry"]
DEVNET_RPC=https://api.devnet.solana.com
RESERVE_LAMPORTS=600000000        # left after the chain step: 0.5 SOL for the relayer (step relay) plus fees
RELAYER_FUND_LAMPORTS=500000000   # docs/deploy.md: fund the relayer with at most 0.5 SOL on devnet
RELAYER_LOW_LAMPORTS=100000000    # FV_RELAY_LOW_BALANCE_LAMPORTS default: below it /health says relay.ok false
EXTEND_HEADROOM=4096              # docs/devnet.md: extend by NEW - OLD + 4096 ...
EXTEND_MIN=10240                  # ... but at least 10240 bytes: the Agave 4.1 CLI refuses a smaller ExtendProgram
BUFFER_HEADER_BYTES=37            # upgradeable loader buffer header (the upgrade writes the .so into a buffer first)
HOLDER_CONFIG_BYTES=227           # 8 + HolderConfig::INIT_SPACE (programs/flacon/src/state.rs)
HOLDING_BYTES=229                 # 8 + Holding::INIT_SPACE
MAX_SERVER_KEYS=8                 # Registry.server_keys max_len

LOCAL=0
if [[ ${FV_ROLLOUT_LOCAL:-0} == 1 ]]; then LOCAL=1; fi
if (( LOCAL )); then
  RPC=${FV_ROLLOUT_RPC:-http://127.0.0.1:8899}
  VERIFY_URL=${FV_ROLLOUT_VERIFY_URL:-http://127.0.0.1:8787}
  WEB_URL=${FV_ROLLOUT_WEB_URL:-http://127.0.0.1:3000}
  CLUSTER=localnet
  CLUSTER_TAG=3
  # A rehearsal keeps its own deploy markers, backups and logs: devnet's chain step must never accept a local deploy
  # marker or keep a local validator's dump as its "before" backup.
  STATE_DIR=${FV_ROLLOUT_STATE_DIR:-$HOME/flaconvault-rollout-local}
  RAILWAY=${FV_ROLLOUT_RAILWAY:-}   # a stand-in or nothing: a rehearsal never calls the real Railway
else
  RPC=${FV_ROLLOUT_RPC:-$DEVNET_RPC}
  VERIFY_URL=${FV_ROLLOUT_VERIFY_URL:-https://verify.flaconvault.com}
  WEB_URL=${FV_ROLLOUT_WEB_URL:-https://app.flaconvault.com}
  CLUSTER=devnet
  CLUSTER_TAG=2
  STATE_DIR=${FV_ROLLOUT_STATE_DIR:-$HOME/flaconvault-rollout}   # backups, logs and step markers: outside the repo
  RAILWAY=railway
fi
VERIFY_URL=${VERIFY_URL%/}
STATE_DIR=${STATE_DIR%/}
WALLET=${ANCHOR_WALLET:-$HOME/.config/solana/id.json}
WAIT_S=${FV_ROLLOUT_WAIT_S:-900}
POLL_S=${FV_ROLLOUT_POLL_S:-10}
KEY_GRACE_S=${FV_ROLLOUT_KEY_GRACE_S:-660}
for n in WAIT_S POLL_S KEY_GRACE_S; do
  [[ ${(P)n} == <-> ]] || die "FV_ROLLOUT_${n} muss eine Zahl (Sekunden) sein."
done
if (( POLL_S == 0 )); then POLL_S=1; fi
# An RPC URL can carry an API key: it is never printed or logged (the public devnet URL and a plain local one excepted,
# see rpc_hint).
if [[ $RPC == *mainnet* ]]; then
  die "Dieses Skript ist nur für devnet gedacht, die RPC-Adresse zeigt auf mainnet." "Ohne FV_ROLLOUT_RPC starten."
fi
# http(s)://127.0.0.1, localhost or [::1], any port, nothing else (the rule of isLocalUrl in scripts/lib/cli.ts)
is_local_url() { [[ $1 == http(|s)://(localhost|127.0.0.1|\[::1\])(|:<->)(|/*) ]]; }
if (( LOCAL )); then
  # The rehearsal changes defaults only; an override pointing elsewhere would upgrade a real cluster after a question
  # that names localnet, with the devnet checks (CI run, live verifier and web app) skipped.
  for n in RPC:FV_ROLLOUT_RPC VERIFY_URL:FV_ROLLOUT_VERIFY_URL WEB_URL:FV_ROLLOUT_WEB_URL; do
    is_local_url "${(P)${n%%:*}}" || die "Die Probe (FV_ROLLOUT_LOCAL=1) läuft nur gegen diesen Mac, aber ${n#*:} zeigt woanders hin." \
      "Für die Probe ${n#*:} weglassen oder auf 127.0.0.1 setzen; für devnet ohne FV_ROLLOUT_LOCAL starten."
  done
  if [[ -n $RAILWAY && ( $RAILWAY != /* || ! -x $RAILWAY ) ]]; then
    die "FV_ROLLOUT_RAILWAY muss der volle Pfad eines ausführbaren Probe-Ersatzes für Railway sein." "Bitte Claude Bescheid geben."
  fi
fi
# A state folder belongs to the cluster that first wrote to it (file "cluster", written by private_dir).
if [[ -f $STATE_DIR/cluster && $(<"$STATE_DIR/cluster") != $CLUSTER ]]; then
  die "Der Ordner $STATE_DIR gehört zu $(<"$STATE_DIR/cluster"), nicht zu $CLUSTER." \
    "Sicherungen und Markierungen dürfen sich nicht mischen. Ohne FV_ROLLOUT_STATE_DIR starten oder Claude fragen."
fi

for d in "$HOME/.local/share/solana/install/active_release/bin" "$HOME/.cargo/bin"; do
  if [[ -d $d && ":$PATH:" != *":$d:"* ]]; then PATH="$PATH:$d"; fi
done
export PATH

need() {
  local t
  for t in "$@"; do
    command -v "$t" >/dev/null 2>&1 || die "Das Werkzeug '$t' fehlt auf diesem Mac." "Bitte Claude Bescheid geben."
  done
}
need git python3 curl

# ---------------------------------------------------------------------------------------------------------------------
# helper: JSON and bytes (python3 stdlib only). It never prints a secret: commands that read one print derived facts,
# and `keypair-part ... seed` / `token` write to stdout only inside a pipe into `railway variable set --stdin`. On bad
# input it names the exception type, never the input.
PYHELP=$(cat <<'PY'
import base64, hashlib, json, os, re, secrets, sys, time

B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
B58_RE = r"[1-9A-HJ-NP-Za-km-z]"

def b58(b):
    n = int.from_bytes(b, "big")
    s = ""
    while n:
        n, r = divmod(n, 58)
        s = B58[r] + s
    return "1" * (len(b) - len(b.lstrip(b"\0"))) + s

def keypair(text):
    """The 64 bytes of a Solana keypair JSON (the format apps/verify/fv/config.py parse_keypair takes), else None."""
    try:
        raw = json.loads(text)
    except Exception:
        return None
    if isinstance(raw, list) and len(raw) == 64 and all(type(x) is int and 0 <= x <= 255 for x in raw):
        return bytes(raw)
    return None

def safe(v, pattern):
    v = "" if v is None else (str(v).lower() if isinstance(v, bool) else str(v)).strip()
    return v if re.fullmatch(pattern, v) else ("-" if not v else "invalid")

def railway_vars(text):
    data = json.loads(text)
    if isinstance(data, dict) and isinstance(data.get("variables"), (dict, list)):
        data = data["variables"]
    if isinstance(data, list):
        data = {i.get("name", i.get("key")): i.get("value") for i in data if isinstance(i, dict)}
    if not isinstance(data, dict):
        raise ValueError("format")
    return data

def cmd_vars():
    """stdin: `railway variable list --json` (raw values!). stdout: facts only."""
    v = railway_vars(sys.stdin.read())
    def state(name):
        if name not in v: return "absent"
        if v[name] is None: return "sealed"          # Railway lists sealed variables with a null value
        return "set" if str(v[name]).strip() else "empty"
    relay = state("FV_RELAY_ENABLED")
    on = relay == "set" and str(v["FV_RELAY_ENABLED"]).strip().lower() in ("1", "true", "yes", "on")   # config.py _bool
    print("relay=" + ("unknown" if relay == "sealed" else "on" if on else "off"))
    for name, key in (("FV_RELAYER_KEY", "relayer_key"), ("FV_ADMIN_TOKEN", "admin_token"),
                      ("FV_SERVER_ED25519_SEED", "server_seed"), ("FV_MASTER_KEY", "master_key")):
        print(key + "=" + ("yes" if state(name) in ("set", "sealed") else "no"))
    kp = keypair(v.get("FV_RELAYER_KEY") or "")
    rk = state("FV_RELAYER_KEY")
    print("relayer_pub=" + (b58(kp[32:]) if kp else "sealed" if rk == "sealed" else "invalid" if rk == "set" else "-"))
    print("cluster=" + safe(v.get("FV_CLUSTER"), r"[a-z]{1,16}"))
    print("program_id=" + safe(v.get("FV_PROGRAM_ID"), B58_RE + r"{32,44}"))
    print("server_key_id=" + safe(v.get("FV_SERVER_KEY_ID"), r"\d{1,3}"))

def cmd_keypair_part():
    """argv: FILE seed|pub|check. seed (hex, only into a pipe), pub (hex) or nothing; exit 3 if not a keypair."""
    with open(sys.argv[2]) as f:
        kp = keypair(f.read())
    if kp is None:
        raise ValueError("not a keypair")
    part = sys.argv[3]
    if part == "seed": sys.stdout.write(kp[:32].hex())
    elif part == "pub": print(kp[32:].hex())

def cmd_token():
    sys.stdout.write(secrets.token_urlsafe(32))   # FV_ADMIN_TOKEN, as docs/deploy.md suggests

def cmd_health():
    """stdin: GET /health. stdout: key=value of its public fields."""
    h = json.loads(sys.stdin.read())
    if not isinstance(h, dict): raise ValueError("format")
    r = h.get("relay") if isinstance(h.get("relay"), dict) else None
    tok = r"[A-Za-z0-9._-]{1,80}"
    print("ok=" + safe(h.get("ok"), tok))
    print("build=" + safe(h.get("build"), r"[0-9a-f]{7,64}"))
    print("keyId=" + safe(h.get("keyId"), r"\d{1,3}"))
    print("pubkeyHex=" + safe(h.get("pubkeyHex"), r"[0-9a-f]{64}"))
    print("simulator=" + safe(h.get("simulator"), tok))
    print("cluster=" + safe(h.get("cluster"), tok))
    print("relay=" + ("present" if r is not None else "absent"))
    print("relayEnabled=" + safe(r.get("enabled") if r else None, tok))
    print("relayOk=" + safe(r.get("ok") if r else None, tok))

def cmd_program():
    """stdin: `solana program show <id> --output json`. stdout: authority dataLen programdata."""
    d = json.loads(sys.stdin.read())
    print(d.get("authority") or "none", int(d["dataLen"]), d.get("programdataAddress") or "-")

def cmd_registry():
    """stdin: `solana account <registry> --output json`. stdout: authority, then one line per server key."""
    d = json.loads(sys.stdin.read())
    raw = base64.b64decode(d["account"]["data"][0])
    if raw[:8] != hashlib.sha256(b"account:Registry").digest()[:8]:
        raise ValueError("not a Registry account")
    print("authority " + b58(raw[8:40]))
    now, off = int(time.time()), 44
    for _ in range(int.from_bytes(raw[40:44], "little")):
        kid, pub = raw[off], raw[off + 1:off + 33].hex()
        vf = int.from_bytes(raw[off + 33:off + 41], "little", signed=True)
        vt = int.from_bytes(raw[off + 41:off + 49], "little", signed=True)
        off += 49
        status = "revoked" if vt != 0 and now > vt else "notyet" if now < vf else "valid"   # ServerKey::is_valid_at
        print("key %d %s %s" % (kid, pub, status))

def cmd_same():
    """argv: SO DUMP. equal = the dump starts with the .so and the rest of the ProgramData is zero."""
    with open(sys.argv[2], "rb") as f: so = f.read()
    with open(sys.argv[3], "rb") as f: dump = f.read()
    same = (len(dump) >= len(so) and hashlib.sha256(dump[:len(so)]).digest() == hashlib.sha256(so).digest()
            and not dump[len(so):].strip(b"\0"))
    print("equal" if same else "different")

def cmd_sha256():
    with open(sys.argv[2], "rb") as f: print(hashlib.sha256(f.read()).hexdigest())

def cmd_ci():
    """argv: SHA; stdin: `gh run list --json`. stdout: success | pending | failure | none."""
    sha = sys.argv[2]
    runs = [r for r in json.loads(sys.stdin.read() or "[]") if r.get("headSha", sha) == sha]
    if any(r.get("status") == "completed" and r.get("conclusion") == "success" for r in runs): print("success")
    elif any(r.get("status") != "completed" for r in runs): print("pending")
    else: print("failure" if runs else "none")

def cmd_ci_ids():
    """argv: SHA; stdin: `gh run list --json`. stdout: ids of completed successful runs, newest first."""
    sha = sys.argv[2]
    runs = [r for r in json.loads(sys.stdin.read() or "[]") if r.get("headSha", sha) == sha
            and r.get("status") == "completed" and r.get("conclusion") == "success"]
    for r in sorted(runs, key=lambda r: int(r.get("databaseId") or 0), reverse=True):
        print(int(r["databaseId"]))

def cmd_anchor_job():
    """stdin: `gh run view <id> --json jobs`. stdout: success when the anchor job (local validator) passed."""
    jobs = json.loads(sys.stdin.read()).get("jobs") or []
    print("success" if any(str(j.get("name", "")).startswith("anchor test") and j.get("conclusion") == "success"
                           for j in jobs) else "missing")

def cmd_buffers():
    """stdin: `solana program show --buffers --output json`. stdout: <count> <lamports> <address>... (the close prints
    no signature; log_sig finds it by address)."""
    b = json.loads(sys.stdin.read()).get("buffers") or []
    addrs = [str(x.get("address") or "") for x in b]
    print(len(b), sum(int(x.get("lamports") or 0) for x in b), *[a for a in addrs if re.fullmatch(B58_RE + r"{32,44}", a)])

def cmd_newest_sig():
    """stdin: `solana transaction-history --output json`. stdout: the newest signature or -."""
    h = json.loads(sys.stdin.read() or "[]")
    print(h[0]["signature"] if h else "-")

SIG_RE = re.compile(r"(?<![1-9A-HJ-NP-Za-km-z])" + B58_RE + r"{86,88}(?![1-9A-HJ-NP-Za-km-z])")

def cmd_redact():
    """argv: RPC [LABEL SIGLOG TS]; copies stdin to stdout line by line with the RPC URL (it may carry an API key)
    replaced; with LABEL, appends "TS LABEL <signature>" to SIGLOG for every transaction signature in it."""
    rpc, sigs = sys.argv[2], []
    for line in sys.stdin:
        if len(rpc) > 8: line = line.replace(rpc, "<RPC>")
        sys.stdout.write(line)
        sys.stdout.flush()
        sigs += SIG_RE.findall(line)
    if len(sys.argv) > 5 and sigs:
        with open(sys.argv[4], "a") as f:
            f.writelines("%s %s %s\n" % (sys.argv[5], sys.argv[3], sig) for sig in sigs)

def cmd_kv():
    """argv: FILE KEY; the value of KEY=VALUE in a state file, or -."""
    try:
        with open(sys.argv[2]) as f:
            for line in f:
                k, _, v = line.rstrip("\n").partition("=")
                if k == sys.argv[3]: print(v); return
    except FileNotFoundError:
        pass
    print("-")

try:
    globals()["cmd_" + sys.argv[1].replace("-", "_")]()
except Exception as e:
    sys.stderr.write("rollout helper %s: %s\n" % (sys.argv[1] if len(sys.argv) > 1 else "?", type(e).__name__))
    sys.exit(3)
PY
)
py() { python3 -I -c "$PYHELP" "$@"; }

# ---------------------------------------------------------------------------------------------------------------------
# shared checks and reads

typeset -A H RV AUTH LEN PD SO NEW SUM CUR EXTRA EXTRA_RENT BUF
SHA=""
WALLET_PUB=""
REG_AUTH=""
REG_KEYS=()
LOG=/dev/null
SIGLOG=/dev/null
BK=""

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/fv-rollout.XXXXXX")
chmod 700 "$TMP_DIR"
# `npx tsx` listens on a socket under $TMPDIR/tsx-<uid>/, and macOS caps a socket path at 104 bytes: with a TMPDIR
# longer than 80 characters (a sandbox's) it fails with "listen EINVAL", so npx gets a short private dir of its own.
if (( ${#${TMPDIR:-/tmp}} > 80 )); then
  NPX_TMP=$(mktemp -d /tmp/fv-npx.XXXXXX)
  chmod 700 "$NPX_TMP"
fi

short() { print -r -- "${1[1,7]}"; }
num() {   # 466592 → 466.592
  local s=$1 out=""
  while (( ${#s} > 3 )); do out=".${s[-3,-1]}$out"; s=${s[1,-4]}; done
  print -r -- "$s$out"
}
sol() {   # lamports → SOL with a German decimal comma, at most 4 decimals (rounded): 652434560 → 0,6524
  local n=$(( ($1 + 50000) / 100000 )) r f
  r=$(( n % 10000 ))
  f=${(l:4::0:)r}
  while [[ $f == *0 ]]; do f=${f%0}; done
  print -r -- "$(( n / 10000 ))${f:+,$f}"
}
sol_arg() {   # lamports → the exact decimal SOL amount `solana transfer` takes: 500000000 → 0.500000000
  local r=$(( $1 % 1000000000 ))
  print -r -- "$(( $1 / 1000000000 )).${(l:9::0:)r}"
}
json_int() {   # <field> <json>: the integer value of "field" in a Solana CLI's JSON output
  local re="\"$1\": *([0-9]+)"
  [[ $2 =~ $re ]] || return 1
  print -r -- "$match[1]"
}
rpc_hint() {   # the RPC for a command shown to the owner: the public devnet URL or a plain local one, else the variable
  if [[ $RPC == $DEVNET_RPC ]] || { is_local_url "$RPC" && [[ $RPC != *[?@#]* ]]; }; then
    print -r -- "$RPC"
  else
    print -r -- '"$FV_ROLLOUT_RPC"'
  fi
}

check_clean() {
  [[ -z $(git status --porcelain) ]] || die "Im Ordner gibt es ungespeicherte Änderungen." \
    "Es würde sonst etwas anderes hochgeladen oder gebaut als der geprüfte Stand. Bitte Claude Bescheid geben."
}

check_main() {
  local branch
  branch=$(git rev-parse --abbrev-ref HEAD)
  [[ $branch == main ]] || die "Hier ist der Zweig '$branch' ausgecheckt, nicht main." \
    "Online geht nur, was auf main ist. Bitte Claude Bescheid geben."
  git fetch --quiet origin main 2>/dev/null || die "GitHub ist gerade nicht erreichbar (git fetch)." "Gleich nochmal starten."
  [[ $(git rev-parse HEAD) == $(git rev-parse refs/remotes/origin/main) ]] || die \
    "Dieser Stand ist nicht genau der auf GitHub (origin/main)." "Bitte Claude Bescheid geben."
}

check_ci() {   # ci.yml has a successful run for this commit (any event)
  local runs verdict
  runs=$(gh run list --workflow ci.yml --commit "$1" --json databaseId,status,conclusion,event,headSha --limit 50 2>/dev/null) \
    || die "GitHub antwortet nicht (gh run list)." "Gleich nochmal starten."
  verdict=$(print -r -- "$runs" | py ci "$1") || die "Die Antwort von GitHub ist nicht lesbar." "Bitte Claude Bescheid geben."
  case $verdict in
    success) ok "Tests auf GitHub grün für $(short $1)" ;;
    pending) die "Die Tests auf GitHub laufen noch für $(short $1)." "In ein paar Minuten nochmal starten." ;;
    failure) die "Die Tests auf GitHub sind rot für $(short $1)." "Bitte Claude Bescheid geben." ;;
    *) die "Für $(short $1) gibt es noch keinen Testlauf auf GitHub." "Erst wenn die Tests nach dem Push grün sind, nochmal starten." ;;
  esac
}

# The manual CI run with "anchor" ticked (docs/devnet.md, P1 rollout step 0): local validator, LiteSVM record_scan_v2
# and the escrow time-travel tests. Without one for this commit the step starts it and stops.
check_anchor_ci() {
  local runs id jobs
  runs=$(gh run list --workflow ci.yml --commit "$1" --event workflow_dispatch --json databaseId,status,conclusion,event,headSha --limit 20 2>/dev/null) \
    || die "GitHub antwortet nicht (gh run list)." "Gleich nochmal starten."
  for id in ${(f)"$(print -r -- "$runs" | py ci-ids "$1" 2>/dev/null)"}; do
    [[ -n $id ]] || continue
    jobs=$(gh run view "$id" --json jobs 2>/dev/null) || continue
    if [[ $(print -r -- "$jobs" | py anchor-job 2>/dev/null) == success ]]; then
      ok "Programm-Tests auf GitHub (CI mit anchor) grün für $(short $1)"
      return 0
    fi
  done
  case $(print -r -- "$runs" | py ci "$1" 2>/dev/null) in
    pending) die "Die Programm-Tests auf GitHub (CI mit anchor) laufen noch." "In etwa einer halben Stunde nochmal starten." ;;
    failure) die "Die Programm-Tests auf GitHub (CI mit anchor) sind rot für $(short $1)." "Bitte Claude Bescheid geben." ;;
  esac
  if (( DRY )); then
    die "Die Programm-Tests auf GitHub (CI mit anchor) fehlen noch für $(short $1)." "Der echte Lauf (ohne --dry-run) startet sie."
  fi
  if [[ $(git rev-parse refs/remotes/origin/main 2>/dev/null) == $1 ]] && gh workflow run ci.yml --ref main -f anchor=true >/dev/null 2>&1; then
    die "Die Programm-Tests auf GitHub (CI mit anchor) fehlten noch. Ich habe sie gerade gestartet." \
      "Sie dauern etwa 30 bis 45 Minuten. Danach diesen Schritt nochmal starten."
  fi
  die "Die Programm-Tests auf GitHub (CI mit anchor) fehlen für $(short $1)." "Bitte Claude Bescheid geben."
}

# H = public fields of GET /health; returns 1 when the verifier does not answer with them
read_health() {
  H=()
  local raw facts line
  raw=$(curl -fsS --max-time 15 "$VERIFY_URL/health" 2>/dev/null) || return 1
  facts=$(print -r -- "$raw" | py health 2>/dev/null) || return 1
  for line in ${(f)facts}; do H[${line%%=*}]=${line#*=}; done
  return 0
}

# wait_until <function>: polls /health until the function (reading H) succeeds, at most WAIT_S seconds
wait_until() {
  local waited=0
  while true; do
    if read_health && $1; then return 0; fi
    if (( waited >= WAIT_S )); then return 1; fi
    sleep "$POLL_S"
    waited=$(( waited + POLL_S ))
  done
}

web_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$WEB_URL" 2>/dev/null || true; }
wait_web() {
  local i
  for i in 1 2 3 4 5 6; do
    if [[ $(web_code) == 200 ]]; then return 0; fi
    sleep "$POLL_S"
  done
  return 1
}

wallet_pub() {
  [[ -r $WALLET ]] || die "Die Wallet-Datei fehlt: $WALLET" "Bitte Claude Bescheid geben."
  WALLET_PUB=$(solana-keygen pubkey "$WALLET" 2>/dev/null) || die "Die Wallet-Datei ist nicht lesbar: $WALLET" "Bitte Claude Bescheid geben."
}

lamports_of() {
  local out
  out=$(solana balance "$1" --url "$RPC" --output json 2>/dev/null) || return 1
  json_int lamports "$out"
}
rent_of() {
  local out
  out=$(solana rent "$1" --url "$RPC" --output json 2>/dev/null) || return 1
  json_int rentExemptMinimumLamports "$out"
}

program_info() {   # <name> <program id> → AUTH, LEN (ProgramData data length), PD (ProgramData address)
  local out
  local -a f
  out=$(solana program show "$2" --url "$RPC" --output json 2>/dev/null) \
    || die "Das Programm $1 ist auf der Chain nicht lesbar." "Gleich nochmal starten."
  out=$(print -r -- "$out" | py program) || die "Die Angaben zum Programm $1 sind nicht lesbar." "Bitte Claude Bescheid geben."
  f=(${=out})
  AUTH[$1]=${f[1]}
  LEN[$1]=${f[2]}
  PD[$1]=${f[3]}
}

registry_info() {   # REG_AUTH and REG_KEYS ("<id> <pubkeyHex> valid|revoked|notyet")
  local out line
  out=$(solana account "$REGISTRY" --url "$RPC" --output json 2>/dev/null) \
    || die "Die Registry ist auf der Chain nicht lesbar." "Gleich nochmal starten."
  out=$(print -r -- "$out" | py registry) || die "Die Registry ist nicht lesbar." "Bitte Claude Bescheid geben."
  REG_KEYS=()
  for line in ${(f)out}; do
    case $line in
      "authority "*) REG_AUTH=${line#authority } ;;
      "key "*) REG_KEYS+=("${line#key }") ;;
    esac
  done
}

npx_tsx() { env ${NPX_TMP:+TMPDIR=$NPX_TMP} ANCHOR_PROVIDER_URL="$RPC" ANCHOR_WALLET="$WALLET" npx tsx "$@"; }

holder_tag() {   # prints none | <cluster_tag> of the HolderConfig; returns 1 when it cannot be read (see holder_die)
  local out
  out=$(npx_tsx scripts/holder-config.ts show 2>"$TMP_DIR/holder.err") || return 1
  if [[ $out == *"not initialised"* ]]; then print -r -- none; return 0; fi
  [[ $out =~ 'cluster_tag ([0-9]+)' ]] || return 1
  print -r -- "$match[1]"
}
show_holder_config() {   # the HolderConfig as scripts/holder-config.ts prints it (the program's field names), indented
  local out
  out=$(npx_tsx scripts/holder-config.ts show 2>/dev/null) || return 1
  print -r -- "$out" | py redact "$RPC" | sed 's/^/    /'
}
holder_die() {   # the tool's last lines (RPC URL redacted), then a German stop
  tail -n 5 "$TMP_DIR/holder.err" 2>/dev/null | py redact "$RPC" >&2 || true
  die "Die HolderConfig ist nicht lesbar." "Gleich nochmal starten; scheitert es wieder, die Zeilen oben an Claude schicken."
}
holdings_count() {   # <init-holdings.ts --dry-run output> → "<passports> <without a Holding>"
  [[ $1 =~ '([0-9]+) passports, ([0-9]+) without a Holding' ]] || return 1
  print -r -- "$match[1] $match[2]"
}

# Railway ($RAILWAY: the CLI, or a rehearsal's stand-in): sign-in, and the facts of the verifier's variables (never
# their values). railway_ready never prompts; in a rehearsal it accepts only a stand-in that names itself as one, so a
# FV_ROLLOUT_RAILWAY pointing at the real CLI cannot reach the production verifier.
STANDIN_MARK="fv-rollout stand-in"
railway_ready() {
  local who
  [[ -n $RAILWAY ]] && command -v "$RAILWAY" >/dev/null 2>&1 || return 1
  who=$("$RAILWAY" whoami 2>/dev/null) || return 1
  (( ! LOCAL )) || [[ $who == *"$STANDIN_MARK"* ]]
}
railway_login() {
  if railway_ready; then return 0; fi
  if (( LOCAL )); then
    die "FV_ROLLOUT_RAILWAY ist kein Probe-Ersatz für Railway (whoami nennt nicht \"$STANDIN_MARK\")." \
      "Die Probe ruft das echte Railway nie auf. Bitte Claude Bescheid geben."
  fi
  if (( DRY )); then die "Railway: nicht angemeldet." "Ohne --dry-run starten: dann öffnet sich die Anmeldung."; fi
  say "Railway: Anmeldung nötig, gleich öffnet sich der Browser."
  "$RAILWAY" login || die "Die Railway-Anmeldung hat nicht geklappt." "Nochmal starten."
  railway_ready || die "Die Railway-Anmeldung hat nicht geklappt." "Nochmal starten."
}
railway_facts() {
  local facts line
  facts=$("$RAILWAY" variable list --service verify --json 2>/dev/null | py vars 2>/dev/null) \
    || die "Die Railway-Variablen des Verifiers sind nicht lesbar." "Prüfen, ob 'railway login' geklappt hat, dann nochmal starten."
  RV=()
  for line in ${(f)facts}; do RV[${line%%=*}]=${line#*=}; done
}
# railway_secret <NAME> <command producing the value>: the value goes from the command straight into Railway (stdin),
# staged with --skip-deploys. Railway's own output is not shown: nothing of the value can appear on screen.
railway_secret() {
  local name=$1
  shift
  "$@" | "$RAILWAY" variable set "$name" --stdin --service verify --skip-deploys >/dev/null 2>&1 \
    || die "Railway hat $name nicht gespeichert (Ausgabe aus Sicherheitsgründen nicht gezeigt)." \
      "Prüfen, ob 'railway login' geklappt hat, dann nochmal starten."
}

# run_logged <label> <command...>: logs the tool's output (RPC URL redacted) and records its transaction signatures.
# The owner reads German: the tool's own text (English, warnings such as Anchor's deprecation notice) stays in the
# log, and only when the tool fails do its last lines appear, to send to Claude.
run_logged() {
  local label=$1 rc=0 ts cmdline
  shift
  ts=$(date -u +%FT%TZ)
  cmdline="$*"
  # ${x//$RPC/...} takes $RPC literally (GLOB_SUBST is off); ${(b)RPC} would add backslashes that never match
  print -r -- "$ts \$ ${cmdline//$RPC/<RPC>}" >> "$LOG"
  if "$@" 2>&1 | py redact "$RPC" "$label" "$SIGLOG" "$ts" | tee -a "$LOG" > "$TMP_DIR/run.out"; then rc=0; else rc=$?; fi
  if (( rc != 0 )); then
    print -r -- "Ausgabe von $label, letzte Zeilen:" >&2
    grep -v '^[[:space:]]*$' "$TMP_DIR/run.out" | tail -n 12 | sed 's/^/  /' >&2 || true
  fi
  return $rc
}
log_sig() {   # <label> <address>: the newest signature touching the address (extend and close print none)
  local out sig
  out=$(solana transaction-history "$2" --limit 1 --url "$RPC" --output json 2>/dev/null) || return 0
  sig=$(print -r -- "$out" | py newest-sig 2>/dev/null) || return 0
  if [[ $sig != - ]]; then print -r -- "$(date -u +%FT%TZ) $1 $sig" >> "$SIGLOG"; fi
}

# private_dir <dir under STATE_DIR>: created private (700); the first one also marks STATE_DIR with this cluster
private_dir() {
  (umask 077; mkdir -p "$1")
  if [[ ! -f $STATE_DIR/cluster ]]; then print -r -- "$CLUSTER" > "$STATE_DIR/cluster"; fi
}
make_secret_dir() { SECRET_DIR=$(mktemp -d "${TMPDIR:-/tmp}/fv-secret.XXXXXX"); chmod 700 "$SECRET_DIR"; }

confirm() {   # one question; anything but j/ja/y/yes stops without changes
  local answer=""
  print -n -- "$1 (j/n) "
  if ! read -r answer; then answer=""; fi
  case ${answer:l} in
    j|ja|y|yes) return 0 ;;
  esac
  die "Abgebrochen. Auf der Chain und auf Railway wurde nichts verändert."
}

# ---------------------------------------------------------------------------------------------------------------------
# step 1: deploy (docs/deploy.md, Deploying). The verifier goes first, then the web app: the new web app offers the
# public record only while /health reports `relay`, and the relay stays off until step relay.

clip() {   # <text> <max>: at most <max> characters, cut at a word boundary, with … when cut
  local s=$1 n=$2
  if (( ${#s} <= n )); then print -r -- "$s"; return 0; fi
  if [[ ${s[n+1]} == " " || ${s[1,n]} != *" "* ]]; then s=${s[1,n]}; else s=${${s[1,n]}% *}; fi
  while [[ $s == *[[:space:],\;:] ]]; do s=${s[1,-2]}; done
  print -r -- "$s…"
}

step_deploy() {
  local verifier_live=0
  if (( ! LOCAL )); then need railway vercel gh tar; fi
  title "Prüfungen"
  if (( ! LOCAL )); then check_main; fi
  check_clean
  SHA=$(git rev-parse HEAD)
  ok "Stand $(short $SHA): $(clip "$(git log -1 --format=%s)" 70)"
  if (( ! LOCAL )); then
    check_ci "$SHA"
    railway_login
    railway_facts
    case ${RV[relay]} in
      on) die "Das Relay ist auf Railway schon an (FV_RELAY_ENABLED)." \
        "Dieser Schritt bringt einen Stand nur mit Relay AUS online. Bitte Claude Bescheid geben." ;;
      unknown) die "FV_RELAY_ENABLED ist auf Railway versiegelt, ich sehe nicht, ob das Relay aus ist." "Bitte Claude Bescheid geben." ;;
    esac
    ok "Relay auf Railway: aus"
    [[ -f .vercel/project.json ]] || die "Die Vercel-Verknüpfung (.vercel) fehlt in diesem Ordner." "Bitte Claude Bescheid geben."
    # The CLI sign-in expires after hours; the first command then renews it but fails, so a whoami goes first.
    vercel whoami >/dev/null 2>&1 || vercel whoami >/dev/null 2>&1 || die "Vercel: nicht angemeldet." "Bitte Claude Bescheid geben (vercel login)."
    ok "Railway und Vercel: angemeldet"
  fi
  if read_health && [[ ${H[build]} == $SHA ]]; then verifier_live=1; fi

  title "Plan"
  if (( LOCAL )); then
    say "Lokal: nichts hochladen. Prüfen, dass der Verifier ($VERIFY_URL) $(short $SHA) meldet und die Web-App ($WEB_URL) antwortet."
  else
    if (( verifier_live )); then
      say "1. Verifier: läuft schon mit $(short $SHA), wird übersprungen."
    else
      say "1. Verifier: FV_BUILD_SHA=$(short $SHA) setzen, hochladen (railway up), warten bis /health ihn meldet (bis $(( WAIT_S / 60 )) Min.)."
    fi
    say "2. Web-App: Export von $(short $SHA) zu Vercel (production), dann prüfen, ob $WEB_URL antwortet."
    say "Das Relay bleibt aus."
  fi
  if (( DRY )); then say ""; say "Nur Vorschau (--dry-run): nichts verändert."; return 0; fi

  if (( LOCAL )); then
    read_health || die "Der lokale Verifier ($VERIFY_URL) antwortet nicht." "Erst den Verifier starten."
    [[ ${H[build]} == $SHA ]] || die "Der lokale Verifier meldet den Stand '${H[build]}' statt $(short $SHA)." \
      "Den Verifier mit FV_BUILD_SHA=$SHA neu starten."
  else
    if (( ! verifier_live )); then
      title "Verifier"
      railway variable set FV_BUILD_SHA="$SHA" --service verify --skip-deploys >/dev/null \
        || die "Railway hat FV_BUILD_SHA nicht gespeichert." "Gleich nochmal starten."
      say "Lade den Verifier hoch, Railway baut danach ein paar Minuten …"
      railway up --service verify --detach --ci || die "Das Hochladen zu Railway ist fehlgeschlagen." "Gleich nochmal starten."
      say "Warte, bis $VERIFY_URL den neuen Stand meldet …"
      if ! python3 .github/scripts/check-health.py "$VERIFY_URL" --build "$SHA" --simulator false --wait-for-build --timeout "$WAIT_S" > "$TMP_DIR/health" 2>&1; then
        grep '::error::' "$TMP_DIR/health" | cut -c10- | sed 's/^/  /' >&2 || true
        die "Der neue Verifier ist nicht gesund online." "Der alte Stand läuft weiter. Bitte Claude Bescheid geben (railway logs --service verify)."
      fi
    fi
    read_health || die "Der Verifier antwortet nicht mehr." "Gleich nochmal starten."
    [[ ${H[relayEnabled]} != true ]] || die "Der Verifier meldet das Relay als an." "Bitte Claude Bescheid geben."
    ok "Verifier läuft mit $(short $SHA), Relay aus"

    title "Web-App"
    EXPORT_DIR=$(mktemp -d "${TMPDIR:-/tmp}/fv-export.XXXXXX")
    D=$EXPORT_DIR/flaconvault && mkdir -p "$D"
    git archive "$SHA" | tar -x -C "$D"
    cp -R .vercel "$D/"
    vercel --cwd "$D" --prod --yes || die "Die Veröffentlichung bei Vercel ist fehlgeschlagen." "Gleich nochmal starten (der Verifier ist schon online)."
    rm -rf -- "$EXPORT_DIR"
    EXPORT_DIR=""
  fi
  wait_web || die "Die Web-App ($WEB_URL) antwortet nicht mit 200." "In ein paar Minuten nochmal starten."
  ok "Web-App antwortet ($WEB_URL)"
  private_dir "$STATE_DIR/deployed"
  print -r -- "$(date -u +%FT%TZ) verifier+web $SHA" > "$STATE_DIR/deployed/$SHA"
  title "Fertig"
  if (( LOCAL )); then
    say "Verifier und Web-App laufen mit $(short $SHA)."
  else
    say "Verifier und Web-App laufen mit $(short $SHA), das Relay ist aus."
  fi
  say "Nächster Schritt: zsh scripts/p1-rollout.sh chain"
}

# ---------------------------------------------------------------------------------------------------------------------
# step 2: chain (docs/devnet.md, P1 rollout steps 1-3). A plain `anchor build`: the owner's Mac has no Docker, so no
# verifiable build; the sha256 of each .so is recorded, and after each upgrade the deployed bytes are compared with it.

check_live() {   # the verifier and the web app of this commit are online (step deploy)
  read_health || die "Der Verifier ($VERIFY_URL) antwortet nicht." "Erst Schritt 1: zsh scripts/p1-rollout.sh deploy"
  [[ ${H[build]} == $1 ]] || die "Online läuft der Stand '${H[build][1,7]}', hier ist $(short $1)." \
    "Erst Schritt 1 für diesen Stand: zsh scripts/p1-rollout.sh deploy"
  [[ -f $STATE_DIR/deployed/$1 ]] || die "Die Web-App von $(short $1) wurde noch nicht mit diesem Skript veröffentlicht." \
    "Erst Schritt 1: zsh scripts/p1-rollout.sh deploy"
  [[ $(web_code) == 200 ]] || die "Die Web-App ($WEB_URL) antwortet nicht mit 200." "In ein paar Minuten nochmal starten."
  ok "Verifier und Web-App laufen mit $(short $1)"
}

backup_dir() {   # the first backup folder of this commit, else a new one named by today's UTC date
  local -a found
  found=($STATE_DIR/*-$(short $SHA)(N/))
  if (( ${#found} )); then BK=${found[1]}; else BK=$STATE_DIR/$(date -u +%Y-%m-%d)-$(short $SHA); fi
}

step_chain() {
  local name id holder passports without holdings_out facts bufout bufcount buflamports todo=0 i=1
  local holder_rent=0 holding_rent=0 writes=0 peak=0 permanent fees need have balance one addr
  local -a hc bufaddrs
  need solana solana-keygen anchor npx bash
  if (( ! LOCAL )); then need gh; fi
  title "Prüfungen"
  wallet_pub
  check_clean
  SHA=$(git rev-parse HEAD)
  check_live "$SHA"
  if (( ! LOCAL )); then check_anchor_ci "$SHA"; fi
  program_info escrow $ESCROW_ID
  program_info flacon $FLACON_ID
  registry_info
  for name in escrow flacon; do
    [[ ${AUTH[$name]} == $WALLET_PUB ]] || die "Die Wallet $WALLET_PUB darf $name nicht upgraden (Upgrade-Recht hat ${AUTH[$name]})." \
      "Es braucht die Deploy-Wallet. Bitte Claude Bescheid geben."
  done
  [[ $REG_AUTH == $WALLET_PUB ]] || die "Die Wallet $WALLET_PUB ist nicht die Registry-Autorität ($REG_AUTH)." \
    "Es braucht die Deploy-Wallet. Bitte Claude Bescheid geben."
  ok "Wallet $WALLET_PUB: Upgrade-Recht für escrow und flacon, Registry-Autorität"

  title "Build"
  if (( DRY )); then
    [[ -s target/deploy/escrow.so && -s target/deploy/flacon.so ]] || die "Für die Vorschau fehlt ein Build (target/deploy)." \
      "Ohne --dry-run starten: der echte Lauf baut zuerst und fragt vor dem ersten Schritt auf der Chain."
    say "Vorschau mit dem vorhandenen Build in target/deploy (der echte Lauf baut neu)."
  else
    backup_dir
    private_dir "$BK"
    LOG=$BK/rollout.log
    SIGLOG=$BK/signatures.log
    say "Baue die Programme (anchor build, ein paar Minuten) …"
    if ! anchor build > "$BK/build.log" 2>&1; then
      tail -n 30 "$BK/build.log" >&2
      die "Der Build ist fehlgeschlagen." "Bitte Claude Bescheid geben (Protokoll: $BK/build.log)."
    fi
    if [[ -n $(git status --porcelain) ]]; then warn "Der Build hat Dateien im Repo geändert (git status zeigt sie)."; fi
  fi
  # The web app and the scripts load the committed IDLs (packages/proof/src/idl): they must equal this build's.
  if ! bash .github/scripts/idl-check.sh > "$TMP_DIR/idl-check" 2>&1; then
    if (( ! DRY )); then cat "$TMP_DIR/idl-check" >> "$BK/build.log"; fi
    die "Die Programm-Schnittstelle (IDL) des Builds weicht von der im Repo ab." \
      "Web-App und Programme würden nicht zusammenpassen. Bitte Claude Bescheid geben (bash .github/scripts/idl-check.sh zeigt es)."
  fi
  ok "IDL des Builds gleich der im Repo (packages/proof/src/idl)"
  for name in escrow flacon; do
    SO[$name]=target/deploy/$name.so
    [[ -s ${SO[$name]} ]] || die "Der Build hat ${SO[$name]} nicht erzeugt." "Bitte Claude Bescheid geben."
    NEW[$name]=$(( $(wc -c < "${SO[$name]}") ))
    SUM[$name]=$(py sha256 "${SO[$name]}")
    ok "$name.so: $(num ${NEW[$name]}) Bytes, sha256 ${SUM[$name]}"
  done
  if (( ! DRY )); then
    {
      print -r -- "commit $SHA"
      print -r -- "build: plain anchor build (not verifiable: no Docker on this Mac), $(date -u +%FT%TZ)"
      for name in escrow flacon; do print -r -- "${SO[$name]} ${NEW[$name]} bytes sha256 ${SUM[$name]}"; done
    } > "$BK/build.txt"
  fi

  title "Sicherung und Stand auf der Chain"
  for name in escrow flacon; do
    id=$ESCROW_ID
    if [[ $name == flacon ]]; then id=$FLACON_ID; fi
    solana program dump "$id" "$TMP_DIR/$name-now.so" --url "$RPC" >/dev/null 2>&1 \
      || die "Das Programm $name ist nicht herunterladbar (Sicherung)." "Gleich nochmal starten."
    if (( ! DRY )) && [[ ! -s $BK/$name-before.so ]]; then cp "$TMP_DIR/$name-now.so" "$BK/$name-before.so"; fi
    CUR[$name]=$(py same "${SO[$name]}" "$TMP_DIR/$name-now.so")
    EXTRA[$name]=0
    EXTRA_RENT[$name]=0
    BUF[$name]=0
    if [[ ${CUR[$name]} == different ]]; then
      if (( NEW[$name] > LEN[$name] )); then
        EXTRA[$name]=$(( NEW[$name] - LEN[$name] + EXTEND_HEADROOM ))
        if (( EXTRA[$name] < EXTEND_MIN )); then EXTRA[$name]=$EXTEND_MIN; fi
        EXTRA_RENT[$name]=$(rent_of ${EXTRA[$name]}) || die "Die Miete ist nicht abrufbar." "Gleich nochmal starten."
      fi
      BUF[$name]=$(rent_of $(( NEW[$name] + BUFFER_HEADER_BYTES ))) || die "Die Miete ist nicht abrufbar." "Gleich nochmal starten."
    fi
  done
  if (( DRY )); then say "Sicherung (beim echten Lauf): $STATE_DIR/<Datum>-$(short $SHA)/"; else ok "Sicherung beider Programme: $BK"; fi

  holder=$(holder_tag) || holder_die
  if [[ $holder != none && $holder != $CLUSTER_TAG ]]; then
    die "Die HolderConfig gibt es schon, mit cluster_tag $holder statt $CLUSTER_TAG ($CLUSTER)." "Sie ist unveränderlich. Bitte Claude Bescheid geben."
  fi
  if ! holdings_out=$(npx_tsx scripts/init-holdings.ts --dry-run 2>&1); then
    print -r -- "$holdings_out" | py redact "$RPC" >&2
    die "Die Vorschau der Holdings ist fehlgeschlagen." "Gleich nochmal starten."
  fi
  facts=$(holdings_count "$holdings_out") || die "Die Vorschau der Holdings ist nicht lesbar." "Bitte Claude Bescheid geben."
  hc=(${=facts})
  passports=${hc[1]}
  without=${hc[2]}

  bufout=$(solana program show --buffers --buffer-authority "$WALLET_PUB" --url "$RPC" --output json 2>/dev/null) \
    || die "Die Upload-Puffer der Wallet sind nicht lesbar." "Gleich nochmal starten."
  facts=$(print -r -- "$bufout" | py buffers) || die "Die Upload-Puffer der Wallet sind nicht lesbar." "Bitte Claude Bescheid geben."
  hc=(${=facts})
  bufcount=${hc[1]}
  buflamports=${hc[2]}
  bufaddrs=(${hc[3,-1]})

  # What it costs. Permanent: extend rent, the HolderConfig and Holding rent, fees. Temporary: the upgrade writes the
  # .so into a buffer account first (its rent comes back after the upgrade), one program after the other, so the peak
  # is the larger buffer; after the upgrades RESERVE_LAMPORTS must remain for step relay.
  if [[ $holder == none ]]; then
    holder_rent=$(rent_of $HOLDER_CONFIG_BYTES) || die "Die Miete ist nicht abrufbar." "Gleich nochmal starten."
  fi
  if (( without > 0 )); then
    one=$(rent_of $HOLDING_BYTES) || die "Die Miete ist nicht abrufbar." "Gleich nochmal starten."
    holding_rent=$(( without * one ))
  fi
  for name in escrow flacon; do
    if [[ ${CUR[$name]} == different ]]; then writes=$(( writes + (NEW[$name] + 999) / 1000 )); fi
    if (( BUF[$name] > peak )); then peak=${BUF[$name]}; fi
  done
  fees=$(( (writes + without + 20) * 5000 ))
  permanent=$(( EXTRA_RENT[escrow] + EXTRA_RENT[flacon] + holder_rent + holding_rent + fees ))
  if (( peak > RESERVE_LAMPORTS )); then need=$(( permanent + peak )); else need=$(( permanent + RESERVE_LAMPORTS )); fi
  balance=$(lamports_of "$WALLET_PUB") || die "Das Guthaben der Wallet ist nicht lesbar." "Gleich nochmal starten."
  have=$(( balance + buflamports ))

  title "Plan"
  if (( bufcount > 0 )); then
    say "0. $bufcount alte(n) Upload-Puffer schließen (von einem abgebrochenen Upgrade): $(sol $buflamports) SOL kommen zurück."
    todo=1
  fi
  for name in escrow flacon; do
    if [[ ${CUR[$name]} == equal ]]; then
      say "$i. $name: auf der Chain schon gleich dem Build, nichts zu tun."
    else
      todo=1
      if (( EXTRA[$name] > 0 )); then
        say "$i. $name: Platz um $(num ${EXTRA[$name]}) Bytes erweitern (Miete $(sol ${EXTRA_RENT[$name]}) SOL), dann Upgrade auf $(num ${NEW[$name]}) Bytes."
      else
        say "$i. $name: Upgrade auf $(num ${NEW[$name]}) Bytes (passt in die $(num ${LEN[$name]}) Bytes auf der Chain)."
      fi
    fi
    i=$(( i + 1 ))
  done
  if [[ $holder == none ]]; then
    say "3. HolderConfig anlegen: cluster $CLUSTER ($CLUSTER_TAG), danach unveränderlich (Miete $(sol $holder_rent) SOL)."
    todo=1
  else
    say "3. HolderConfig: gibt es schon (cluster_tag $holder), nichts zu tun."
  fi
  if (( without > 0 )); then
    # the preview's own lines (English, one per passport) go to the log only
    say "4. Holding für $without von $passports Pässen anlegen (Miete zusammen $(sol $holding_rent) SOL)."
    todo=1
  else
    say "4. Holdings: alle $passports Pässe haben eine, nichts zu tun."
  fi
  if (( todo == 0 )); then
    title "Fertig"
    say "HolderConfig auf der Chain:"
    show_holder_config || true
    say "Auf der Chain ist schon alles erledigt. Nächster Schritt: zsh scripts/p1-rollout.sh relay"
    return 0
  fi
  say ""
  if (( peak > 0 )); then
    say "Kosten: dauerhaft etwa $(sol $permanent) SOL; während eines Upgrades sind zusätzlich bis zu $(sol $peak) SOL gebunden (kommen danach zurück)."
  else
    say "Kosten: etwa $(sol $permanent) SOL."
  fi
  say "Guthaben: $(sol $balance) SOL. Nötig: $(sol $need) SOL (danach bleiben mindestens $(sol $RESERVE_LAMPORTS) SOL für das Relay)."
  (( have >= need )) || die "Zu wenig devnet-SOL auf der Wallet $WALLET_PUB: $(sol $balance) SOL, nötig $(sol $need) SOL." \
    "Devnet-SOL holen (https://faucet.solana.com, Adresse $WALLET_PUB), dann nochmal starten."
  if (( DRY )); then say ""; say "Nur Vorschau (--dry-run): nichts verändert."; return 0; fi
  print -r -- "$(date -u +%FT%TZ) chain $SHA plan: escrow ${CUR[escrow]} extend ${EXTRA[escrow]}, flacon ${CUR[flacon]} extend ${EXTRA[flacon]}, holder_config $holder, holdings $without/$passports, buffers $bufcount" >> "$LOG"
  if (( without > 0 )); then
    { print -r -- "$(date -u +%FT%TZ) \$ npx_tsx scripts/init-holdings.ts --dry-run"; print -r -- "$holdings_out" | py redact "$RPC"; } >> "$LOG"
  fi

  say ""
  confirm "Jetzt auf $CLUSTER ausführen? Das lässt sich nicht rückgängig machen."

  if (( bufcount > 0 )); then
    run_logged close-buffers solana program close --buffers --authority "$WALLET" --keypair "$WALLET" --recipient "$WALLET_PUB" --url "$RPC" \
      || die "Die alten Upload-Puffer ließen sich nicht schließen." "Gleich nochmal starten."
    # the close prints a table without signatures: each one is looked up by the closed buffer's address
    for addr in $bufaddrs; do log_sig close-buffers "$addr"; done
    ok "Alte Upload-Puffer geschlossen, $(sol $buflamports) SOL zurück"
  fi
  # escrow first: its PassHeldInAccount guard must be live before flacon can run mint_passport_v2 (docs/devnet.md)
  for name in escrow flacon; do
    id=$ESCROW_ID
    if [[ $name == flacon ]]; then id=$FLACON_ID; fi
    if [[ ${CUR[$name]} == equal ]]; then ok "$name: schon aktuell"; continue; fi
    title "$name"
    if (( EXTRA[$name] > 0 )); then
      say "Erweitere $name um $(num ${EXTRA[$name]}) Bytes …"
      run_logged "extend-$name" solana program extend "$id" "${EXTRA[$name]}" --url "$RPC" --keypair "$WALLET" \
        || die "Das Erweitern von $name ist fehlgeschlagen." "Gleich nochmal starten: Erledigtes wird übersprungen."
      log_sig "extend-$name" "${PD[$name]}"
      ok "$name um $(num ${EXTRA[$name]}) Bytes erweitert"
    fi
    say "Upgrade von $name läuft (ein paar Minuten) …"
    run_logged "upgrade-$name" anchor upgrade "${SO[$name]}" --program-id "$id" --provider.cluster "$RPC" --provider.wallet "$WALLET" \
      || die "Das Upgrade von $name ist fehlgeschlagen." \
        "Gleich nochmal starten: Erledigtes wird übersprungen, ein halb geschriebener Upload-Puffer wird geschlossen."
    solana program dump "$id" "$BK/$name-after.so" --url "$RPC" >/dev/null 2>&1 \
      || die "$name ist nach dem Upgrade nicht herunterladbar." "Gleich nochmal starten."
    [[ $(py same "${SO[$name]}" "$BK/$name-after.so") == equal ]] || die "$name auf der Chain ist nach dem Upgrade nicht gleich dem Build." \
      "Bitte Claude Bescheid geben (Sicherung: $BK)."
    ok "$name: auf der Chain gleich dem Build (sha256 ${SUM[$name]})"
  done

  title "HolderConfig"
  if [[ $holder == none ]]; then
    run_logged holder-config npx_tsx scripts/holder-config.ts init "$CLUSTER" \
      || die "Die HolderConfig ließ sich nicht anlegen." "Gleich nochmal starten."
  fi
  holder=$(holder_tag) || holder_die
  [[ $holder == $CLUSTER_TAG ]] || die "Die HolderConfig hat cluster_tag $holder statt $CLUSTER_TAG." "Bitte Claude Bescheid geben."
  ok "HolderConfig vorhanden, cluster_tag $holder ($CLUSTER). Auf der Chain:"
  show_holder_config || die "Die HolderConfig ist nicht lesbar." "Gleich nochmal starten."

  title "Holdings"
  if (( without > 0 )); then
    say "Lege $without Holding(s) an …"
    run_logged holdings npx_tsx scripts/init-holdings.ts || die "Nicht alle Holdings ließen sich anlegen." "Gleich nochmal starten: vorhandene werden übersprungen."
    holdings_out=$(npx_tsx scripts/init-holdings.ts --dry-run 2>/dev/null) && facts=$(holdings_count "$holdings_out") \
      || die "Die Holdings sind nicht lesbar." "Gleich nochmal starten."
    hc=(${=facts})
    [[ ${hc[2]} == 0 ]] || die "Noch ${hc[2]} Pässe ohne Holding." "Gleich nochmal starten."
  fi
  ok "Alle $passports Pässe haben eine Holding"

  title "Fertig"
  say "Beide Programme sind aktuell, HolderConfig und Holdings sind da."
  say "Sicherung, Build-Prüfsummen und Signaturen: $BK"
  say "Nächster Schritt: zsh scripts/p1-rollout.sh relay"
}

# ---------------------------------------------------------------------------------------------------------------------
# step 3: relay (docs/deploy.md, Public record relay; docs/devnet.md, P1 rollout steps 4-5)

relay_ok() { [[ ${H[relayEnabled]} == true && ${H[relayOk]} == true ]]; }

relay_report() {   # <relayer public key | sealed | invalid | ->
  local bal
  if [[ $1 == - || $1 == sealed || $1 == invalid ]]; then
    say "Relayer: öffentlicher Schlüssel hier nicht lesbar (auf Railway versiegelt); GET /api/admin/status zeigt ihn."
  elif bal=$(lamports_of "$1"); then
    say "Relayer: $1, Guthaben $(sol $bal) SOL"
  else
    say "Relayer: $1 (Guthaben gerade nicht lesbar)"
  fi
  say ""
  say "So testest du es: mit dem iPhone ein Siegel antippen. Die Seite zeigt erst \"Saving to the public record within about 3 minutes.\""
  say "und nach ein paar Minuten \"Saved to the public record ✓\". Dann mit der Seriennummer des Passes (z. B. SN-2026-000001):"
  say "  cd \"$ROOT\" && npm run verify-pass -- --rpc $(rpc_hint) --serial <seriennummer>"
}

step_relay() {
  local holder pub bal=-1 top=0 wbal k last
  local -a sets
  need solana solana-keygen npx
  if [[ -n $RAILWAY ]]; then need "$RAILWAY"; fi
  title "Prüfungen"
  wallet_pub
  read_health || die "Der Verifier ($VERIFY_URL) antwortet nicht." "Erst Schritt 1: zsh scripts/p1-rollout.sh deploy"
  [[ ${H[relay]} == present ]] || die "Der Verifier kennt das Relay noch nicht (alter Stand)." "Erst Schritt 1: zsh scripts/p1-rollout.sh deploy"
  holder=$(holder_tag) || holder_die
  [[ $holder == $CLUSTER_TAG ]] || die "Auf der Chain fehlt die HolderConfig ($CLUSTER)." "Erst Schritt 2: zsh scripts/p1-rollout.sh chain"
  ok "Verifier mit Relay-Unterstützung, HolderConfig ($CLUSTER) vorhanden"

  if [[ -z $RAILWAY ]]; then   # a rehearsal without a Railway stand-in: the local verifier is started by hand
    if relay_ok; then ok "Das Relay ist an und meldet ok."; return 0; fi
    title "Lokal"
    say "Ohne FV_ROLLOUT_RAILWAY setzt dieses Skript lokal keine Variablen. Den lokalen Verifier mit FV_RELAYER_KEY"
    say "(eigene Testwallet), FV_CLUSTER=localnet, FV_PROGRAM_ID und FV_RELAY_ENABLED=true starten; ich warte auf relay.ok."
    if (( DRY )); then say "Nur Vorschau (--dry-run): nichts verändert."; return 0; fi
    wait_until relay_ok || die "Der lokale Verifier meldet relay.ok nicht." "Variablen prüfen und den Verifier neu starten."
    ok "Relay an, relay.ok"
    return 0
  fi

  # devnet, or a rehearsal with a stand-in: the same path (key, funding, variables, restart) with real Solana tools
  railway_login
  railway_facts
  [[ ${RV[relayer_key]} == no || ${RV[relayer_pub]} != invalid ]] || die "FV_RELAYER_KEY auf Railway ist kein Solana-Schlüssel." \
    "Bitte Claude Bescheid geben (der Verifier startet so nicht)."
  [[ ${RV[relay]} != unknown ]] || die "FV_RELAY_ENABLED ist auf Railway versiegelt." "Bitte Claude Bescheid geben."
  sets=()
  case ${RV[cluster]} in
    -) sets+=("FV_CLUSTER=$CLUSTER") ;;
    $CLUSTER) ;;
    *) die "FV_CLUSTER auf Railway ist '${RV[cluster]}', erwartet $CLUSTER." "Bitte Claude Bescheid geben." ;;
  esac
  case ${RV[program_id]} in
    -) sets+=("FV_PROGRAM_ID=$FLACON_ID") ;;
    $FLACON_ID) ;;
    *) die "FV_PROGRAM_ID auf Railway ist '${RV[program_id]}', erwartet $FLACON_ID." "Bitte Claude Bescheid geben." ;;
  esac
  if [[ ${RV[relay]} != on ]]; then sets+=("FV_RELAY_ENABLED=true"); fi

  pub=${RV[relayer_pub]}
  if [[ ${RV[relayer_key]} == no ]]; then
    top=$RELAYER_FUND_LAMPORTS
  elif [[ $pub != sealed ]]; then
    bal=$(lamports_of "$pub") || die "Das Guthaben des Relayers ist nicht lesbar." "Gleich nochmal starten."
    if (( bal < RELAYER_LOW_LAMPORTS )); then top=$(( RELAYER_FUND_LAMPORTS - bal )); fi
  fi
  if (( ${#sets} == 0 && top == 0 )) && read_health && relay_ok; then
    ok "Das Relay ist schon an und meldet ok."
    relay_report "$pub"
    return 0
  fi

  title "Plan"
  if [[ ${RV[relayer_key]} == no ]]; then
    say "1. Neuen Relayer-Schlüssel erzeugen und als FV_RELAYER_KEY auf Railway speichern (wird nie angezeigt)."
  else
    say "1. FV_RELAYER_KEY gibt es schon ($pub), er bleibt."
  fi
  if (( top > 0 )); then say "2. Relayer mit $(sol $top) SOL von der Deploy-Wallet aufladen."; else say "2. Guthaben des Relayers reicht."; fi
  if (( ${#sets} )); then say "3. Auf Railway setzen: ${sets[*]} (der Verifier startet dann neu)."; else say "3. Railway-Variablen stimmen schon."; fi
  say "4. Warten, bis /health relay.ok meldet (bis $(( WAIT_S / 60 )) Min.)."
  if (( top > 0 )); then
    wbal=$(lamports_of "$WALLET_PUB") || die "Das Guthaben der Deploy-Wallet ist nicht lesbar." "Gleich nochmal starten."
    (( wbal >= top + 10000 )) || die "Zu wenig devnet-SOL auf der Deploy-Wallet ($(sol $wbal) SOL) für $(sol $top) SOL an den Relayer." \
      "Devnet-SOL holen (https://faucet.solana.com, Adresse $WALLET_PUB), dann nochmal starten."
  fi
  if (( DRY )); then say ""; say "Nur Vorschau (--dry-run): nichts verändert."; return 0; fi
  private_dir "$STATE_DIR/relay"
  LOG=$STATE_DIR/relay/rollout.log
  SIGLOG=$STATE_DIR/relay/signatures.log

  if [[ ${RV[relayer_key]} == no ]]; then
    title "Relayer-Schlüssel"
    make_secret_dir
    solana-keygen new --no-bip39-passphrase --silent --force -o "$SECRET_DIR/relayer.json" >/dev/null 2>&1 \
      || die "Der Relayer-Schlüssel ließ sich nicht erzeugen." "Gleich nochmal starten."
    py keypair-part "$SECRET_DIR/relayer.json" check 2>/dev/null || die "Der neue Relayer-Schlüssel hat nicht das erwartete Format." "Bitte Claude Bescheid geben."
    pub=$(solana-keygen pubkey "$SECRET_DIR/relayer.json" 2>/dev/null) || die "Der neue Relayer-Schlüssel ist nicht lesbar." "Gleich nochmal starten."
    # stored before it is funded: a funded key that never reached Railway would be lost with the temp dir
    railway_secret FV_RELAYER_KEY cat "$SECRET_DIR/relayer.json"
    rm -rf -- "$SECRET_DIR"
    SECRET_DIR=""
    railway_facts
    [[ ${RV[relayer_key]} == yes && ( ${RV[relayer_pub]} == $pub || ${RV[relayer_pub]} == sealed ) ]] \
      || die "FV_RELAYER_KEY ist auf Railway nicht wie erwartet angekommen." "Gleich nochmal starten."
    print -r -- "$(date -u +%FT%TZ) relayer $pub" >> "$LOG"
    ok "FV_RELAYER_KEY gespeichert (Relayer $pub)"
  fi
  if (( top > 0 )); then
    title "Aufladen"
    run_logged relayer-funding solana transfer "$pub" "$(sol_arg $top)" --allow-unfunded-recipient --url "$RPC" --keypair "$WALLET" \
      || die "Das Aufladen des Relayers ist fehlgeschlagen." "Gleich nochmal starten: der Schlüssel bleibt."
    ok "Relayer aufgeladen"
  fi
  if (( ${#sets} )); then
    title "Railway"
    last=${sets[-1]}
    for k in ${sets[1,-2]}; do
      "$RAILWAY" variable set "$k" --service verify --skip-deploys >/dev/null || die "Railway hat ${k%%=*} nicht gespeichert." "Gleich nochmal starten."
    done
    "$RAILWAY" variable set "$last" --service verify >/dev/null || die "Railway hat ${last%%=*} nicht gespeichert." "Gleich nochmal starten."
    ok "Gesetzt: ${sets[*]}"
  fi
  say "Warte auf relay.ok von $VERIFY_URL (Railway startet neu) …"
  wait_until relay_ok || die "Der Verifier meldet nach $(( WAIT_S / 60 )) Minuten kein relay.ok." \
    "Vielleicht dauert der Neustart noch, oder der Start wurde verweigert (railway logs --service verify). Nochmal starten oder Claude fragen."
  print -r -- "$(date -u +%FT%TZ) relay on, relay.ok" >> "$LOG"
  title "Fertig"
  ok "Das Relay ist an: Scans ohne Wallet landen jetzt im öffentlichen Register."
  relay_report "$pub"
  say ""
  say "Danach (empfohlen): zsh scripts/p1-rollout.sh rotate-keys"
}

# ---------------------------------------------------------------------------------------------------------------------
# step 4: rotate-keys. The secrets Railway recommended rotating after its October 2026 incident, as far as they can be
# rotated without breaking physical tags: FV_ADMIN_TOKEN (a new random value) and the server signing key
# (FV_SERVER_ED25519_SEED + FV_SERVER_KEY_ID; docs/devnet.md, Upgrading devnet step 2). FV_MASTER_KEY is never touched:
# every programmed sticker derives its SUN keys from it, so a new master key would make every existing tag fail.
#
# Order, so that no scan is lost:
#  1. The new public key is registered on chain under the next free key id (scripts/server-key.ts add) BEFORE the
#     verifier uses it, so every scan the new key signs can be anchored from its first second.
#  2. The verifier switches in one redeploy (new seed, key id and admin token), and the script waits until /health
#     reports the new key id and public key.
#  3. The old key id is revoked (scripts/server-key.ts revoke) only KEY_GRACE_S (660 s) after that. Scans the old key
#     signed that are not on chain yet: a wallet scan (FVSCAN1, record_scan) lands while its signed ts is within
#     600 s of the cluster clock, and a relay row (FVSCAN2) carries the key id and public key that signed it and is
#     sent until ts + 570 s (docs/public-record.md D13). The old key stays valid on chain through that window, so both
#     still land; after it they could not land anyway (stale ts), so revoking loses nothing. The verifier's own records
#     of those scans do not depend on the key.
# A run that stops half way is resumed: rotate-keys.state records the key this step installed, and a key registered
# by an attempt that never went live (its seed was only ever in the deleted temp dir) is revoked with the old one.
# Once a rotation has finished (phase=done), the next run starts a new one (behind the same question): the way to
# rotate again, for example after another leak. Every rotation takes one of the registry's 8 key ids for good.

rotate_state() { py kv "$STATE_DIR/rotate-keys.state" "$1"; }
write_rotate_state() { private_dir "$STATE_DIR"; print -rl -- "$@" > "$STATE_DIR/rotate-keys.state"; }

NEW_KEY_ID=""
NEW_KEY_PUB=""
new_key_live() { [[ ${H[keyId]} == $NEW_KEY_ID && ${H[pubkeyHex]} == $NEW_KEY_PUB ]]; }

step_rotate_keys() {
  local live_id live_pub entry live_valid=0 switch=1 switched_at max=0 id wait_s phase
  local -a f stale ids revoke
  if [[ -z $RAILWAY ]]; then
    die "Der Schlüsseltausch braucht Railway; lokal (FV_ROLLOUT_LOCAL=1) geht er nur mit einem Ersatz (FV_ROLLOUT_RAILWAY)." \
      "Für devnet ohne FV_ROLLOUT_LOCAL=1 starten."
  fi
  need solana solana-keygen npx "$RAILWAY"
  title "Prüfungen"
  say "FV_MASTER_KEY bleibt, wie er ist: alle programmierten Siegel hängen an ihm, ein neuer würde jedes davon ungültig machen."
  wallet_pub
  registry_info
  [[ $REG_AUTH == $WALLET_PUB ]] || die "Die Wallet $WALLET_PUB ist nicht die Registry-Autorität ($REG_AUTH)." \
    "Es braucht die Deploy-Wallet. Bitte Claude Bescheid geben."
  read_health || die "Der Verifier ($VERIFY_URL) antwortet nicht." "Erst Schritt 1: zsh scripts/p1-rollout.sh deploy"
  live_id=${H[keyId]}
  live_pub=${H[pubkeyHex]}
  stale=()
  ids=()
  for entry in $REG_KEYS; do
    f=(${=entry})
    ids+=(${f[1]})
    if [[ ${f[1]} == $live_id ]]; then
      if [[ ${f[2]} == $live_pub && ${f[3]} == valid ]]; then live_valid=1; fi
    elif [[ ${f[3]} == valid ]]; then
      stale+=(${f[1]})
    fi
  done
  (( live_valid )) || die "Der Verifier signiert mit Schlüssel $live_id, der in der Registry nicht gültig ist." "Bitte Claude Bescheid geben."
  ok "Verifier signiert mit Schlüssel $live_id (gültig in der Registry)"
  railway_login
  railway_facts
  [[ ${RV[server_key_id]} == $live_id || ( ${RV[server_key_id]} == - && $live_id == 1 ) ]] || die \
    "Auf Railway steht FV_SERVER_KEY_ID=${RV[server_key_id]}, online läuft Schlüssel $live_id." "Bitte Claude Bescheid geben."

  # Resume only a rotation that has not finished (phase switching or switched) and whose new key is the one the
  # verifier runs; after a finished one, this run is a new rotation.
  phase=$(rotate_state phase)
  if [[ $phase != done && $(rotate_state new_id) == $live_id && $(rotate_state new_pub) == $live_pub ]]; then switch=0; fi
  switched_at=$(rotate_state switched_at)
  if (( switch == 0 && ${#stale} == 0 )); then
    # Every other key is revoked: a run stopped after its revocations but before it recorded the end (an RPC error, a
    # closed window). The chain shows the end state, so it is recorded now and `status` stops calling it unfinished.
    if (( ! DRY )); then
      write_rotate_state "phase=done" "new_id=$live_id" "new_pub=$live_pub" "old_id=$(rotate_state old_id)" \
        "switched_at=$switched_at" "done_at=$(date -u +%FT%TZ)"
    fi
    ok "Schon erledigt: Schlüssel $live_id ist der einzige gültige, das Admin-Token wurde dabei erneuert."
    if (( ! DRY )); then say "Ein neuer Schlüsseltausch (etwa nach einem Leck): diesen Schritt nochmal starten."; fi
    return 0
  fi
  for id in $ids; do
    if (( id > max )); then max=$id; fi
  done
  NEW_KEY_ID=$(( max + 1 ))
  revoke=($stale)
  if (( switch )); then
    (( ${#ids} < MAX_SERVER_KEYS && NEW_KEY_ID <= 255 )) || die "Die Registry hat keinen Platz für einen weiteren Schlüssel." "Bitte Claude Bescheid geben."
    revoke+=($live_id)
  fi

  title "Plan"
  if [[ $phase == done ]]; then
    say "Der letzte Schlüsseltausch ist abgeschlossen (am $(rotate_state done_at), Schlüssel $(rotate_state new_id)). Dieser Lauf macht einen neuen."
  fi
  if (( switch )); then
    say "1. Neues FV_ADMIN_TOKEN (zufällig, wird nie angezeigt; steht danach nur auf Railway)."
    say "2. Neuen Signierschlüssel erzeugen und auf der Chain als Schlüssel $NEW_KEY_ID eintragen (scripts/server-key.ts add)."
    say "   Danach sind $(( ${#ids} + 1 )) von $MAX_SERVER_KEYS Schlüsselplätzen der Registry belegt (gesperrte bleiben belegt)."
    say "3. Verifier umstellen (FV_SERVER_ED25519_SEED, FV_SERVER_KEY_ID=$NEW_KEY_ID; Railway startet neu), warten bis /health ihn meldet."
    say "4. $(( (KEY_GRACE_S + 59) / 60 )) Minute(n) warten (Scans mit dem alten Schlüssel landen noch), dann sperren: Schlüssel ${(j:, :)revoke}."
  else
    say "Der neue Schlüssel $live_id läuft schon. Noch zu sperren (nach der Wartezeit): Schlüssel ${(j:, :)revoke}."
  fi
  say "FV_MASTER_KEY bleibt unverändert."
  if (( DRY )); then say ""; say "Nur Vorschau (--dry-run): nichts verändert."; return 0; fi
  private_dir "$STATE_DIR/rotate-keys"
  LOG=$STATE_DIR/rotate-keys/rollout.log
  SIGLOG=$STATE_DIR/rotate-keys/signatures.log
  say ""
  confirm "Schlüssel jetzt tauschen?"

  if (( switch )); then
    title "Neuer Schlüssel"
    make_secret_dir
    solana-keygen new --no-bip39-passphrase --silent --force -o "$SECRET_DIR/server.json" >/dev/null 2>&1 \
      || die "Der neue Signierschlüssel ließ sich nicht erzeugen." "Gleich nochmal starten: noch nichts geändert."
    NEW_KEY_PUB=$(py keypair-part "$SECRET_DIR/server.json" pub 2>/dev/null) || die "Der neue Signierschlüssel ist nicht lesbar." "Gleich nochmal starten."
    run_logged server-key-add npx_tsx scripts/server-key.ts add "$NEW_KEY_PUB" "$NEW_KEY_ID" \
      || die "Der neue Schlüssel ließ sich nicht auf der Chain eintragen." "Gleich nochmal starten: auf Railway ist noch nichts geändert."
    write_rotate_state "phase=switching" "new_id=$NEW_KEY_ID" "new_pub=$NEW_KEY_PUB" "old_id=$live_id"
    ok "Schlüssel $NEW_KEY_ID auf der Chain eingetragen"
    railway_secret FV_ADMIN_TOKEN py token
    railway_secret FV_SERVER_ED25519_SEED py keypair-part "$SECRET_DIR/server.json" seed
    rm -rf -- "$SECRET_DIR"
    SECRET_DIR=""
    "$RAILWAY" variable set FV_SERVER_KEY_ID="$NEW_KEY_ID" --service verify >/dev/null \
      || die "Railway hat FV_SERVER_KEY_ID nicht gespeichert." "Nochmal starten: ein neuer Versuch nimmt einen neuen Schlüssel, der alte bleibt gültig."
    ok "Railway: FV_ADMIN_TOKEN, FV_SERVER_ED25519_SEED, FV_SERVER_KEY_ID=$NEW_KEY_ID gesetzt"
    say "Warte, bis $VERIFY_URL Schlüssel $NEW_KEY_ID meldet …"
    wait_until new_key_live || die "Der Verifier meldet den neuen Schlüssel nicht." \
      "Der alte Schlüssel bleibt gültig, es geht nichts verloren. Bitte Claude Bescheid geben (railway logs --service verify)."
    switched_at=$(date +%s)
    write_rotate_state "phase=switched" "new_id=$NEW_KEY_ID" "new_pub=$NEW_KEY_PUB" "old_id=$live_id" "switched_at=$switched_at"
    ok "Verifier signiert mit Schlüssel $NEW_KEY_ID"
  else
    NEW_KEY_ID=$live_id
    NEW_KEY_PUB=$live_pub
    if [[ $switched_at != <-> ]]; then
      switched_at=$(date +%s)
      write_rotate_state "phase=switched" "new_id=$NEW_KEY_ID" "new_pub=$NEW_KEY_PUB" "old_id=$(rotate_state old_id)" "switched_at=$switched_at"
    fi
  fi

  title "Alten Schlüssel sperren"
  wait_s=$(( switched_at + KEY_GRACE_S - $(date +%s) ))
  if (( wait_s > 0 )); then
    say "Warte noch $(( (wait_s + 59) / 60 )) Minute(n), damit jeder Scan mit dem alten Schlüssel landen kann …"
    sleep "$wait_s"
  fi
  for id in $revoke; do
    run_logged "server-key-revoke-$id" npx_tsx scripts/server-key.ts revoke "$id" \
      || die "Schlüssel $id ließ sich nicht sperren." "Gleich nochmal starten: der neue Schlüssel läuft schon."
    ok "Schlüssel $id gesperrt"
  done
  registry_info
  for entry in $REG_KEYS; do
    f=(${=entry})
    if [[ ${f[1]} != $NEW_KEY_ID && ${f[3]} == valid ]]; then die "Schlüssel ${f[1]} ist noch gültig." "Gleich nochmal starten."; fi
  done
  write_rotate_state "phase=done" "new_id=$NEW_KEY_ID" "new_pub=$NEW_KEY_PUB" "old_id=$(rotate_state old_id)" "switched_at=$switched_at" "done_at=$(date -u +%FT%TZ)"
  title "Fertig"
  ok "Signierschlüssel $NEW_KEY_ID ($NEW_KEY_PUB) ist der einzige gültige; gesperrt: Schlüssel ${(j:, :)revoke}"
  ok "FV_ADMIN_TOKEN ist neu (nur auf Railway zu sehen). FV_MASTER_KEY ist unverändert."
}

# ---------------------------------------------------------------------------------------------------------------------
# step 5: status (read-only: GETs, RPC reads and the helper's facts; it never signs in or writes anything)

onoff() { case $1 in true|on) print -r -- an ;; false|off) print -r -- aus ;; *) print -r -- "$1" ;; esac; }

step_status() {
  local head same name id out auth cmp hout tag bal facts line wallet_known=0
  local -a f hc
  head=$(git rev-parse HEAD)
  title "Verifier ($VERIFY_URL)"
  if read_health; then
    same="anderer Stand als hier ($(short $head))"
    if [[ ${H[build]} == $head ]]; then same="gleich diesem Stand"; fi
    say "läuft (ok ${H[ok]}): Stand ${H[build][1,7]} ($same), Simulator $(onoff ${H[simulator]}), Schlüssel ${H[keyId]}, cluster ${H[cluster]}"
    if [[ ${H[relay]} != present ]]; then
      say "Relay: dieser Stand kennt es noch nicht"
    elif [[ ${H[relayEnabled]} != true ]]; then
      say "Relay: aus"
    elif [[ ${H[relayOk]} == true ]]; then
      say "Relay: an, ok"
    else
      say "Relay: an, aber nicht ok (Guthaben des Relayers, HolderConfig oder Tagesbudget; railway logs --service verify)"
    fi
  else
    say "antwortet nicht"
  fi
  title "Web-App ($WEB_URL)"
  say "HTTP $(web_code)"

  title "Programme"
  if command -v solana-keygen >/dev/null 2>&1 && [[ -r $WALLET ]] && WALLET_PUB=$(solana-keygen pubkey "$WALLET" 2>/dev/null); then wallet_known=1; fi
  if command -v solana >/dev/null 2>&1; then
    for name in escrow flacon; do
      id=$ESCROW_ID
      if [[ $name == flacon ]]; then id=$FLACON_ID; fi
      if out=$(solana program show "$id" --url "$RPC" --output json 2>/dev/null) && out=$(print -r -- "$out" | py program 2>/dev/null); then
        f=(${=out})
        auth="Upgrade-Recht ${f[1]}"
        if (( wallet_known )) && [[ ${f[1]} == $WALLET_PUB ]]; then auth="Upgrade-Recht: diese Wallet"; fi
        cmp=""
        if [[ -s target/deploy/$name.so ]] && solana program dump "$id" "$TMP_DIR/$name.so" --url "$RPC" >/dev/null 2>&1; then
          if [[ $(py same "target/deploy/$name.so" "$TMP_DIR/$name.so") == equal ]]; then cmp=", gleich dem lokalen Build"; else cmp=", anders als der lokale Build"; fi
        fi
        say "$name: $(num ${f[2]}) Bytes auf der Chain, $auth$cmp"
      else
        say "$name: nicht lesbar"
      fi
    done
  else
    say "Solana-CLI fehlt"
  fi

  title "Öffentliches Register"
  if command -v npx >/dev/null 2>&1; then
    if tag=$(holder_tag); then
      if [[ $tag == none ]]; then say "HolderConfig: fehlt noch"; else say "HolderConfig: vorhanden, cluster_tag $tag"; fi
    else
      say "HolderConfig: nicht lesbar"
    fi
    if hout=$(npx_tsx scripts/init-holdings.ts --dry-run 2>/dev/null) && facts=$(holdings_count "$hout"); then
      hc=(${=facts})
      say "Pässe mit Holding: $(( hc[1] - hc[2] )) von ${hc[1]}"
    else
      say "Pässe mit Holding: nicht lesbar"
    fi
  fi

  title "Wallets"
  if (( wallet_known )); then
    if bal=$(lamports_of "$WALLET_PUB"); then say "Deploy-Wallet $WALLET_PUB: $(sol $bal) SOL"; else say "Deploy-Wallet $WALLET_PUB: Guthaben nicht lesbar"; fi
  else
    say "Deploy-Wallet: nicht lesbar ($WALLET)"
  fi
  if [[ -z $RAILWAY ]]; then
    say "Relayer: lokal nicht verwaltet (kein FV_ROLLOUT_RAILWAY)"
  elif railway_ready && facts=$("$RAILWAY" variable list --service verify --json 2>/dev/null | py vars 2>/dev/null); then
    RV=()
    for line in ${(f)facts}; do RV[${line%%=*}]=${line#*=}; done
    say "Railway: FV_RELAY_ENABLED $(onoff ${RV[relay]}), FV_RELAYER_KEY $([[ ${RV[relayer_key]} == yes ]] && print vorhanden || print fehlt), FV_CLUSTER ${RV[cluster]}, FV_SERVER_KEY_ID ${RV[server_key_id]}"
    case ${RV[relayer_pub]} in
      -) ;;
      sealed|invalid) say "Relayer: Schlüssel ${RV[relayer_pub]}" ;;
      *) if bal=$(lamports_of "${RV[relayer_pub]}"); then say "Relayer ${RV[relayer_pub]}: $(sol $bal) SOL"; else say "Relayer ${RV[relayer_pub]}: Guthaben nicht lesbar"; fi ;;
    esac
  else
    say "Railway: nicht angemeldet oder nicht lesbar (ein anderer Schritt meldet an)"
  fi
  if [[ -f $STATE_DIR/rotate-keys.state ]]; then
    case $(rotate_state phase) in
      done) say "Schlüsseltausch: zuletzt abgeschlossen am $(rotate_state done_at) (Schlüssel $(rotate_state new_id))" ;;
      *) say "Schlüsseltausch: begonnen, nicht abgeschlossen (zsh scripts/p1-rollout.sh rotate-keys schließt ihn ab)" ;;
    esac
  fi
}

case $STEP in
  deploy) step_deploy ;;
  chain) step_chain ;;
  relay) step_relay ;;
  rotate-keys) step_rotate_keys ;;
  status) step_status ;;
esac
