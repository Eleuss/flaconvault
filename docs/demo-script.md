# Demo-Video (≤ 3 min) — Drehbuch

Regel aus dem Briefing: jede Szene läuft real, nichts gerendert. Sprachregelung §16. Ein Take pro Szene, Bildschirmaufnahme vom Android-Gerät plus eine zweite Kamera auf Flakon, Karte und Hand.

| # | Sek. | Szene | Was zu sehen ist (Bild) | Was gesagt wird (Ton) | Vorbereitung |
|---|---|---|---|---|---|
| 0 | 0–15 | Titel | Flakon mit Hals-Fahne, Karte, Chip. Einblendung: „Aus erster Hand versiegelt. Auf dem Zweitmarkt lesbar.“ | „Sammlerparfum, 150 bis 3.000 Euro. Bisher: Vertrauen. Ab jetzt: ein Siegel, das beim Antippen beweist, dass es echt ist – und eine Karte, die zeigt, wie der Flakon behandelt wurde.“ | Flakon mit Gehäuse Rev C, Karte eingelegt |
| 1 | 15–45 | Geburtsurkunde | `/certify` auf dem Handy: Serial, Marke, Name, Charge, Standort. **Metaplex Core minten** → **Pass minten** → **Siegel anlegen** (UID per NFC). Dann `/p/<serial>`: erster Timeline-Eintrag, Grade A. | „Die Parfümerie legt den Pass an. Ein Chip, ein Pass, eine Geschichte ab Quelle.“ | Partner-Wallet (Phantom) mit `scripts/add-partner.ts` whitelisten, ~0,05 SOL |
| 2 | 45–65 | Käufer-Tap | iPhone ans Siegel → `/t` → grün „Siegel echt · Tap 14“ → „Pass mit Geschichte ansehen“ → Timeline. | „Jeder kann prüfen. Ohne App, ohne Wallet, ohne Login. Der Zähler zeigt, der wievielte Tap das ist.“ | Sticker mit SDM-URL auf die Web-Domain |
| 3 | 65–105 | Zertifizierungs-Scan | Android, Handschuhe, Waage im Bild. `/scan`: Tap → Foto der Karte mit Sitzungscode im Overlay → Indikatoren gelesen → Signatur → Phantom signiert → Explorer-Link. | „Der Server prüft den Chip und signiert. Das Programm nimmt nur an, was der Server signiert hat. Jeder Scan ist ein Konto auf Solana.“ | Gedruckte Karte, Tageslicht, `docs/heat_fields.json` kalibriert |
| 4 | 105–130 | Ausgelöster Indikator | Zweite Karte, 40-°C-Feld schwarz. Scan → „Hitze: über 40 °C erfasst“ → Grade C → Timeline. Einblendung des Satzes: „Der Indikator dokumentiert die Handhabung, nicht den Zustand des Inhalts.“ | „Über 40 Grad – die Temperatur, bei der Kosmetik und Pharma beschleunigte Alterung prüfen. Kein Urteil über den Duft. Ein Fakt über die Handhabung.“ | Karte mit schwarzem Marker, ggf. Testbild-Knopf als Fallback |
| 5 | 130–155 | Betrug | (a) alte Tap-URL erneut öffnen → rot „Wiederholter Tap“. (b) Sticker über Kartonkante abreißen, antippen → nichts; `/scan` → „Kein Siegel gefunden“ → SEAL_DEAD, Grade-Vorschau VOID. | „Kopierte URL: abgelehnt. Gerissene Antenne: toter Chip. Ohne gültigen Scan keine Freigabe.“ | Alte URL bereithalten, präparierter Sticker |
| 6 | 155–175 | Handover mit Escrow | `/market`: Listing 480 USDC → Reservierung (Vault) → Versand-Scan → Versendet → Empfangs-Scan → **Freigeben**. Timeline zeigt alles mit Explorer-Links. | „Geld fließt erst, wenn der Scan vor Versand und der Scan nach Empfang übereinstimmen: gleiche Indikatoren, Füllstand im Toleranzband.“ | Dev-Wallets A/B oder zwei Phantoms mit Test-USDC (`scripts/fund-dev-wallet.ts`) |
| 7 | 175–180 | Abspann | Repo-URL, Devnet-Programm-IDs, Explorer. | „Devnet, Anchor, Metaplex Core, Arweave. Open Source.“ | `docs/devnet.md` |

## Pitch-Video: Roadmap-Folie **Rev D** (nicht ins Demo-Video schneiden)

- Münze Ø 30 mm statt Karte 66 × 34
- Ein Chip mit TagTamper (424 DNA TT), sobald lieferbar → `tamper` aus dem Chip statt mechanisch
- Gedruckte Indikatoren (Hitze 40 °C, Feuchte 60 % rF, Licht ab Rev D)
- Stückkosten < 1,50 € in Serie
- Origin-Konto (Charge, Abfülldatum, Hersteller-Signatur) für Artisan-Häuser

## Checkliste vor dem Dreh

1. Web-App und Verifier über HTTPS erreichbar (`scripts/tunnel.sh` oder Vercel), `NEXT_PUBLIC_DEV_SIMULATOR=false` für Szene 2/3/5, `true` nur falls Testbild-Fallback nötig.
2. Devnet-Wallet ≥ 0,5 SOL; Phantom-Wallets mit je 0,05 SOL; Test-USDC für Käufer.
3. Drei Pässe vorbereitet: einer frisch (Szene 1), einer mit Geschichte (Szene 2/6), einer für Grade C (Szene 4).
4. Bildschirmaufnahme Android (Systemrecorder), zweite Kamera auf Hände/Flakon, Ton separat.
5. Explorer-Tabs vorab geöffnet (Programm, Pass-PDA, letzte Transaktion).
