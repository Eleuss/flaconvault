# Hardware runbook

How to program an NTAG 424 DNA sticker, bind it to a passport, read the indicator card and run the flows on real phones. The procedure that works comes first; what did not work is at the end.

## 0. HTTPS for the phone

WebNFC and the camera (`getUserMedia`) only run in a secure context; a phone treats `http://192.168.x.x` as insecure.

- **Hosted:** use the deployed web app (https://app.flaconvault.com for the hackathon deployment, see `docs/deploy.md`).
- **Local:** `scripts/tunnel.sh` starts two Cloudflare quick tunnels (web `:3000`, verifier `:8787`) and prints the matching `FV_WEB_URL`, `FV_VERIFIER_HOST`, `FV_CORS_ORIGINS` and `NEXT_PUBLIC_VERIFY_URL` lines; restart both servers afterwards. A tunnel makes your local verifier public: run it only with a local development configuration (simulator, factory keys, a throwaway signing seed), never with the production master key or signing seed.

## 1. Program a sticker (NFC Developer App)

Use the **NFC Developer App** (nfcdeveloper.com, Android and iOS) to write the sticker:

- URL: the web app's `/t`, for example `https://app.flaconvault.com/t`
- mode: encrypted SUN (the tag sends `picc_data` and `cmac`), custom data empty
- master key: the verifier's `FV_MASTER_KEY` (keep it in a secret store; it derives every sticker key)

The verifier must then run with `FV_KEY_MODE=sdmbackend` and `FV_SDM_DERIVE=legacy` (the NFC Developer App / sdm-backend derivation) and decrypts each tap. Verified on 2026-10-06 with a real sticker bound to passport SN-2026-000006.

## 2. First real tap

1. Verifier with the simulator off (`FV_DEV_SIMULATOR=false`) and the real master key.
2. Tap the sticker with an iPhone (background NFC opens Safari) → `/t` shows **"Seal genuine · Tap N"**, or "Chip genuine, but not assigned to a passport" for a chip that is not bound yet.
3. Open the same URL again → **"Repeated tap"** (the counter did not go up).

## 3. Bind the chip to a passport

- **Browser (partner wallet):** `/certify` → mint a Metaplex Core asset and the passport, then attach the seal. **"UID from the last tap"** fills in the UID that `/t` remembered (iPhone), **"Read UID via NFC"** reads it directly where WebNFC works. **"Go to scan"** starts the certification scan (tier 4, photo required).
- **CLI (partner wallet in `~/.config/solana/id.json`):** `npx tsx scripts/bind-chip.ts <serial> <uid14hex> "<brand>" "<name>" "<batch>" [kind=1] [verifyUrl]` sends `mint_passport` and `attach_seal`, then posts the MINT and SEAL_ATTACH events with their transaction signatures. The verifier records history entries only together with a verified on-chain transaction (`POST /api/events` needs `txSig` and `actor`).

## 4. Seal not responding (tamper test)

Stick a sticker over a cardboard edge, tear it, tap: nothing happens on the phone, the chip is dead. In `/scan`, choose **"Seal not responding"** → "No seal found" and file the report. The report shows as unverified until a partner confirms the dead seal on chain (`mark_seal_dead`). Repeat until the sticker tears reliably (score the foil first if needed).

## 5. Range

Sticker on the back of the card (carrier-label position), card in the holder, measured on a filled bottle: target at least 15 mm.

## 6. Indicator card

### Physical card in the 3D-printed holder (frame mode)

The Rev C card has no ArUco marker and no reference patches, so `readCard` uses **frame mode** (the `frame` section of `docs/heat_fields.json`): the holder's window (62.5 × 30.5 mm) gives the coarse homography, the blue heat label seen through its 11 × 25.5 mm window refines it on the card plane (the card sits about 1.8 mm below the holder face, so the window alone is parallax-shifted at oblique angles), white is the card, black is the ring around the humidity dot.

Calibrate from phone photos: scale a photo to about 1600 px wide (for example `sips -s format png --resampleWidth 1600 IMG.jpg --out a.png` on macOS), then `node packages/vision/scripts/calibrate.ts a.png`, which prints the reading and writes `a.warped.png` with the regions drawn. Verified on 2026-10-11 on three photos (daylight, room light, oblique): heat levels `[1,1,1,0,0,0]`, 40 °C field intact, confidence about 1.

### Heat strip and humidity dot

- Photograph the strip on the card in daylight and artificial light → `/dev/vision` → upload → compare the six regions in the rectified card with the real fields → adjust `docs/heat_fields.json` (`fields[i].roi_mm`, `reference_colors`) → `node apps/web/scripts/copy-vendor.mjs` (or restart the dev server). A series of 10 photos must agree 10/10. Only field index 4 (40 °C) decides; the 29 °C field may already be dark.
- Humidity dot: punch Ø 9 mm, stick it into the circle and compare blue/pink against the printed patches in `/dev/vision` (the ΔE values are shown). The humidity colour is not yet calibrated against the indicator datasheet.

## 7. Phones

### iPhone (works end to end)

- **One tap, then the scan:** a background NFC read lands on `/t?tap=<id>` ("Seal genuine · Tap N"). **"Check condition · Photograph the card"** opens `/scan?adopt=<id>`: the scan starts a session and adopts that tap (`POST /api/verify` with `tapId` and its single-use token). The verifier accepts a tap once, from `/t`, with verdict VALID, and at most 180 seconds old (`ADOPT_WINDOW_S` in `apps/verify/fv/service.py`). No second tap is needed.
- **Signing:** Safari has no injected wallet and iOS has no Mobile Wallet Adapter. Two ways work:
  - **WalletConnect** (shown once `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`, a Reown Cloud project id, is set): the modal deep-links into Phantom, Solflare or Backpack, the user approves there and returns to Safari.
  - **"Continue in Phantom" / "Continue in Solflare":** the wallets' *browse* universal links (`https://phantom.com/ul/browse/<url>?ref=<ref>`, `https://solflare.com/ul/v1/browse/<url>?ref=<ref>`) reopen the scan at the signing step inside the wallet's own browser (`apps/web/src/lib/wallet-links.ts`), where the injected wallet signs natively. The same links appear on the wallet button of other pages on iPhone. Verified on 2026-10-11 end to end.

### Android

A Google Pixel 6 rejects this sticker batch at the NDEF level: TagInfo reads the full SUN URL, but Android's NDEF detection does not, so WebNFC returns an empty record. The WebNFC path (`/scan` → "Start NFC reading") is implemented for compatible tags. Android signs through the Mobile Wallet Adapter (Solflare).

## 8. Demo wallets

With `NEXT_PUBLIC_DEV_SIMULATOR=true` and demo mode on (`apps/web/src/lib/demo.ts`), the wallet menu offers **"Dev wallet A (seller)"** and **"Dev wallet B (buyer)"**: keypairs persisted in the browser's `localStorage`, so one phone can play both escrow roles. They sign without a prompt and their secret keys are readable by any script on the page: use them for demos on devnet only, never as registry partners and never with anything of value. Fund them with `npx tsx scripts/fund-dev-wallet.ts <pubkey> 0.05 500` (SOL and test USDC on devnet).

## 9. Devnet budget

Deploying `flacon` locked about 1.3 SOL of rent, `escrow` about 2.3 SOL. Each scan costs about 0.002 SOL in fees plus about 0.003 SOL of rent for its ScanProof account, paid by the scanning wallet. Top up the deploy wallet at https://faucet.solana.com when it drops below 1 SOL.

## Appendix: what did not work

- **NXP TagWriter** placed the SDMMAC at offset 7 (over `https://`) in every mode we tried; do not use it for NTAG 424 DNA SUN.
- The first plan (plain `uid`/`ctr`/`cmac` mirror with factory keys, `FV_KEY_MODE=factory`) is only usable with the simulator: factory keys are public, so anyone can compute a valid tap. The verifier supports `factory` and `diversified` (AN10922) for local development and tests.
- Stickers written earlier with `https://flaconvault.vercel.app/t` keep working through the permanent redirect to the canonical web origin.
