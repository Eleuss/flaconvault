# Demo video (≤ 3 min): script

Rule from the briefing: every scene runs for real, nothing is rendered. Wording follows briefing §16 (a handling and provenance record, not a damage record). One take per scene: a screen recording of the phone plus a second camera on bottle, card and hand.

| # | Sec. | Scene | Picture | Voice-over | Preparation |
|---|---|---|---|---|---|
| 0 | 0–15 | Title | Bottle with neck tag, card, chip. Caption: "Sealed at first hand. Readable on the secondary market." | "Collectible perfume, 150 to 3,000 euros. Until now: trust. From now on: a seal that proves it is genuine when you tap it, and a card that shows how the bottle was handled." | Bottle in the Rev C holder, card inserted |
| 1 | 15–45 | Birth certificate | `/certify` on the phone: serial, brand, name, batch, site. **Mint Core asset** → **Create passport** → **Attach seal** (UID via NFC). Then `/p/<serial>`: first timeline entry, grade A. | "The perfumery creates the passport. One chip, one passport, one history from the source." | Partner wallet whitelisted with `scripts/add-partner.ts`, about 0.05 SOL |
| 2 | 45–65 | Buyer tap | iPhone to the seal → `/t` → green "Seal genuine · Tap 14" → "View passport with history" → timeline. | "Anyone can check. No app, no wallet, no login. The counter shows which tap this is." | Sticker written with the SUN URL of the web domain |
| 3 | 65–105 | Certification scan | Gloves and scale in the picture. `/scan`: tap → photo of the card → indicators read → signature → wallet signs → explorer link. | "The server checks the chip and signs. The program accepts only what the server signed. Every scan is an account on Solana." | Printed card, daylight, `docs/heat_fields.json` calibrated |
| 4 | 105–130 | Triggered indicator | Second card, 40 °C field black. Scan → "Heat: above 40 °C recorded" → grade C → timeline. Caption: "The indicator documents the handling, not the condition of the contents." | "Above 40 degrees: the temperature at which cosmetics and pharma test for accelerated ageing. No verdict on the scent. A fact about the handling." | Card with a blackened field, or the "Test image: 40 °C triggered" button as a fallback |
| 5 | 130–155 | Fraud | (a) Open an old tap URL again → red "Repeated tap". (b) Tear the sticker over a cardboard edge, tap → nothing; `/scan` → "Seal not responding" → report (SEAL_DEAD, shown as unverified until a partner confirms it on chain). | "Copied URL: rejected. Torn antenna: dead chip. No release without a valid scan." | Old URL at hand, prepared sticker |
| 6 | 155–175 | Handover with escrow | `/market`: listing at 480 USDC → reservation (vault) → shipping scan → shipped → receipt scan → **release**. The timeline shows every step with explorer links. | "Money only moves when the scan before shipping and the scan after receipt agree: same indicators, fill level within the tolerance band." | Dev wallets A/B or two wallets with test USDC (`scripts/fund-dev-wallet.ts`) |
| 7 | 175–180 | Credits | Repo URL, devnet program ids, explorer. | "Devnet, Anchor, Metaplex Core, Arweave. Open source." | `docs/devnet.md` |

## Pitch video: roadmap slide Rev D (not part of the demo video)

- A 30 mm coin instead of the 66 × 34 mm card
- One chip with TagTamper (NTAG 424 DNA TT) once available, so `tamper` comes from the chip instead of being mechanical
- Printed indicators (heat 40 °C, humidity 60 % RH, light from Rev D)
- Unit cost below 1.50 € in series
- An origin account (batch, filling date, manufacturer signature) for artisan houses

## Checklist before the shoot

1. Web app and verifier reachable over HTTPS (the deployment or `scripts/tunnel.sh`). Demo tools (test images, dev wallets) only where a scene needs them.
2. Deploy wallet at least 0.5 SOL; scanning wallets about 0.05 SOL each; test USDC for the buyer.
3. Three passports prepared: a fresh one (scene 1), one with history (scenes 2 and 6), one for grade C (scene 4).
4. Screen recording on the phone, a second camera on hands and bottle, sound recorded separately.
5. Explorer tabs open in advance (program, passport PDA, latest transaction).

## Shooting plan 2026-10-12 (hardware state: the Pixel cannot read the chips, the iPhone can)

Devices: **iPhone** for the seal scenes (screen recording from Control Centre), a **laptop** for certification and escrow (screen recording, browser wallet extension or dev wallets), the **Pixel** as the second camera on hands, bottle and card. Demo tools stay on (test image for scene 4).

| Scene | Device | Steps | Preparation |
|---|---|---|---|
| 1 Birth certificate | Laptop, wallet extension (partner) | `/certify`: SN-2026-000008, brand/name/batch, type the UID of sticker 3 → mint Core asset → create passport → attach seal → `/p/SN-2026-000008` | Write sticker 3 beforehand with the NFC Developer App (URL `/t`, master key), tap once and read the UID |
| 2 Buyer tap | iPhone | Tap sticker 3 (now SN-2026-000008) → "Seal genuine · Tap 2" → "View passport with history" | — |
| 3 Certification scan | iPhone, Dev wallet A or Solflare via WalletConnect | Tap the Tom Ford tag → "Check condition · Photograph the card" → card in the box → 5 frames → indicators (heat intact, humidity intact, light intact) → get the signature → sign → scan anchored → explorer | Card flat, 25 cm, daylight, no flash |
| 4 Triggered indicator | iPhone | As scene 3 with sticker 2 (SN-2026-000007); at the camera step "Test image: 40 °C triggered" → "Heat: above 40 °C recorded" → grade C | Caption "Reference image: the physical card must not be heated" |
| 5a Replay | iPhone | Open an old `/t?tap=N` URL again → "Repeated tap" | Copy the URL from scene 2 |
| 5b Tear test | iPhone + Pixel camera | Tear sticker 3 over the cardboard edge, tap → nothing; `/scan` → session → "Seal not responding" → serial SN-2026-000008 → report (SEAL_DEAD) → timeline | Shoot only after scene 2 |
| 6 Escrow | Laptop, Dev wallets A/B | `/market`: listing → reservation → shipping scan → shipped → receipt scan → release | `scripts/list-order.ts` to check |
| 7 Credits | — | Repo, program ids, explorer | `docs/devnet.md` |

Order on set: 1 → 2 → 3 → 4 → 5a → 5b → 6. One take per scene; do not cut around mistakes, shoot the scene again.
