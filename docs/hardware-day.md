# Hardware day — runbook (briefing §18)

Deliveries: NFC stickers (NFC21) ~Thu 25.09 · humidity cards (llfa) ~Wed 24.09 · heat strips (Euro-Industry) ~Fri 26.–Mon 29.09.

## 0. Phone needs HTTPS

WebNFC and `getUserMedia` only run in a secure context. Chrome on Android treats `http://192.168.x.x` as insecure. Two options:

- **Quick tunnels (no account):** `scripts/tunnel.sh` starts two Cloudflare tunnels for web `:3000` and verify `:8787` and prints the env lines. URLs change on every start — that is fine because **tags point to the web app's `/t`**, and the web app forwards to whatever `NEXT_PUBLIC_VERIFY_URL` says.
- **Stable domain:** deploy `apps/web` to Vercel (env `NEXT_PUBLIC_VERIFY_URL`, `NEXT_PUBLIC_SOLANA_RPC`, `NEXT_PUBLIC_PROGRAM_ID`, `NEXT_PUBLIC_ESCROW_PROGRAM_ID`, `NEXT_PUBLIC_DEV_SIMULATOR=false`) and keep the verifier behind a tunnel or on a small VM. Bake the Vercel domain into the tags.

Either way: `FV_WEB_URL`, `FV_VERIFIER_HOST`, `FV_CORS_ORIGINS` in `apps/verify/.env` must match, then restart both servers.

## 1. Read the sticker (NXP TagWriter, Android)

Read tag → note the UID (7 bytes, starts with `04`), NDEF must be empty (= factory keys, `FV_KEY_MODE=factory`).

## 2. Configure SDM (SUN)

TagWriter → *Write tags* → *New dataset* → *Link/URI* → paste the template from `scripts/tunnel.sh` (or `https://<web-domain>/t?uid=00000000000000&ctr=000000&cmac=0000000000000000`) → enable **NTAG 424 DNA SUN/SDM**: UID mirror at the `uid=` placeholder, read-counter mirror at `ctr=`, SDMMAC at `cmac=`; keys stay zero (do not change keys in the hackathon). Write.

Fallback without TagWriter: NXP TagXplorer on a PC with a PC/SC reader, or `icedevml/ntag424-dna` (Python) — same mirrors, plain mode, key 0 = 16×0x00.

## 3. First real tap

1. `FV_DEV_SIMULATOR=false` in `apps/verify/.env` (keeps `/dev` off for the demo), restart.
2. Tap → phone opens `…/t?uid=…&ctr=…&cmac=…` → web forwards to the verifier → **„Siegel echt · Tap N"**. Screenshot → README.
3. Open the same URL again → **„Wiederholter Tap"** (REPLAY).
4. `/certify` on the phone: **UID per NFC lesen** fills the UID; mint a passport, attach the seal. Or attach the real UID to a seed passport via `POST /api/events {serial, type: 1, payload:{uid, kind}}` after `attach_seal` on chain.

## 4. Tamper

Stick the sticker over a cardboard edge, tear, tap → nothing happens on the phone (the chip is dead). In `/scan`, no tap arrives; use **„Kein Siegel gefunden"** (step 3) → SEAL_DEAD. Repeat until it tears reliably (score the foil first if needed).

## 5. Range

Sticker on the **back** of the card (carrier-label position), card in the housing, measure on the filled bottle: target ≥ 15 mm.

## 6. Calibrate the heat strip

Photograph the strip on the card (daylight + artificial light) → `/dev/vision` → upload → compare the six ROIs in the warped card with the real fields → adjust `docs/heat_fields.json` (`fields[i].roi_mm`, `reference_colors`) → `node apps/web/scripts/copy-vendor.mjs` (or restart dev) → 10× series must agree 10/10. Check whether the 29 °C field is already dark (cosmetic only; the decision is field index 4 = 40 °C).

## 7. Humidity dot

Punch Ø 9 mm, stick it into the circle, check blue/pink against the printed patches in `/dev/vision` (ΔE values are shown).

## 8. Scenes 2, 3, 5 on the Android device

Scene 2 buyer tap (iPhone works too: `/t` only) · Scene 3 certification scan with gloves/scale: `/certify` → **Zum Scan** (tier 4, photo required) · Scene 5 fraud: replay + torn sticker.

## Demo wallets

With `NEXT_PUBLIC_DEV_SIMULATOR=true` the wallet menu offers **Dev-Wallet A (Verkäufer)** and **Dev-Wallet B (Käufer)** — keypairs persisted in the browser's localStorage, so one phone can play both escrow roles. Fund them with `npx tsx scripts/fund-dev-wallet.ts <pubkey> 0.05 500` (SOL + test USDC on devnet). For the real demo use Phantom and set the simulator flag to false.

## Devnet budget

Wallet `Bsy5DFxtugs5PGqjF8ADrPYm7kt89dFpwEe9hTZokpFy`. flacon deployed (≈1.3 SOL rent). Escrow deploy needs ≈2.3 SOL. Each scan ≈0.002 SOL + rent for the ScanProof (≈0.003). Top up via https://faucet.solana.com when below 1 SOL.
