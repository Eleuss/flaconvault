# FlaconVault

**Aus erster Hand versiegelt. Auf dem Zweitmarkt lesbar.**

A seal for collectible perfume bottles: an NXP NTAG 424 DNA chip proves on every tap that it is the genuine chip and which tap it is; an insert card carries irreversible heat and humidity indicators read by the phone camera; every scan is signed by the verification server and anchored on Solana as a **ScanProof**, building a **Passport** with a gapless history — birth, sealing, every scan, every change of hands.

Colosseum Crypto World's Fair hackathon build. Solana **Devnet** only. Briefing: [`docs/Dev-Briefing_v2.md`](docs/Dev-Briefing_v2.md).

## Architecture

```
 NTAG 424 DNA ──tap (SUN-URL)──▶ apps/verify (FastAPI, SQLite) ──Ed25519 sig──▶ programs/flacon (Anchor, Devnet)
                                  CMAC · counter · nonce · sign                    Registry · Passport · Seal · ScanProof
                                          │ JSON                                          ▲ tx
                                  apps/web (Next.js PWA) ─────────────────────────────────┘
                                  /t · /p/[serial] · /scan · /certify · /dev
```

One truth, three parts: **the server is the only place that can check the chip** (AES-CMAC per AN12196). **The program accepts only what the server signed** (Ed25519 instruction introspection). **The web app shows both as one history.**

## Repo

| Path | What |
|---|---|
| `packages/proof` | TypeScript source of truth: enums, 152-byte signature message (§4.3), ScanProof bundle schema (§4.4), grade rule (§4.5). `npm run vectors` writes `docs/vectors.json` + `docs/enums.json`, which server and program tests consume. |
| `apps/verify` | Python 3.12 / FastAPI / SQLite verification server, simulator for virtual tags, indexer for the passport timeline. Based on `icedevml/sdm-backend`. |
| `programs/flacon` | Anchor program: `Registry`, `Passport`, `Seal`, `ScanProof`; `record_scan` verifies the server signature via the Ed25519 precompile. |
| `apps/web` | Next.js 14 App Router PWA: landing, public passport, tag landing, scan flow, certification console, simulator console. |
| `docs/` | Briefing, card layout Rev C (`card/`), `layout.py`, `heat_fields.json`, shared vectors, devnet addresses. |
| `scripts/` | Devnet seed (`seed-devnet`, `seed-passports`, `seed-escrow`), `add-partner`, `fund-dev-wallet`, `list-order`, `tunnel.sh`. |

## Run it

```bash
# 1. packages (once, and after changes): proof + vision, shared vectors
npm install && npm run proof:build && npm run vectors && npm run build -w @flaconvault/vision

# 2. verification server — http://localhost:8787
cd apps/verify && uv sync && uv run uvicorn fv.main:app --port 8787 --reload

# 3. web app — http://localhost:3000  (copies OpenCV.js + heat_fields.json into public/ first)
npm run web:dev
```

Then open `/dev`, create a virtual tag for `SN-2026-000001`, hit **Tap**, open it in `/t`, follow to `/p/SN-2026-000001`.

### Chain: local validator (no faucet needed)

```bash
anchor localnet --validator legacy                       # builds + deploys programs/flacon, 500 SOL for ~/.config/solana/id.json
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 npx tsx scripts/seed-devnet.ts --server-pubkey-from-env   # registry, server key, partner, sites
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 npx tsx scripts/seed-passports.ts                          # the three seed passports + seals
```

Set `NEXT_PUBLIC_SOLANA_RPC=http://127.0.0.1:8899` in `apps/web/.env.local` and `FV_SOLANA_RPC` in `apps/verify/.env`. The scan flow then runs end-to-end with the simulator: `/scan` → virtual tap → signature → transaction (burner wallet, airdrop button) → `/p/[serial]`.

### Chain: devnet

Same scripts without `ANCHOR_PROVIDER_URL`, after `anchor deploy --provider.cluster devnet` — needs devnet SOL in `~/.config/solana/id.json` (see `docs/devnet.md`).

### Tests

```bash
npm run proof:test                          # 9   byte layout, grade rule, bundle hash, ed25519
npm run test -w @flaconvault/vision         # 7   synthetic card: 10/10 under tilt, light, blur, noise
cd apps/verify && uv run pytest -q          # 36  SDM vectors, msg/sig/bundle identical to vectors.json, simulator flow, reconcile
anchor test --validator legacy              # 15  record_scan with/without Ed25519 ix, replay, tier gating, dead seal, grade table
cargo test -p flacon                        # 9   message reconstruction, grade constants
```

## Decisions that are fixed (briefing §1)

One chip (NTAG 424 DNA standard, no TagTamper) · mechanical tamper: a torn antenna is a dead chip, on-chain `tamper = 3 UNKNOWN` · pass hangs on the bottle serial, not the chip · heat threshold 40 °C, humidity 60 % rF, UV not fitted · no GPS on-chain · Devnet, Anchor, Metaplex Core, Arweave via Irys · reputation is read-only.

## Wording (briefing §16)

The seal is a **handling and provenance record, not a damage record**. Say "Siegel echt · Tap 14", "Hitze: über 40 °C erfasst". Never "beschädigt", "NFT", "fälschungssicher durch Blockchain".

## Status (2026-09-24)

| Briefing § | State |
|---|---|
| 4 data contracts, `packages/proof`, vectors | done — DoD |
| 5 verification server + simulator | done — DoD (36 tests) |
| 6 Anchor program | done — DoD: deployed on devnet (`7dCr825ibTyE6Y5oPHP2RCmUi5qFPCaKdZmE9TYeAcWL`), registry + passports seeded, first live scan anchored |
| 7 web screens `/`, `/p`, `/t`, `/dev`, `/certify`, `/wallet`, `/market` | done |
| 8 scan flow | done — DoD (simulator): verified on localnet and devnet; camera/WebNFC path needs the Android device |
| 9 camera indicator reading | done (`packages/vision`, `/dev/vision`); calibrate `docs/heat_fields.json` on delivery day |
| 10 passport timeline + reconcile | done — DoD (reconcile every 60 s, `POST /api/reconcile`) |
| 11 escrow + `/market` + Blink, 12 reputation view | done — DoD: escrow deployed on devnet, scene 6 played end-to-end (see `docs/devnet.md`); Blink at `/api/actions/verify-buy` |

Devnet addresses: [`docs/devnet.md`](docs/devnet.md). Delivery-day runbook: [`docs/hardware-day.md`](docs/hardware-day.md).
