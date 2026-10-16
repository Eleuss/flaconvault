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
3. **Secrets come from the platform's secret store** (Railway service variables), never from the repo and never copied from a local `.env`: `FV_MASTER_KEY`, `FV_SERVER_ED25519_SEED`, `FV_ADMIN_TOKEN`, `FV_IRYS_KEY_JSON`.
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
| `FV_SERVER_ED25519_SEED` | **secret**, 32 bytes hex | production-only seed, e.g. `python3 -c "import secrets; print(secrets.token_hex(32))"`; `GET /health` shows its public key |
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
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | Reown Cloud project id | optional; enables the WalletConnect entry (sign from Safari on iPhone) |
| `NEXT_PUBLIC_ESCROW_ADMIN_CONTACT` | a `mailto:` address or an `https://` link of the escrow admin | set it in production. The order page shows it as "Contact the escrow admin" when a buyer needs the admin (non-delivery, a dead seal after shipping, disagreeing scans; see `programs/README.md`, escrow admin duties); a `mailto:` gets the order as subject. Any other value is ignored, and without it the page shows the admin wallet only |
| `NEXT_PUBLIC_DEV_SIMULATOR` | `false` | `true` only for a demo deployment: it enables the demo tools (dev wallets, burner, airdrop, test images, simulator UI), which then still need demo mode in the browser (`apps/web/src/lib/demo.ts`; any visitor can switch it on for their own browser with `/dev?demo=1`, so only `false` removes them). The dev wallets keep their secret keys in the browser's `localStorage`: never register them as partners or fund them with anything of value. |

## After both are up

1. `curl -s https://verify.flaconvault.com/health` shows `"ok": true`, `"simulator": false`, the program id, the deployed commit (`build`; `null` after a `railway up` without `FV_BUILD_SHA`, and the previous commit if it was not updated before the upload, so compare it with the commit you deployed), the Arweave status, and a `pubkeyHex` equal to the on-chain server key with the same `keyId` (`curl -s https://verify.flaconvault.com/api/registry`).
2. `curl -s -o /dev/null -w '%{http_code}\n' https://verify.flaconvault.com/api/dev/tags` prints `404` (simulator off).
3. `curl -s -D - -o /dev/null -H 'Origin: http://localhost:3000' https://verify.flaconvault.com/health | grep -i access-control-allow-origin` prints nothing (localhost is not an allowed origin).
4. Tap a real sticker (iPhone: background NFC opens Safari): `/t` shows "Seal genuine · Tap N". For the replay check, read the sticker with an NFC reader app (NFC Tools, TagInfo), copy its tap URL (`…/t?picc_data=…&cmac=…`) and open it twice: the second time shows "Repeated tap". Reopening the result page (`/t?tap=…`) only shows the stored result again.
5. On that sticker's passport page, "Check live on-chain" reads the Passport account from devnet.

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

Vercel and Railway are **not** connected to GitHub: a push to `main` runs CI and deploys nothing, and nothing else deploys automatically. Both services are deployed by hand, from a commit that passed CI (`.github/workflows/ci.yml`), so the running code equals a commit on GitHub. Both CLIs upload files from disk, uncommitted changes included, so deploy from a clean tree of that commit, from the repo root:

```bash
git status --short                              # must print nothing: the upload is the working tree
SHA=$(git rev-parse HEAD)                       # a commit that passed CI

# web (Vercel): deploy a git archive export of the commit
D=$(mktemp -d)/flaconvault && mkdir -p "$D"
git archive "$SHA" | tar -x -C "$D"
cp -R .vercel "$D/"                             # the project link is not in git; without it `--yes` links by folder name
vercel --cwd "$D" --prod --yes

# verifier (Railway): record the commit for /health, then upload the tree (builds Dockerfile.verify, railway.json)
railway variable set FV_BUILD_SHA="$SHA" --service verify --skip-deploys
railway up --service verify --detach --ci       # --detach returns after the upload; it does not wait for the build
railway logs --service verify --build           # build output; without --build: the runtime logs (startup refusals)
# waits until /health reports $SHA (the old deployment answers until then), then checks ok, key and simulator off
python3 .github/scripts/check-health.py https://verify.flaconvault.com --build "$SHA" --simulator false --wait-for-build --timeout 900
```

Changing variables:

```bash
vercel env add NAME production                  # web (value from stdin), then deploy again as above
railway variable set K=V --service verify       # verifier: triggers a redeploy of the current deployment
```

When the programs change too, deploy web and verifier first and upgrade the programs right after: see [`devnet.md`](devnet.md#upgrading-devnet), step 0.

## Custom domains

- Web: add the domain to the Vercel project and create the DNS record Vercel shows (an `A` record for an apex or subdomain, or a `CNAME`).
- Verifier: add the custom domain to the Railway service and create the `CNAME` and the `TXT` ownership record Railway shows; Railway issues the certificate once both resolve.
- Then update `FV_WEB_URL`, `FV_VERIFIER_HOST`, `FV_CORS_ORIGINS`, `NEXT_PUBLIC_VERIFY_URL` and `NEXT_PUBLIC_CANONICAL_ORIGIN`, and program new stickers with the new web domain.
