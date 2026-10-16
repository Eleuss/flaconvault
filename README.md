# FlaconVault

**Sealed at first hand. Readable on the secondary market.**

FlaconVault is an NFC seal and a public passport on Solana for collectible perfume. One phone tap checks the seal, the passport shows how the bottle has been handled, and a USDC escrow pays the seller when the scans before shipping and after receipt agree.

**The problem.** Rare, vintage and niche perfume is resold on photos and the seller's word. A buyer cannot check whether the seal is the original one, or whether the bottle spent hours in a hot delivery van.

- **Seal:** an NXP NTAG 424 DNA sticker over the bottle neck. Every tap returns a fresh checksum and a counter that only goes up. Only the verification server can check them, so a copied tap link is rejected, and a torn sticker stops answering.
- **Card:** an insert card in a small 3D-printed holder with indicators for heat (the 40 °C field turns dark for good), humidity (60 % RH) and UV, read by the phone camera.
- **Passport:** the server signs every witnessed scan, and the scanner's wallet anchors it on Solana as its own ScanProof account. The passport lists the bottle's registration, its sealing, every anchored scan and every sale through the escrow.
- **Escrow:** USDC waits in a program-owned vault until the seller's pre-ship scan and the buyer's receipt scan agree. Deadlines and an admin decision settle the cases where they do not.

**Why Solana.** The record has to outlive any one shop, platform or server, and the payment has to follow the evidence. The program accepts only scans the server signed and keeps one ScanProof per tap, anyone can read a passport straight from the chain without going through our server, and the escrow settles in USDC against those same accounts.

