# FlaconVault — Dev-Briefing v2 (Stand 22.09.2026)

**Für die Coding-Session. Vollständig, von Grund auf. Ersetzt das Briefing vom 14.09. und den Nachtrag vom 21.09.**

Wer das liest, soll ohne weitere Rückfragen anfangen können. Wo eine Entscheidung offen ist, steht sie in Abschnitt 17 — alles andere ist entschieden.

---

## 0. Was gebaut wird, in fünf Sätzen

FlaconVault ist ein Siegel für hochwertige Parfümflakons (Sammler, Vintage, Nische, 150–3.000 €). Ein NFC-Chip (NXP NTAG 424 DNA) beweist beim Antippen kryptografisch, dass es der echte Chip ist und der wievielte Tap das ist. Eine Fahne am Flaschenhals trägt irreversible Indikatoren für Hitze und Feuchte, die per Handykamera gelesen werden. Jeder Scan wird vom Server signiert und als **ScanProof** auf Solana verankert — so entsteht ein **Pass** mit lückenloser Geschichte: Geburt, Versiegelung, jeder Scan, jeder Besitzerwechsel. Ein Escrow gibt Geld erst frei, wenn Verkäufer-Scan vor Versand und Käufer-Scan nach Empfang übereinstimmen.

**Der Satz, der alles trägt:** *Aus erster Hand versiegelt. Auf dem Zweitmarkt lesbar.*

**Hackathon:** Colosseum Crypto World's Fair, Solana. Feature-Freeze **Mi 07.10.**, Abgabe **Sa 10.10.** Bewertet: Demo-Video (≤ 3 Min), Pitch-Video, öffentliches Repo mit Commits im Zeitraum, Business. **Alles, was in keiner Demo-Szene (Abschnitt 15) vorkommt, wird nicht gebaut.**

---

## 1. Entscheidungen, die feststehen

| Thema | Entscheidung | Warum |
|---|---|---|
| Chip | **Ein Chip: NTAG 424 DNA Standard** (NT4H2421Gx). Kein TagTamper im Hackathon. | 424 DNA TT ist EU-weit nicht lieferbar. Der Standard liefert den kompletten Echtheitsbeweis. |
| Tamper | **Mechanisch:** Sticker so geklebt, dass die Antenne beim Öffnen reißt. Toter Chip = geöffnet. On-chain `tamper = 3 (UNKNOWN)`. | Kein zweites Feld, kein zweiter Chip, passt zur Escrow-Logik: kein gültiger Scan → keine Freigabe. |
| 213 TT | Liegt in der Schublade. Optionales Upgrade (Abschnitt 13), **nicht** im Hauptpfad. | Zeit. |
| Pass-Identität | **Pass hängt am Flakon (Seriennummer), nicht am Chip.** `Seal`-Konto zeigt auf den Pass. | Zwei Siegel pro Flakon (Packung + Hals) schreiben in eine Geschichte. |
| Hitze-Schwelle | **40 °C.** Physisch: Thermax 6-Stufen-Streifen 29/33/34/37/40/42 °C — **gelesen wird das 40-°C-Feld**, die anderen sind Zusatzinfo. | ICH-Q1A-/Cosmetics-Europe-Referenz; deutsche Lieferwagen erreichen bei 23 °C außen >50 °C, alles unter 40 °C löst ständig aus. |
| Feuchte-Schwelle | **60 % rF.** Physisch: 6-Punkt-Karte 10–60 %, ausgestanzter 60-%-Punkt, blau → rosa. | Oberkante Konservierungskorridor, Schimmel/Stockflecken ab 65–75 %. |
| UV | **Nicht bestückt im Hackathon.** Feld bleibt auf der Karte, Aufdruck „LICHT — REV D". Classifier liefert `3 (MISSING)`, UI zeigt „nicht bestückt". | UVB kommt nicht durchs Glas, UV ist <50 % des Lichtschadens, Flakon in Schachtel = Lichtdosis null. |
| Lokation | **Kein GPS on-chain.** Off-chain grob `{country, city}`, vom Nutzer bestätigt. On-chain nur `site_id` bei Rolle VAULT/PARTNER. | Fälschbar, Datenschutz. |
| Sprache | Das Siegel ist ein **Handhabungs- und Herkunftsnachweis, kein Schadensnachweis.** UI-Texte in Abschnitt 16. | Chemisch ist ein Hitzepeak fast egal; wer „beschädigt" schreibt, wird zerlegt. |
| Chain | Solana **Devnet**, Anchor, Metaplex Core, Arweave via Irys. Kein Mainnet. | |
| Reputation | Nur **Leseansicht** (Abschnitt 12), nichts on-chain. | Daten sind schon da. |

---

## 2. Architektur

