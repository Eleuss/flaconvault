#!/usr/bin/env python3
"""
Fake railway, vercel, gh, solana, solana-keygen, anchor and npx for tests/p1-rollout.ts.

One JSON world (FAKE_STATE) models Railway's variables and deployment, the devnet programs (their bytes live in
<state dir>/chain/<id>.bin), the registry, HolderConfig and Holdings, balances and the CI runs; the test's HTTP server
serves /health from the same file. Every call is appended to FAKE_CALLS as one line "<tool> <argv...>", so values sent
on stdin never appear there. A call this file does not model exits 97 ("fake: unexpected ..."), so a change to
scripts/p1-rollout.sh cannot quietly reach a path the test does not model. Only reads leave the world file unchanged.
"railway-standin" is the same Railway model as a rehearsal's stand-in (FV_ROLLOUT_RAILWAY): it names itself as one in
`whoami` and is logged under its own name, so a test can tell it from the real CLI.

Usage (from the per-tool wrappers the test writes): rollout_fake.py <tool> <args...>
"""
import base64
import hashlib
import json
import os
import stat
import sys
import time

STATE = os.environ["FAKE_STATE"]
CALLS = os.environ["FAKE_CALLS"]
CHAIN = os.path.join(os.path.dirname(STATE), "chain")
FLACON = "7dCr825ibTyE6Y5oPHP2RCmUi5qFPCaKdZmE9TYeAcWL"
REGISTRY = "4JPPCBA7DpbmfDsq1oHDuiJD1zL8VhfuJSoWQyYZXZWt"
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
RENT_PER_BYTE = 6960


def b58(b):
    n = int.from_bytes(b, "big")
    s = ""
    while n:
        n, r = divmod(n, 58)
        s = B58[r] + s
    return "1" * (len(b) - len(b.lstrip(b"\0"))) + s


def load():
    with open(STATE) as f:
        return json.load(f)


def save(s):
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(s, f, indent=1)
    os.replace(tmp, STATE)


def fail(msg, code=1):
    sys.stderr.write(msg + "\n")
    sys.exit(code)


def unexpected():
    fail("fake: unexpected " + " ".join(sys.argv[1:]), 97)


def opts(args, valued):
    pos, kv, flags = [], {}, set()
    i = 0
    while i < len(args):
        a = args[i]
        if a in valued:
            if i + 1 >= len(args):
                unexpected()
            kv[a] = args[i + 1]
            i += 2
        elif a.startswith("-"):
            flags.add(a)
            i += 1
        else:
            pos.append(a)
            i += 1
    return pos, kv, flags


def rent(n):
    return (int(n) + 128) * RENT_PER_BYTE


def new_sig(s):
    s["sigCounter"] += 1
    raw = hashlib.sha256(b"sig-%d" % s["sigCounter"]).digest() + hashlib.sha256(b"sig2-%d" % s["sigCounter"]).digest()
    return b58(raw)


def pub_of_file(path):
    with open(os.path.expanduser(path)) as f:
        kp = json.load(f)
    return b58(bytes(kp[32:64]))


def truthy(v):
    return str(v or "").strip().lower() in ("1", "true", "yes", "on")


def keypair_pub(text):
    try:
        raw = json.loads(text or "")
        if isinstance(raw, list) and len(raw) == 64:
            return b58(bytes(raw[32:]))
    except ValueError:
        pass
    return None


def program_bytes(pid):
    with open(os.path.join(CHAIN, pid + ".bin"), "rb") as f:
        return f.read()


