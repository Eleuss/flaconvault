# Programs on devnet

Two Anchor programs: `programs/flacon` (registry, passports, seals, scan proofs) and `programs/escrow` (USDC escrow). Both are deployed on Solana devnet.

Toolchain: Anchor CLI 1.2.0 (via `avm`), Solana CLI 4.1.x (Agave), Rust from `rust-toolchain.toml` (1.89), Node 22.18 or newer, and the npm client `@anchor-lang/core` 1.2 (`@coral-xyz/anchor` 0.32 cannot read Anchor 1.x IDLs).

## Addresses

| What | Value |
|---|---|
| flacon program | `7dCr825ibTyE6Y5oPHP2RCmUi5qFPCaKdZmE9TYeAcWL` ([explorer](https://explorer.solana.com/address/7dCr825ibTyE6Y5oPHP2RCmUi5qFPCaKdZmE9TYeAcWL?cluster=devnet)), deployed 2026-09-24, IDL account initialised |
| escrow program | `9vabByStbAqKH6sM6fuf8HhfGZbV3993Ncp3uZScexKL` ([explorer](https://explorer.solana.com/address/9vabByStbAqKH6sM6fuf8HhfGZbV3993Ncp3uZScexKL?cluster=devnet)), deployed 2026-09-24, IDL registered |
| Upgrade authority, registry authority, escrow admin | `Bsy5DFxtugs5PGqjF8ADrPYm7kt89dFpwEe9hTZokpFy` (the deploy wallet, a single hot key) |
| Registry PDA `["registry"]` | `4JPPCBA7DpbmfDsq1oHDuiJD1zL8VhfuJSoWQyYZXZWt` |
| Escrow config PDA `["config"]` | `CJWph4fTD2sJFZoei1x5xCjq18UEAVyHnLQSnLX7JVa7` (dispute window 7 days) |
| Test USDC mint (6 decimals) | `FLhABVjb5dHqbZs8zpWXi4Qr9JhHJC2gx75KnHQ9AdW5`; mint authority is the deploy wallet. The escrow config has no setter for the mint, so devnet keeps this test mint. |

The program ids are fixed in `Anchor.toml` (`[programs.localnet]`, `[programs.devnet]`), in `declare_id!` in each program's `lib.rs`, in the IDLs under `packages/proof/src/idl/`, and in the apps' environment (`FV_PROGRAM_ID`, `FV_ESCROW_PROGRAM_ID`, `NEXT_PUBLIC_PROGRAM_ID`, `NEXT_PUBLIC_ESCROW_PROGRAM_ID`). The program keypairs live in `target/deploy/*-keypair.json` (git-ignored; only needed for the first deploy, upgrades are signed by the upgrade authority). Back them up.

## Registry on devnet

Read on 2026-10-16 from the registry account (`solana account 4JPPCBA7DpbmfDsq1oHDuiJD1zL8VhfuJSoWQyYZXZWt --url devnet`, or `GET https://verify.flaconvault.com/api/registry`):

| Item | Value |
|---|---|
| authority | the deploy wallet `Bsy5DFxt…` |
| server key | key id `1`, public key `0f5b0efa6284cee08eb3ca19493be2391e86e902bce6d94fb8e47f157d068690`, `valid_from 0`, `valid_to 0` (open-ended); the production verifier's `GET /health` reports the same key |
| partners | `Bsy5DFxtugs5PGqjF8ADrPYm7kt89dFpwEe9hTZokpFy` (deploy wallet) · `AciBj4mKqxhPDF7KRYqvpGt8EZm75b582dumVmTv2LJ1` (**Dev wallet A, a demo keypair held in browser `localStorage`**: treat it as public) · `JSMC3U7YqEwfvJMzsKEm17Uk1jspegk1L6KsE1nKiob` · `3HTM8mzTWe7aPcQY2Jf1QB38anr4G19v8eWjY7rU5RNC` · `5AhqcuywyxWNVhv8DPSHKdefKhYrFAdM9Q9ziZexpRvV` (test partner wallets added with `scripts/add-partner.ts`) |
| site 1 | `Parfümerie X, Düsseldorf` |
| site 2 | `FlaconVault Vault, Wickede` |

A partner can mint passports and certify scans, so a partner key held in a browser is a demo shortcut, not a production setup.

## Commands

```bash
# build (also regenerates target/idl/*.json and target/types/*.ts)
anchor build

# unit tests (message reconstruction vs docs/vectors.json, grade table, ed25519 parser)
cargo test -p flacon

# integration tests on a local validator (Anchor 1.2 defaults to surfpool; use the legacy validator)
anchor test --validator legacy            # or: ANCHOR_TEST_VALIDATOR=legacy anchor test

# copy the IDLs and types for the web app after a program change
cp target/idl/flacon.json packages/proof/src/idl/flacon.json && cp target/types/flacon.ts packages/proof/src/idl/flacon.ts
cp target/idl/escrow.json packages/proof/src/idl/escrow.json && cp target/types/escrow.ts packages/proof/src/idl/escrow.ts

# read an account (registry, passport, seal, scan proof) from devnet
solana account 4JPPCBA7DpbmfDsq1oHDuiJD1zL8VhfuJSoWQyYZXZWt --url devnet
```

### Fresh deployment (new cluster or new program ids)

```bash
solana config set --url https://api.devnet.solana.com
solana balance                                  # deploy + rent need a few SOL; https://faucet.solana.com if airdrops are rate-limited
anchor deploy --provider.cluster devnet
# registry: init_registry, server key id 1, the wallet as partner, sites 1 and 2 (idempotent)
npx tsx scripts/seed-devnet.ts --server-pubkey <pubkeyHex from the target verifier's GET /health>
npx tsx scripts/add-partner.ts <partner pubkey>  # optional, authority only
# escrow config: FV_USDC_MINT = an existing mint, otherwise a new test mint is created and printed
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com npx tsx scripts/seed-escrow.ts
```

Always pass the server key explicitly. Without a flag `seed-devnet.ts` registers the test key from `docs/vectors.json`, whose seed is public in this repo, and server keys cannot be removed from the registry: use the default only on a local validator. `--server-pubkey-from-env` derives the key from `FV_SERVER_ED25519_SEED` in `apps/verify/.env` and is meant for a local validator with a local, throwaway seed. `seed-devnet.ts` registers key id 1; a further key on an existing registry needs an `add_server_key` call from the authority wallet.

The scripts honour `ANCHOR_PROVIDER_URL` and `ANCHOR_WALLET` (default `~/.config/solana/id.json`); for example `ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 npx tsx scripts/seed-devnet.ts` after `anchor localnet --validator legacy`. Other helpers: `scripts/bind-chip.ts` (mint a passport and attach a real chip from the CLI), `scripts/list-order.ts` (list a passport on the escrow), `scripts/fund-dev-wallet.ts <pubkey> [sol] [usdc]` (SOL and test USDC for a demo wallet).

## flacon: program surface

PDAs (seeds from `docs/vectors.json` → `constants.PDA_SEEDS`):

| Account | Seeds |
|---|---|
| `Registry` | `["registry"]` |
| `Passport` | `["passport", serial_hash]` |
| `Seal` | `["seal", uid_hash]` |
| `ScanProof` | `["scan", seal_pubkey, counter u32 LE]` |
| `Origin` | `["origin", passport]` (reserved, not implemented) |

Instructions: `init_registry`, `add_server_key`, `add_partner`, `add_site` (authority only); `mint_passport`, `attach_seal`, `mark_seal_dead` (registry partners or the authority); `record_scan(args)` (any signer for tier ≤ 2 and role OWNER, SELLER or BUYER; a partner for tier ≥ 3 or role VAULT or PARTNER). The exact signer checks live in `programs/flacon/src/instructions/`; the IDL in `packages/proof/src/idl/flacon.json` is the authoritative interface.

`record_scan` must be sent as `[Ed25519Program.createInstructionWithPublicKey({publicKey: serverPubkey, message, signature}), flacon.record_scan(args)]`. The program reads the previous instruction from the instructions sysvar, checks that it is the Ed25519 precompile, that the public key is the registry server key `args.server_key_id` valid at `args.ts`, and that the signed 152-byte message equals its reconstruction (`"FVSCAN1" ‖ serial_hash ‖ uid_hash ‖ counter ‖ tamper ‖ uv ‖ hum ‖ heat ‖ fill ‖ media_hash ‖ nonce ‖ ts`) byte for byte. Errors are typed (`MissingEd25519Instruction`, `MessageMismatch`, `CounterNotIncreasing`, `SealDead`, `NotPartner`, …). Events: `RegistryInitialized`, `ServerKeyAdded`, `PartnerAdded`, `SiteAdded`, `PassportMinted`, `SealAttached`, `SealMarkedDead`, `ScanRecorded`.

All enum values (`tamper`, `indicator`, `tier`, `role`, `grade`, `seal_kind`, `event`), the seeds, `MSG_PREFIX`, `MSG_LEN` and the grade thresholds (`GRADE_FILL_A_MIN = 90`, `GRADE_FILL_B_MIN = 60`) are IDL constants (`program.rawIdl.constants`). `cargo test -p flacon` and `tests/flacon.ts` assert them against `docs/enums.json` and `docs/vectors.json`; `npm run proof:test` checks those files against `packages/proof`.

## escrow

### Flow

```
list(price) ─────────────► LISTED ──cancel()──► CANCELLED ──close_order()──► (account closed, re-listable)
   │ deposit_asset() (optional, Core asset → Order PDA)
reserve(expectedPrice) [buyer, USDC → vault] ─► RESERVED
record_pre_ship_scan() [seller, flacon ScanProof attested by the seller] ─► PRESHIP_SCANNED
ship() [seller] ─► SHIPPED
record_receipt_scan() [buyer, ScanProof attested by the buyer] ─► heat ==, hum ==, |Δfill| ≤ 5 ? RECEIPT_SCANNED : MISMATCH
release() [anyone, from RECEIPT_SCANNED] ─► USDC → seller, asset → buyer, RELEASED
dispute() ─► USDC → buyer, asset → seller, DISPUTE (admin, buyer on MISMATCH, buyer after the dispute window, buyer with a dead seal)
```

`list` requires the seller to be the passport's issuer or the owner of its Core asset; `reserve` takes the price the buyer saw and fails unless it equals `order.price`. The program source and the IDL (`packages/proof/src/idl/escrow.json`) are authoritative for every state transition and signer rule; the devnet deployment is upgraded separately from this repository, so compare with the IDL account on devnet (`anchor idl fetch <program id> --provider.cluster devnet`) before relying on a change.

States (u8, IDL constants `ORDER_STATE_*`): 0 LISTED · 1 RESERVED · 2 PRESHIP_SCANNED · 3 SHIPPED · 4 RECEIPT_SCANNED · 5 RELEASED · 6 MISMATCH · 7 DISPUTE · 8 CANCELLED. Dispute reasons in the `OrderDisputed` event (`DISPUTE_REASON_*`): 0 ADMIN · 1 TIMEOUT · 2 SEAL_DEAD · 3 MISMATCH.

Vault: SPL token account PDA `["vault", order]`, authority = the Order PDA, created at `reserve` (rent paid by the buyer) and closed at `release`/`dispute` (rent back to the buyer). flacon accounts are typed through the `flacon` crate (`Account<'info, flacon::Passport|Seal|ScanProof>`: owner and discriminator enforced). Core asset custody: `deposit_asset` (LISTED only) moves the asset to the Order PDA with an mpl-core `TransferV1` CPI; `release`, `dispute` and `cancel` then take the optional `asset` and `mpl_core_program` accounts (pass `null` when nothing was deposited). Metaplex Core must be on the validator for that path (`Anchor.toml` clones it from devnet for `anchor test` and `anchor localnet`).

### Account layouts (byte offsets after the 8-byte Anchor discriminator)

`EscrowConfig` (81 bytes): `admin` Pubkey @8 · `usdc_mint` Pubkey @40 · `dispute_after_s` i64 LE @72 · `bump` u8 @80.

`Order` (244 bytes): `passport` Pubkey @8 · `seller` @40 · `buyer` @72 (zero until reserved) · `asset` @104 · `price` u64 LE @136 · `state` u8 @144 · `listed_at` i64 @145 · `reserved_at` i64 @153 · `shipped_at` i64 @161 · `seller_scan` Pubkey @169 · `buyer_scan` Pubkey @201 · `dispute_after_s` i64 @233 · `asset_deposited` bool @241 · `bump` u8 @242 · `vault_bump` u8 @243.

Useful `memcmp` filters for `getProgramAccounts(escrow)`: orders of a seller → offset 40; of a buyer → offset 72; for a passport → offset 8; by state → offset 144 (1 byte).

### Localnet

```bash
anchor localnet --validator legacy                                            # deploys both programs on http://127.0.0.1:8899
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 npx tsx scripts/seed-devnet.ts --server-pubkey-from-env
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 npx tsx scripts/seed-escrow.ts      # test mint (printed), init_config(7 d), 1000 test USDC to the wallet
```

`scripts/seed-escrow.ts` env: `ANCHOR_PROVIDER_URL` (default localnet), `ANCHOR_WALLET`, `FV_USDC_MINT` (use an existing mint instead of creating one), `FV_DISPUTE_AFTER_S` (default 604800; an existing config is updated to it when the wallet is the admin). Mint more test USDC with the helpers in `scripts/lib/spl.ts` (`mintTo`, mint authority = the CLI wallet).

## History on devnet

- **First live scan (2026-09-24):** `/scan` with a simulator tap on SN-2026-000001, counter 17, grade A; Ed25519 instruction and `record_scan` in one transaction: [tx](https://explorer.solana.com/tx/3RETYHEFCnTtYXYGKDHgFeHyeAKWf1jPhBdFcRT77LtLJLJebyNCPykBwLwmYvx2qtLLbqbKAUHHLh9heZUxKrsh?cluster=devnet).
- **Escrow end to end (2026-09-24):** two browser dev wallets (A seller `AciBj4mK…`, B buyer `7u5uM6oU3XnzDpPNYHxSFhviB6pLaS52XXVsjAwE8jtf`) on SN-2026-000001 at 480 test USDC: list → reserve (vault funded) → seller scan (counter 18) → `record_pre_ship_scan` → ship → buyer scan (counter 19) → `record_receipt_scan` (heat and humidity equal, Δfill 0) → release. [Release tx](https://explorer.solana.com/tx/2oEXVqFVJ6kg6ubCrLFVGFzGV6QB67WMPVzhij99aT8RBsVoWbw1UfkcvxzP83gcrU4xx4iXpHAwwcw18sJFBLhv?cluster=devnet), order PDA `2cSy9BQac8LcNzb4ir32mRB178SejNbLnf95VdF8PQe2` (state RELEASED).
- **Certification from the browser (2026-09-24):** `/certify` with Dev wallet A as partner: Metaplex Core asset `FEM7HG84tRevMsUWcazdYJJhDCu2tWDLYpDdFeyKm4xG` minted with umi, `mint_passport` SN-2026-000005, `attach_seal`.
- **Triggered indicator, software path (2026-09-24):** `/scan` → simulator tap (counter 20) → "Test image: 40 °C triggered" (five synthetic frames instead of the camera) → media upload with matching sha256 → reading "Heat: above 40 °C recorded" → tier-2 signature → `record_scan` → grade C.
- **Arweave via Irys devnet (2026-09-24):** tier-2 scan counter 21 on SN-2026-000001 with `FV_ARWEAVE=true`: frames → `ar://DZptJtGsi4T63Q9PsQ4gHjzAyP44y8oRYeApuw5bDxcy`, canonical bundle → `ar://CUmyCgM4hEUzN55aEChBpdoJwxWG6oLhBfN6ihz9bXZN`; the bundle fetched from the gateway hashed to the on-chain `bundle_hash`. Irys devnet data is pruned after about 60 days.
