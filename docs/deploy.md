# Deployment

Two services:

- the **web app** (`apps/web`, Next.js) on Vercel, with a stable domain for the stickers and the README links;
- the **verifier** (`apps/verify`, FastAPI + SQLite) on Railway, with a persistent volume for the database and media.

Stickers point at the web domain's `/t`; the web app forwards each tap once to the verifier.

Neither service is connected to GitHub: pushing to `main` runs CI and deploys nothing. Both are deployed by hand from a
commit that passed CI (see [Deploying](#deploying)).

The hackathon deployment runs at https://app.flaconvault.com (web) and https://verify.flaconvault.com (verifier), against Solana devnet. Stickers written earlier with `https://flaconvault.vercel.app/t` keep working: that host redirects permanently to `NEXT_PUBLIC_CANONICAL_ORIGIN` (`apps/web/src/middleware.ts`).

## Production rules

Read these before setting any variable.

1. **Simulator off.** `FV_DEV_SIMULATOR=false` (the default). `/api/dev/*` then answers 404.
2. **Never factory keys in production.** `FV_KEY_MODE=factory` uses the NXP null keys, which anyone can compute, so anyone could forge a valid tap. Production uses the key mode the stickers were programmed with: `sdmbackend` with `FV_SDM_DERIVE=legacy` for stickers written with the NFC Developer App (see `docs/hardware-day.md`). Factory mode is for local development with the simulator only.
3. **Secrets come from the platform's secret store** (Railway service variables), never from the repo and never copied from a local `.env`: `FV_MASTER_KEY`, `FV_SERVER_ED25519_SEED`, `FV_ADMIN_TOKEN`, `FV_IRYS_KEY_JSON`, and for the public record `FV_RELAYER_KEY`, `FV_HOLDER_KEY`, `FV_ISSUER_KEY` (one set per cluster, each its own key).
4. **A production-only signing key.** Generate a seed that exists only in the secret store, register its public key on-chain under its own key id (`add_server_key`, see `docs/devnet.md`) and set `FV_SERVER_KEY_ID` to that id. A local verifier, especially one with the simulator on or exposed through a tunnel, must never hold the production seed or the production master key: it could sign scans and mint taps that production accepts.
5. **No demo seed.** `docs/seed/passports.json` is sample data with fake transaction signatures. The verifier loads it into an empty database only with `FV_DEV_SIMULATOR=true` or `FV_SEED_DEMO=true`, so keep both `false`. Keep `FV_SEED_PATH` at its default: the startup check and `POST /api/admin/purge-seed` use the file to recognise seed rows left in an older database.
6. **CORS lists only the web origin.** Never `localhost` in production.

## Verifier (Railway)

- Build: `Dockerfile.verify` at the repo root (`railway.json` sets the builder and the `/health` healthcheck). The build context is the repo root.
- Volume: mount a persistent volume at `/data` (SQLite at `/data/flaconvault.db`, media at `/data/media`; both are set in the Dockerfile). The container starts as root only to hand `/data` to the unprivileged user `fv` (uid 10001) on its first start (`apps/verify/docker-entrypoint.sh`); uvicorn and the Irys sidecar run as `fv`.
- Startup refuses forgeable settings (factory keys or an all-zero master key with the simulator off, the simulator with real keys) with one clear error: check `railway logs` if a deploy does not come up.
- Service variables:

| Variable | Production value | Notes |
|---|---|---|
| `FV_DEV_SIMULATOR` | `false` | default `false` |
| `FV_KEY_MODE` | `sdmbackend` | never `factory` in production |
| `FV_SDM_DERIVE` | `legacy` | NFC Developer App / sdm-backend key derivation (`standard` = `libsdm/derive.py`) |
| `FV_MASTER_KEY` | **secret**, 16 bytes hex | the SDM master key the stickers were programmed with; never all zeros, never a key used for local development |
| `FV_SERVER_ED25519_SEED` | **secret**, 32 bytes hex | production-only seed, e.g. `python3 -c "import secrets; print(secrets.token_hex(32))"`; `GET /health` shows its public key. To replace it and `FV_ADMIN_TOKEN` without losing a scan (after a leak, for example): `zsh scripts/p1-rollout.sh rotate-keys` ([`devnet.md`](devnet.md#upgrading-devnet), step 2) |
| `FV_SERVER_KEY_ID` | the key id registered for that public key | must match the on-chain registry entry |
| `FV_ADMIN_TOKEN` | **secret**, e.g. `python3 -c "import secrets; print(secrets.token_urlsafe(32))"` | `x-admin-token` for `POST /api/reconcile`, `GET /api/admin/status`, `POST /api/admin/purge-seed` and `POST /api/dev/reset` (simulator only: it wipes and reseeds the database). While it is empty all of them answer 403, the reset included; the background reconcile loop runs anyway |
| `FV_BUILD_SHA` | `git rev-parse HEAD` of the deployed commit, set before every deploy | shown as `build` by `GET /health`. A `railway up` upload carries no commit, so set it right before each `railway up` (see Deploying). `RAILWAY_GIT_COMMIT_SHA` (set only by Railway's GitHub deploys, which this project does not use) counts only while `FV_BUILD_SHA` is unset |
| `FV_NONCE_TTL_S` | `90` | scan session lifetime |
| `FV_RATE_LIMIT_PER_MIN` | `60` (default) | per-client (IPv4 address, IPv6 /64) request budget for every POST route, `GET /t` and the resume `GET /api/verify/<id>` (429 `rate_limited`) |
| `FV_REPORT_LIMIT_PER_HOUR` | `3` (default) | unverified SEAL_DEAD reports per client and hour (429 `report_limited`) |
| `FV_TRUSTED_PROXY_HOPS` | `1` (default) | Railway's edge is one proxy; the client IP comes from `X-Forwarded-For` only behind it |
| `FV_MAX_JSON_BODY` | `65536` (default) | request body limit in bytes for every route and method except `POST /api/media` (413 `request_too_large`) |
| `FV_MEDIA_MIN_FREE_BYTES` | `268435456` (default, 256 MiB) | `POST /api/media` refuses uploads that would leave less free space on the `/data` volume, which also holds the database (507 `storage_full`) |
| `FV_MEDIA_MAX_BYTES_PER_IP_DAY` | `209715200` (default, 200 MiB) | upload bytes per client and 24 h (429 `media_limited`) |
| `FV_MEDIA_MAX_BYTES_PER_HOUR` | `2147483648` (default, 2 GiB) | upload bytes for the whole verifier per hour (503 `media_busy`) |
| `FV_MEDIA_RETENTION_S` | `604800` (default, 7 days) | the reconcile job deletes kept seal frames that no pending, confirmed or still recoverable failed scan references after this long; `0` keeps them forever. Staged uploads go once their session nonce has expired |
| `FV_SOLANA_RPC` | `https://api.devnet.solana.com` | a dedicated RPC endpoint is better: the public one rate-limits |
| `FV_PROGRAM_ID` | `7dCr825ibTyE6Y5oPHP2RCmUi5qFPCaKdZmE9TYeAcWL` | flacon program, `docs/devnet.md` |
| `FV_ESCROW_PROGRAM_ID` | `9vabByStbAqKH6sM6fuf8HhfGZbV3993Ncp3uZScexKL` | escrow program (this is also the default) |
| `FV_SEED_DEMO` | `false` | default `false` (rule 5) |
| `FV_SEED_PATH` | default | keep the default (rule 5) |
| `FV_ALLOW_SIM_WITH_REAL_KEYS` | `false` | default `false`; only for tests against a local validator (the startup check refuses it with a program id on a shared cluster) |
| `FV_SDM_LRP` | `false` | default `false`; the stickers are AES, 24-byte (LRP) input is refused |
| `FV_WEB_URL` | `https://app.flaconvault.com` | redirect target of `/t` |
| `FV_VERIFIER_HOST` | `https://verify.flaconvault.com` | the verifier's own public URL |
| `FV_CORS_ORIGINS` | `https://app.flaconvault.com` | comma-separated web origins; no `localhost` |
| `FV_RECONCILE_INTERVAL_S` | `60` | `0` disables the background reconcile loop |
| `FV_RECONCILE_TIMEOUT_S` | `600` | a pending scan without its ScanProof account after this many seconds becomes `failed` |
| `FV_ARWEAVE` | `false` | `true` only with a funded Irys key; failures are logged as errors and reported by `GET /health` (`arweave`: status flags and short codes only) and `GET /api/admin/status` (full detail), and the reconcile job's archiving queue retries what failed (media first, then the bundle) |
| `FV_IRYS_KEY_JSON` | **secret**, only with `FV_ARWEAVE=true` | a separate Solana keypair (64-number JSON array) used only to pay Irys, never the deploy wallet |
| `FV_IRYS_KEY` | unset | a key file path for local runs; hosted deployments use `FV_IRYS_KEY_JSON` |
| `FV_IRYS_NETWORK` | `devnet` | Irys devnet uploads are pruned after about 60 days |
| `FV_ARWEAVE_TIMEOUT_S` | `60` (default) | Irys sidecar timeout per upload |
| `FV_CLUSTER` | `devnet` | `devnet`, `mainnet` or `localnet`: the cluster tag of every public-record scan (FVSCAN2) the verifier signs. It must equal the on-chain `HolderConfig.cluster_tag`; otherwise the relay sends nothing (`cluster_mismatch`) |
| `FV_RELAY_ENABLED` | `false` until the devnet rollout below, then `true` | kill switch of the public-record relay (unset or empty = `false`: nothing is sent, relay scans stay off chain). `true` needs `FV_RELAYER_KEY` and `FV_PROGRAM_ID` |
| `FV_RELAYER_KEY` | **secret**, a Solana keypair JSON (64 numbers) used for nothing else | fee payer of relay transactions only, no program authority; fund it with at most 0.5 SOL on devnet. `zsh scripts/p1-rollout.sh relay` generates one in a private temp dir, stores the file's content with `railway variable set FV_RELAYER_KEY --stdin` (never shown, never on a command line) and keeps an existing one. By hand: `solana-keygen new --no-bip39-passphrase -o <file>` outside the repo, paste the file's content into the variable, then delete the file. `GET /api/admin/status` shows its public key |
| `FV_HOLDER_KEY` | **secret**, unset in P1 | holder-move key for P2; only parsed and validated now (its public key appears in `GET /api/admin/status`) |
| `FV_ISSUER_KEY` | **secret**, unset in P1 | registry partner key for sealing at the counter (P2); only parsed and validated now |
| `FV_SOLANA_RPC_FALLBACK` | a second RPC endpoint (optional) | relay sends and status reads switch to it after a failure of `FV_SOLANA_RPC`, and before an attempt is given up it is asked as a second source, by the relay loop and the reconcile job alike; it needs no transaction history (a signature it does not find never counts as lost) |
| `FV_RELAY_DAILY_LAMPORTS` | `10000000` (default) | global relay fee cap per UTC day; a scan above it is kept off chain (`over_cap` / `budget`) |
| `FV_RELAY_LOW_BALANCE_LAMPORTS` | `100000000` (default, 0.1 SOL) | below this relayer balance the log warns (at most hourly) and `GET /health` reports `relay.ok: false` |
| `FV_RELAY_CU_LIMIT` | `150000` (default) | compute unit limit of a relay transaction |
| `FV_RELAY_MAX_PRIORITY_MICROLAMPORTS` | `10000` (default) | ceiling of the priority fee price (micro-lamports per compute unit) |
| `FV_RELAY_INTERVAL_S` | `2` (default) | relay loop interval in seconds |
| `FV_DB_PATH`, `FV_MEDIA_DIR`, `FV_NODE_BIN` | set by the image | `/data/flaconvault.db`, `/data/media`, `/usr/local/bin/node` (`Dockerfile.verify`) |
| `PORT` | set by Railway | the Dockerfile honours it (`FV_PORT` is not used in the container) |

## Web app (Vercel)

- Project root directory `apps/web`, framework Next.js, "Include source files outside of the Root Directory" on (npm workspaces). Node 22.18 or newer.
- `packages/proof` and `packages/vision` are built in order (proof first) by the root `prepare` script on install and again by the web app's `prebuild` (`npm run build:packages`), so a plain install works; the workspaces have no `prepare` scripts of their own any more (npm ran those in parallel, and vision needs proof's type declarations). The sequence CI and the README use, `npm ci --ignore-scripts && npm run build:packages`, also works as an Install Command (`cd ../.. && …`).
- Environment variables (Production):

| Variable | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_VERIFY_URL` | `https://verify.flaconvault.com` | |
| `VERIFY_URL` | optional | server-side fetches; defaults to `NEXT_PUBLIC_VERIFY_URL` |
| `NEXT_PUBLIC_CANONICAL_ORIGIN` | `https://app.flaconvault.com` | other hosts redirect here |
| `NEXT_PUBLIC_SOLANA_RPC` | `https://api.devnet.solana.com` | |
| `NEXT_PUBLIC_PROGRAM_ID` | `7dCr825ibTyE6Y5oPHP2RCmUi5qFPCaKdZmE9TYeAcWL` | |
| `NEXT_PUBLIC_ESCROW_PROGRAM_ID` | `9vabByStbAqKH6sM6fuf8HhfGZbV3993Ncp3uZScexKL` | |
| `NEXT_PUBLIC_SOLANA_CLUSTER` | `devnet` | `devnet`, `mainnet` or `localnet`; the test-phase notice on scan results and passport pages shows unless it is `mainnet` |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | Reown Cloud project id | required for certified (tier 3/4) and vault/partner scans from iPhone Safari: Safari has no wallet extension, so without it iPhone partners cannot certify (the scan page says "This browser cannot sign a certified scan"). Other flows work without it (on iPhone, owner scans then sign through the Phantom/Solflare resume links) |
| `NEXT_PUBLIC_ESCROW_ADMIN_CONTACT` | a `mailto:` address or an `https://` link of the escrow admin | set it in production. The order page shows it as "Contact the escrow admin" when a buyer needs the admin (non-delivery, a dead seal after shipping, disagreeing scans; see `programs/README.md`, escrow admin duties); a `mailto:` gets the order as subject. Any other value is ignored, and without it the page shows the admin wallet only |
| `NEXT_PUBLIC_DEV_SIMULATOR` | `false` | `true` only for a demo deployment: it enables the demo tools (dev wallets, burner, airdrop, test images, simulator UI), which then still need demo mode in the browser (`apps/web/src/lib/demo.ts`; any visitor can switch it on for their own browser with `/dev?demo=1`, so only `false` removes them). The dev wallets keep their secret keys in the browser's `localStorage`: never register them as partners or fund them with anything of value. |

## After both are up

1. `curl -s https://verify.flaconvault.com/health` shows `"ok": true`, `"simulator": false`, the program id, the deployed commit (`build`; `null` after a `railway up` without `FV_BUILD_SHA`, and the previous commit if it was not updated before the upload, so compare it with the commit you deployed), the Arweave status, and a `pubkeyHex` equal to the on-chain server key with the same `keyId` (`curl -s https://verify.flaconvault.com/api/registry`).
2. `curl -s -o /dev/null -w '%{http_code}\n' https://verify.flaconvault.com/api/dev/tags` prints `404` (simulator off).
3. `curl -s -D - -o /dev/null -H 'Origin: http://localhost:3000' https://verify.flaconvault.com/health | grep -i access-control-allow-origin` prints nothing (localhost is not an allowed origin).
4. Tap a real sticker (iPhone: background NFC opens Safari): `/t` shows "Seal genuine · Tap N". For the replay check, read the sticker with an NFC reader app (NFC Tools, TagInfo), copy its tap URL (`…/t?picc_data=…&cmac=…`) and open it twice: the second time shows "Repeated tap". Reopening the result page (`/t?tap=…`) only shows the stored result again.
5. On that sticker's passport page, "Check live on-chain" reads the Passport account from devnet.
6. With the public record on: `curl -s https://verify.flaconvault.com/health` shows `"cluster": "devnet"` and `"relay": {"enabled": true, "ok": true}`; a sticker tap shows "Saving to the public record within about 3 minutes." and, a few minutes later, "Saved to the public record ✓". On `/scan`, "Save to the public record" appears only while `/health` reports `relay` (the page asks once per load); against a verifier without it the page shows the wallet flow.

## Public record relay (devnet rollout)

The public record (`docs/public-record.md`) lets every genuine tap land on chain without a wallet: the verifier signs the scan (FVSCAN2) and its relayer key pays the fee of `record_scan_v2`. The owner rolls it out; nothing here runs from CI or a builder. Owner path: `zsh scripts/p1-rollout.sh deploy`, then `chain` (steps 1 to 3 below), then `relay` (steps 4 and 5), each first with `--dry-run` if wanted; `zsh scripts/p1-rollout.sh status` shows where things stand ([`devnet.md`](devnet.md#public-record-p1-rollout) describes every check). Order:

1. Upgrade `flacon` and `escrow` on devnet, escrow first (the escrow refuses passes held in an account, and that guard must be live before flacon can run `mint_passport_v2`; `docs/devnet.md`).
2. `init_holder_config` with cluster tag DEVNET (2), signed by the registry authority (`docs/devnet.md`).
3. `init_holding_v1` for every existing devnet passport (`scripts/init-holdings.ts`, run by the owner). Bottles minted afterwards get their Holding in the mint transaction (the partner console, `scripts/bind-chip.ts`, `scripts/seed-passports.ts`), so the script needs no re-run after each mint.
4. Set the verifier variables: `FV_CLUSTER=devnet`, `FV_PROGRAM_ID`, a fresh `FV_RELAYER_KEY` (and optionally `FV_SOLANA_RPC_FALLBACK`); fund the relayer with at most 0.5 SOL; then `FV_RELAY_ENABLED=true` and redeploy. Startup refuses an incomplete relay configuration (no relayer key or program id, a malformed key, two roles sharing one key, a cluster that does not match the RPC) with one clear error in `railway logs`.
5. `curl -s https://verify.flaconvault.com/health` → `"relay": {"enabled": true, "ok": true}`. `ok` turns true once the verifier has read HolderConfig with the matching cluster tag, the relayer balance is above `FV_RELAY_LOW_BALANCE_LAMPORTS` and the daily budget is not used up. `GET /api/admin/status` (admin token) shows the relayer's public key, balance, today's spend and the row counts.

To stop sending at once, set `FV_RELAY_ENABLED=false` and redeploy: relay scans are then kept off chain, and the web shows "Not saved to the public record this time. FlaconVault keeps the check."

### Rolling back

The rollback for the public record is `FV_RELAY_ENABLED=false` on this build (above), never an older verifier build on the same volume. A verifier from before the public record (main `8fc705b` or older) does not know visitor scans: it shows their city, note and device on the passport page, takes a visitor's off-chain reading as the passport header, and with `FV_ARWEAVE=true` uploads those scans to Arweave for good, and a visitor's card photos as soon as any wallet scan names their hash. This build's web offers "Save to the public record" only while `/health` reports `relay`, so against an older verifier it shows the wallet flow; but a scan page opened before the switch still offers the button, and the older verifier signs that visitor's scan as an ordinary scan and shows the city typed with it.

If an older verifier must run on this volume anyway:

1. Roll the web back first, to a build from before the public record.
2. Set `FV_RELAY_ENABLED=false`, `FV_ARWEAVE=false` and `FV_MEDIA_RETENTION_S=0` (`railway variable set FV_RELAY_ENABLED=false FV_ARWEAVE=false FV_MEDIA_RETENTION_S=0 --service verify`; this redeploys this build). Keep all three until this build or a later one runs again: the older build must not archive anything, and with retention `0` it does not delete the visitors' photos it no longer sees.
3. Wait until `GET /api/admin/status` shows `relay.queued` and `relay.sending` at `0` (queued rows expire at their deadline, within about 10 minutes).
4. Open a shell in the running container (`railway ssh --service verify`) and run the park command below. It moves every visitor scan from `events` into `events_relay_parked`, and the photos only visitor scans use from `media` into `media_relay_parked`, so the older build neither shows, archives nor reads them. It refuses while a relay row is still queued or sending.
5. Deploy the older build ([Deploying](#deploying), from its commit) and run the park command once more in its container: it parks the visitor scans saved in between.
6. Rolling forward: deploy this build (or a later one) with the three variables unchanged, run the restore command in its container (every parked scan comes back as it was, with its record), then set the three variables back to their production values.

Park:

```sh
/app/apps/verify/docker-entrypoint.sh python3 - <<'PY'
import sqlite3
db = sqlite3.connect("/data/flaconvault.db", isolation_level=None, timeout=30)
busy = db.execute("SELECT COUNT(*) FROM relay_tx WHERE status IN ('queued','sending')").fetchone()[0]
if busy:
    raise SystemExit(f"{busy} relay rows are still queued or sending: wait, then run this again")
db.executescript("""
PRAGMA foreign_keys=OFF;
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS events_relay_parked AS SELECT * FROM events WHERE 0;
CREATE TABLE IF NOT EXISTS media_relay_parked AS SELECT * FROM media WHERE 0;
INSERT INTO events_relay_parked SELECT * FROM events
 WHERE type=2 AND json_extract(payload_json,'$.anchor')='relay' AND json_extract(payload_json,'$.indicators') IS NOT NULL;
DELETE FROM events WHERE id IN (SELECT id FROM events_relay_parked);
INSERT INTO media_relay_parked SELECT * FROM media
 WHERE sha256 IN (SELECT lower(substr(json_extract(payload_json,'$.media[0].sha256'),3)) FROM events_relay_parked)
   AND sha256 NOT IN (SELECT lower(substr(json_extract(payload_json,'$.media[0].sha256'),3)) FROM events
                       WHERE json_extract(payload_json,'$.media[0].sha256') IS NOT NULL);
DELETE FROM media WHERE sha256 IN (SELECT sha256 FROM media_relay_parked);
COMMIT;
""")
print(db.execute("SELECT COUNT(*) FROM events_relay_parked").fetchone()[0], "visitor scans parked,",
      db.execute("""SELECT COUNT(*) FROM events WHERE type=2 AND json_extract(payload_json,'$.anchor')='relay'
                    AND json_extract(payload_json,'$.indicators') IS NOT NULL""").fetchone()[0], "left (0 expected)")
PY
```

Restore:

```sh
/app/apps/verify/docker-entrypoint.sh python3 - <<'PY'
import sqlite3
db = sqlite3.connect("/data/flaconvault.db", isolation_level=None, timeout=30)
db.executescript("""
PRAGMA foreign_keys=ON;
BEGIN IMMEDIATE;
INSERT INTO events(id, serial, type, ts, actor_pubkey, actor_label, tx_sig, status, seal_uid_hash, payload_json, ar_bundle,
                   ar_media, grade_after, country, city, resume_hash)
 SELECT id, serial, type, ts, actor_pubkey, actor_label, tx_sig, status, seal_uid_hash, payload_json, ar_bundle,
        ar_media, grade_after, country, city, resume_hash
 FROM events_relay_parked WHERE id NOT IN (SELECT id FROM events) AND serial IN (SELECT serial FROM passports);
INSERT OR IGNORE INTO media(sha256, bytes, files, content_type, ar, url, ar_preview, created_at)
 SELECT sha256, bytes, files, content_type, ar, url, ar_preview, created_at FROM media_relay_parked;
DROP TABLE events_relay_parked;
DROP TABLE media_relay_parked;
COMMIT;
""")
print(db.execute("SELECT COUNT(*) FROM relay_tx WHERE event_id IS NOT NULL AND event_id NOT IN (SELECT id FROM events)").fetchone()[0],
      "relay rows without their scan (0 expected)")
PY
```

Both use Python's own `sqlite3` (the image has no `sqlite3` command); the entrypoint runs them as the app user. Parking with `foreign_keys=OFF` keeps each relay row pointing at its parked scan, so the restore needs no re-linking. Rehearsed on a copy of a database written by this build: with the scans parked, main `8fc705b` (even with `FV_ARWEAVE=true`) showed and archived none of them and its header was the last wallet scan again; after the restore this build showed every visitor scan and record as before.

### Removing demo data from an older production database

Older verifier builds seeded every empty database, production included. After deploying the current build:

```bash
H=https://verify.flaconvault.com
curl -s -X POST "$H/api/admin/purge-seed" -H "x-admin-token: $FV_ADMIN_TOKEN"                 # dry run: what would go
curl -s -X POST "$H/api/admin/purge-seed?dry_run=false" -H "x-admin-token: $FV_ADMIN_TOKEN"   # apply
curl -s "$H/api/admin/status" -H "x-admin-token: $FV_ADMIN_TOKEN"                               # key mode, seed flags, Arweave
```

Rows with real on-chain evidence are kept; `apps/verify/README.md` describes the rules. `replayedOnChain` in the answer lists seed signatures somebody anchored: retire those seals on chain (`docs/devnet.md`, Upgrading devnet).

Run it again (dry run first) after deploying a build whose purge changed, and check `mintFromChain` in the report: a kept on-chain seed passport whose MINT an older purge build removed gets its MINT rebuilt from chain there. The startup log warns while seed rows remain.

## Deploying

Vercel and Railway are **not** connected to GitHub: a push to `main` runs CI and deploys nothing, and nothing else deploys automatically. Both services are deployed by hand, from a commit that passed CI (`.github/workflows/ci.yml`), so the running code equals a commit on GitHub. Both CLIs upload files from disk, uncommitted changes included, so deploy from a clean tree of that commit, from the repo root.

**Owner path (P1 rollout):** `zsh scripts/p1-rollout.sh deploy`, or with `--dry-run` for the checks and the plan alone. It refuses unless the checkout is `main`, clean and equal to `origin/main`, `ci.yml` has a successful run for the commit (`gh run list --commit`) and `FV_RELAY_ENABLED` is off on Railway (it reads the variable list only through a helper that prints facts such as on/off, never a value). Then it runs the commands below in this order and checks that the web app answers 200; a re-run skips the verifier upload while `/health` already reports the commit. It stops while the relay is on: it is the first step of the rollout, and later deploys use the commands below.

The commands it runs, the reference:

```bash
git status --short                              # must print nothing: the upload is the working tree
SHA=$(git rev-parse HEAD)                       # a commit that passed CI

# verifier (Railway) first: record the commit for /health, then upload the tree (builds Dockerfile.verify, railway.json)
railway variable set FV_BUILD_SHA="$SHA" --service verify --skip-deploys
railway up --service verify --detach --ci       # --detach returns after the upload; it does not wait for the build
railway logs --service verify --build           # build output; without --build: the runtime logs (startup refusals)
# waits until /health reports $SHA (the old deployment answers until then), then checks ok, key and simulator off
python3 .github/scripts/check-health.py https://verify.flaconvault.com --build "$SHA" --simulator false --wait-for-build --timeout 900

# web (Vercel): deploy a git archive export of the commit
D=$(mktemp -d)/flaconvault && mkdir -p "$D"
git archive "$SHA" | tar -x -C "$D"
cp -R .vercel "$D/"                             # the project link is not in git; without it `--yes` links by folder name
vercel --cwd "$D" --prod --yes
```

The verifier goes first, so the new web app goes live in front of the verifier of the same commit (against an older one, whose `/health` has no `relay`, it shows the wallet flow).

Changing variables:

```bash
vercel env add NAME production                  # web (value from stdin), then deploy again as above
railway variable set K=V --service verify       # verifier: triggers a redeploy of the current deployment
railway variable set K --stdin --service verify # a secret: the value comes from stdin, never from the command line
```

When the programs change too, deploy web and verifier first and upgrade the programs right after: see [`devnet.md`](devnet.md#upgrading-devnet), step 0.

## Custom domains

- Web: add the domain to the Vercel project and create the DNS record Vercel shows (an `A` record for an apex or subdomain, or a `CNAME`).
- Verifier: add the custom domain to the Railway service and create the `CNAME` and the `TXT` ownership record Railway shows; Railway issues the certificate once both resolve.
- Then update `FV_WEB_URL`, `FV_VERIFIER_HOST`, `FV_CORS_ORIGINS`, `NEXT_PUBLIC_VERIFY_URL` and `NEXT_PUBLIC_CANONICAL_ORIGIN`, and program new stickers with the new web domain.