The chip verifies the seal, not what is inside the bottle, and a grade describes the recorded handling, not the condition of the contents: see [What a passport claims](#what-a-passport-claims) and [Security model and known limits](#security-model-and-known-limits).

Built for the Colosseum Crypto World's Fair hackathon · Solana **devnet** (test network, test USDC) · tested with real stickers on an iPhone.

## Try it

No sticker needed: open the real bottle, press **Check live on-chain**, then open the escrow release transaction.

| | |
|---|---|
| A sealed bottle (Tom Ford · Rose d'Amalfi, real sticker) | https://app.flaconvault.com/p/SN-2026-000007 |
| A complete escrow sale on devnet (2026-09-24, two browser dev wallets, simulated taps) | [release transaction](https://explorer.solana.com/tx/2oEXVqFVJ6kg6ubCrLFVGFzGV6QB67WMPVzhij99aT8RBsVoWbw1UfkcvxzP83gcrU4xx4iXpHAwwcw18sJFBLhv?cluster=devnet) · every step in [`docs/devnet.md`](docs/devnet.md#history-on-devnet) |
| App | **https://app.flaconvault.com** |
| Market (escrow) | https://app.flaconvault.com/market |
| Programs on devnet | flacon [`7dCr825i…eAcWL`](https://explorer.solana.com/address/7dCr825ibTyE6Y5oPHP2RCmUi5qFPCaKdZmE9TYeAcWL?cluster=devnet) · escrow [`9vabBySt…ScexKL`](https://explorer.solana.com/address/9vabByStbAqKH6sM6fuf8HhfGZbV3993Ncp3uZScexKL?cluster=devnet) |
| Verifier health | https://verify.flaconvault.com/health |

A buyer needs no app and no wallet: tapping the sticker with an iPhone opens the result page ("Seal genuine · Tap N") with a link to the passport. On every passport, **Check live on-chain** reads the Passport account straight from Solana in the browser and compares its grade and its number of anchored scans with what our server shows. Taps made without a wallet appear in the history as sightings; they are not anchored and not part of that count.

## How it works

One scan, end to end: the verifier checks the tap, the browser reads the card, the verifier signs the scan, and the scanner's wallet sends it to the flacon program, which writes a ScanProof only for the server's signature.

```
 NTAG 424 DNA ──tap (encrypted SUN URL)──▶ verifier (FastAPI)  ──Ed25519 signature──▶ programs/flacon (Anchor)
                                          CMAC · counter · nonce                       Registry · Passport · Seal · ScanProof
 card in holder ──5 camera frames──▶ packages/vision (OpenCV, in-browser)                       ▲
                                          │                                                     │ tx (wallet)
                                    apps/web (Next.js) ─────────────────────────────────────────┘
                                    /t · /scan · /p/[serial] · /certify · /market     programs/escrow (USDC) · Metaplex Core · Arweave (optional)
```

- **The chip verifies the seal.** Every tap carries an AES-CMAC over the chip UID and a counter that only goes up (NXP AN12196, encrypted SUN). Only the server holds the key, and it rejects a replayed tap URL.
- **The program accepts only what the server signed.** `record_scan` checks the server's Ed25519 signature via instruction introspection (a registered, unrevoked key; a signature at most 10 minutes old) and rebuilds the 152-byte message from the instruction arguments and the hashes stored in the passport and seal accounts; one ScanProof per (seal, counter).
- **The card records the handling.** The camera finds the card in its holder, rectifies it, white-balances against the card itself and reads each indicator by colour distance. Of the six heat fields only the 40 °C one decides (the others are context); a triggered heat or humidity indicator sets grade C. The UV window is recorded but does not change the grade.
- **The escrow ties payment to evidence.** List → reserve (USDC into a program-owned vault) → pre-ship scan → ship → receipt scan → release. The receipt scan must match the pre-ship scan: same heat and humidity readings, fill within 5 points. The buyer is refunded if the seller does not ship, the seller is paid if the buyer never scans, and an admin `resolve` decides when the scans disagree.

## What a passport claims

The seal is a **handling and provenance record, not a damage record**. The chip verifies the seal; it does not prove what is inside the bottle. A grade describes the recorded handling, not the condition of the contents.

| Grade | Recorded | After a later scan |
|---|---|---|
| A / B / D | the fill level of the latest scan: A 90 % or more, B 60 % or more, D below | follows the latest scan |
| C | a triggered heat (40 °C) or humidity (60 % RH) indicator | stays C |
| VOID | the seal recorded as opened, or confirmed dead on chain | stays VOID |

The app and the docs say "Seal genuine · Tap 14" and "Heat: above 40 °C recorded", and never "damaged", "NFT" or "tamper-proof through blockchain" (the verifier keeps the list in `apps/verify/fv/strings.py`).

## Tested on real hardware

- **iPhone** read the stickers reliably in our tests through background NFC and opens the result page in Safari. The scan continues from that tap through a single-use token, valid for 180 seconds, so one tap is enough.
- **Android:** a Google Pixel 6 cannot read this sticker batch. TagInfo reads the full SUN URL, but Android's NDEF detection does not, so WebNFC returns an empty record. The WebNFC path is implemented for compatible tags; reprogramming the batch with the factory configuration is planned.
- **Wallets on iPhone:** Safari has no injected wallet, so signing goes through **WalletConnect** or the Phantom/Solflare in-app browser, where a resume link reopens the scan at the signing step. Certified (partner) scans need WalletConnect, with the partner wallet connected before "Get signature". Android signs through the Mobile Wallet Adapter (Solflare).
- **The physical card** has no printed marker and no reference patches. Frame mode anchors on the holder's window and the blue heat label and corrects the parallax of the recessed card. Verified on 2026-10-11 on three photos (daylight, room light, oblique), each with the 40 °C field read as intact.

## Security model and known limits

- The server proves that the genuine chip was tapped, once: within a 90-second scan session, or, on the one-tap iPhone path, at most 180 seconds before the scan adopts that tap. It does not prove what is inside the bottle, and a genuine sticker moved to another bottle is not detected by the chip alone.
- Indicator and fill readings are currently reported by the scanning phone and signed as sent. The escrow program compares the readings of the two scans but does not itself require a card reading; the web order page offers only scans with heat and humidity read.
- History comes from the chain, not from the client: the verifier records an entry only after decoding a confirmed transaction signed by the actor, and it takes the facts (price, seal kind, counters, match, attester, tier, role) from the instruction and the program's accounts and events. Unverified seal reports appear as "reported · unverified" and never void a passport.
- The verifier's simulator is off in production (`/health` reports it), and the verifier refuses to start with forgeable key settings.
- Pending scans stay private: no message, signature or nonce of an unanchored scan appears in public views, and the wallet-app resume link works only while its scan is pending. Certified tiers and the vault/partner roles are signed only for wallets in the on-chain partner registry.
- VOID and C are sticky; A/B/D follow the latest scan. A C from a triggered heat or humidity indicator, or a VOID passport, stays that way, while the next scan corrects a single low fill reading. The verifier applies this rule on every confirmation and in its reconcile job, and both programs enforce it on chain since the devnet upgrade of 2026-10-16 (before it, a later scan could still overwrite C or VOID on chain).
- The programs also add server-key revocation with a freshness window (10 minutes against the cluster clock), partner removal, issuer-only seal administration, owner-only escrow listing, a price-bound reserve, a buyer refund when the seller does not ship, a seller payout when the buyer never scans, and an admin `resolve` for disagreeing scans. Devnet runs them since the same upgrade; [`programs/README.md`](programs/README.md) lists every instruction with its signer rules.
- Before mainnet: a multisig for upgrade, registry and escrow authority, binding attester/tier into the signed message, indicator readings that do not rely on the scanning phone, and an external audit.

## Repo

| Path | What |
|---|---|
| `packages/proof` | TypeScript source of truth: enums, the 152-byte signed message, ScanProof bundle schema, grade rule. `npm run vectors` writes `docs/vectors.json`, which the Python and Rust tests consume. |
| `packages/vision` | OpenCV.js card reader (marker mode and frame mode for the physical holder), runs in a Web Worker. `packages/vision/scripts/calibrate.ts` reads photos and draws the regions. |
| `apps/verify` | Python 3.12 / FastAPI / SQLite verifier: SUN/CMAC (from `icedevml/sdm-backend`), sessions, signatures, on-chain transaction verification for history entries, reconcile job, optional Arweave archiving via Irys (`FV_ARWEAVE`). |
| `programs/flacon` | Anchor program: `Registry`, `Passport`, `Seal`, `ScanProof`; Ed25519 verification in `record_scan`. |
| `programs/escrow` | Anchor program: USDC escrow that compares seller and buyer ScanProofs. |
| `apps/web` | Next.js 15 (React 19): landing, tap result, scan flow, public passport, certification console, market. |
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
bash scripts/test-escrow-time-travel.sh     # escrow timeout branches in LiteSVM (needs the Solana CLI's cargo build-sbf)
anchor build && bash .github/scripts/idl-check.sh   # the committed IDLs in packages/proof/src/idl equal the build output
bash .github/scripts/docker-smoke.sh        # needs Docker: build Dockerfile.verify, start it with a throwaway config, check /health
bash .github/scripts/hygiene.sh             # no tracked env files, keys, local tool config, absolute home paths or machine PATH lines
```

CI (`.github/workflows/ci.yml`) runs all of these on every push to `main` and every pull request, except `anchor test` and the escrow time-travel tests, which run on manual dispatch (Actions → CI → Run workflow, "anchor" ticked), and the IDL check, which `.github/workflows/programs.yml` runs whenever the programs, the committed IDLs or the toolchain pins change. CI never deploys: Vercel and Railway are not connected to GitHub, and both services are deployed by hand ([`docs/deploy.md`](docs/deploy.md#deploying)).

## Status (2026-10-16)

| Area | State |
|---|---|
| Data contracts, shared vectors (TS · Python · Rust) | done |
| Verifier: encrypted SUN, replay, nonce, signatures, authenticated history | done, live at verify.flaconvault.com |
| Anchor programs flacon + escrow | done, on devnet (upgraded 2026-10-16) |
| Web: tap result, scan flow, passport, certification, market, Solana Action (Blink) to reserve a listing | done, live at app.flaconvault.com |
| Real stickers (NTAG 424 DNA, encrypted SUN) | done on iPhone; a Google Pixel 6 cannot read this batch |
| Camera indicator reading of the physical card | done (frame mode); humidity colour to be confirmed against the indicator datasheet |
| Escrow seller protection, key revocation, partner removal | done, live on devnet since 2026-10-16 |
| Arweave archiving of photos and scan bundles via Irys | built and tested on Irys devnet (2026-09-24); the live verifier's Irys wallet is empty, so current scans are not archived |
| Attester binding in the signed message, multisig authorities | next |

More: what is stored where: https://app.flaconvault.com/privacy (`apps/web/src/app/privacy/page.tsx`; it refers data requests to the operator named in the legal notice on flaconvault.com) · devnet addresses [`docs/devnet.md`](docs/devnet.md) · hardware runbook [`docs/hardware-day.md`](docs/hardware-day.md) · hosting [`docs/deploy.md`](docs/deploy.md) · demo video script [`docs/demo-script.md`](docs/demo-script.md) · original briefing (German) [`docs/Dev-Briefing_v2.md`](docs/Dev-Briefing_v2.md).
