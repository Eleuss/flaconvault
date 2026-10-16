# apps/verify — FlaconVault verification server

Python 3.12 · FastAPI · SQLite (WAL) · based on [icedevml/sdm-backend](https://github.com/icedevml/sdm-backend) (`libsdm/`, MIT).

The server is the only place that can check the chip (NTAG 424 DNA SUN CMAC, AN12196), keeps the
counter and nonce state, signs every VALID scan with Ed25519 (briefing §4.3) and indexes the passport
timeline (§10). For local development a simulator (`/api/dev/*`) produces genuine SUN URLs with factory (null) keys;
production runs with the simulator off and the real tag keys (`FV_KEY_MODE=sdmbackend`).

## Run

```bash
cd apps/verify
cp .env.example .env            # then set a DEV-ONLY FV_SERVER_ED25519_SEED (python -c "import os;print(os.urandom(32).hex())")
uv sync                         # creates .venv (Python 3.12) and installs everything, incl. dev deps
uv run uvicorn fv.main:app --port 8787 --reload
```

* Never reuse production secrets locally: the local `.env` gets its own `FV_SERVER_ED25519_SEED` (never one that is
  registered on chain) and, with the simulator, `FV_KEY_MODE=factory` — the simulator mints valid taps for any UID
  with the configured keys.
* On first start the DB (`FV_DB_PATH`, default `./data/flaconvault.db`) is created and — when empty **and** the
  simulator (or `FV_SEED_DEMO=true`) is on — seeded from `docs/seed/passports.json` (3 passports, 35 events,
  4 virtual tags). Seed scans are signed with a throwaway key generated for that run (`server.keyId` 0, never
  registered on chain) and every seeded row carries `payload.seed = true`. A production verifier never seeds.
* `uv run python -m fv.seed` wipes and re-seeds (refused unless the simulator or `FV_SEED_DEMO` is on);
  `POST /api/dev/reset` with `x-admin-token: $FV_ADMIN_TOKEN` does the same at runtime (403 without a configured
  token, also locally).
* `uv run pytest -q` — all tests (fixtures: `docs/vectors.json`, `docs/enums.json`).
* `uv run python scripts/sync_enums.py` — copy `docs/enums.json` → `fv/enums.json` after `npm run vectors`.

## Configuration (`.env`, all `FV_*`)

| Key | Default | Meaning |
|---|---|---|
| `FV_MASTER_KEY` | `00…00` (16 B hex) | **secret** SDM master key of the tags; factory mode ignores it |
| `FV_KEY_MODE` | `factory` | `factory` = public all-zero NXP keys (plain mirror, **simulator only**) · `diversified` = AN10922 `CMAC(K, 0x01‖UID‖APP_ID‖SYS_ID)` (plain mirror) · `sdmbackend` = encrypted SUN as written by the **NFC Developer App** / icedevml sdm-backend: meta read key `derive_undiversified_key(K, 1)`, file read key `derive_tag_key(K, uid, 2)` — production |
| `FV_SDM_DERIVE` | `legacy` | sdmbackend derivation: `legacy` (`legacy_derive.py`, NFC Developer App) \| `standard` (`derive.py`) |
| `FV_SERVER_ED25519_SEED` | — (required) | 32 B hex seed of the signing key (**secret**; production and development use different seeds) |
| `FV_SERVER_KEY_ID` | `1` | `key_id` in bundles / on-chain registry |
| `FV_DEV_SIMULATOR` | `false` | enables `/api/dev/*` (404 otherwise) and the demo seed |
| `FV_SEED_DEMO` | `false` | load the demo seed into an empty database even with the simulator off (demo deployments only; no virtual tags) |
| `FV_ALLOW_SIM_WITH_REAL_KEYS` | `false` | tests against a **local validator** only: allow the simulator together with `sdmbackend`/`diversified` keys. Refused when `FV_PROGRAM_ID` is set and `FV_SOLANA_RPC` is not localhost / a loopback address; never combine it with the production master key or seed |
| `FV_ADMIN_TOKEN` | — | `x-admin-token` for `POST /api/reconcile`, `/api/admin/*` and `POST /api/dev/reset`; all of them answer 403 while it is unset or the header is wrong |
| `FV_NONCE_TTL_S` | `90` | nonce lifetime |
| `FV_DB_PATH` | `./data/flaconvault.db` | SQLite file (relative to `apps/verify`) |
| `FV_MEDIA_DIR` | `./data/media` | seal frames: staged uploads under `staging/<nonce>/`, kept ones as `<sha256>.bin` (+ `<sha256>.preview.<ext>`) |
| `FV_MEDIA_MIN_FREE_BYTES` | `268435456` (256 MiB) | `POST /api/media` refuses an upload that would leave less free space on the media volume (507 `storage_full`; the volume also holds the database) |
| `FV_MEDIA_MAX_BYTES_PER_IP_DAY` | `209715200` (200 MiB) | upload bytes per client (IPv4 address, IPv6 /64) and 24 h (429 `media_limited`, `Retry-After`) |
| `FV_MEDIA_MAX_BYTES_PER_HOUR` | `2147483648` (2 GiB) | upload bytes for the whole server per hour (503 `media_busy`, `Retry-After`) |
| `FV_MEDIA_RETENTION_S` | `604800` (7 days) | the reconcile job deletes kept seal frames (blob, preview, `media` row) that no pending, confirmed or still recoverable failed scan references once they are older than this, and blob files without a `media` row; `0` = keep them forever. Staged uploads are deleted as soon as their session nonce has expired or was used |
| `FV_SEED_PATH` | `docs/seed/passports.json` | demo seed file (also what `purge-seed` recognises) |
| `FV_PORT` | `8787` | port setting (the container honours `PORT`) |
| `FV_WEB_URL` | `http://localhost:3000` | `/t` redirects to `${FV_WEB_URL}/t?tap=<id>` |
| `FV_VERIFIER_HOST` | `http://localhost:8787` | host baked into simulator tag URLs |
| `FV_CORS_ORIGINS` | `http://localhost:3000` | comma-separated allow-list; responses to these origins carry `Access-Control-Expose-Headers: Retry-After`, so the web can read the `Retry-After` of a 429/503 |
| `FV_SOLANA_RPC` | `https://api.devnet.solana.com` | JSON-RPC used by the reconcile job and `/api/registry` (local validator: `http://127.0.0.1:8899`) |
| `FV_PROGRAM_ID` | — | `flacon` program id; empty = reconcile disabled, `/api/sites` falls back to the seed sites, tx-backed `POST /api/events` → 503 `chain_not_configured` |
| `FV_ESCROW_PROGRAM_ID` | `9vabByStbAqKH6sM6fuf8HhfGZbV3993Ncp3uZScexKL` | escrow program whose transactions back LIST…DISPUTE events |
| `FV_RECONCILE_INTERVAL_S` | `60` | seconds between reconcile cycles; `0` = manual `POST /api/reconcile` only |
| `FV_RECONCILE_TIMEOUT_S` | `600` | a SCAN(pending) without ScanProof PDA after this long → `failed` |
| `FV_ARWEAVE` | `false` | upload seal frames and ScanProof bundles to Arweave via the Irys sidecar |
| `FV_IRYS_KEY` | — | path to a Solana keypair json, or `default` = `~/.config/solana/id.json` |
| `FV_IRYS_KEY_JSON` | — | hosted deployments: the keypair inline (64-number JSON array); written 0600 next to the database. One of the two Irys keys is required for uploads |
| `FV_ARWEAVE_TIMEOUT_S` | `60` | sidecar subprocess timeout |
| `FV_IRYS_NETWORK` | `devnet` | `devnet` \| `mainnet` |
| `FV_NODE_BIN` | auto | node binary for the sidecar (`~/.local/node/bin/node`, else `PATH`) |
| `FV_SDM_LRP` | `false` | accept 24-byte (LRP) `picc_data`; production stickers are AES, so LRP input is refused by default |
| `FV_RATE_LIMIT_PER_MIN` | `60` | requests per minute and client (IPv4 address, IPv6 /64) for every POST route — the `/api/dev/*` simulator routes included — `GET /t` and the resume `GET` (429 `rate_limited`, `Retry-After`) |
| `FV_REPORT_LIMIT_PER_HOUR` | `3` | unverified SEAL_DEAD reports per hour and client IP (429 `report_limited`) |
| `FV_TRUSTED_PROXY_HOPS` | `1` | proxies in front of the app; the client IP is taken from `X-Forwarded-For` only when the socket peer is a private (platform proxy) address |
| `FV_MAX_JSON_BODY` | `65536` | request body limit in bytes for every route and method except `POST /api/media` (which checks its own `Content-Length`): ASGI middleware in front of routing and JSON parsing, chunked bodies counted as they stream in; 413 `request_too_large`, with CORS headers so the browser can read it |
| `FV_BUILD_SHA` | `RAILWAY_GIT_COMMIT_SHA` | commit shown as `build` by `GET /health`. Deploys are manual `railway up` uploads, which set no commit: set it to `git rev-parse HEAD` before each deploy ([`docs/deploy.md`](../../docs/deploy.md#deploying)); `RAILWAY_GIT_COMMIT_SHA` only counts when it is unset |

Comments must be on their own lines (python-dotenv treats an inline `# …` after an empty value as the value).

**Startup refusals** (clear error, exit): simulator off with an all-zero `FV_MASTER_KEY`; simulator off with
`FV_KEY_MODE=factory` (the null keys are public, so anyone could forge a tap); simulator on with `sdmbackend` or
`diversified` keys unless `FV_ALLOW_SIM_WITH_REAL_KEYS=true` — and that flag only counts without `FV_PROGRAM_ID` or
against a local validator; simulator on against a shared cluster (`FV_PROGRAM_ID` set, `FV_SOLANA_RPC` not local) with an
`FV_SERVER_ED25519_SEED` whose public key is a live server key of that cluster's registry (one `getAccountInfo` at
startup, else the registry the reconcile job cached; if neither can be read the start goes on with an error in the log).

A local simulator therefore always runs with `FV_KEY_MODE=factory`, a **dev-only** `FV_MASTER_KEY` and a **dev-only**
`FV_SERVER_ED25519_SEED` that is not registered on devnet. An older local `.env` that still holds the production master
key or a registered seed must be changed to such dev-only values — not worked around with `FV_ALLOW_SIM_WITH_REAL_KEYS`.

## Endpoints

Verdicts are data, not errors: every verdict is HTTP 200; 4xx only for malformed input.
Hashes in responses are `0x` + lowercase hex (32 bytes); in the DB they are stored without `0x`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | `{ok, keyId, pubkeyHex, simulator, programId, build, arweave:{enabled, ok, problem, lastOkAt, lastErrorAt, lastErrorCode, failures, balanceSol, balanceOk}}` — the Arweave part is status only: `problem` is a code (`key_missing`, `key_invalid`, `key_file_missing`, `sidecar_missing`, `sidecar_dependencies_missing`, `node_missing`), never a path, key, wallet address or sidecar output (full detail in `/api/admin/status`) |
| GET | `/t?uid&ctr&cmac` or `/t?picc_data&cmac[&enc]` | Real tag landing (plain mirror, or encrypted SUN from the NFC Developer App — `enc` is decrypted and ignored). Checks CMAC + counter (**consumes**: advances `seals.last_counter`), logs a Tier-0 SCAN event when VALID and a `taps` row (random id in [2^32, 2^53), so ids cannot be enumerated) for every hit with a parsable chip UID; hits without one are not stored (`tapId` null). INVALID taps are deleted after 24 h. A VALID tap on a dead seal is answered and stored as `NO_RESPONSE` (no token, no sighting). A VALID tap gets a one-time adoption token (`secrets.token_urlsafe(16)`, only its sha256 is stored). `Accept: application/json` or `&format=json` → tap JSON (+ `tapToken` when VALID); otherwise `302 → ${FV_WEB_URL}/t?tap=<tapId>&k=<token>` (no `k` unless VALID) |
| GET | `/api/tap/<tapId>` | Stored tap `{tapId, ts, verdict, counter, uid, serial, serialHash, uidHash, sealKind, sealDead, message}` — `uid` only when the verdict is `UNREGISTERED` (else `null`); never the token |
| POST | `/api/session` | `{}` → `{nonce: "0x…", issuedAt, expiresAt, ttl}` (32 random bytes, single use) |
| POST | `/api/preview` | `{uid, ctr, cmac}` → non-consuming check `{verdict, counter, serial, serialHash, uidHash, sealKind, sealDead, message}` |
| POST | `/api/verify` | Scan flow step 7 — see below |
| GET | `/api/verify/<eventId>?token=<resumeToken>` | The same JSON as the VALID `/api/verify` answer while that SCAN is still `pending` (constant-time token compare); anything else → 404 `resume_not_found`. Used by the wallet-app resume link `/scan?resume=<eventId>.<token>` |
| POST | `/api/media` | multipart `file` (or `files`) plus the field `nonce` = the current session nonce (unexpired and not yet used by `/api/verify`, else 403 `media_nonce_invalid`). `Content-Length` is required (411) and checked before the body is read, together with the free space (507 `storage_full`) and the byte budgets per client (429 `media_limited`) and per server (503 `media_busy`), see the `FV_MEDIA_*` settings. At most 6 files per upload and per nonce (413), ≤ 8 MB each (413), only `image/jpeg`, `image/png`, `image/webp` (415) → `{sha256: "0x…", ar, url, arPreview, bytes, files}`. Several files are hashed as one concatenation in upload order. The upload is only **staged** under its nonce (`<FV_MEDIA_DIR>/staging/<nonce>/`): a VALID `/api/verify` that consumes this nonce with `mediaHash` = this sha256 keeps it (`<sha256>.bin`, a `media` row, the first of several frames as `<sha256>.preview.<ext>`); everything else staged under the nonce is deleted then, or once the nonce has expired. Nothing is uploaded to Arweave here, so `ar`/`url`/`arPreview` (and `bundle.media[0].ar` of the scan) are `null` unless the same bytes were archived for an earlier scan: with `FV_ARWEAVE=true` the reconcile job's archiving queue uploads the file (`ar`/`url`) once its scan is confirmed; several image frames additionally upload the first frame alone as `arPreview` (viewable thumbnail); a single image is its own preview. Kept frames no scan references any more expire after `FV_MEDIA_RETENTION_S` |
| POST | `/api/events` | Client-reported events — verified against the chain, see [`POST /api/events`](#post-apievents) below |
| GET | `/api/passport/<serial>` | Passport + timeline (shape below), 404 if unknown or not a valid serial |
| GET | `/api/passport/<serial>/metadata.json` | Metaplex-style metadata for the passport's Core asset `uri`: `{name, symbol, description, image, external_url, attributes, properties}` |
| GET | `/api/passports` | `[{serial, brand, name, grade, void, scanCount, lastEventTs}]` (confirmed events only; `lastEventTs` ignores pending events) |
| POST | `/api/reconcile` | Header `x-admin-token: $FV_ADMIN_TOKEN` (403 otherwise / when unset). Run one reconcile cycle now (§10) → `{checked, confirmed, recovered, failed, pending, mismatched, ignoredAccounts, refreshed:{passports, seals}, registry, escrow, arweave, media:{staging, rows, files, bytes}, enabled}` |
| GET | `/api/admin/status` | Admin token. Key mode, simulator/seed flags, program ids and the full Arweave status `{enabled, configured, problem, uploads, failures, consecutiveFailures, lastOkAt, lastErrorAt, lastErrorCode, lastError, probe}` |
| POST | `/api/admin/purge-seed?dry_run=true` | Admin token. Report (default) or, with `dry_run=false`, delete what the demo seed put into this database — see [Removing seed data](#removing-seed-data-from-a-deployed-database) |
| GET | `/api/registry` | Registry PDA `{programId, authority, partners:[base58], serverKeys:[{keyId, pubkeyHex, validFrom, validTo}], sites:[{siteId, label}], source:"chain"\|"fallback"}` — read at most once a minute (the last chain read stays usable for 15 min while the RPC fails, then the registry the reconcile job stored, if it is younger than 15 min); fallback (no program id / RPC down / PDA missing): `authority null`, `serverKeys []`, `partners` = partner attesters from the DB, seed sites |
| GET | `/api/sites` | `[{siteId, label}]` for the certification console: the on-chain registry's sites (possibly none) whenever the registry is readable (`source: "chain"`); the two seed sites only in the fallback (no program id, RPC down, PDA missing) |
| GET | `/api/attester/<pubkey>` | `{pubkey, label, isPartner, firstSeen, scanCount, certifiedCount, agreeCount, compareCount, agreeRate, escrowsOk, escrowsDisputed, recentSerials}` — `isPartner` from the on-chain registry, escrow counters from confirmed RELEASE/DISPUTE events and Order accounts, `recentSerials` from confirmed events |
| POST | `/api/dev/tag` | `{uid?, serial?, kind?}` → virtual tag (random `04…` UID if omitted); with `serial` also attaches the seal. 409 for the uid of a registered seal that has no virtual tag (never a CMAC oracle for real chips) |
| POST | `/api/dev/tap` | `{uid}` → `{responds: true, uid, ctr, ctrHex, cmac, url}` or, if killed, `{responds: false, uid, tapId, url}` (a `NO_RESPONSE` tap row) |
| POST | `/api/dev/kill` · `/api/dev/revive` | tag stops / resumes responding (does **not** touch `seals.dead` — that happens on-chain via `mark_seal_dead`) |
| GET | `/api/dev/tags` | virtual tags with their last URLs |
| POST | `/api/dev/reset` | wipe DB and re-seed; always needs `x-admin-token: $FV_ADMIN_TOKEN` (403 while the token is unset or wrong). Every `/api/dev/*` POST counts against `FV_RATE_LIMIT_PER_MIN` |

### `POST /api/verify`

Request:

```json
{ "uid": "04A1B2C3D4E5F6", "ctr": "00000E", "cmac": "6F3A0B1C2D3E4F50", "nonce": "0x…",
  "role": 1, "tier": 2, "indicators": { "heat": 0, "humidity": 0, "uv": 3 }, "heatLevels": [1,1,0,0,0,0],
  "fill": 92, "mediaHash": "0x…", "serial": "SN-2026-000001", "location": { "country": "DE", "city": "Wickede" },
  "attester": "<base58 pubkey>", "platform": "ANDROID_WEB" }
```

`ctr` may be the 3-byte hex from the URL or an int. `piccData` is at most 48 hex characters (24-byte LRP input only
with `FV_SDM_LRP=true`), `enc` at most 64; `serial` must match `^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$` (422); `attester`
must be a base58 pubkey. A tier ≥ 3 or a VAULT/PARTNER role is signed only for an attester in the on-chain registry
partner list (403 `not_partner`; the registry is cached 60 s). Extra fields such as `tamper` are ignored. Instead of tag parameters a session may adopt the tap that
landed on `/t` moments before: `{"tapId": <id>, "tapToken": "<k from the /t redirect>"}` — accepted once, within
180 s, only for a VALID `/t` tap; a wrong or missing token → `INVALID`, a second use or an older tap → `REPLAY`. Encrypted tags send `piccData` (+ optional `enc`) and `cmac` instead of `uid`/`ctr` (same for `/api/preview`); the response then carries the decrypted `uid` and `counter`. `indicators.uv` is signed as sent (frame mode reads it). `indicators.heat`
must equal `heatLevels[4]` when it is 0/1 (2 UNREADABLE / 3 MISSING are trusted as sent). `mediaHash` is
required for tier ≥ 2 and ignored (zero hash) below. `tamper` is always UNKNOWN (3): NTAG 424 DNA has no tamper loop.
Optional: `note`.

Order of checks (briefing §5): nonce → key by mode → CMAC (`INVALID`) → `ctr > last_counter` (`REPLAY`, then
advance) → seal lookup (`UNREGISTERED`; dead seal → `NO_RESPONSE`) → build message, sign, consume nonce, insert
`events` SCAN `pending` with the full bundle; the claimed attester lives only in the signed bundle (the event's actor
and label stay empty). Passport grade and attester statistics are **not** touched here — they change only when the
scan is confirmed (`POST /api/events` with the verified `record_scan` tx, or the reconcile job), using the verified
signer as attester and the tier/role/site the program recorded (`payload.confirmed`, `payload.tier`, `payload.role`). **Signed only when VALID**; otherwise
`serverSig`, `msgHex`, `bundle`, `bundleHash`, `eventId` are `null`. The nonce is consumed only on VALID.
A `serial` that does not match the tag's passport → 409.

Response:

```json
{ "verdict": "VALID", "counter": 14, "serial": "SN-2026-000001", "serialHash": "0x…", "uidHash": "0x…",
  "sealKind": 1, "sealDead": false, "heatMask": 3, "grade": 0, "reviewRecommended": false,
  "serverSig": "0x…(64 bytes)", "serverPubkey": "<hex 32 bytes>", "keyId": 1, "ts": 1790000012, "msgHex": "<152 bytes>",
  "bundle": { …§4.4 with server.sig filled… }, "bundleHash": "0x…", "eventId": 36, "message": "Seal genuine · tap 14",
  "resumeToken": "<secrets.token_urlsafe(16)>" }
```

`resumeToken` is returned once; the server stores only its sha256 on the pending SCAN event. Public views
(`/api/passport`, `/api/passports`, `/api/attester` and event responses) never contain `msgHex`, `server.sig` or
`session.nonce` for an event that is not `confirmed`, so nobody can anchor someone else's pending scan.

`msgHex` is the exact 152-byte message for `Ed25519Program.createInstructionWithPublicKey`; `eventId` goes back
to `POST /api/events` with the `txSig` after confirmation.

### `POST /api/events`

The server never trusts the client here: `ts`, `status`, `actorLabel` and `location` in the body are ignored (a
location belongs only to the scanner's own SCAN from `/api/verify`, so whoever posts a public transaction first cannot
write text into the timeline).

* **Tx-backed event** `{serial, type, txSig, actor, payload?, sealUidHash?, location?}` for `MINT`, `SEAL_ATTACH`,
  `LIST`, `RESERVE`, `SHIP`, `RECEIVE`, `RELEASE`, `DISPUTE` and `SEAL_DEAD` with a `txSig` (`txSig` — a base58
  64-byte signature — and `actor` required, 422 otherwise). The tx is fetched with `getTransaction` (commitment
  `confirmed`, v0 allowed; results cached). A signature the cluster does not know (`getSignatureStatuses`) is answered
  503 `tx_not_visible` at once, without retries; at most 2 lookups per client are in flight (429 `rate_limited`) and
  8 for the whole server (503 `busy` with `Retry-After`). The tx must: exist, have
  `actor` among its signers, contain an instruction of the expected program (flacon: `mint_passport`, `attach_seal`,
  `mark_seal_dead`, `record_scan`; escrow: `list`, `reserve`, `ship`, `record_receipt_scan`, `release` /
  `release_after_timeout` / `resolve(to_seller=true)` for RELEASE, `dispute` / `resolve(to_seller=false)` for DISPUTE —
  matched by Anchor discriminator, top-level or CPI) whose accounts include the actor and whose accounts **at their
  IDL positions** are the passport PDA `["passport", sha256(serial)]` (escrow: the Order account at its position, read
  from chain, whose `passport` field is that PDA and whose address is `["order", passport, seller]`; known LIST sellers
  are a fallback for closed orders), for `SEAL_ATTACH` / `SEAL_DEAD` also the seal PDA `["seal", uid_hash]`, and
  `meta.err` must be null. Stored `confirmed` with `ts` = block time (else now). One tx backs one event (a repeat
  returns the same event). A MINT or SEAL_ATTACH that already exists is returned as stored before any RPC: a passport
  is never renamed or re-pointed and a seal never changes its kind. A MINT by someone other than the issuer of an
  existing passport → 403 `not_issuer`. A verified `SEAL_DEAD` marks the seal dead and voids the passport.
* **Payloads are fixed by the server**: tx-backed facts come from the decoded instruction args, its accounts, the
  program's Anchor events and the Order/ScanProof accounts; the client only supplies what the chain cannot know, and
  client labels (`actorLabel`, `issuerLabel`) are ignored.

  | Type | Stored payload |
  |---|---|
  | MINT | `{brand, name, batch, asset, bindingHash}` — brand/name/batch from the client (the first MINT only; a passport is never renamed), asset and binding hash from `mint_passport`; a client `siteId` / `issuerLabel` is ignored (the issuer label is the server's record of the verified issuer) |
  | SEAL_ATTACH | `{uidHash, uidTail, kind, kindName}` — kind from `attach_seal` (BOX or NECK); the raw UID is never published |
  | LIST / RESERVE | `{order, currency, price, priceUsdc, seller \| buyer}` |
  | SHIP | `{order, carrier, preShipScanCounter}` — `carrier` only from a fixed list (DHL, DPD, UPS, GLS, Hermes, FedEx, … `CARRIERS` in `fv/routes_api.py`, case-insensitive), anything else is dropped |
  | RECEIVE | `{order, preShipScanCounter, receiptScanCounter, match, fillDelta}` |
  | RELEASE | `{order, currency, price, priceUsdc, to, passportTo?, reason?}` — `passportTo` only when the Core asset moved |
  | DISPUTE | `{order, currency, reason, reasonCode, refunded, refundedUsdc}` |
  | SEAL_DEAD (report) | `{source, note?, uidTail?, reportedBy?}` |

* **SCAN confirmation** `{eventId, txSig, actor?}` (`actor` defaults to the attester given at `/api/verify`): the
  `record_scan` tx must reference the seal and the ScanProof PDA of that scan, and its attester (account 4) must be the
  signer. On success the event turns `confirmed`, attester, tier, role and site are taken from the `record_scan` args
  (`payload.confirmed = {attester, tier, role, siteId, source, mismatch}`), and the passport grade / attester stats
  are applied once. The same `txSig` again → 200 (idempotent); any
  other change of a confirmed event → 409 `event_confirmed`.
* **SEAL_DEAD report** without `txSig`: `{serial, type: "SEAL_DEAD", nonce, sealUidHash?, payload?}` with an unused,
  unexpired `/api/session` nonce (consumed; 403 `nonce_invalid`). Stored with status `reported` — it does not void the
  passport, does not mark the seal dead and does not affect `sealStatus`; the claimed reporter is kept as
  `payload.reportedBy`. One open report per seal (or per passport when no seal is named) per 24 h, and at most
  `FV_REPORT_LIMIT_PER_HOUR` per client IP (429 `report_limited`).
* `SCAN` events cannot be created here (422). `payload` is limited to 16 KiB (413).

| Status | `detail` | Meaning |
|---|---|---|
| 503 | `tx_not_visible` | signature unknown to the cluster (answered at once), or a known tx still not found after 3 quick retries (≈ 4 s) — retry |
| 422 | `tx_failed` | the tx failed on chain (a SCAN confirmation also marks the event `failed`; a later successful tx can still confirm it) |
| 403 | `tx_mismatch` | signer, program, instruction or accounts do not match the event |
| 403 | `not_issuer` | MINT for an already minted serial by someone other than its issuer |
| 403 | `nonce_invalid` | SEAL_DEAD report with a missing/used/expired nonce |
| 409 | `event_confirmed` | the event is already confirmed with another tx |
| 503 | `chain_not_configured` | `FV_PROGRAM_ID` (or the escrow id) is not set |
| 429 | `rate_limited` | too many requests from this client, or 2 transaction lookups of this client already in flight (`Retry-After`) |
| 503 | `busy` | all 8 transaction lookup slots of the server are in use (`Retry-After`) — retry |
| 429 | `report_limited` | a SEAL_DEAD report for this seal is already open, or the IP's report budget is used up |
| 413 | `request_too_large` | request body above `FV_MAX_JSON_BODY` |

Other codes the web maps: 403 `not_partner` (`/api/verify`), 403 `media_nonce_invalid`, 411, 413, 415,
507 `storage_full`, 429 `media_limited`, 503 `media_busy` (`/api/media`), 404 `resume_not_found`
(`GET /api/verify/<id>`), 403 `admin token required` (`/api/reconcile`, `/api/admin/*`, `/api/dev/reset`) and 413
`request_too_large` (any route).

### Passport response

```json
{ "serial": "SN-2026-000001", "serialHash": "0x…", "brand": "Roja Parfums", "name": "Haute Luxe", "batch": "4A12",
  "asset": "<pubkey|null>", "issuer": "<pubkey|null>", "issuerLabel": "Parfümerie X, Düsseldorf",
  "grade": 0, "void": false, "createdAt": 1789459200,
  "seals": [ { "uidHash": "0x…", "kind": 1, "lastCounter": 14, "dead": false, "attachedAt": 1789459500 } ],
  "sealStatus": "INTACT | NO_RESPONSE | OPENED",
  "stats": { "scanCount": 14, "attesterCount": 3, "certifiedCount": 1, "onChainScanCount": 9, "counter": 14 },
  "latest": { "tamper": 3, "indicators": {"heat":0,"humidity":0,"uv":3}, "heatLevels": [1,1,0,0,0,0], "fill": 92,
              "counter": 14, "ts": 1790161500, "reviewRecommended": false, "eventId": 18, "attester": "<pubkey|null>" } ,
  "events": [ { "id": 1, "type": 0, "ts": 1789459200, "actor": "<pubkey|null>", "actorLabel": "…", "txSig": "…|null",
                "status": "confirmed", "sealUidHash": null, "payload": { … }, "arBundle": null, "arMedia": null,
                "gradeAfter": 0, "location": { "country": "DE", "city": "Düsseldorf" } } ] }
```

`latest` (the header) is the newest **confirmed** SCAN whose heat or humidity was actually read (not MISSING), so a
pending scan or a no-photo scan never blanks it. `status` is `pending | confirmed | failed | reported`; a `reported`
SEAL_DEAD appears in the timeline only.

`stats` count **confirmed** SCAN events only (a pending scan and the attester it claims never count):
`scanCount` all tiers incl. Tier-0 `/t` sightings, `attesterCount` distinct verified signers, `certifiedCount` tier ≥ 3
(the on-chain ScanProof tier wins over the claimed one), and `onChainScanCount` the confirmed bundle scans that the
program counted in `passport.scan_count` (backed by their `record_scan` tx or by the ScanProof the reconcile job found;
sightings and seeded demo rows excluded) — the number "Check live on-chain" compares with the chain.

`grade` follows the program's rule (`record_scan`, `programs/flacon/src/grade.rs`; mirrored by `fv.proof.passport_after_scan`):
**VOID and C are sticky; A/B/D follow the latest scan.** VOID stays once the passport is void or any confirmed scan graded
VOID (`void` is sticky too), C stays once any confirmed scan graded C (heat or humidity triggered), and otherwise the
newest confirmed scan's fill grade (A ≥ 90, B ≥ 60, else D) is the passport's — so one low fill reading is corrected by
the next scan. A scan whose confirmation arrives after a newer one's (a retried confirm, a failed scan the reconcile job
recovers) can still make the passport C or VOID but never overwrites the newer fill grade. The reconcile job applies the
same rule against the Passport account (below), so the two never flip a grade back and forth.

## Hardware tags with the NFC Developer App

NXP TagWriter cannot place the SDMMAC correctly, so tags are programmed with the **NFC Developer App**
(nfcdeveloper.com, by the sdm-backend author) in its encrypted SUN mode:

* URL to be programmed: `https://app.flaconvault.com/t` (the app appends `?picc_data=…&cmac=…`, with TagTamper `&enc=…`;
  stickers written with `https://flaconvault.vercel.app/t` keep working through the redirect)
* master key in the app = `FV_MASTER_KEY`, and `FV_KEY_MODE=sdmbackend` on the server. Tag keys are derived like
  sdm-backend's `/tag` handler: meta read key = `derive_undiversified_key(K, 1)`, file read key = `derive_tag_key(K, uid, 2)`.
  `FV_SDM_DERIVE` picks the derivation: `legacy` (default — `libsdm/legacy_derive.py`, pbkdf2-sha512, what the NFC
  Developer App and sdm-backend's shipped `DERIVE_MODE="legacy"` use) or `standard` (`libsdm/derive.py`, 2023+).
  If a real tag comes back INVALID, switch the derivation first. With an all-zero master key both derive null keys.

The server accepts both tag URL forms on `GET /t`, and `piccData`/`enc`/`cmac` on `/api/preview` and `/api/verify`.
Replay, seal lookup, verdicts and wording are identical to the plain-mirror path.

## Arweave (Irys devnet)

No maintained Python SDK exists for Irys, so `fv/arweave.py` shells out to a tiny Node sidecar in `irys/`
(`@irys/upload` + `@irys/upload-solana`, own `package.json`, not part of the root workspace):

```bash
cd apps/verify/irys && npm install                          # once (Node ≥ 20; ~/.local/node/bin/node is used by default)
node fund.mjs --key default --network devnet --dry-run      # balance vs. price of 1 MB
node fund.mjs --key default --network devnet                # funds 0.01 SOL only if the balance is below that price (hard cap 0.05)
node upload.mjs --key default --network devnet --tag Content-Type=image/jpeg frame.jpg
# → {"id":"…","url":"https://gateway.irys.xyz/<id>","ar":"ar://<id>","bytes":n,…}
```

Server side, uploads happen only when `FV_ARWEAVE=true` **and** `FV_IRYS_KEY` or `FV_IRYS_KEY_JSON` is set. Failures
return `null` links — the scan flow never breaks because of Arweave — but they are not silent any more: they are
logged as errors, classified (`insufficient_balance`, `timeout`, `sidecar_unavailable`, `key_invalid`,
`upload_failed`) and reported by `GET /health` (`arweave`: status flags and codes only) and `GET /api/admin/status`
(full text, last error, balance probe); startup logs a misconfiguration
(`FV_ARWEAVE=true` without a key, sidecar dependencies or node missing) as an error, and the background loop probes the
Irys balance hourly (`fund.mjs --dry-run`, read-only). The sidecar gets a minimal environment (no `FV_*` variable, no
secret; the key only as a 0600 file path).

Uploads happen in one place only: the **archiving queue** the reconcile job runs after each cycle's write
transaction (`arweave.backfill`). No request waits for the sidecar — `POST /api/media` and the confirming
`POST /api/events` never upload.

* Queue: confirmed SCANs (not seeded) whose bundle is not archived, or whose media is not, at most 5 per cycle — fewest
  failed attempts first, then newest. Newly confirmed scans (by `POST /api/events` or by the reconcile job) are picked
  up by the next cycle.
* Per scan (`arweave.archive_scan`) the media blob goes first (tags `App-Type=seal-frames`, `FV-Sha256`; for several
  frames also the first frame as `seal-frame-preview`; links kept in the `media` table), so a newly confirmed scan never
  gets its `ar_media` copied from a row that is not archived yet; then the canonical bundle (exactly the bytes whose sha256
  is `bundleHash`, tags `App-Type=scanproof-bundle`, `FV-Serial`, `FV-Bundle-Hash`) as `application/json` →
  `events.ar_bundle`; the media preview/url is copied to `events.ar_media`. The passport timeline exposes them as
  `arBundle` / `arMedia`. The bundle does not depend on the media upload, so it is archived even when the media fails.
* A scan whose upload fails is recorded in `arweave_queue` (attempts, last error code) and due again after 5 min,
  10 min, … up to 6 h; the queue goes on with the next scan, so one failing row (e.g. media the Irys balance cannot
  pay for, while small bundles are free) never blocks the others. A failure that would hit every upload (`timeout`,
  `sidecar_unavailable`, `key_invalid`) ends the cycle, and the following cycles wait (1 min … 1 h, exponential).
* With `FV_RECONCILE_INTERVAL_S=0` nothing is archived until `POST /api/reconcile` runs a cycle.

The sidecar is handed the public devnet RPC when `FV_SOLANA_RPC` points at a local validator (a local validator
cannot pay the Irys devnet node). **Irys devnet uploads are pruned after ~60 days**; uploads under ~100 KiB are
currently free, larger ones are paid from the funded Irys balance (~0.0005 SOL per MB).

## Reconcile job (briefing §10)

Runs in the FastAPI lifespan every `FV_RECONCILE_INTERVAL_S` (first cycle 5 s after start) when `FV_PROGRAM_ID` is
set, and on `POST /api/reconcile` (admin token; without `FV_PROGRAM_ID` that only runs step 6). All RPC reads happen before the single write transaction of a
cycle, which re-checks each event's status (a parallel `POST /api/events` confirmation is never applied twice).

1. **SCAN events** — every `pending` one and every `failed` one of the last 24 h (the web app keeps a signed scan
   anchorable) with a `seal_uid_hash` and a payload `counter` — derive `ScanProof ["scan", seal_pda, counter u32le]`
   and read it via `getMultipleAccounts`:
   * a valid ScanProof (Anchor discriminator, this seal and counter) → `confirmed`. Actor, label, tier, role and site
     come from the proof (`payload.chain`), never from the client's claim; `counter, tamper, uv, hum, heat, fill,
     media_hash, bundle_hash, tier, role, site_id` (+ `heatLevels`, `attester`) are compared and differences recorded in
     `payload.reconcile.mismatch`. `tx_sig` = the creating `record_scan`: of the newest 50 successful signatures on the
     PDA at most 20 are checked, oldest first, with `getTransaction`, and only a successful flacon `record_scan` with this ScanProof
     and seal PDA at their account positions, signed by the proof's attester, qualifies — a SOL transfer that
     pre-funded the PDA, dust or an escrow tx never does. Nothing qualifies → `tx_sig` stays empty (the client can
     still post the real one). A recovered failed scan never keeps the client's failed tx. Such confirmations carry
     `payload.reconcile.signatureChecked`; a scan an older build confirmed with an unchecked guess takes the client's
     tx once, if it verifies as this scan's `record_scan` by its attester;
   * anything else at the address — no data (a plain SOL transfer to the PDA), another account type, a proof for
     another counter — counts as "not created" (`payload.reconcile.ignoredAccount`) and never aborts the cycle;
   * no ScanProof and a pending event older than `FV_RECONCILE_TIMEOUT_S` → `failed` (`payload.reconcile.reason`).
2. **Other pending events** (no ScanProof can ever confirm them) → `failed` after `FV_RECONCILE_TIMEOUT_S`, so they
   never block step 3.
3. **Passport/Seal PDAs** refresh `passports.grade/void` and `seals.last_counter/dead` for passports with nothing
   pending, once the chain has recorded a scan or a void. The grade follows `record_scan` ("chain wins",
   `fv.proof.passport_from_chain`): VOID and C are sticky on either side (a VOID grade on chain counts as void), otherwise
   the chain's A/B/D replaces the DB's — unless the account shows fewer scans than the DB has confirmed on chain (a
   lagging RPC node), which keeps the DB's A/B/D. `void` and `dead` are OR-ed, counters only rise (a raised seal counter
   pulls the simulator tag along).
4. **Registry** partners → `attesters.is_partner` (the decoded registry is cached in `chain_state`); **escrow** Order
   accounts (`getProgramAccounts`, one row per listing in `escrow_orders`, kept after `close_order`; a confirmed
   RELEASE / DISPUTE event writes its listing's final state there too, so an order closed before the job ever saw it
   still counts, and a final state is never moved back) → `escrows_ok` (RELEASED) / `escrows_disputed` (DISPUTE) for
   seller and buyer, recomputed from that one table.
5. **Arweave**: the archiving queue (see [Arweave](#arweave-irys-devnet)), nothing while a global failure backs off.
6. **Media retention** (`media_store.retention`, also without `FV_PROGRAM_ID` on `POST /api/reconcile`): staging
   directories of expired or used session nonces, then — unless `FV_MEDIA_RETENTION_S=0` — kept frames (blob, preview,
   `media` row) older than `FV_MEDIA_RETENTION_S` that no pending or confirmed event references and no failed scan the
   job may still recover (24 h), and blob files without a `media` row whose mtime is that old. At most 200 rows and 200
   files per cycle, in one write transaction, so a parallel `/api/verify` keeping the same bytes never loses its file.
   Only `<sha256>.bin` / `<sha256>.preview.<ext>` names are ever deleted.

`events` are sorted by `ts` ascending. SCAN payloads of tier ≥ 1 are the full §4.4 bundle plus `grade`,
`reviewRecommended`, `msgHex`, `bundleHash` (and `reconcile` / `chain` once checked); Tier-0 sightings carry
`{tier: 0, verdict, counter, tapId}`.

## Production deployment (Docker / Railway)

`Dockerfile.verify` (repo root) pins Python 3.12.11 (bookworm slim), Node 22.18.0 (copied from the official image, no
download) and uv 0.12.18; npm installs the sidecar with `--ignore-scripts`. The container starts as root only to hand
the root-owned `/data` volume to the unprivileged user `fv` (uid 10001, `docker-entrypoint.sh`); uvicorn and the Irys
sidecar run as `fv`. Required production settings: `FV_KEY_MODE=sdmbackend`, `FV_SDM_DERIVE=legacy`, the secret
`FV_MASTER_KEY`, a production-only `FV_SERVER_ED25519_SEED`, `FV_DEV_SIMULATOR=false`, `FV_ADMIN_TOKEN`, `FV_PROGRAM_ID`.
The image also carries `docs/seed` (never loaded with the simulator and `FV_SEED_DEMO` off): the startup warning about
leftover seed rows and `POST /api/admin/purge-seed` recognise demo rows by it.

Railway is not connected to GitHub: a push deploys nothing. The verifier is deployed by hand with `railway up` from a
clean checkout of a commit that passed CI, after setting `FV_BUILD_SHA` to that commit
([`docs/deploy.md`](../../docs/deploy.md#deploying)).

### Removing seed data from a deployed database

Older builds seeded every empty database, also in production, and signed those demo scans with the live server key.
`POST /api/admin/purge-seed` (admin token) removes them while keeping everything with real on-chain evidence:

```bash
curl -s -X POST "$H/api/admin/purge-seed" -H "x-admin-token: $FV_ADMIN_TOKEN"                 # dry run: report only
curl -s -X POST "$H/api/admin/purge-seed?dry_run=false" -H "x-admin-token: $FV_ADMIN_TOKEN"   # apply
```

It deletes seed events whose `txSig` does not exist on chain (`getSignatureStatuses` over the full history, batched,
read before the write lock), seed events without a tx (sightings), every seed-signed SCAN payload (recognised by the
seed's deterministic session nonce), the seed's fake attesters/partners (unless they act in a kept event, are registry
partners or take part in an on-chain order — then only the seeded label, partner flag and counters go), the seed's
virtual tags (all of them while the simulator is off), and seed passports/seals left without events and without an
on-chain account. Kept seed passports/seals get grade/void/dead recomputed from what remains plus the chain, and the
on-chain issuer. Without `FV_PROGRAM_ID` or with the RPC down it refuses (503) and deletes nothing.
`replayedOnChain` lists seed signatures somebody already anchored — retire those seals on chain (`mark_seal_dead`).

A kept passport that exists on chain is never left without a MINT event: without one, anybody could replay the
issuer's public `mint_passport` tx through `POST /api/events` and give the passport a new brand and name. When no MINT
of it survives the purge (the seed's fake MINT tx is deleted) — or an older purge build already left it without one —
a MINT is rebuilt from chain (`mintFromChain` in the report): actor = the on-chain issuer, `txSig` = the passport PDA's
creating `mint_passport` signed by that issuer (of the newest 1000 signatures at most 20 checked, oldest first, with
`getTransaction`; none found → empty), brand/name/batch from the passport row, `payload.fromChain`, no seed flag. Independently, a MINT
for an existing passport never replaces its brand, name or batch (`upsert_passport`). Kept rows (their tx exists on
chain) are marked `payload.seedKept`, so the startup warning about leftover seed rows counts only what a purge still has
to handle and is silent after a complete purge.

## Simulator flow (curl)

```bash
H=http://localhost:8787; J='Content-Type: application/json'
curl -s $H/health
curl -s -X POST $H/api/dev/tag -H "$J" -d '{"serial":"SN-2026-000001","kind":1}'      # → {"uid":"04…", …}
curl -s -X POST $H/api/dev/tap -H "$J" -d '{"uid":"04A1B2C3D4E5F6"}'                  # → {"ctr":15,"ctrHex":"00000F","cmac":"…","url":"…"}
curl -s -X POST $H/api/preview -H "$J" -d '{"uid":"04A1B2C3D4E5F6","ctr":"00000F","cmac":"<cmac>"}'
curl -s -X POST $H/api/session -H "$J" -d '{}'                                         # → {"nonce":"0x…"}
curl -s -X POST $H/api/verify -H "$J" -d '{"uid":"04A1B2C3D4E5F6","ctr":"00000F","cmac":"<cmac>","nonce":"<nonce>",
  "role":1,"tier":2,"indicators":{"heat":0,"humidity":0,"uv":3},"heatLevels":[1,1,0,0,0,0],"fill":92,
  "mediaHash":"0x358bd5e49a401b60105ca4fe2f6fd4563c617295f4704debe35da7844cd5b380",
  "location":{"country":"DE","city":"Wickede"},"attester":"7GhXQ2fV4d1eo9yq1vQdD9Zk9sHkYd8qz2pM4hN6FaK2"}'
# same tap again → "verdict":"REPLAY"
curl -s -H 'Accept: application/json' "$H/t?uid=04A1B2C3D4E5F6&ctr=000010&cmac=<cmac>"  # real-tag landing as JSON
curl -s -X POST $H/api/dev/kill -H "$J" -d '{"uid":"04A1B2C3D4E5F6"}'
curl -s -X POST $H/api/dev/tap  -H "$J" -d '{"uid":"04A1B2C3D4E5F6"}'                  # → {"responds":false,"tapId":N,…}
curl -s $H/api/tap/N                                                                    # → "verdict":"NO_RESPONSE", "Seal not responding"
curl -s -X POST $H/api/events -H "$J" -d '{"eventId":36,"txSig":"<record_scan tx>","actor":"<attester>"}'   # confirm a pending scan (verified on chain)
curl -s $H/api/passport/SN-2026-000001
curl -s -X POST $H/api/dev/reset -H "x-admin-token: $FV_ADMIN_TOKEN"
```

Seeded virtual tags: `04A1B2C3D4E5F6` (SN-2026-000001, NECK) · `04DE5F1EACC040` (SN-2026-000002, BOX) ·
`041E3C8A2D6B80` (SN-2026-000003, NECK, killed) · `04FFEEDDCCBBAA` (unregistered).

## Layout

```
fv/main.py        app factory (CORS, lifespan: checks, schema, seed)    fv/routes_api.py  /health /api/session …/attester
fv/config.py      Settings from .env                                     fv/routes_tag.py  /t, /api/tap/<id>
fv/proof.py       message bytes, Ed25519, grade rule, canonical bundle   fv/routes_dev.py  /api/dev/* simulator
fv/sdm.py         SUN CMAC check + generation, AN10922 diversification   fv/service.py     shared tap check (CMAC → counter → seal)
fv/db.py          sqlite3 repository, fv/schema.sql                      fv/views.py       JSON shapes for the web app
fv/enums.py       enums from fv/enums.json (synced from docs/enums.json) fv/strings.py     UI wording (briefing §16)
fv/seed.py        docs/seed/passports.json → DB                          fv/routes_chain.py /api/reconcile /api/registry /api/sites
fv/arweave.py     Irys sidecar wrapper, bundle archiving                    irys/             Node sidecar (upload.mjs, fund.mjs)
fv/chain.py       PDAs (solders), Anchor account decoders, JSON-RPC       fv/reconcile.py   §10 reconcile cycle
fv/txverify.py    getTransaction checks behind POST /api/events          fv/routes_admin.py /api/admin/status, /api/admin/purge-seed
fv/ratelimit.py   per-IP token buckets (FV_RATE_LIMIT_PER_MIN …)          fv/bodylimit.py   request body size limit (ASGI)
config.py         SDMMAC_PARAM for libsdm                                libsdm/           vendored icedevml/sdm-backend (MIT)
                                                                         tests/            pytest suite
```

## Wording (briefing §16)

Server-emitted lines (`fv/strings.py`): "Seal genuine · tap N" · "Seal not responding" · "Repeated tap · counter N" ·
"Seal not confirmed" · "Chip genuine · seal not assigned to any passport · tap N" · "Session expired · please start
again". `fv/strings.py` also carries the indicator lines ("Heat: above 40 °C recorded", "Humidity: above 60 % RH
recorded", "Light: not fitted (Rev D)"); a test asserts the forbidden words never appear.
