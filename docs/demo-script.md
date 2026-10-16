# Demo video (≤ 3 min): script

Rule from the briefing: every scene runs for real, nothing is rendered. Wording follows briefing §16 (a handling and provenance record, not a damage record). One take per scene: a screen recording of the phone plus a second camera on bottle, card and hand.

| # | Sec. | Scene | Picture | Voice-over | Preparation |
|---|---|---|---|---|---|
| 0 | 0–15 | Title | Bottle with neck tag, card, chip. Caption: "Sealed at first hand. Readable on the secondary market." | "Collectible perfume is resold on trust: photos and the seller's word. FlaconVault adds a seal that proves itself genuine on every tap, and a card that records how the bottle was handled." | Bottle in the Rev C holder, card inserted |
| 1 | 15–45 | Birth certificate | `/certify` on the phone: serial, brand, name, batch, site. **Mint Metaplex Core** → **Create passport** → **Attach seal** (UID via NFC). Then `/p/<serial>`: first timeline entry, grade A. | "The perfumery registers the bottle and attaches the seal. One bottle, one passport, one history from the source." | Partner wallet whitelisted with `scripts/add-partner.ts`, about 0.05 SOL |
| 2 | 45–65 | Buyer tap | iPhone to the seal → `/t` → green "Seal genuine · Tap 14" → "View passport with history" → timeline. | "Anyone can check. No app, no wallet, no login. The counter shows which tap this is." | Sticker written with the SUN URL of the web domain |
| 3 | 65–105 | Certification scan | Gloves and scale in the picture. The certified scan page `/scan?role=4&tier=3&site=1` with the partner wallet connected first: tap → photo of the card → indicators read → signature → partner wallet signs → explorer link. | "This is the certified check a perfumery or vault makes. The server checks the chip and signs the scan; the program on Solana accepts only what the server signed. The scan is now its own account on Solana, readable by anyone without asking us." | A registry partner wallet; printed card, daylight, `docs/heat_fields.json` calibrated |
| 4 | 105–130 | Triggered indicator | Second card, 40 °C field black. Scan → "Heat: above 40 °C recorded" → grade C → timeline. Caption: "The indicator documents the handling, not the condition of the contents." | "Above 40 degrees: the temperature at which cosmetics and pharma test for accelerated ageing. The grade drops to C and stays there. No verdict on the scent: a fact about the handling." | A dedicated demo passport (a triggered scan leaves it at C for good). Card with a blackened field, or the "Test image: 40 °C triggered" button (demo mode only) as a fallback |
| 5 | 130–155 | Fraud | (a) Open the sticker's original tap URL (`…/t?picc_data=…&cmac=…`) again → red "Repeated tap". (b) Tear the sticker over a cardboard edge, tap → nothing; `/scan` → "Seal not responding" → report (SEAL_DEAD, shown as unverified until the passport's issuer or the registry authority confirms it on chain with `mark_seal_dead`). | "Reused URL: rejected. Torn antenna: dead chip. No release without a valid scan." | Sticker URL copied with an NFC reader app (NFC Tools, TagInfo), prepared sticker |
| 6 | 155–175 | Handover with escrow | `/market`: listing at 480 USDC → reservation (vault) → shipping scan → shipped → receipt scan → **release**. The timeline shows every step with explorer links. | "The payment is released when the scan before shipping and the scan after receipt agree: same heat and humidity readings, fill level within five points. If they disagree, an admin decides; deadlines cover a seller who never ships and a buyer who never scans." | Dev wallets A/B (demo mode) or two wallets with test USDC (`scripts/fund-dev-wallet.ts`) |
| 7 | 175–180 | Credits | Repo URL, devnet program ids, explorer. | "Solana devnet, Anchor, Metaplex Core, a USDC escrow. Open source." | `docs/devnet.md` |

## Pitch video: roadmap slide Rev D (not part of the demo video)

- A 30 mm coin instead of the 66 × 34 mm card
- One chip with TagTamper (NTAG 424 DNA TT) once available, so `tamper` comes from the chip instead of being mechanical
- Printed indicators (heat 40 °C, humidity 60 % RH, light from Rev D)
- Target cost below €1.50 per seal in series production (estimate)
- An origin account (batch, filling date, manufacturer signature) for artisan houses

## Checklist before the shoot

