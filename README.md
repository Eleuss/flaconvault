# FlaconVault

**Sealed at first hand. Readable on the secondary market.**

A seal and condition passport for collectible perfume (150–3,000 € per bottle). An NXP **NTAG 424 DNA** sticker over the bottle neck proves on every tap that it is the genuine chip and which tap number this is. An insert card in a 3D-printed holder carries **irreversible heat (40 °C), humidity (60 % RH) and UV indicators**, read by the phone camera. Every scan is signed by the verification server and anchored on **Solana** as a ScanProof, building a public **passport** with an unbroken history: birth, sealing, every scan, every change of hands. A **USDC escrow** releases payment only when the seller's pre-ship scan and the buyer's receipt scan agree.

Colosseum Crypto World's Fair hackathon build · Solana **devnet** · tested with real stickers on real phones.

## Try it

| | |
|---|---|
| App | **https://app.flaconvault.com** |
| A real bottle (Tom Ford · Rose d'Amalfi, real sticker) | https://app.flaconvault.com/p/SN-2026-000007 |
| Escrow run on devnet (list → reserve → pre-ship scan → ship → receipt scan → release) | [release transaction](https://explorer.solana.com/tx/2oEXVqFVJ6kg6ubCrLFVGFzGV6QB67WMPVzhij99aT8RBsVoWbw1UfkcvxzP83gcrU4xx4iXpHAwwcw18sJFBLhv?cluster=devnet) · details in [`docs/devnet.md`](docs/devnet.md#history-on-devnet) |
| Market (escrow) | https://app.flaconvault.com/market |
| Verifier health | https://verify.flaconvault.com/health |
| Programs on devnet | flacon [`7dCr825i…eAcWL`](https://explorer.solana.com/address/7dCr825ibTyE6Y5oPHP2RCmUi5qFPCaKdZmE9TYeAcWL?cluster=devnet) · escrow [`9vabBySt…ScexKL`](https://explorer.solana.com/address/9vabByStbAqKH6sM6fuf8HhfGZbV3993Ncp3uZScexKL?cluster=devnet) |

A buyer needs no app and no wallet: tapping the sticker with an iPhone opens the result page ("Seal genuine · tap N") and the passport. On every passport, **"Check live on-chain"** reads the Passport account straight from Solana in the browser and compares its grade and scan counter with what the server shows.

## How it works

```
 NTAG 424 DNA ──tap (encrypted SUN URL)──▶ verifier (FastAPI)  ──Ed25519 signature──▶ programs/flacon (Anchor)
                                          CMAC · counter · nonce                       Registry · Passport · Seal · ScanProof
 card in holder ──5 camera frames──▶ packages/vision (OpenCV, in-browser)                       ▲
                                          │                                                     │ tx (wallet)
                                    apps/web (Next.js) ─────────────────────────────────────────┘
                                    /t · /scan · /p/[serial] · /certify · /market     programs/escrow (USDC) · Metaplex Core · Arweave
```

- **The chip proves authenticity of the seal.** AES-CMAC over UID and a counter that only goes up (NXP AN12196, encrypted SUN). Only the server holds the key; replays of an old tap URL are rejected.
- **The program accepts only what the server signed.** `record_scan` checks the server's Ed25519 signature via instruction introspection and rebuilds the 152-byte message from on-chain accounts; one ScanProof per (seal, counter).
- **The card shows the handling.** The camera finds the card in its holder, rectifies it, white-balances against the card itself and reads each indicator by colour distance. Only the 40 °C field decides; the others are context.
- **The escrow ties money to evidence.** List → reserve (USDC into a program-owned vault) → pre-ship scan → ship → receipt scan → release, with dispute and timeout paths.

## Tested on real hardware

- **iPhone** reads the stickers every time through background NFC and opens the result page in Safari. The scan continues from that tap (one tap, no second read) via a single-use token.
- **Android:** a Google Pixel 6 rejects this sticker batch at the NDEF level (TagInfo reads the full SUN URL, Android's NDEF detection does not), so WebNFC returns an empty record. The WebNFC path is implemented for compatible tags; re-programming the batch with factory configuration is on the list.
- **Wallets on iPhone:** Safari has no injected wallet, so signing works through **WalletConnect** or by continuing in the Phantom/Solflare in-app browser (a resume link reopens the scan at the signing step there). Android uses the Mobile Wallet Adapter (Solflare).
- **The physical card** has no printed marker. "Frame mode" uses the holder's window and the blue heat label as anchors and corrects the parallax of the recessed card. Verified on daylight, room light and oblique photos.

## Security model (honest)

- The server proves that the genuine chip was tapped, once: within a 90-second scan session, or, on the one-tap iPhone path, at most 180 seconds before the scan adopts that tap. It does not prove what is inside the bottle, and a genuine sticker moved to another bottle is not detected by the chip alone.
- Indicator and fill readings are currently reported by the scanning phone and signed as sent. Binding them to the server or a partner, and binding attester/tier into the signed message, are the next protocol steps.
- The verifier only accepts history entries that are backed by a verified on-chain transaction signed by the actor, and it takes the facts (price, seal kind, counters, match, attester, tier, role) from the decoded instruction and the program's accounts and events, never from the client. A minted passport is never renamed. Unverified seal reports are shown as "reported · unverified" (one per seal and day) and never void a passport. The simulator is off in production, and the verifier refuses to start with forgeable key settings.
- A pending signed scan is never published (no message, signature or nonce in public views); the wallet-app resume link carries only an event id and a token that works only while the scan is pending (it stops working once the scan is anchored or fails). Certified tiers and the vault/partner roles are signed only for wallets in the on-chain partner registry.
- Grades only get worse on the server: a heat-triggered C or an opened (VOID) passport stays so. The programs in this repository enforce the same on chain; on the current devnet deployment a later scan can still overwrite a C or VOID grade until it is upgraded (next point).
- The programs in this repository add sticky C and VOID grades, server-key revocation with a freshness window (10 minutes against the cluster clock), partner removal, issuer-only seal administration, owner-only escrow listing, a price-bound reserve, a buyer refund when the seller does not ship, a seller payout when the buyer never scans, and an admin `resolve` for disagreeing scans. The devnet deployment is upgraded to them separately (operator step, see [`programs/README.md`](programs/README.md)).
- Before mainnet: a multisig for upgrade, registry and escrow authority, binding attester/tier into the signed message, indicator readings that do not rely on the scanning phone, and an external audit.

## Repo

| Path | What |
|---|---|
| `packages/proof` | TypeScript source of truth: enums, the 152-byte signed message, ScanProof bundle schema, grade rule. `npm run vectors` writes `docs/vectors.json`, which the Python and Rust tests consume. |
| `packages/vision` | OpenCV.js card reader (marker mode and frame mode for the physical holder), runs in a Web Worker. `scripts/calibrate.ts` reads photos and draws the regions. |
| `apps/verify` | Python 3.12 / FastAPI / SQLite verifier: SUN/CMAC (from `icedevml/sdm-backend`), sessions, signatures, on-chain transaction verification for history entries, reconcile job, optional Arweave archiving via Irys (`FV_ARWEAVE`). |
| `programs/flacon` | Anchor program: `Registry`, `Passport`, `Seal`, `ScanProof`; Ed25519 verification in `record_scan`. |
| `programs/escrow` | Anchor program: USDC escrow that compares seller and buyer ScanProofs. |
| `apps/web` | Next.js 14: landing, tap result, scan flow, public passport, certification console, market. |
| `docs/` | Briefing, card layout, `heat_fields.json` (card geometry, change the file, not the code), shared fixtures `vectors.json` and `enums.json`, devnet addresses, hardware runbook, deploy runbook, demo script. |
| `scripts/` | Devnet seeding, `partner` / `server-key` registry admin, `bind-chip`, `fund-dev-wallet`, `list-order`. |
| `.github/` | CI (GitHub Actions: every test suite below except `anchor test`, which runs on manual dispatch; the verifier Docker image; the IDL drift check when the programs change) and Dependabot. |

## Run it locally

Needs Node 22.18 or newer (24 recommended) and [uv](https://docs.astral.sh/uv/) (it provides Python 3.12 if your system has none). The programs additionally need Rust (pinned in `rust-toolchain.toml`), the Solana CLI 4.1 and Anchor 1.2.

```bash
# 1. install the npm workspaces and build packages/proof, then packages/vision (the root `prepare` script runs
#    `npm run build:packages`; with --ignore-scripts run `npm run build:packages` yourself)
npm ci

# 2. verification server on http://localhost:8787, local development config:
#    simulator on, factory keys, and a throwaway signing seed that exists only on your machine
cd apps/verify
uv sync
cp .env.example .env
echo "FV_SERVER_ED25519_SEED=$(uv run python -c 'import secrets; print(secrets.token_hex(32))')" >> .env
uv run uvicorn fv.main:app --port 8787 --reload

# 3. web app on http://localhost:3000 (second terminal, repo root); the flag turns on the simulator UI and demo tools
echo "NEXT_PUBLIC_DEV_SIMULATOR=true" >> apps/web/.env.local
npm run web:dev
```

On first start the verifier fills its empty local database with the sample passports from `docs/seed/passports.json` (local sample data, not on-chain history). Open http://localhost:3000/dev, create a virtual tag for `SN-2026-000001`, tap it, open the tap in `/t` and follow it to `/p/SN-2026-000001`. Anchoring scans on chain needs a program id and a registered server key (`FV_PROGRAM_ID`, `NEXT_PUBLIC_PROGRAM_ID`): see [`docs/devnet.md`](docs/devnet.md) for a local validator. Hosting: [`docs/deploy.md`](docs/deploy.md).

### Tests

```bash
npm run proof:test                          # byte layout, grade rule, bundle hash, ed25519, parity with docs/vectors.json + docs/enums.json
npm run vectors:check                       # the committed docs/vectors.json and docs/enums.json equal the generator output
npm run vision:test                         # card reading under tilt, light, blur, noise
npm run web:typecheck && npm run web:lint && npm run web:test && npm run web:build
cd apps/verify && uv run pytest -q          # SUN vectors, signatures, tap adoption, authenticated events, limits, reconcile
cargo test -p flacon && cargo test -p escrow   # message reconstruction, grade rule, escrow state rules
npm run mocha:unit                          # web escrow action matrix and price parser, ops-script argument checks (no validator)
anchor test --validator legacy              # record_scan with/without Ed25519 ix, replay, tier gating, dead seal, escrow flows
anchor build && bash .github/scripts/idl-check.sh   # the committed IDLs in packages/proof/src/idl equal the build output
bash .github/scripts/docker-smoke.sh        # needs Docker: build Dockerfile.verify, start it with a throwaway config, check /health
bash .github/scripts/hygiene.sh             # no tracked env files, keys, local tool config, absolute home paths or machine PATH lines
```

CI (`.github/workflows/ci.yml`) runs all of these on every push to `main` and every pull request, except `anchor test`, which needs a local validator and runs on manual dispatch, and the IDL check, which `.github/workflows/programs.yml` runs whenever the programs, the committed IDLs or the toolchain pins change.

## Wording

The seal is a **handling and provenance record, not a damage record**. Say "Seal genuine · tap 14" and "Heat: above 40 °C recorded". Never "damaged", "NFT", or "tamper-proof through blockchain". A grade describes the recorded handling, not the condition of the contents.

## Status (2026-10-16)

| Area | State |
|---|---|
| Data contracts, shared vectors (TS · Python · Rust) | done |
| Verifier: encrypted SUN, replay, nonce, signatures, authenticated history | done, live at verify.flaconvault.com |
| Anchor programs flacon + escrow | done, deployed on devnet |
| Web: tap result, scan flow, passport, certification, market, Blink | done, live at app.flaconvault.com |
| Real stickers (NTAG 424 DNA, encrypted SUN) | done on iPhone; this batch is not readable on the tested Android phone |
| Camera indicator reading of the physical card | done (frame mode); humidity colour to be confirmed against the indicator datasheet |
| Escrow seller protection, key revocation, partner removal (programs in this repo) | done; devnet upgrade pending |
| Attester binding in the signed message, multisig authorities | next |

More: what is stored where: https://app.flaconvault.com/privacy (`apps/web/src/app/privacy/page.tsx`) · devnet addresses [`docs/devnet.md`](docs/devnet.md) · hardware runbook [`docs/hardware-day.md`](docs/hardware-day.md) · hosting [`docs/deploy.md`](docs/deploy.md) · demo video script [`docs/demo-script.md`](docs/demo-script.md) · original briefing (German) [`docs/Dev-Briefing_v2.md`](docs/Dev-Briefing_v2.md).
