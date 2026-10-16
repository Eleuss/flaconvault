# @flaconvault/web

Next.js 14 App Router, mobile first (Android Chrome reads the seal with Web NFC; iPhone uses the tag's own URL and a
wallet app's browser).

```bash
cp apps/web/.env.example apps/web/.env.local      # local values; never put a secret in a NEXT_PUBLIC_* variable
npm run dev -w @flaconvault/web                  # http://localhost:3000 (copies OpenCV.js and the card files into public/)
npm run test -w @flaconvault/web                 # unit tests (node:test via tsx, tsconfig.test.json)
npx tsc --noEmit -p apps/web && npx next lint --dir apps/web/src
```

Everything is read from the verification server (`NEXT_PUBLIC_VERIFY_URL`, default `http://localhost:8787`) and from
Solana (`NEXT_PUBLIC_SOLANA_RPC`, `NEXT_PUBLIC_PROGRAM_ID`, `NEXT_PUBLIC_ESCROW_PROGRAM_ID`).

## Routes

| Route | Purpose |
|---|---|
| `/` | landing page and the passport list |
| `/p/[serial]` | public passport: grade, seals, timeline, "Check live on-chain" (compares the grade and `passport.scan_count` with the verifier's `stats.onChainScanCount`) |
| `/t` | tag landing (`/t?tap=<id>&k=<token>` after the verifier's `/t` redirect). A VALID tap can be adopted by a scan session within 180 s; a dead seal reads as not responding |
| `/scan` | scan flow: session, tap, photos of the indicator card (5 frames, majority vote), server signature, `record_scan` with the wallet. `/scan?resume=<eventId>.<token>` reloads a pending signed scan inside a wallet app's browser |
| `/certify` | partner console: Metaplex Core asset (`uri` = the verifier's `/api/passport/<serial>/metadata.json`), `mint_passport`, `attach_seal`, printable card |
| `/market`, `/market/[serial]`, `/market/o/[order]` | escrow market: listings, the orders of one passport, one order by its PDA (reserve with the agreed price, ship, receipt scan, release, timeouts, disputes, admin resolve) |
| `/wallet/[pubkey]` | attester page (scans, partner badge from the on-chain registry, escrow counters) |
| `/dev`, `/dev/vision` | simulator console (only with `NEXT_PUBLIC_DEV_SIMULATOR=true`; `/dev?demo=1` / `?demo=0` switches demo mode for this browser) and the card-reader lab |
| `/privacy` | what is stored where (chain, Arweave, verifier, hosting) |
| `/actions.json`, `/api/actions/verify-buy` | Solana Action (Blink) for buying a listed bottle: `?order=<pda>&price=<base units>`; the chained `/confirm` callback posts the RESERVE event |

## Demo mode

Dev wallets, the burner wallet, airdrop buttons, test images and the virtual-tap card exist for local development and
the demo video. They appear only when `NEXT_PUBLIC_DEV_SIMULATOR=true` **and** the page runs on localhost or demo mode
was switched on in that browser (`src/lib/demo.ts`). Production sets `NEXT_PUBLIC_DEV_SIMULATOR=false`, which also
removes `/dev`.