1. Web app and verifier reachable over HTTPS (a deployment or `scripts/tunnel.sh`). The demo tools (dev wallets A/B, test images, airdrop) exist only on a **demo deployment** of the web app (`NEXT_PUBLIC_DEV_SIMULATOR=true`; production sets it to `false`, which also turns `/dev` into a 404, see `docs/deploy.md`) and only in a browser with demo mode on: open `/dev?demo=1` once on every device that needs them (it is on automatically on `localhost`), and `/dev?demo=0` after the shoot.
2. Deploy wallet at least 0.5 SOL; scanning wallets about 0.05 SOL each; test USDC for the buyer.
3. Three passports prepared: a fresh one (scene 1), one with history (scenes 2 and 6), and a dedicated demo passport for grade C (scene 4). C and VOID are sticky (only A/B/D follow the latest scan): a triggered scan cannot be undone, so never use SN-2026-000007 or any other passport the README links for scene 4.
4. Screen recording on the phone, a second camera on hands and bottle, sound recorded separately.
5. Explorer tabs open in advance (program, passport PDA, latest transaction).

## Shooting plan 2026-10-12 (hardware state: the Pixel cannot read the chips, the iPhone can)

Devices: **iPhone** for the seal scenes (screen recording from Control Centre), a **laptop** for certification and escrow (screen recording, browser wallet extension or dev wallets), the **Pixel** as the second camera on hands, bottle and card. Use a demo deployment (`NEXT_PUBLIC_DEV_SIMULATOR=true`) and open `/dev?demo=1` once on the iPhone and the laptop (dev wallets for scenes 3 and 6, test image for scene 4); `/dev?demo=0` switches demo mode off again after the shoot.

| Scene | Device | Steps | Preparation |
|---|---|---|---|
| 1 Birth certificate | Laptop, wallet extension (partner) | `/certify`: SN-2026-000008, brand/name/batch, type the UID of sticker 3 → **Mint Metaplex Core** → create passport → attach seal → `/p/SN-2026-000008` | Write sticker 3 beforehand with the NFC Developer App (URL `/t`, master key), tap once and read the UID |
| 2 Buyer tap | iPhone | Tap sticker 3 (now SN-2026-000008) → "Seal genuine · Tap 2" → "View passport with history" | — |
| 3 Certification scan | iPhone, a partner wallet: Solflare via WalletConnect (Dev wallet A only while it is still a registry partner; the devnet upgrade removes it, `docs/devnet.md`) | Open `/scan?role=4&tier=3&site=1` in Safari (the certified flow, tier 3 at site 1; `/certify` → "Go to scan" opens the same flow at tier 4, the birth scan of a new passport) → "Select Wallet" → WalletConnect → approve in Solflare, back to Safari → "Start session" → tap the Tom Ford tag (Safari loads the tag link into this tab and returns to the scan page; if the wallet button shows "Connect", press it once) → "Continue to camera" → card in the box → "Capture 5 frames" → indicators (heat intact, humidity intact, light intact) → "Get signature" → "Sign and send with WalletConnect", approve in Solflare → scan anchored → explorer. Not through the tap page's "Check condition" link: that always makes an owner scan (tier 2) | `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` set on the deployment (without it the page says "This browser cannot sign a certified scan"); card flat, 25 cm, daylight, no flash |
| 4 Triggered indicator | iPhone | As scene 3 with sticker 4 on a dedicated demo passport (a fresh serial, e.g. SN-2026-000009), **never SN-2026-000007**; at the camera step "Test image: 40 °C triggered" → "Heat: above 40 °C recorded" → grade C | Bind sticker 4 to the demo passport beforehand (`/certify` or `scripts/bind-chip.ts`). The anchored scan keeps that passport at C for good. Caption "Reference image: the physical card must not be heated" |
| 5a Replay | iPhone | Open the sticker's original tap URL (`…/t?picc_data=…&cmac=…`) again → "Repeated tap". Not the result page `/t?tap=…`: reopening it shows the stored "Seal genuine" again | After scene 2, read sticker 3 with NFC Tools or TagInfo, copy the URL it shows (that read counts as a tap) and open it once off camera ("Seal genuine") |
| 5b Tear test | iPhone + Pixel camera | Tear sticker 3 over the cardboard edge, tap → nothing; `/scan` → session → "Seal not responding" → serial SN-2026-000008 → report (SEAL_DEAD) → timeline | Shoot only after scene 2 |
| 6 Escrow | Laptop, Dev wallets A/B | `/market`: listing → reservation → shipping scan → shipped → receipt scan → release | `scripts/list-order.ts` to check |
| 7 Credits | — | Repo, program ids, explorer | `docs/devnet.md` |

Order on set: 1 → 2 → 3 → 4 → 5a → 5b → 6. One take per scene; do not cut around mistakes, shoot the scene again.
