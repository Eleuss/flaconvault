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
3. Replay: read the sticker once with an NFC reader app (NFC Tools, TagInfo) and copy the URL it shows (`…/t?picc_data=…&cmac=…`; that read counts as a tap). Open the copied URL in Safari once (**"Seal genuine · Tap N"**), then open the same URL again, or after a newer tap → **"Repeated tap"** (its counter is not above the last one seen). Reopening the result page (`/t?tap=…`, where the first tap lands) only shows the stored result again, not a replay.

## 3. Bind the chip to a passport

- **Browser (partner wallet):** `/certify` → mint a Metaplex Core asset and the passport, then attach the seal. **"UID from the last tap"** fills in the UID that `/t` remembered (iPhone), **"Read UID via NFC"** reads it directly where WebNFC works. **"Go to scan"** starts the certification scan (tier 4, photo required).
- **CLI (partner wallet in `~/.config/solana/id.json`):** `npx tsx scripts/bind-chip.ts <serial> <uid14hex> "<brand>" "<name>" "<batch>" <coreAssetPubkey|new> [kind=1] [verifyUrl]` (`mint_passport` only accepts a Metaplex Core asset owned by the issuer: pass an existing one owned by the CLI wallet, or `new` to mint one owned by the CLI wallet whose uri is the verifier's `/api/passport/<serial>/metadata.json`) sends `mint_passport` and `attach_seal`, then posts the MINT and SEAL_ATTACH events with their transaction signatures. The verifier records history entries only together with a verified on-chain transaction (`POST /api/events` needs `txSig` and `actor`).

## 4. Seal not responding (tamper test)

Stick a sticker over a cardboard edge, tear it, tap: nothing happens on the phone, the chip is dead. In `/scan`, choose **"Seal not responding"** → "No seal found" and file the report. The report shows as unverified (it never voids the passport) until the passport's issuer, while it is a registry partner, or the registry authority confirms the dead seal on chain with `mark_seal_dead`. Repeat until the sticker tears reliably (score the foil first if needed).

## 5. Range

Sticker on the back of the card (carrier-label position), card in the holder, measured on a filled bottle: target at least 15 mm.

## 6. Indicator card

### Physical card in the 3D-printed holder (frame mode)

The Rev C card has no ArUco marker and no reference patches, so `readCard` uses **frame mode** (the `frame` section of `docs/heat_fields.json`): the holder's window (62.5 × 30.5 mm) gives the coarse homography, the blue heat label seen through its 11 × 25.5 mm window refines it on the card plane (the card sits about 1.8 mm below the holder face, so the window alone is parallax-shifted at oblique angles), white is the card, black is the ring around the humidity dot.

Calibrate from phone photos: `node packages/vision/scripts/calibrate.ts photo.jpg` (JPEG or PNG; scale very large photos to about 1600 px wide first, for example with `sips --resampleWidth 1600` on macOS) prints the reading and writes `photo.warped.png` with the regions of the layout the reader used; it never overwrites the input. Frame mode fails closed, with a reason the scan shows next to a retake hint:

- **Heat label not found**, **white balance failed** (card white and ring black too close, usually glare or exposure) or **inconsistent heat fields** (a hotter field black while a cooler one is white, a sign of a misregistered or mirrored photo): every indicator reads UNREADABLE.
- **Glare:** a sampled region in which more than 15 % of the pixels are sensor-clipped (darkest colour channel at 250 or more; `GLARE_CLIP_LEVEL` and `GLARE_MAX_FRACTION` in `packages/vision/src/pipeline.ts`) has an unknown colour. Glare on the decisive 40 °C field makes heat UNREADABLE, glare on another heat field is filled in from the strip's order where the other fields allow it (else heat is UNREADABLE), and glare on the humidity dot or the UV window makes that indicator UNREADABLE. The reason reads "Glare on …: tilt the card away from the light and retake the photo". Marker mode (the simulator's synthetic card and the test card) has no glare detection.
- The scan combines its five frames with `combineReadings` (`packages/vision/src/combine.ts`, called by `apps/web/src/components/scan-flow.tsx`): each indicator needs a majority of all captured frames (3 of 5). Frames without the card, and frame-mode frames without the heat label, do not vote but still count. Without that majority the indicator is UNREADABLE, with one of two reasons: "Only N of 5 frames could be read: hold the card steady and fully in view, then retake the photos" when fewer than 3 frames voted, or "Frames disagree on …: retake the photos" when enough frames voted but they split. When no frame anchors on the heat label, the scan reports the card as not found ("The heat label was not recognized in any frame: …").

UNREADABLE never lowers the grade; it only marks the scan "review recommended". Verified on 2026-10-11 on three photos (daylight, room light, oblique): heat levels `[1,1,1,0,0,0]`, 40 °C field intact, confidence about 1.

### Heat strip and humidity dot

- Photograph the strip on the card in daylight and artificial light → `/dev/vision` → upload → compare the six regions in the rectified card with the real fields → adjust `docs/heat_fields.json` (`frame.fields[i].roi_mm`, `frame.reference_colors`; the delivered card has no marker or printed patches, so the top-level marker-mode values do not apply) → `node apps/web/scripts/copy-vendor.mjs` (or restart the dev server). A series of 10 photos must agree 10/10. Only field index 4 (40 °C) decides; the 29 °C field may already be dark.
- Humidity dot: punch Ø 9 mm, stick it into the circle and compare blue/pink in `/dev/vision` (the ΔE values against `frame.reference_colors` are shown). The humidity colour is not yet calibrated against the indicator datasheet.

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