```
 ┌──────────────┐   Tap (SUN-URL)     ┌──────────────────┐   Ed25519-Sig    ┌────────────────┐
 │  NTAG 424 DNA│ ─────────────────▶  │ apps/verify      │ ───────────────▶ │ programs/flacon│
 │  am Flakon   │                     │ FastAPI, SQLite  │                  │ Anchor, Devnet │
 └──────────────┘                     │ CMAC · Zähler ·  │                  │ Passport · Seal│
                                      │ Nonce · Signatur │                  │ ScanProof      │
                                      └────────┬─────────┘                  └───────▲────────┘
                                               │ JSON                              │ tx
                                      ┌────────▼─────────┐                         │
                                      │ apps/web         │ ────────────────────────┘
                                      │ Next.js PWA      │  Wallet Adapter (Phantom)
                                      │ Scan · Kamera ·  │
                                      │ Verifier · Pass  │ ──▶ Arweave (Irys): Fotos + Bündel
                                      └──────────────────┘
```

Drei Teile, eine Wahrheit: **Der Server ist die einzige Stelle, die den Chip prüfen kann** (CMAC). **Das Programm akzeptiert nur, was der Server signiert hat.** **Die Web-App zeigt beides zusammen als Geschichte.**

---

## 3. Repo und Stack

```
flaconvault/                      öffentlich, Commits ab sofort aussagekräftig
  apps/web/                       Next.js 14 App Router, TypeScript, Tailwind, PWA, Wallet Adapter, OpenCV.js
  apps/verify/                    Python 3.12, FastAPI, SQLite; basiert auf github.com/icedevml/sdm-backend
  programs/flacon/                Anchor ≥ 0.30; Programm `flacon`; Woche 3: `escrow`
  packages/proof/                 TS: Typen, Schema (zod), Signatur-Helper, Enum-Tabellen — Single Source of Truth
  docs/                           dieses Briefing, card/Einlegekarte_RevC.svg + .pdf, heat_fields.json
  scripts/                        Tag-Personalisierung, Devnet-Deploy, Seed-Daten
```

**Konventionen:** Enum-Werte und Byte-Layouts stehen **einmal** in `packages/proof` und werden von Server (als generierte JSON) und Programm (als Konstanten, mit Test, der beide vergleicht) übernommen. Keine Secrets im Repo; `.env.example` vollständig. Jeder Abschnitt unten hat eine **Definition of Done (DoD)** — erst dann weiter.

**.env (apps/verify):**
```
FV_MASTER_KEY=00000000000000000000000000000000   # Hackathon: Werksschlüssel, 16 Byte hex
FV_KEY_MODE=factory                              # factory | diversified (AN10922)
FV_SERVER_ED25519_SEED=<32 byte hex>
FV_SERVER_KEY_ID=1
FV_DEV_SIMULATOR=true                            # bis Hardware da ist
FV_NONCE_TTL_S=90
FV_IRYS_KEY=<devnet keypair json>                # Woche 2
FV_SOLANA_RPC=https://api.devnet.solana.com
FV_PROGRAM_ID=<nach Deploy>
```

---

## 4. Datenverträge — jetzt festlegen, dann nicht mehr anfassen

### 4.1 Enums (u8), gelten überall

```
tamper:     0 CLOSED · 1 OPENED_NOW · 2 OPENED_BEFORE · 3 UNKNOWN        (Hackathon: immer 3)
indicator:  0 INTACT · 1 TRIGGERED · 2 UNREADABLE · 3 MISSING            (UV: immer 3)
tier:       0 SIGHTING · 1 SELF · 2 SELF_MEDIA · 3 CERTIFIED · 4 BIRTH
role:       0 OWNER · 1 SELLER · 2 BUYER · 3 VAULT · 4 PARTNER
grade:      0 A · 1 B · 2 C · 3 D · 4 VOID
seal_kind:  0 BOX · 1 NECK
event:      0 MINT · 1 SEAL_ATTACH · 2 SCAN · 3 LIST · 4 RESERVE · 5 SHIP · 6 RECEIVE · 7 RELEASE · 8 DISPUTE · 9 SEAL_DEAD
```

### 4.2 Tag-URL (steht im Chip, der Chip füllt die Platzhalter selbst)

```
https://<verifier-host>/t?uid=04A1B2C3D4E5F6&ctr=00000E&cmac=6F3A0B1C2D3E4F50
```
`uid` 7 Byte hex · `ctr` 3 Byte hex, monoton · `cmac` 8 Byte AES-CMAC (SDMMAC). Kein `tt`-Parameter (kein TT-Chip). Standard: NXP AN12196, Plain-Mirror-Modus (keine verschlüsselten PICC-Daten — bewusst einfach).

### 4.3 Server-Signaturnachricht (exakt diese Bytes — Server signiert, Programm rekonstruiert)