def build_bytes(s, name):
    b = s["build"][name]
    unit = ("%s-%s-" % (name, b["tag"])).encode()
    return (unit * (b["size"] // len(unit) + 1))[: b["size"]]


def flacon_upgraded(s):
    return program_bytes(FLACON) == build_bytes(s, "flacon")


# ---------------------------------------------------------------------------------------------------------- railway

def redeploy(s):
    """A Railway deployment of the current variables (what the verifier reports in /health)."""
    v, ver = s["vars"], s["verifier"]
    ver["build"] = v.get("FV_BUILD_SHA") or None
    ver["keyId"] = int(v.get("FV_SERVER_KEY_ID") or 1)
    ver["pubkeyHex"] = s["seedPubs"].get(str(v.get("FV_SERVER_ED25519_SEED") or "").strip().lower(), "00" * 32)
    ver["relayEnabled"] = truthy(v.get("FV_RELAY_ENABLED"))
    ver["relayerPub"] = keypair_pub(v.get("FV_RELAYER_KEY"))
    ver["cluster"] = v.get("FV_CLUSTER") or "devnet"
    ver["programId"] = v.get("FV_PROGRAM_ID") or None
    ver["deploys"] += 1


def railway(args, standin=False):
    s = load()
    if args == ["whoami"]:
        if not s["railway"]["loggedIn"]:
            fail("Unauthorized. Please login with `railway login`")
        print("fv-rollout stand-in (test world)" if standin else "Logged in as Fake Owner")
        return
    if args[:2] == ["variable", "list"]:
        pos, kv, flags = opts(args[2:], {"--service"})
        if pos or kv.get("--service") != "verify" or flags != {"--json"}:
            unexpected()
        print(json.dumps(s["vars"], indent=2))
        return
    if args[:2] == ["variable", "set"]:
        pos, kv, flags = opts(args[2:], {"--service"})
        if kv.get("--service") != "verify" or not pos or not flags <= {"--stdin", "--skip-deploys"}:
            unexpected()
        if "--stdin" in flags:
            if len(pos) != 1 or "=" in pos[0]:
                unexpected()
            value = sys.stdin.read()
            s["vars"][pos[0]] = value
            s["stdinSecrets"].append(value)
        else:
            for p in pos:
                k, eq, val = p.partition("=")
                if not eq:
                    unexpected()
                s["vars"][k] = val
        if "--skip-deploys" not in flags:
            redeploy(s)
        save(s)
        print("Set variables " + ", ".join(p.partition("=")[0] for p in pos))
        return
    if args[:1] == ["up"]:
        pos, kv, flags = opts(args[1:], {"--service"})
        if pos or kv.get("--service") != "verify" or flags != {"--detach", "--ci"}:
            unexpected()
        if s["railway"].get("upFails"):
            fail("Failed to upload")
        s["verifier"]["p1"] = True
        redeploy(s)
        save(s)
        print("Indexing... Uploading... Build Logs: https://railway.example.test/build")
        return
    unexpected()


# ----------------------------------------------------------------------------------------------------------- vercel

def vercel(args):
    s = load()
    if args == ["whoami"]:
        print("fake-owner")
        return
    if len(args) == 4 and args[0] == "--cwd" and args[2:] == ["--prod", "--yes"]:
        d = args[1]
        if not os.path.isfile(os.path.join(d, ".vercel", "project.json")):
            fail("Error: the export has no .vercel link")
        if not os.path.isfile(os.path.join(d, "scripts", "p1-rollout.sh")) or os.path.exists(os.path.join(d, ".git")):
            fail("Error: not a git archive export of the repo")
        s["web"]["deploys"] += 1
        save(s)
        print("https://flaconvault-fake.vercel.app")
        return
    unexpected()


# --------------------------------------------------------------------------------------------------------------- gh

def gh(args):
    s = load()
    if args[:2] == ["run", "list"]:
        pos, kv, flags = opts(args[2:], {"--workflow", "--commit", "--json", "--limit", "--event"})
        if pos or flags or kv.get("--workflow") != "ci.yml" or "--commit" not in kv or "--json" not in kv:
            unexpected()
        runs = [r for r in s["ci"].get(kv["--commit"], []) if "--event" not in kv or r["event"] == kv["--event"]]
        print(json.dumps(runs))
        return
    if args[:2] == ["run", "view"]:
        pos, kv, flags = opts(args[2:], {"--json"})
        if len(pos) != 1 or kv.get("--json") != "jobs":
            unexpected()
        print(json.dumps({"jobs": s["ciJobs"].get(pos[0], [])}))
        return
    if args[:2] == ["workflow", "run"]:
        if args[2:] != ["ci.yml", "--ref", "main", "-f", "anchor=true"]:
            unexpected()
        s["ciTriggered"] += 1
        save(s)
        print("✓ Created workflow_dispatch event for ci.yml at main")
        return
    unexpected()


# ----------------------------------------------------------------------------------------------------------- solana

def registry_bytes(s):
    r = s["registry"]
    out = hashlib.sha256(b"account:Registry").digest()[:8]
    out += bytes(json.loads(open(os.path.expanduser(s["walletFile"])).read())[32:64]) if r["authority"] == "wallet" \
        else hashlib.sha256(r["authority"].encode()).digest()
    out += len(r["keys"]).to_bytes(4, "little")
    for k in r["keys"]:
        out += bytes([k["id"]]) + bytes.fromhex(k["pub"]) + k["from"].to_bytes(8, "little", signed=True) \
            + k["to"].to_bytes(8, "little", signed=True)
    return out + (0).to_bytes(4, "little") + (0).to_bytes(4, "little") + bytes([255])


def authority_of(s, p):
    return s["walletPub"] if p["authority"] == "wallet" else p["authority"]


def solana(args):
    s = load()
    valued = {"--url", "--output", "--keypair", "--buffer-authority", "--authority", "--recipient", "--limit"}
    if args[:1] == ["program"] and len(args) > 1:
        act = args[1]
        pos, kv, flags = opts(args[2:], valued)
        if "--url" not in kv:
            unexpected()
        if act == "show" and flags == {"--buffers"}:
            if kv.get("--buffer-authority") != s["walletPub"] or kv.get("--output") != "json":
                unexpected()
            print(json.dumps({"buffers": s["buffers"]}))
            return
        if act == "show" and len(pos) == 1 and kv.get("--output") == "json" and not flags:
            p = s["programs"][pos[0]]
            print(json.dumps({"programId": pos[0], "owner": "BPFLoaderUpgradeab1e11111111111111111111111",
                              "programdataAddress": p["programdata"], "authority": authority_of(s, p),
                              "lastDeploySlot": p["slot"], "dataLen": p["dataLen"], "lamports": rent(p["dataLen"] + 45)}))
            return
        if act == "dump" and len(pos) == 2 and not flags:
            p = s["programs"][pos[0]]
            data = program_bytes(pos[0])
            with open(pos[1], "wb") as f:
                f.write(data + b"\0" * (p["dataLen"] - len(data)))
            print("Wrote program to " + pos[1])
            return
        if act == "extend" and len(pos) == 2 and not flags:
            p = s["programs"][pos[0]]
            payer = pub_of_file(kv["--keypair"])
            if payer != authority_of(s, p):
                fail("Error: the keypair is not the upgrade authority")
            n = int(pos[1])
            if n < 10240:   # the Agave 4.1 CLI's rule
                fail("Error: ExtendProgram requires a minimum of 10240 additional bytes or to extend to maximum size, "
                     "but only %d were requested" % n)
            if s["balances"].get(payer, 0) < rent(n) + 5000:
                fail("Error: insufficient funds for rent")
            p["dataLen"] += n
            s["balances"][payer] -= rent(n) - rent(0) + 5000
            s["history"].setdefault(p["programdata"], []).append(new_sig(s))
            save(s)
            print("\nExtended Program Id %s by %d bytes" % (pos[0], n))
            return
        if act == "close" and flags == {"--buffers"} and not pos:
            payer = pub_of_file(kv["--keypair"])
            if pub_of_file(kv["--authority"]) != payer or kv.get("--recipient") != payer:
                unexpected()
            # like the CLI: one transaction per buffer, and a table without any signature
            print("\nBuffer Address                               | Authority                                    | Balance")
            for b in s["buffers"]:
                s["balances"][payer] = s["balances"].get(payer, 0) + b["lamports"]
                s["history"].setdefault(b["address"], []).append(new_sig(s))
                print("%-44s | %-44s | %.8f SOL" % (b["address"], payer, b["lamports"] / 1e9))
            s["buffers"] = []
            save(s)
            return
        unexpected()
    pos, kv, flags = opts(args[1:], valued)
    if "--url" not in kv:
        unexpected()
    if args[:1] == ["rent"] and len(pos) == 1 and kv.get("--output") == "json":
        print(json.dumps({"lamportsPerByteYear": 0, "lamportsPerEpoch": 0, "rentExemptMinimumLamports": rent(pos[0])}))
        return
    if args[:1] == ["balance"] and len(pos) == 1 and kv.get("--output") == "json":
        print(json.dumps({"lamports": s["balances"].get(pos[0], 0)}))
        return
    if args[:1] == ["account"] and pos == [REGISTRY] and kv.get("--output") == "json":
        print(json.dumps({"pubkey": REGISTRY, "account": {"lamports": rent(1493), "owner": FLACON, "executable": False,
                                                          "data": [base64.b64encode(registry_bytes(s)).decode(), "base64"]}}))
        return
    if args[:1] == ["transaction-history"] and len(pos) == 1 and kv.get("--limit") == "1":
        sigs = s["history"].get(pos[0], [])
        print(json.dumps([{"signature": sigs[-1]}] if sigs else []))
        return
    if args[:1] == ["transfer"] and len(pos) == 2 and flags == {"--allow-unfunded-recipient"}:
        payer = pub_of_file(kv["--keypair"])
        whole, _, frac = pos[1].partition(".")
        lamports = int(whole) * 10**9 + int((frac + "000000000")[:9])
        if s["balances"].get(payer, 0) < lamports + 5000:
            fail("Error: insufficient funds")
        s["balances"][payer] -= lamports + 5000
        s["balances"][pos[0]] = s["balances"].get(pos[0], 0) + lamports
        sg = new_sig(s)
        s["history"].setdefault(pos[0], []).append(sg)
        save(s)
        print("\nSignature: " + sg + "\n")
        return
    unexpected()


def solana_keygen(args):
    s = load()
    if args[:1] == ["pubkey"] and len(args) == 2:
        print(pub_of_file(args[1]))
        return
    if args[:1] == ["new"]:
        pos, kv, flags = opts(args[1:], {"-o", "--outfile"})
        out = kv.get("-o") or kv.get("--outfile")
        if pos or not out or not {"--silent", "--no-bip39-passphrase"} <= flags:
            unexpected()
        d = os.path.dirname(os.path.abspath(out))
        if stat.S_IMODE(os.stat(d).st_mode) & 0o077:
            fail("fake: a new keypair must go into a private (mode 700) directory, not %o" % stat.S_IMODE(os.stat(d).st_mode))
        if os.path.exists(out) and "--force" not in flags:
            fail("Refusing to overwrite " + out)
        s["keygenCount"] += 1
        seed = hashlib.sha256(b"fake-generated-seed-%d" % s["keygenCount"]).digest()
        pub = hashlib.sha256(b"fake-generated-pub" + seed).digest()
        content = json.dumps(list(seed + pub), separators=(",", ":"))
        with open(out, "w") as f:
            f.write(content)
        s["seedPubs"][seed.hex()] = pub.hex()
        s["generated"].append({"json": content, "seedHex": seed.hex(), "pub": b58(pub), "pubHex": pub.hex(), "dir": d})
        save(s)
        return
    unexpected()


# ----------------------------------------------------------------------------------------------------------- anchor

def anchor(args):
    s = load()
    if args == ["build"]:
        if s.get("buildFails"):
            fail("error: could not compile `flacon`")
        for d in ("target/deploy", "target/idl", "target/types"):
            os.makedirs(d, exist_ok=True)
        for name in ("escrow", "flacon"):
            with open("target/deploy/%s.so" % name, "wb") as f:
                f.write(build_bytes(s, name))
            # the IDL and types this build generates: the committed copies unless the world says otherwise
            for ext, d in (("json", "target/idl"), ("ts", "target/types")):
                with open("packages/proof/src/idl/%s.%s" % (name, ext)) as f:
                    committed = f.read()
                with open("%s/%s.%s" % (d, name, ext), "w") as f:
                    f.write(s["build"][name].get("idl" + ext.upper(), committed))
        print("Finished release profile")
        return
    if args[:1] == ["upgrade"]:
        pos, kv, flags = opts(args[1:], {"--program-id", "--provider.cluster", "--provider.wallet"})
        if len(pos) != 1 or flags or set(kv) != {"--program-id", "--provider.cluster", "--provider.wallet"}:
            unexpected()
        sys.stderr.write("Warning: 'anchor upgrade' is deprecated. Use 'anchor program upgrade' instead.\n")   # Anchor 1.2
        with open(pos[0], "rb") as f:
            so = f.read()
        pid = kv["--program-id"]
        p = s["programs"][pid]
        payer = pub_of_file(kv["--provider.wallet"])
        if payer != authority_of(s, p):
            fail("Error: the wallet is not the upgrade authority")
        buffer = rent(len(so) + 37)
        if s["failOnce"].get("upgrade:" + pid):
            s["failOnce"]["upgrade:" + pid] -= 1
            s["buffers"].append({"address": b58(hashlib.sha256(b"buffer-%d" % len(s["buffers"])).digest()), "authority": payer,
                                 "dataLen": len(so), "lamports": buffer})
            s["balances"][payer] -= buffer
            save(s)
            fail("Error: fake network failure while writing the buffer")
        if len(so) > p["dataLen"]:
            fail("Error: ProgramData account too small (%d < %d): extend it first" % (p["dataLen"], len(so)))
        fee = ((len(so) + 999) // 1000 + 2) * 5000
        if s["balances"].get(payer, 0) < buffer + fee:
            fail("Error: insufficient funds for the buffer")
        with open(os.path.join(CHAIN, pid + ".bin"), "wb") as f:
            f.write(so)
        p["slot"] += 1
        s["balances"][payer] -= fee
        sg = new_sig(s)
        s["history"].setdefault(p["programdata"], []).append(sg)
        s["upgrades"].append(pid)
        save(s)
        print("Program Id: %s\n\nSignature: %s\n" % (pid, sg))
        return
    unexpected()


# -------------------------------------------------------------------------------------------------------------- npx

def show_holder_config(s):
    hc = s["holderConfig"]
    if not hc:
        print("holder_config FakeHolderConfig1111111111111111111111111111: not initialised")
        return
    print("holder_config FakeHolderConfig1111111111111111111111111111\n  authority %s\n  cluster_tag %d\n"
          "  guardian 11111111111111111111111111111111\n  holder_key 11111111111111111111111111111111\n"
          "  registrar_key 11111111111111111111111111111111\n  claim_delay_s 0 notap_delay_s 0 paused false"
          % (s["walletPub"], hc["clusterTag"]))


def npx(args):
    s = load()
    if len(args) < 2 or args[0] != "tsx":
        unexpected()
    # tsx listens on $TMPDIR/tsx-<uid>/<pid>.pipe; macOS refuses a socket path of more than 103 bytes
    sock = os.path.join(os.environ.get("TMPDIR", "/tmp").rstrip("/") or "/", "tsx-%d" % os.getuid(), "%d.pipe" % os.getpid())
    if len(sock.encode()) > 103:
        fail("Error: listen EINVAL: invalid argument " + sock)
    script, rest = args[1], args[2:]
    wallet = pub_of_file(os.environ["ANCHOR_WALLET"])
    url = os.environ["ANCHOR_PROVIDER_URL"]
    authority = s["walletPub"] if s["registry"]["authority"] == "wallet" else s["registry"]["authority"]
    if script == "scripts/holder-config.ts":
        if rest == ["show"]:
            show_holder_config(s)
            return
        if len(rest) == 2 and rest[0] == "init" and rest[1] in ("devnet", "localnet"):
            if wallet != authority:
                fail("registry authority is %s, not this wallet" % authority)
            if not flacon_upgraded(s):
                fail("AnchorError: InstructionFallbackNotFound (the deployed flacon has no init_holder_config)")
            if s["holderConfig"]:
                fail("holder_config exists already (its cluster_tag cannot change)")
            s["holderConfig"] = {"clusterTag": 2 if rest[1] == "devnet" else 3}
            sg = new_sig(s)
            save(s)
            print("init_holder_config(%s = %d) %s" % (rest[1], s["holderConfig"]["clusterTag"], sg))
            show_holder_config(s)
            return
        unexpected()
    if script == "scripts/init-holdings.ts":
        if rest not in ([], ["--dry-run"]):
            unexpected()
        dry = rest == ["--dry-run"]
        if wallet != authority:
            fail("registry authority is %s, not this wallet" % authority)
        print("rpc %s\nwallet %s\nprogram %s%s" % (url, wallet, FLACON, "\n(dry run: nothing is sent)" if dry else ""))
        if not s["holderConfig"]:
            sys.stderr.write("warning: no holder_config yet (rollout step 2): record_scan_v2 needs it, init_holding_v1 does not\n")
        n, have = s["passports"], s["holdings"]
        print("%d passports, %d without a Holding" % (n, n - have))
        for i in range(n):
            if i < have:
                print("  skip Passport%d (holding exists)" % i)
            elif dry:
                print("  would init Passport%d → holding Holding%d" % (i, i))
            else:
                if not flacon_upgraded(s):
                    fail("AnchorError: InstructionFallbackNotFound (the deployed flacon has no init_holding_v1)")
                s["holdings"] += 1
                sg = new_sig(s)
                save(s)
                print("  init Passport%d → holding Holding%d %s" % (i, i, sg))
        return
    if script == "scripts/server-key.ts":
        keys = s["registry"]["keys"]
        now = int(time.time())
        if rest == ["list"]:
            for k in keys:
                print("id=%d %s valid %d..%s" % (k["id"], k["pub"], k["from"], k["to"] or "open"))
            return
        if wallet != authority:
            fail("registry authority is %s, not this wallet" % authority)
        if len(rest) == 3 and rest[0] == "add":
            kid = int(rest[2])
            if any(k["id"] == kid for k in keys):
                fail("key_id %d is taken (revoked ids stay taken); pick another" % kid)
            keys.append({"id": kid, "pub": rest[1], "from": 0, "to": 0})
            sg = new_sig(s)
            save(s)
            print("add_server_key(%d) %s %s" % (kid, rest[1], sg))
            return
        if len(rest) == 2 and rest[0] == "revoke":
            kid = int(rest[1])
            k = next((k for k in keys if k["id"] == kid), None)
            if not k:
                fail("no server key with key_id %d" % kid)
            k["to"] = now - 1
            sg = new_sig(s)
            if s["failOnce"].get("revoke-lands:%d" % kid):   # the transaction lands, the client times out
                s["failOnce"]["revoke-lands:%d" % kid] -= 1
                save(s)
                fail("Error: transaction was not confirmed in 30.00 seconds (it may still land)")
            save(s)
            print("revoke_server_key(%d) %s" % (kid, sg))
            return
        unexpected()
    unexpected()


TOOLS = {"railway": railway, "railway-standin": lambda a: railway(a, standin=True), "vercel": vercel, "gh": gh,
         "solana": solana, "solana-keygen": solana_keygen, "anchor": anchor, "npx": npx}

if __name__ == "__main__":
    tool, argv = sys.argv[1], sys.argv[2:]
    with open(CALLS, "a") as log:
        log.write(" ".join([tool] + argv) + "\n")
    TOOLS[tool](argv)
