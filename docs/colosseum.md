# Colosseum — Einreichung (Checkliste)

Plattform: https://arena.colosseum.org (Login, dann „Projects“ → „Create project“). Felder können sich im Detail unterscheiden; das hier ist die Vorbereitung, damit jede Angabe griffbereit ist. Feature-Freeze Mi 07.10., Abgabe Sa 10.10. (Stand der Links: 16.10.)

| Feld | Eintrag | Woher |
|---|---|---|
| Projektname | FlaconVault | |
| Tagline (ein Satz) | Aus erster Hand versiegelt. Auf dem Zweitmarkt lesbar. | Briefing §0 |
| Beschreibung (kurz) | NFC-Siegel (NTAG 424 DNA) + Indikatorkarte + Pass auf Solana: Jeder Tap beweist den Chip, jeder Scan ist ein signiertes ScanProof-Konto, Escrow gibt USDC erst nach übereinstimmendem Empfangs-Scan frei. | README, Abschnitt „Architecture“ |
| Beschreibung (lang / Problem, Lösung, Markt) | Sammler-, Vintage- und Nischenparfum 150–3.000 €; Fälschungen und Lagerungsschäden; Handhabungs- und Herkunftsnachweis statt Vertrauen. Business: Siegel pro Flakon an Parfümerien/Vaults, Rev D < 1,50 € Stückkosten. | Briefing §0, §15 (Rev-D-Folie), `docs/demo-script.md` |
| Track / Kategorie | Consumer / Payments / DePIN — je nach Angebot; primär Consumer, sekundär Payments (Escrow) | |
| Repo-Link | https://github.com/Eleuss/flaconvault | öffentlich, Commits ab 23.09. |
| Live-Link | https://app.flaconvault.com (echte Flasche: https://app.flaconvault.com/p/SN-2026-000007 · Escrow-Durchlauf auf Devnet: https://explorer.solana.com/tx/2oEXVqFVJ6kg6ubCrLFVGFzGV6QB67WMPVzhij99aT8RBsVoWbw1UfkcvxzP83gcrU4xx4iXpHAwwcw18sJFBLhv?cluster=devnet) | `docs/deploy.md` |
| Programm-IDs (Devnet) | flacon `7dCr825ibTyE6Y5oPHP2RCmUi5qFPCaKdZmE9TYeAcWL`, escrow `9vabByStbAqKH6sM6fuf8HhfGZbV3993Ncp3uZScexKL` | `docs/devnet.md` (mit Explorer-Links und Beispiel-Transaktionen) |
| Demo-Video (≤ 3 min) | YouTube/Loom-Link, unlisted | Drehbuch `docs/demo-script.md`, Szenen 1–6 |
| Pitch-Video | Link; enthält die Roadmap-Folie Rev D | `docs/demo-script.md`, Abschnitt Pitch |
| Technische Details | Anchor 1.2, Ed25519-Instruktion-Introspektion, Metaplex Core, Arweave via Irys, OpenCV.js (Kartenrahmen-Erkennung der echten Karte), WebNFC, WalletConnect | README, `docs/deploy.md` |
| Team | Name(n), Rolle(n), GitHub `Eleuss`, Kontakt | |
| Logo / Bild | `apps/web/public/icon.svg` (SVG) — ggf. als PNG exportieren | |
| Land / Standort | Deutschland | |
| Open Source | ja, MIT (`LICENSE` im Repo-Root) | |

## Vor dem Absenden

1. README-Screenshots (Pass-Seite, Scan-Ergebnis, Markt) einfügen; Live- und Explorer-Links prüfen.
2. Simulator: `FV_DEV_SIMULATOR=false` in Produktion (aus Sicherheitsgründen). Demo-Werkzeuge im Web (Testbild, Dev-Wallets) nur über `/dev?demo=1` im eigenen Browser.
3. Devnet-Wallet-Guthaben ≥ 0,5 SOL, damit Juroren-Scans nicht an Gebühren scheitern (Scans zahlt die Wallet des Scannenden; Dev-Wallets A/B sind vorfinanziert).
4. Lizenz: erledigt (`LICENSE`, MIT).