```
msg = "FVSCAN1"                (7 Byte ASCII)
   || serial_hash (32)          sha256(serial, UTF-8)
   || uid_hash    (32)          sha256(uid bytes, 7)
   || counter     (u32 LE)
   || tamper      (u8)
   || uv          (u8)
   || hum         (u8)
   || heat        (u8)
   || fill        (u8, 0–100)
   || media_hash  (32)          sha256 der Frames-Datei, 0x00×32 wenn Tier < 2
   || nonce       (32)
   || ts          (i64 LE)      Unix-Sekunden
sig = ed25519(server_secret, msg)
```

### 4.4 ScanProof-Bündel v1 (JSON, kanonisch serialisiert → `bundle_hash`, liegt auf Arweave)

```json
{
  "schema": "flaconvault.scanproof.v1",
  "serial": "SN-2026-000001",
  "serialHash": "0x…", "uidHash": "0x…", "counter": 14,
  "seal": { "kind": "NECK", "uidHash": "0x…" },
  "tamper": 3,
  "indicators": { "heat": 0, "humidity": 0, "uv": 3 },
  "heatLevels": [1,1,0,0,0,0],
  "fill": 92,
  "visual": { "loopIntact": true, "note": "" },
  "location": { "country": "DE", "city": "Wickede" },
  "media": [ { "type": "SEAL_FRAMES", "sha256": "0x…", "ar": "ar://…" } ],
  "logger": null,
  "session": { "nonce": "0x…", "issuedAt": 1790000000 },
  "device": { "platform": "ANDROID_WEB" },
  "attester": { "role": 2, "tier": 2, "pubkey": "…" },
  "server": { "keyId": 1, "verdict": "VALID", "ts": 1790000012, "sig": "…" },
  "ts": 1790000015
}
```
`heatLevels` = die sechs Felder des Streifens (29/33/34/37/40/42), 0/1. `indicators.heat` = `heatLevels[4]` (das 40-°C-Feld). Die anderen fünf sind Kontext, keine Aussage.

### 4.5 Grade-Regel (Konfiguration, `packages/proof/grade.ts`)

```
VOID   wenn server.verdict != VALID  oder tamper ∈ {1,2}  oder Siegel tot (Event SEAL_DEAD)
C      sonst wenn heat == TRIGGERED oder humidity == TRIGGERED
A      sonst wenn fill ≥ 90
B      sonst wenn fill ≥ 60
D      sonst
UNREADABLE senkt nicht, setzt Flag "Prüfung empfohlen"
```

---

## 5. Verifikationsserver `apps/verify` — **jetzt bauen, ohne Hardware**

**Grundlage:** `icedevml/sdm-backend` forken/übernehmen (Python, kann 424 DNA SDM komplett). Nicht neu schreiben.

