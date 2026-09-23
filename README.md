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
| `scripts/` | Devnet seed, tag personalisation. |

## Run it

```bash
# 1. proof package (once, and after changes)
npm install && npm run proof:build && npm run vectors

# 2. verification server — http://localhost:8787
cd apps/verify && uv sync && uv run uvicorn fv.main:app --port 8787 --reload

# 3. web app — http://localhost:3000
npm run web:dev
```

Then open `/dev`, create a virtual tag for `SN-2026-000001`, hit **Tap**, open it in `/t`, follow to `/p/SN-2026-000001`.

## Decisions that are fixed (briefing §1)

One chip (NTAG 424 DNA standard, no TagTamper) · mechanical tamper: a torn antenna is a dead chip, on-chain `tamper = 3 UNKNOWN` · pass hangs on the bottle serial, not the chip · heat threshold 40 °C, humidity 60 % rF, UV not fitted · no GPS on-chain · Devnet, Anchor, Metaplex Core, Arweave via Irys · reputation is read-only.

## Wording (briefing §16)

The seal is a **handling and provenance record, not a damage record**. Say "Siegel echt · Tap 14", "Hitze: über 40 °C erfasst". Never "beschädigt", "NFT", "fälschungssicher durch Blockchain".

## Status

See commits with `— DoD` for finished sections. Devnet addresses: [`docs/devnet.md`](docs/devnet.md).
