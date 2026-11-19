# @flaconvault/web

Next.js 15 App Router with React 19, mobile first (Android Chrome reads the seal with Web NFC; iPhone uses the tag's own
URL and a wallet app's browser).

```bash
cp apps/web/.env.example apps/web/.env.local      # local values; never put a secret in a NEXT_PUBLIC_* variable
npm run dev -w @flaconvault/web                  # http://localhost:3000 (copies OpenCV.js and the card files into public/)
npm run test -w @flaconvault/web                 # unit tests (node:test via tsx, tsconfig.test.json)
npm run web:typecheck && npm run web:lint      # what CI runs (tsc --noEmit, then next lint inside apps/web)
```

`next lint` is deprecated in Next 15.5 and is removed in Next 16; before that upgrade the `lint` script has to move to
the ESLint CLI.

Everything is read from the verification server (`NEXT_PUBLIC_VERIFY_URL`, default `http://localhost:8787`) and from
Solana (`NEXT_PUBLIC_SOLANA_RPC`, `NEXT_PUBLIC_PROGRAM_ID`, `NEXT_PUBLIC_ESCROW_PROGRAM_ID`).
`NEXT_PUBLIC_SOLANA_CLUSTER` (`devnet`, `mainnet` or `localnet`; default `devnet`) names that cluster: explorer links
follow it, and the test-phase notice on scan results and passport pages shows unless it is `mainnet`.

## The public record

A visitor's scan is saved to the public record without a wallet (spec: `docs/public-record.md`). The verifier signs it
(FVSCAN2) and FlaconVault's relayer sends `record_scan_v2`; the web app only asks and shows the status. The strings of
this path live in `src/lib/public-record.ts`; it says "public record", never blockchain, wallet, NFT, token or crypto.

- `/t` with raw seal parameters first asks `{NEXT_PUBLIC_VERIFY_URL}/health` (2 s): only an `ok` answer hands the tap
  to the verifier, otherwise the page says "Seal check unavailable right now" and "Try again" checks the same tap.
- The `/t` result shows the tap's record (`GET /api/tap/<id>`, every 5 s while pending, at most 10 minutes).
  "Saving to the public record within about 3 minutes." holds until the tap's own time + 185 s and never returns once
  left (never decided from `dueAt`, which the relayer also moves for its retry pauses). The line disappears when the
  record does (`record: null`, or a 404 for the tap); after the 10 minutes it stays without its spinner and loads once
  more whenever the tab becomes visible again.
- `/scan` (tier ≤ 2, owner/seller/buyer): "Save to the public record" posts `/api/verify` with `anchor: "relay"` and
  polls `GET /api/verify/<eventId>/record?token=…`; polling that ends without a final state leaves only its text
  ("not available", or "Not saved…" when the record is gone). The button and its place note are offered only when
  the verifier's `/health` reports `relay` (asked once per page load, 5 s): a verifier without the public record
  ignores `anchor` and would publish the typed place, so without that answer the page is the wallet flow with its own
  place note, as before. The wallet flow (`record_scan`) is under "Advanced"; certified scans and an order's shipping
  and receipt scans (the order page links to `/scan?role=1|2&flow=wallet`: the order needs a scan its party signs)
  keep it directly.
- `/p/[serial]` labels each scan Visitor, Holder, Partner or Recipient (the verifier's `scanBy`) and keeps the on-chain
  details and "Check live on-chain" in the "How this record is checked" drawer.

## Routes

| Route | Purpose |
|---|---|
| `/` | landing page and the passport list |
| `/p/[serial]` | public passport: grade, seals, timeline, "Check live on-chain" (compares the grade and `passport.scan_count` with the verifier's `stats.onChainScanCount`) |
| `/t` | tag landing (`/t?tap=<id>&k=<token>` after the verifier's `/t` redirect), with the tap's public record status. A VALID tap can be adopted by a scan session within 180 s; a dead seal reads as not responding |
| `/scan` | scan flow: session, tap, photos of the indicator card (5 frames, majority vote), then "Save to the public record" (no wallet) or, under "Advanced" and for certified scans, server signature and `record_scan` with the wallet. `/scan?resume=<eventId>.<token>` reloads a pending signed scan inside a wallet app's browser |
| `/certify` | partner console: Metaplex Core asset (`uri` = the verifier's `/api/passport/<serial>/metadata.json`), `mint_passport` (with `init_holding_v1` in the same transaction once the cluster has a HolderConfig, so the bottle's taps can reach the public record; an existing passport of the wallet without its Holding gets `init_holding_v1` alone), `attach_seal`, printable card |
| `/market`, `/market/[serial]`, `/market/o/[order]` | escrow market: listings, the orders of one passport, one order by its PDA (reserve with the agreed price, ship, receipt scan, release, timeouts, disputes, admin resolve) |
| `/wallet/[pubkey]` | attester page (scans, partner badge from the on-chain registry, escrow counters) |
| `/dev`, `/dev/vision` | simulator console (only with `NEXT_PUBLIC_DEV_SIMULATOR=true`; `/dev?demo=1` / `?demo=0` switches demo mode for this browser; Reset + Seed asks for the verifier's `FV_ADMIN_TOKEN`, keeps it in page memory only, and is refused while the verifier has none set) and the card-reader lab |
| `/privacy` | what is stored where (chain, Arweave, verifier, hosting) |
| `/actions.json`, `/api/actions/verify-buy` | Solana Action (Blink) for buying a listed bottle: `?order=<pda>&price=<base units>`; the chained `/confirm` callback posts the RESERVE event |

## Demo mode

Dev wallets, the burner wallet, airdrop buttons, test images and the virtual-tap card exist for local development and
the demo video. They appear only when `NEXT_PUBLIC_DEV_SIMULATOR=true` **and** the page runs on localhost or demo mode
was switched on in that browser (`src/lib/demo.ts`). Production sets `NEXT_PUBLIC_DEV_SIMULATOR=false`, which also
removes `/dev`.
