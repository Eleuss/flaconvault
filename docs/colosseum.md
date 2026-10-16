# Colosseum — Einreichung (Checkliste)

Plattform: https://arena.colosseum.org (Login, dann „Projects“ → „Create project“). Felder können sich im Detail unterscheiden; das hier ist die Vorbereitung, damit jede Angabe griffbereit ist. Feature-Freeze Mi 07.10., Abgabe Sa 10.10. (Stand der Links: 16.10.)

Die Spalte „Eintrag“ ist der Text, der ins (englische) Formular kommt; Platzhalter (Videos, Team, Logo) vor dem Absenden ersetzen.

| Feld | Eintrag | Woher |
|---|---|---|
| Projektname | FlaconVault | |
| Tagline (ein Satz) | Sealed at first hand, readable on the secondary market: an NFC seal and a Solana passport for collectible perfume. | README, Titelzeile |
| Beschreibung (kurz) | An NFC seal and a public passport on Solana for collectible perfume. An NXP NTAG 424 DNA sticker answers every tap with a checksum only our server can verify, a camera-read card records excess heat (40 °C) and humidity (60 % RH), every witnessed scan becomes a signed ScanProof account on Solana, and a USDC escrow pays the seller when the pre-ship and receipt scans agree. | README, Einleitung und Abschnitt „How it works“ |
| Beschreibung (lang / Problem, Lösung, Markt) | siehe unten, [Beschreibung (lang)](#beschreibung-lang) | README, Einleitung; Briefing §0, §15 (Rev-D-Folie) |
| Track / Kategorie | Consumer (primary) · Payments (secondary: USDC escrow tied to seal scans) | Track-Namen auf der Plattform prüfen; DePIN nicht wählen (kein dezentrales Infrastruktur-Netz) |
| Repo-Link | https://github.com/Eleuss/flaconvault | öffentlich, Commits ab 23.09. |
| Live-Link | https://app.flaconvault.com · a real sealed bottle (press "Check live on-chain"): https://app.flaconvault.com/p/SN-2026-000007 · a complete escrow sale on devnet (two browser dev wallets, simulated taps): https://explorer.solana.com/tx/2oEXVqFVJ6kg6ubCrLFVGFzGV6QB67WMPVzhij99aT8RBsVoWbw1UfkcvxzP83gcrU4xx4iXpHAwwcw18sJFBLhv?cluster=devnet | `docs/deploy.md` |
| Programm-IDs (Devnet) | flacon `7dCr825ibTyE6Y5oPHP2RCmUi5qFPCaKdZmE9TYeAcWL`, escrow `9vabByStbAqKH6sM6fuf8HhfGZbV3993Ncp3uZScexKL` | `docs/devnet.md` (mit Explorer-Links und Beispiel-Transaktionen) |
| Demo-Video (≤ 3 min) | YouTube/Loom-Link, unlisted | Drehbuch `docs/demo-script.md`, Szenen 0–7 |
| Pitch-Video | Link | `docs/demo-script.md`, Abschnitt Pitch; enthält die Roadmap-Folie Rev D |
| Technische Details | Two Anchor 1.2 programs on Solana devnet: flacon (registry, passport, seal, ScanProof) and a USDC escrow that compares the seller's and the buyer's ScanProofs. record_scan verifies the server's Ed25519 signature by instruction introspection and rebuilds the 152-byte signed message from the instruction arguments and on-chain hashes; one ScanProof PDA per (seal, counter). NXP NTAG 424 DNA encrypted SUN (AES-CMAC, AN12196) with replay and nonce checks in a Python/FastAPI verifier. The mint_passport instruction requires a Metaplex Core asset owned by the issuer (since the 2026-10-16 upgrade; older devnet passports have none), and the escrow can hold that asset and hand it to the buyer on release. OpenCV.js in a Web Worker reads the physical indicator card. Next.js 15 / React 19 web app with iPhone background NFC for one-tap checks, WalletConnect and the Mobile Wallet Adapter for signing, and a Solana Action (Blink) to reserve a listing. One set of test vectors shared by TypeScript, Python and Rust. Optional Arweave archiving via Irys (tested on Irys devnet). | README, `docs/deploy.md` |
| Team | Name(n), Rolle(n), GitHub `Eleuss`, Kontakt | |
| Logo / Bild | `apps/web/public/icon.svg` (SVG) | ggf. als PNG exportieren |
| Land / Standort | Germany | |
| Open Source | Yes, MIT | `LICENSE` im Repo-Root |

## Beschreibung (lang)

Zum Einfügen ins Formular (Problem, Lösung, Markt):

**Problem.** Rare, vintage and niche perfume is resold on photos and the seller's word. A buyer cannot check whether the bottle still carries its original seal, or how it was stored and shipped: a delivery van passes 40 °C on a warm day.

**Solution.** FlaconVault seals the bottle at the source. A perfumery or vault registers the bottle and places an NXP NTAG 424 DNA sticker over the neck. Every tap returns a fresh checksum and a counter that only goes up; only our verification server can check them, so a tap link that has already been checked is rejected, and a torn sticker stops answering. An insert card with indicators for heat (40 °C, irreversible), humidity (60 % RH) and UV is read by the phone camera. The server signs every witnessed scan, and a Solana program that accepts only server-signed scans stores each witnessed scan as its own ScanProof account, tied to the bottle's seal and counted on its passport. Anyone can tap the seal with an iPhone and see the result without an app or a wallet, then compare the passport with the chain in the browser. For a sale, a USDC escrow pays the seller when the seller's pre-ship scan and the buyer's receipt scan agree. If they disagree, an admin decides; deadlines cover a seller who never ships and a buyer who never scans. The seal is a handling and provenance record, not a damage record: the chip verifies the seal, not what is inside the bottle, and a grade describes the recorded handling, not the condition of the contents.

**Why Solana.** The history has to outlive any one shop, platform or server, and the payment has to follow the evidence. The program checks the server's Ed25519 signature in the same transaction. Passports and scans are public accounts anyone can read without going through us. On release, the escrow can hand the bottle's Metaplex Core asset to the buyer, and USDC settles against the same scans.

**Market.** Collectors, resellers and resale platforms for collectible, vintage and niche perfume, and the perfumeries and storage vaults that serve them. Business model: perfumeries and vaults buy one seal per bottle and run the certified scans. Target cost below €1.50 per seal in series production (next hardware revision, estimate).

**Status.** Live on Solana devnet with test USDC; tested with real stickers on an iPhone.

## Vor dem Absenden

1. README-Screenshots (Pass-Seite, Scan-Ergebnis, Markt) einfügen; Live- und Explorer-Links prüfen.
2. Simulator: `FV_DEV_SIMULATOR=false` in Produktion (aus Sicherheitsgründen). Demo-Werkzeuge im Web (Testbild, Dev-Wallets) nur über `/dev?demo=1` im eigenen Browser.
3. Devnet-Wallet-Guthaben ≥ 0,5 SOL, damit Juroren-Scans nicht an Gebühren scheitern (Scans zahlt die Wallet des Scannenden; Dev-Wallets A/B sind vorfinanziert).
4. Lizenz: erledigt (`LICENSE`, MIT).