**Endpunkte**

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/t?uid&ctr&cmac` | Tag-Landing. Prüft CMAC + Zähler, loggt Tier-0-Sichtung, leitet auf `/p/<serial>` weiter (Web-App). |
| POST | `/api/session` | `{nonce, expiresAt}`; Nonce 32 Byte, 90 s, einmalig. |
| POST | `/api/verify` | `{uid, ctr, cmac, nonce, role, tier, indicators, heatLevels, fill, mediaHash?, serial?}` → `{verdict, counter, serialHash, uidHash, serverSig, keyId, ts, msgHex}`. **Signiert nur bei VALID.** |
| POST | `/api/media` | multipart Frames → `{sha256, ar}` (Woche 2 Arweave; bis dahin lokal + Hash). |
| POST | `/api/events` | Web-App meldet `tx_sig` + Event nach Bestätigung → DB. |
| GET | `/api/passport/<serial>` | Pass + Timeline aus DB (Abschnitt 10). |
| GET | `/api/attester/<pubkey>` | Reputationskennzahlen (Abschnitt 12). |
| POST | `/api/dev/tag` | **Simulator:** legt virtuellen Tag an `{uid}`. |
| POST | `/api/dev/tap` | **Simulator:** `{uid}` → gültige SUN-URL mit hochgezähltem Zähler. |
| POST | `/api/dev/kill` | **Simulator:** Tag antwortet nicht mehr (mechanischer Tamper). |

**Logik `/api/verify`, in dieser Reihenfolge**
1. Nonce existiert, nicht abgelaufen, nicht verbraucht → sonst `NONCE_INVALID`.
2. Schlüssel: `factory` = 16×0x00; `diversified` = AN10922 `CMAC(K_master, 0x01‖UID‖AppID‖SysID)`.
3. CMAC nach AN12196 prüfen → sonst `INVALID`.
4. `ctr > last_counter[uid]` → sonst `REPLAY`. Zähler fortschreiben.
5. `uid` muss einem `Seal` zugeordnet sein (DB, gespiegelt aus Chain) → `serial_hash`; sonst `UNREGISTERED` (Tier 0 darf trotzdem anzeigen).
6. Nachricht nach 4.3 bauen, signieren, Nonce verbrauchen, Event `SCAN(pending)` in DB, Antwort.

**Tests (pytest):** AN12196-Testvektoren für CMAC mit Nullschlüssel; Replay; abgelaufene Nonce; Signatur mit `pynacl` gegen den Public Key verifizierbar; `msgHex` byteidentisch mit der TS-Implementierung in `packages/proof` (gemeinsame Fixture-Datei `docs/vectors.json`).

**DoD:** Simulierter Tap → signiertes Verdict. Zweiter Tap mit altem Zähler → REPLAY. `/api/dev/kill` → `/t` liefert „Siegel antwortet nicht". Alle Tests grün.

---

## 6. Anchor-Programm `flacon` — **jetzt bauen, ohne Hardware**

### Accounts (PDAs)

| Account | Seeds | Felder |
|---|---|---|
| `Registry` | `["registry"]` | `authority`, `server_keys: Vec<{key_id u8, pubkey [u8;32], valid_from i64, valid_to i64}>` (max 8), `partners: Vec<Pubkey>` (max 16), `sites: Vec<{site_id u16, label [u8;32]}>` (max 16) |
| `Passport` | `["passport", serial_hash]` | `serial_hash [32]`, `binding_hash [32]`, `asset Pubkey` (Core), `issuer Pubkey`, `grade u8`, `scan_count u32`, `seal_count u8`, `void bool`, `created_at i64` |
| `Seal` | `["seal", uid_hash]` | `passport Pubkey`, `kind u8`, `uid_hash [32]`, `last_counter u32`, `dead bool`, `attached_at i64` |
| `ScanProof` | `["scan", seal, counter_le]` | `seal Pubkey`, `counter u32`, `tier u8`, `role u8`, `tamper u8`, `uv u8`, `hum u8`, `heat u8`, `heat_levels u8` (Bitmaske 6 Bit), `fill u8`, `site_id u16`, `media_hash [32]`, `bundle_hash [32]`, `attester Pubkey`, `server_key_id u8`, `ts i64` |
| `Origin` | `["origin", passport]` | **reserviert, nicht bauen** (Charge, Abfülldatum, Hersteller-Signatur — Artisan-Häuser, später) |

### Instruktionen

- `init_registry(authority)` · `add_server_key(...)` · `add_partner(pubkey)` · `add_site(site_id, label)` — nur authority.
- `mint_passport(serial_hash, binding_hash, asset)` — Signer ∈ partners. Geburtsurkunde. `binding_hash = sha256(serial ‖ batch_code ‖ uid_hash_first_seal)`.
- `attach_seal(uid_hash, kind)` — Signer ∈ partners oder authority. Legt `Seal` an, `passport.seal_count += 1`.
- `mark_seal_dead(uid_hash)` — Signer ∈ partners/authority, nach bestätigtem Nicht-Antworten (Escrow-Dispute oder Zertifizierung). Setzt `seal.dead`, `passport.void`, `grade = VOID`, Event.
- `record_scan(args)` — **der Kern.** Prüft:
  1. In derselben Transaktion liegt **vor** dieser Instruktion eine `Ed25519Program`-Instruktion (`sysvar::instructions::load_instruction_at_checked`). Deren Pubkey = ein zum `ts` gültiger `server_key` (per `key_id`); deren Nachricht == Rekonstruktion aus 4.3 mit den `args` (Byte für Byte).
  2. `seal.passport == passport`, `!seal.dead`, `args.counter > seal.last_counter`.
  3. `attester == signer`. Rolle/Tier: OWNER/SELLER/BUYER max Tier 2; VAULT/PARTNER Tier 3/4 nur wenn Signer ∈ partners. `site_id != 0` nur bei Rolle VAULT/PARTNER.
  4. Legt `ScanProof` an, setzt `seal.last_counter`, `passport.scan_count`, berechnet `grade` (Regel 4.5, als Konstanten im Programm — Test vergleicht mit `packages/proof`).

**Bewusst nicht:** Merkle-Batching, Rollen-Token, Verschlüsselung, Multisig. Ein PDA pro Scan (~0,002 SOL Rent), für Devnet egal.

**Tests (anchor test):** (a) gültiger Scan; (b) ohne Ed25519-Instruktion → Fehler; (c) manipulierte Nachricht (fill +1) → Fehler; (d) alter Zähler → Fehler; (e) Tier 3 ohne Partner-Whitelist → Fehler; (f) `mark_seal_dead` → weiterer Scan schlägt fehl, grade VOID; (g) Grade-Tabelle gegen `docs/vectors.json`.

**DoD:** Deploy auf Devnet, Program-ID in `.env`, alle Tests grün, `scripts/seed-devnet.ts` legt Registry + 1 Partner + 2 Sites an.

---

## 7. Web-App `apps/web` — Screens

Die Landing existiert grob — **behalten, nicht neu bauen.** Design: ruhig, typografisch, viel Weiß/Ink, ein Akzent (Amber) für das Siegel, Ampelfarben nur für Zustände. Alles mobile-first, Android Chrome ist das Demo-Gerät.

| Route | Für wen | Was |
|---|---|---|
| `/` | alle | Landing (existiert) + Link „Siegel prüfen" |
| `/p/[serial]` | **öffentlich, ohne Wallet, ohne Login** | **Der Pass.** Grade groß, Siegelstatus, Indikatoren als Ampel, Füllstand, „bezeugt von N Wallets, davon X zertifiziert", **Timeline** (Abschnitt 10), Fotos von Arweave, Explorer-Links, Button „Live on-chain prüfen" (liest PDA per RPC). **Nie** Wallet-/Login-Prompt auf dieser Seite. Zählerstand immer sichtbar. |
| `/t` | alle | Tag-Landing: nimmt `uid/ctr/cmac`, ruft Server, zeigt Verdict (grün/rot/„antwortet nicht"), leitet auf `/p/…`. |
| `/scan` | Owner/Seller/Buyer | **Scan-Flow** (Abschnitt 8). |
| `/certify` | Vault/Partner (Wallet ∈ partners) | **Zertifizierungskonsole:** Pass anlegen (Serial, Marke, Name, Charge, Fotos), Core-Asset minten, Siegel anlegen (UID lesen oder aus Simulator), Erst-Scan Tier 3/4, Grade, Site wählen. Druck-Button für Karten-Serial (QR). |
| `/wallet/[pubkey]` | alle | Attester-Profil (Abschnitt 12). |
| `/market`, `/market/[serial]` | Woche 3 | Listing, Kauf, Escrow-Zustände (Abschnitt 11). |
| `/dev` | nur `FV_DEV_SIMULATOR` | **Simulatorkonsole:** virtuelle Tags anlegen, „Tap" auslösen, „Kill" (Tamper), letzte URLs, direkte Sprünge in `/t` und `/scan`. Bis Hardware da ist die Hauptarbeitsfläche. |

---

## 8. Scan-Flow (`/scan`) — Schritt für Schritt, jeder Schritt ein Screen

1. **Session:** `POST /api/session` → Nonce; als 6-Zeichen-Code anzeigen (Basis für Foto-Overlay).
2. **Tap:** WebNFC `NDEFReader.scan()` → URL des Tags → `uid/ctr/cmac` extrahieren. **Simulator:** Button „virtuellen Tap einspielen" (holt von `/api/dev/tap`). iPhone: kein WebNFC — Tap öffnet `/t`, das reicht für Tier 0/Käuferszene.
3. **Verdict-Vorschau:** Server-Antwort ohne Signatur (nur CMAC/Zähler) → grün/rot. Bei „antwortet nicht" (Timeout 8 s): Screen **„Kein Siegel gefunden — Siegel beschädigt, entfernt oder nicht in Reichweite"** mit Foto-Aufforderung → Event `SEAL_DEAD(pending)`, Grade-Vorschau VOID. Das ist die Tamper-Szene.
4. **Kamera:** `getUserMedia` Rückkamera, Overlay mit Zielrahmen für die Fahne **und dem Nonce-Code als Text im Overlay**. 5 Frames oder 3-s-Clip. Kein Galerie-Upload. Frames im Browser SHA-256 → `media_hash`.
5. **Indikatorlesung** (Abschnitt 9) → `heatLevels[6]`, `humidity`, `uv=3`, Konfidenzen. Bei UNREADABLE: „nochmal fotografieren". Füllstand: Slider (Demo), später Kamera.
6. **Bündel** nach 4.4 bauen → `bundle_hash`.
7. **Signatur holen:** `POST /api/verify` mit allem → `serverSig`, `msgHex`.
8. **Transaktion:** `[Ed25519Program.createInstructionWithPublicKey({publicKey: serverPubkey, message: msg, signature: serverSig}), flacon.record_scan(args)]` → Phantom signiert → senden → bestätigen → `POST /api/events` mit `tx_sig`.
9. **Ergebnis:** Grade, Siegel, Indikatoren, Explorer-Link, „Pass ansehen".

**Zeitregel:** Schritt 2 → 8 innerhalb 90 s, sonst Nonce ungültig → Neustart. UI zeigt Countdown.

**DoD (Simulator):** kompletter Flow mit virtuellem Tap, gedruckter Karte vor der Kamera, Devnet-Transaktion, Pass-Seite zeigt den Scan. **DoD (Hardware):** dasselbe mit echtem Tap auf Android.

---

## 9. Indikatorlesung per Kamera (OpenCV.js im Worker)

### Kartengeometrie Rev C (mm, Ursprung oben links, y nach unten; Quelle `docs/card/Einlegekarte_RevC.svg`)

| Element | x | y | Größe |
|---|---|---|---|
| Karte | 0 | 0 | 66 × 34, Ecken r 2 |
| **ArUco DICT_4X4_50, ID 7** | 3,5 | 24,9 | 6,5 × 6,5 |
| QR (Inhalt = Serial) | 10,8 | 24,9 | 6,5 × 6,5 |
| Fenster Hitze (Streifen 32 × 12 liegt zentriert darin) | 2,5 | 5,6 | 33 × 13 |
| Fenster UV (nicht bestückt, Aufdruck „LICHT — REV D") | 36,2 | 5,6 | 13 × 13 |
| Feuchtepunkt (Kreis, Mittelpunkt) | 56,5 | 12,1 | Ø 9,5 |
| Farbfelder, je 4 × (2,5 mm, Abstand 0,6), y = 21,0 | Hitze ab 2,5 · UV ab 36,2 · Feuchte ab 50,6 | | Reihenfolge: **Ausgang · Ausgelöst · Grau 18 % · Weiß** |

Farbreferenzen (gedruckt): Hitze `#E9E9E9 → #111111` · Feuchte `#3A6FB0 → #E58AB2` · UV `#FFFFFF → #2F5DA8` (ungenutzt). Grau `#767676`, Weiß `#FFFFFF`.

