# apps/verify — FlaconVault verification server

Python 3.12 · FastAPI · SQLite (WAL) · based on [icedevml/sdm-backend](https://github.com/icedevml/sdm-backend) (`libsdm/`, MIT).

The server is the only place that can check the chip (NTAG 424 DNA SUN CMAC, AN12196), keeps the
counter and nonce state, signs every VALID scan with Ed25519 (briefing §4.3) and indexes the passport
timeline (§10). Until hardware arrives, a simulator (`/api/dev/*`) produces genuine SUN URLs.

## Run

```bash
cd apps/verify
cp .env.example .env            # then set FV_SERVER_ED25519_SEED (python -c "import os;print(os.urandom(32).hex())")
uv sync                         # creates .venv (Python 3.12) and installs everything, incl. dev deps
uv run uvicorn fv.main:app --port 8787 --reload
```

* On first start the DB (`FV_DB_PATH`, default `./data/flaconvault.db`) is created and — when empty —
  seeded from `docs/seed/passports.json` (3 passports, 35 events, 4 virtual tags).
* `uv run python -m fv.seed` wipes and re-seeds; `POST /api/dev/reset` does the same at runtime.
* `uv run pytest -q` — all tests (fixtures: `docs/vectors.json`, `docs/enums.json`).
* `uv run python scripts/sync_enums.py` — copy `docs/enums.json` → `fv/enums.json` after `npm run vectors`.

## Configuration (`.env`, all `FV_*`)

| Key | Default | Meaning |
|---|---|---|
| `FV_MASTER_KEY` | `00…00` (16 B hex) | Master key; factory mode ignores it |
| `FV_KEY_MODE` | `factory` | `factory` = all-zero key · `diversified` = AN10922 `CMAC(K, 0x01‖UID‖APP_ID‖SYS_ID)` |
| `FV_SERVER_ED25519_SEED` | — (required) | 32 B hex seed of the signing key |
| `FV_SERVER_KEY_ID` | `1` | `key_id` in bundles / on-chain registry |
| `FV_DEV_SIMULATOR` | `true` | enables `/api/dev/*` (404 otherwise) |
| `FV_NONCE_TTL_S` | `90` | nonce lifetime |
| `FV_DB_PATH` | `./data/flaconvault.db` | SQLite file (relative to `apps/verify`) |
| `FV_WEB_URL` | `http://localhost:3000` | `/t` redirects to `${FV_WEB_URL}/t?tap=<id>` |
| `FV_VERIFIER_HOST` | `http://localhost:8787` | host baked into simulator tag URLs |
| `FV_CORS_ORIGINS` | `http://localhost:3000` | comma-separated allow-list |
| `FV_SOLANA_RPC` | `https://api.devnet.solana.com` | JSON-RPC used by the reconcile job and `/api/registry` (local validator: `http://127.0.0.1:8899`) |
| `FV_PROGRAM_ID` | — | `flacon` program id; empty = reconcile disabled, `/api/sites` falls back to the seed sites |
| `FV_RECONCILE_INTERVAL_S` | `60` | seconds between reconcile cycles; `0` = manual `POST /api/reconcile` only |
| `FV_RECONCILE_TIMEOUT_S` | `600` | a SCAN(pending) without ScanProof PDA after this long → `failed` |
| `FV_IRYS_KEY` | | week 2 (Arweave) |

Comments must be on their own lines (python-dotenv treats an inline `# …` after an empty value as the value).

## Endpoints

Verdicts are data, not errors: every verdict is HTTP 200; 4xx only for malformed input.
Hashes in responses are `0x` + lowercase hex (32 bytes); in the DB they are stored without `0x`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | `{ok, keyId, pubkeyHex, simulator, programId}` |
| GET | `/t?uid&ctr&cmac` | Real tag landing. Checks CMAC + counter (**consumes**: advances `seals.last_counter`), logs a Tier-0 SCAN event when VALID and a `taps` row for every hit. `Accept: application/json` or `&format=json` → tap JSON; otherwise `302 → ${FV_WEB_URL}/t?tap=<tapId>` |
| GET | `/api/tap/<tapId>` | Stored tap `{tapId, ts, verdict, counter, uid, serial, serialHash, uidHash, sealKind, sealDead, message}` — the web `/t` page reads this, no second validation |
| POST | `/api/session` | `{}` → `{nonce: "0x…", issuedAt, expiresAt, ttl}` (32 random bytes, single use) |
| POST | `/api/preview` | `{uid, ctr, cmac}` → non-consuming check `{verdict, counter, serial, serialHash, uidHash, sealKind, sealDead, message}` |
| POST | `/api/verify` | Scan flow step 7 — see below |
| POST | `/api/media` | multipart `file` (or `files`) → `{sha256: "0x…", ar: null, bytes, files}`; stored at `data/media/<sha256>.bin`. Several files are hashed as one concatenation in upload order |
| POST | `/api/events` | `{eventId, txSig}` confirms a pending event · `{serial, type, txSig?, sealUidHash?, actor?, actorLabel?, payload?, location?, ts?}` inserts one (`confirmed` if `txSig`, else `pending`). Side effects: `MINT` creates/updates the passport (`payload.brand`, `payload.name` required for a new serial; `batch`, `asset`, `issuerLabel`, `siteId` optional; `issuer` = `actor`), `SEAL_ATTACH` upserts the seal (`payload.uid` 7-byte hex, `payload.kind` default 1), `SEAL_DEAD` marks the seal dead and voids the passport. MINT and SEAL_ATTACH are idempotent: a second call for the same serial / uid updates `txSig`/`status`/payload of the first event instead of adding a row |
| GET | `/api/passport/<serial>` | Passport + timeline (shape below), 404 if unknown |
| GET | `/api/passports` | `[{serial, brand, name, grade, void, scanCount, lastEventTs}]` |
| POST | `/api/reconcile` | Run one reconcile cycle now (§10) → `{checked, confirmed, failed, pending, mismatched, refreshed:{passports, seals}, enabled}` |
| GET | `/api/registry` | Registry PDA `{programId, authority, partners:[base58], serverKeys:[{keyId, pubkeyHex, validFrom, validTo}], sites:[{siteId, label}], source:"chain"\|"fallback"}` — fallback (no program id / RPC down / PDA missing): `authority null`, `serverKeys []`, `partners` = partner attesters from the DB, seed sites |
| GET | `/api/sites` | `[{siteId, label}]` for the certification console (registry sites, else the two seed sites) |
| GET | `/api/attester/<pubkey>` | `{pubkey, label, isPartner, firstSeen, scanCount, certifiedCount, agreeCount, compareCount, agreeRate, escrowsOk, escrowsDisputed, recentSerials}` |
| POST | `/api/dev/tag` | `{uid?, serial?, kind?}` → virtual tag (random `04…` UID if omitted); with `serial` also attaches the seal |
| POST | `/api/dev/tap` | `{uid}` → `{responds: true, uid, ctr, ctrHex, cmac, url}` or, if killed, `{responds: false, uid, tapId, url}` (a `NO_RESPONSE` tap row) |
| POST | `/api/dev/kill` · `/api/dev/revive` | tag stops / resumes responding (does **not** touch `seals.dead` — that happens on-chain via `mark_seal_dead`) |
| GET | `/api/dev/tags` | virtual tags with their last URLs |
| POST | `/api/dev/reset` | wipe DB and re-seed |

### `POST /api/verify`

Request:

```json
{ "uid": "04A1B2C3D4E5F6", "ctr": "00000E", "cmac": "6F3A0B1C2D3E4F50", "nonce": "0x…",
  "role": 1, "tier": 2, "indicators": { "heat": 0, "humidity": 0, "uv": 3 }, "heatLevels": [1,1,0,0,0,0],
  "fill": 92, "mediaHash": "0x…", "serial": "SN-2026-000001", "location": { "country": "DE", "city": "Wickede" },
  "attester": "<base58 pubkey>", "platform": "ANDROID_WEB" }
```

`ctr` may be the 3-byte hex from the URL or an int. `indicators.uv` is forced to 3 (MISSING). `indicators.heat`
must equal `heatLevels[4]` when it is 0/1 (2 UNREADABLE / 3 MISSING are trusted as sent). `mediaHash` is
required for tier ≥ 2 and ignored (zero hash) below. Optional: `tamper` (default 3), `note`.

Order of checks (briefing §5): nonce → key by mode → CMAC (`INVALID`) → `ctr > last_counter` (`REPLAY`, then
advance) → seal lookup (`UNREGISTERED`; dead seal → `NO_RESPONSE`) → build message, sign, consume nonce, insert
`events` SCAN `pending` with the full bundle, update attesters. **Signed only when VALID**; otherwise
`serverSig`, `msgHex`, `bundle`, `bundleHash`, `eventId` are `null`. The nonce is consumed only on VALID.
A `serial` that does not match the tag's passport → 409.

Response:

```json
{ "verdict": "VALID", "counter": 14, "serial": "SN-2026-000001", "serialHash": "0x…", "uidHash": "0x…",
  "sealKind": 1, "sealDead": false, "heatMask": 3, "grade": 0, "reviewRecommended": false,
  "serverSig": "0x…(64 bytes)", "serverPubkey": "<hex 32 bytes>", "keyId": 1, "ts": 1790000012, "msgHex": "<152 bytes>",
  "bundle": { …§4.4 with server.sig filled… }, "bundleHash": "0x…", "eventId": 36, "message": "Siegel echt · Tap 14" }
```

`msgHex` is the exact 152-byte message for `Ed25519Program.createInstructionWithPublicKey`; `eventId` goes back
to `POST /api/events` with the `txSig` after confirmation.

### Passport response

```json
{ "serial": "SN-2026-000001", "serialHash": "0x…", "brand": "Roja Parfums", "name": "Haute Luxe", "batch": "4A12",
  "asset": "<pubkey|null>", "issuer": "<pubkey|null>", "issuerLabel": "Parfümerie X, Düsseldorf",
  "grade": 0, "void": false, "createdAt": 1789459200,
  "seals": [ { "uidHash": "0x…", "kind": 1, "lastCounter": 14, "dead": false, "attachedAt": 1789459500 } ],
  "sealStatus": "INTACT | NO_RESPONSE | OPENED",
  "stats": { "scanCount": 14, "attesterCount": 3, "certifiedCount": 1, "counter": 14 },
  "latest": { "tamper": 3, "indicators": {"heat":0,"humidity":0,"uv":3}, "heatLevels": [1,1,0,0,0,0], "fill": 92,
              "counter": 14, "ts": 1790161500, "reviewRecommended": false, "eventId": 18, "attester": "<pubkey|null>" } ,
  "events": [ { "id": 1, "type": 0, "ts": 1789459200, "actor": "<pubkey|null>", "actorLabel": "…", "txSig": "…|null",
                "status": "confirmed", "sealUidHash": null, "payload": { … }, "arBundle": null, "arMedia": null,
                "gradeAfter": 0, "location": { "country": "DE", "city": "Düsseldorf" } } ] }
```

## Reconcile job (briefing §10)

Runs in the FastAPI lifespan every `FV_RECONCILE_INTERVAL_S` (first cycle 5 s after start) when `FV_PROGRAM_ID` is
set, and on `POST /api/reconcile`. For every `events` row `type=SCAN, status=pending` with a `seal_uid_hash` and a
`counter` in its payload it derives `ScanProof ["scan", seal_pda, counter u32le]` (solders) and reads it via
`getMultipleAccounts`:

* account exists → `status=confirmed`; `tx_sig` filled from `getSignaturesForAddress` when it was missing (an
  existing one is left alone); `counter, tamper, uv, hum, heat, fill, media_hash, bundle_hash` (+ `heatLevels`,
  `attester`) are compared with the stored bundle and any difference is recorded in
  `payload.reconcile = {checkedAt, scanPda, mismatch: [...]}`;
* account missing and the event is older than `FV_RECONCILE_TIMEOUT_S` → `status=failed`
  (`payload.reconcile.reason`); otherwise it stays pending.

Then every Passport/Seal PDA that exists refreshes `passports.grade/void` and `seals.last_counter/dead` — chain
wins, but only for passports with nothing pending (so a freshly signed scan does not flicker) and only once the
chain has recorded a scan or a void (a freshly minted PDA carries just the mint default); a counter is never
lowered (replay safety) and a raised seal counter pulls the simulator tag along. One log line per change
(`fv.reconcile`).

`events` are sorted by `ts` ascending. SCAN payloads of tier ≥ 1 are the full §4.4 bundle plus `grade`,
`reviewRecommended`, `msgHex`, `bundleHash`; Tier-0 sightings carry `{tier: 0, verdict, counter, tapId}`.
`scanCount` counts SCAN events of all tiers; `certifiedCount` those with tier ≥ 3.

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
curl -s $H/api/tap/N                                                                    # → "verdict":"NO_RESPONSE", "Siegel antwortet nicht"
curl -s -X POST $H/api/events -H "$J" -d '{"eventId":36,"txSig":"<88 char base58>"}'   # confirm a pending scan
curl -s $H/api/passport/SN-2026-000001
curl -s -X POST $H/api/dev/reset
```

Seeded virtual tags: `04A1B2C3D4E5F6` (SN-2026-000001, NECK) · `04DE5F1EACC040` (SN-2026-000002, BOX) ·
`041E3C8A2D6B80` (SN-2026-000003, NECK, killed) · `04FFEEDDCCBBAA` (unregistered).

## Layout

```
fv/main.py        app factory (CORS, lifespan: schema + auto-seed)      fv/routes_api.py  /health /api/session …/attester
fv/config.py      Settings from .env                                     fv/routes_tag.py  /t, /api/tap/<id>
fv/proof.py       message bytes, Ed25519, grade rule, canonical bundle   fv/routes_dev.py  /api/dev/* simulator
fv/sdm.py         SUN CMAC check + generation, AN10922 diversification   fv/service.py     shared tap check (CMAC → counter → seal)
fv/db.py          sqlite3 repository, fv/schema.sql                      fv/views.py       JSON shapes for the web app
fv/enums.py       enums from fv/enums.json (synced from docs/enums.json) fv/strings.py     UI wording (briefing §16)
fv/seed.py        docs/seed/passports.json → DB                          fv/routes_chain.py /api/reconcile /api/registry /api/sites
fv/chain.py       PDAs (solders), Anchor account decoders, JSON-RPC       fv/reconcile.py   §10 reconcile cycle
config.py         SDMMAC_PARAM for libsdm                                libsdm/           vendored icedevml/sdm-backend (MIT)
                                                                         tests/            pytest suite
```

## Wording (briefing §16)

Server-emitted lines: „Siegel echt · Tap N" · „Siegel antwortet nicht" · „Tap bereits verwendet · Zähler N" ·
„Siegel nicht bestätigt" · „Chip echt · Siegel nicht registriert · Tap N" · „Sitzung abgelaufen · bitte neu starten".
`fv/strings.py` also carries the indicator lines („Hitze: über 40 °C erfasst", „Feuchte: über 60 % rF erfasst",
„Licht: nicht bestückt (Rev D)"); a test asserts the forbidden words never appear.
