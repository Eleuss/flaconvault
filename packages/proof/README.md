# @flaconvault/proof

The single TypeScript source of truth for FlaconVault's byte layouts: enums, the FVSCAN1 and FVSCAN2 scan
messages, the ScanProof (v1) and v2 scan bundles, the grade rules, the holder commitment, the scan-head fold and the
flacon PDAs. `npm run vectors` writes `docs/vectors.json` and `docs/enums.json`, the fixtures that the Rust program
(`programs/flacon`) and the Python verifier (`apps/verify`) are tested against. The binding description of the v2
formats is `docs/public-record.md`.

```
npm run proof:build      # tsc → dist/
npm run proof:test       # node --test (parity with the fixtures, field rules, verify-pass)
npm run vectors          # regenerate docs/vectors.json and docs/enums.json (never edit them by hand)
```

## verify-pass: check a public record yourself

Every scan saved to the public record is a `record_scan_v2` transaction that carries a message signed by
FlaconVault's scan key and folds that message into the pass's Holding account (`scan_head`, `head_count`).
`verify-pass` reads only public chain data and checks that:

- each scan carries a valid signature by a FlaconVault scan key listed in the on-chain registry, valid at the
  scan's time, and names this program, this cluster, this pass and the seal it was written to;
- the scans it found, folded oldest first, give exactly the Holding's `scan_head` and `head_count`: the list is
  complete and in order.

It cannot repeat the seal's secret check (the NFC tag's SUN signature); only FlaconVault can do that. Older v1 scans
(ScanProof accounts) are not part of the scan head and are not covered.

```
npm run -s verify-pass -- --rpc https://api.devnet.solana.com --serial SN-2026-000001
npm run -s verify-pass -- --rpc <url> --serial <serial> --cluster mainnet --program <program id> --json
```

Options: `--cluster devnet|mainnet|localnet` (default `devnet`), `--program` (default: the program id in
`src/idl/flacon.json`), `--commitment finalized|confirmed` (default `finalized`), `--json`. It calls only
`getAccountInfo`, `getSignaturesForAddress` and `getTransaction`, needs no key and sends nothing. A public RPC may
rate-limit `getTransaction`; the client retries with backoff.

Exit codes: `0` complete and in order, `1` not complete or not in order, `2` input or RPC error.