### Pipeline
1. `cv.aruco.detectMarkers(DICT_4X4_50)`, ID 7 → vier Ecken. Nicht gefunden → alles `MISSING`, „Karte nicht erkannt".
2. Homographie Marker-Ecken (mm) → Bild; Karte auf **660 × 340 px** entzerren (10 px/mm).
3. **Weißabgleich pro Indikatorgruppe** über deren Grau- und Weißfeld (Lab).
4. **Hitze:** sechs ROIs aus `docs/heat_fields.json` (mm-Rechtecke innerhalb des Fensters; Startwert: sechs gleich breite Spalten über die inneren 30 mm, ROI = mittlere 60 %; **am Tag der Lieferung anhand eines Fotos kalibrieren, Datei ändern, nicht Code**). Pro ROI mittleres L*; ΔE zu „Ausgang" vs „Ausgelöst" → 0/1 + Konfidenz. `heat = heatLevels[4]`.
5. **Feuchte:** Kreis-ROI (mittlere 60 %), ΔE zu Blau vs Rosa → 0/1 + Konfidenz.
6. **UV:** immer `3 MISSING`, kein Bildzugriff.
7. Konfidenz < 0,85 → `2 UNREADABLE`.

**DoD:** Gedruckte Karte, ein Feld mit schwarzem Marker übermalt, der Feuchtepunkt mit rosa Marker: Lesung reproduzierbar richtig bei Tages- und Kunstlicht, 10 von 10 Aufnahmen. **Das geht heute, ohne Hardware — Karte drucken und loslegen.**

---

## 10. Die Geschichte: Pass-Datenmodell und Timeline

Der Server ist der **Indexer** (er signiert jeden Scan und bekommt jede `tx_sig` gemeldet). SQLite:

```
passports(serial PK, serial_hash, brand, name, batch, asset, issuer, grade, void, created_at)
seals(uid_hash PK, serial FK, kind, last_counter, dead, attached_at)
events(id PK, serial FK, type u8, ts, actor_pubkey, tx_sig, seal_uid_hash?, payload_json, ar_bundle?, ar_media?)
attesters(pubkey PK, first_seen, scan_count, certified_count, escrows_ok, escrows_disputed, agree_count, compare_count)
```

**Reconcile-Job** (alle 60 s): für jedes `SCAN(pending)` die `ScanProof`-PDA per RPC lesen; existiert sie → `confirmed`, Felder vergleichen; nach 10 Min ohne PDA → `failed`. Zusätzlich `getProgramAccounts` mit memcmp auf `seal` als Vollabgleich (Button „Live prüfen" macht dasselbe für einen Pass live im Browser).

**Timeline auf `/p/[serial]`** — jede Zeile: Icon nach `event.type`, Datum, Kurztext, Attester (gekürzt + Link auf `/wallet/…`), Ort grob, Grade danach, Explorer-Link, Thumbnail. Beispiele:

```
● 15.09.2026  Geburtsurkunde · Partner „Parfümerie X, Düsseldorf" · Charge 4A12 · Grade A     [tx] [Foto]
● 15.09.2026  Halssiegel angelegt · Chip …F6                                                  [tx]
● 20.09.2026  Scan Tier 2 · Verkäufer 7Gh…k2 · Hitze ok · Feuchte ok · Füllstand 92 % · Wickede [tx] [Foto]
● 02.10.2026  Gelistet · 480 USDC                                                             [tx]
● 03.10.2026  Versand-Scan Tier 2 · Verkäufer · Zähler 15                                     [tx] [Foto]
● 05.10.2026  Empfangs-Scan Tier 2 · Käufer 9Qm…x1 · übereinstimmend · München               [tx] [Foto]
● 05.10.2026  Freigegeben · 480 USDC → Verkäufer · Pass → Käufer                              [tx]
```

Kopf der Seite: Grade, „Siegel: intakt / antwortet nicht / geöffnet", drei Indikatoren als Ampel (UV: grau „nicht bestückt"), Füllstand, „14 Scans · 3 Bezeuger · 1 zertifiziert", Zähler.

**DoD:** Pass-Seite rendert aus Seed-Daten eine vollständige Timeline; „Live prüfen" liest die PDA und zeigt ✓; ohne Wallet, ohne Login, unter 2 s auf dem Handy.

---

## 11. Escrow (Woche 3, erst nach 5–10)

Programm `escrow`: `Order ["order", passport, seller]`, USDC-Vault-PDA (Devnet-USDC). Zustände `LISTED → RESERVED → PRESHIP_SCANNED → SHIPPED → RECEIPT_SCANNED → RELEASED | MISMATCH | DISPUTE`. `seller_pre_ship_scan` und `buyer_receipt_scan` verweisen auf `ScanProof`-PDAs; `release` prüft: gleicher Pass, beide `verdict VALID`, `heat`/`hum` gleich, `fill` Differenz ≤ 5 → USDC an Verkäufer, Core-Asset an Käufer. Kein Empfangs-Scan binnen 7 Tagen oder `SEAL_DEAD` → `DISPUTE` (Admin-Instruktion, kein Multisig). Dazu `/market`, Blink-Endpoint `/api/actions/verify-buy` (Solana Actions).

---

## 12. Reputation — Leseansicht, nichts on-chain

`/wallet/[pubkey]` und Badge im Pass. Kennzahlen aus `attesters`:
- **Dabei seit**, **Scans**, **zertifizierte Scans** (Tier ≥ 3)
- **Übereinstimmungsquote:** Anteil seiner Scans, bei denen der nächste *unabhängige* Scan desselben Passes `heat`, `hum` gleich und `fill` ±5 hatte
- **Escrows ohne Dispute**
- Rolle geprüft (∈ partners) als Häkchen

Kein Score, keine Formel — nur die Zahlen. Das ist ehrlich und reicht.

---

## 13. Optionales Upgrade: 213 TT als zweiter Sensor (nur wenn Zeit übrig ist)

`attach_seal` mit `kind = 2 LOOP`; `binding_hash` enthält beide UIDs; Scan-Flow bekommt zweiten Tap; `tamper` kommt aus dem TT-Status (nicht signiert, aber gebunden). **Nicht anfangen, bevor Abschnitte 5–10 DoD sind.**

---

## 14. Was nicht gebaut wird

Native App · App Attest / Play Integrity · Merkle-Batching · Rollen-Token · Medienverschlüsselung · HSM · Multisig · Suche/Profile/Chat im Marktplatz · Vault-Lagerfunktionen · GPS · Mainnet · UV-Lesung · Origin-Konto · Reputations-Score.

---

## 15. Demo-Szenen (jede muss real laufen, nichts gerendert)

| # | Szene | Was zu sehen ist | Braucht |
|---|---|---|---|
| 1 | **Geburtsurkunde** | `/certify`: Flakon, Karte, Chip im Bild; Serial eingeben; Mint; Pass entsteht mit erstem Timeline-Eintrag | 6, 7, 10 |
| 2 | **Käufer-Tap** | iPhone ans Siegel → `/t` → grün „echt, Tap 14" → Pass mit Geschichte | 5, 7, 10, Hardware |
| 3 | **Zertifizierungs-Scan** | Android, Handschuhe, Waage: Tap, Foto mit Nonce, Indikatoren gelesen, Transaktion, Explorer | 5, 6, 8, 9 |
| 4 | **Ausgelöster Indikator** | Karte mit schwarzem 40-°C-Feld → App zeigt „Hitze: ausgelöst" → Grade C → Timeline-Eintrag. Sprachregelung 16! | 9 |
| 5 | **Betrug** | (a) alter Tap erneut → REPLAY rot; (b) Sticker aufgerissen → „Siegel antwortet nicht" → VOID-Vorschau | 5, 8 |
| 6 | **Handover mit Escrow** | Listing → Versand-Scan → Empfangs-Scan → Freigabe, Timeline zeigt alles | 11 |

Pitch-Video (getrennt): eine Roadmap-Folie **Rev D** — Münze Ø 30 mm, ein Chip mit TT, gedruckte Indikatoren, Stückkosten < 1,50 € in Serie. **Nicht** ins Demo-Video schneiden.

---

## 16. Sprachregelung in der UI (verbindlich)

**So:** „Siegel echt · Tap 14" · „Seit der Zertifizierung nicht geöffnet" · „Hitze: über 40 °C erfasst — die Temperatur, bei der Kosmetik und Pharma beschleunigte Alterung prüfen" · „Feuchte: über 60 % rF erfasst — Grenze für Karton und Etikett" · „Herkunft ab Quelle dokumentiert" · „Bezeugt von 3 Wallets, davon 1 zertifiziert" · „Licht: nicht bestückt (Rev D)"

**Nie:** „beschädigt", „zerstört", „ruiniert", „Duft verändert", „fälschungssicher durch Blockchain", „NFT", „tokenisiert", „Die Blockchain beweist Echtheit" (die beweist der Chip; die Kette macht es übertragbar und insolvenzfest).

Bei Grade C/D ein Satz darunter: „Der Indikator dokumentiert die Handhabung, nicht den Zustand des Inhalts."

---

## 17. Reihenfolge und Zeitplan

Heute ist **Mo 22.09.** Hardware: NFC-Sticker (NFC21) ~ Do 25.09. · Feuchtekarten (llfa) ~ Mi 24.09. · Hitze-Streifen (Euro-Industry) ~ Fr 26.–Mo 29.09. · ACCUZ 424 TT: nicht einplanen.

| Tage | Bauen | Braucht Hardware? |
|---|---|---|
| **22.–24.09.** | Repo, `packages/proof` mit Vektoren, Server + Simulator + Tests (5), Anchor `flacon` + Tests + Devnet-Deploy (6), `/dev`-Konsole, Pass-Seite mit Timeline aus Seed-Daten (10) | nein |
| **25.–28.09.** | Scan-Flow mit Simulator (8), Kamera + Indikatorlesung an gedruckter Karte (9), `/certify` + Core-Mint + Arweave (7), Reconcile-Job (10) | nein — Karte drucken reicht |
| **Tag der Lieferung** | Checkliste Abschnitt 18; `heat_fields.json` kalibrieren; Farbschwellen an echten Indikatoren prüfen; `FV_DEV_SIMULATOR=false` | ja |
| **29.09.–03.10.** | Escrow + `/market` + Blink (11), `/wallet` (12), Szenen 1–5 einmal komplett durchspielen und filmen (Rohmaterial) | ja |
| **04.–07.10.** | Polish, README mit Architektur + Devnet-Adressen, Szene 6, Feature-Freeze | |
| **08.–10.10.** | Demo-Video, Pitch-Video, Abgabe | |

**Regel:** Ein Abschnitt gilt als fertig, wenn seine DoD erfüllt ist und ein Commit „feat(…): … — DoD" existiert. Kein Abschnitt wird angefangen, bevor der vorherige seine DoD hat — Ausnahme: 9 (Kamera) darf parallel zu 8 laufen.

---

## 18. Checkliste am Tag der Hardware-Lieferung

1. NFC-Sticker mit **NXP TagWriter** (Android) auslesen: UID notieren, prüfen, dass NDEF leer ist (= Werksschlüssel).
2. SDM konfigurieren: TagWriter → „NTAG 424 DNA SUN/SDM" → URL-Vorlage `https://<host>/t?uid=&ctr=&cmac=` mit UID-, Zähler- und MAC-Mirror; Schlüssel bleiben Null. (Falls die TagWriter-Version das nicht kann: NXP TagXplorer am PC mit PC/SC-Reader, oder `scripts/personalize.py` auf Basis von `icedevml/ntag424-dna`.)
3. `FV_DEV_SIMULATOR=false`. Echter Tap → `/api/verify` → `VALID`. **Screenshot ins README.**
4. Denselben Tap-Datensatz erneut senden → `REPLAY`.
5. Sticker über eine Kartonkante kleben, aufreißen, tappen → „Siegel antwortet nicht". Dreimal wiederholen, bis es zuverlässig reißt (ggf. Folie vorher anritzen).
6. Sticker auf die **Rückseite** der Karte (Trägerlabel-Position), Karte ins Gehäuse, Reichweite am gefüllten Flakon messen (Ziel ≥ 15 mm).
7. Hitze-Streifen fotografieren → `heat_fields.json` kalibrieren (sechs ROIs). Prüfen, ob das 29-°C-Feld schon schwarz ist (nur Optik).
8. Feuchtepunkt Ø 9 mm ausstanzen, aufkleben, Farbschwellen gegen die gedruckten Referenzen prüfen.
9. Szenen 2, 3, 5 einmal komplett auf dem Android-Gerät.

---

## 19. Referenzen

NXP AN12196 (SDM/SUN, Testvektoren) · NXP AN10922 (Key-Diversifizierung) · `icedevml/sdm-backend`, `icedevml/ntag424-dna` · Anchor `sysvar::instructions` + Ed25519-Introspektion · Metaplex Core (Umi) · Irys SDK · Solana Actions/Blinks · OpenCV.js ArUco · WebNFC `NDEFReader` (Android Chrome).

**Dateien, die die Session mitbekommt:** `docs/card/Einlegekarte_RevC.svg` + `.pdf` (Kartenlayout, mm exakt), `docs/layout.py` (Konstanten), dieses Briefing.
