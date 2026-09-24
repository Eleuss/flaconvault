# `flacon` on Devnet

Anchor program `programs/flacon` (briefing §6). Toolchain: Anchor CLI 1.2.0, Solana CLI 4.1.x (Agave), Rust 1.89 (`rust-toolchain.toml`), Node 24, `@anchor-lang/core` 1.2.0 (the npm client for Anchor 1.x — `@coral-xyz/anchor` 0.32 cannot read 1.x IDLs).

## Addresses

| What | Value |
|---|---|
| Program id | `7dCr825ibTyE6Y5oPHP2RCmUi5qFPCaKdZmE9TYeAcWL` — [explorer](https://explorer.solana.com/address/7dCr825ibTyE6Y5oPHP2RCmUi5qFPCaKdZmE9TYeAcWL?cluster=devnet) |
| Upgrade authority / deploy wallet | `Bsy5DFxtugs5PGqjF8ADrPYm7kt89dFpwEe9hTZokpFy` (`~/.config/solana/id.json`) — [explorer](https://explorer.solana.com/address/Bsy5DFxtugs5PGqjF8ADrPYm7kt89dFpwEe9hTZokpFy?cluster=devnet) |
| Registry PDA `["registry"]` | `4JPPCBA7DpbmfDsq1oHDuiJD1zL8VhfuJSoWQyYZXZWt` — [explorer](https://explorer.solana.com/address/4JPPCBA7DpbmfDsq1oHDuiJD1zL8VhfuJSoWQyYZXZWt?cluster=devnet) |
| Deployed 2026-09-24 (slot 503146565), IDL account initialised (`anchor idl init`). Explorer: https://explorer.solana.com/address/7dCr825ibTyE6Y5oPHP2RCmUi5qFPCaKdZmE9TYeAcWL?cluster=devnet

The program id is fixed in `Anchor.toml` (`[programs.localnet]` / `[programs.devnet]`), `declare_id!` in `programs/flacon/src/lib.rs`, `.env.example` (`FV_PROGRAM_ID`, `NEXT_PUBLIC_PROGRAM_ID`) and `apps/verify/.env`. The program keypair lives in `target/deploy/flacon-keypair.json` (git-ignored — back it up; it is only needed for the *first* deploy, upgrades are signed by the wallet).

## Deploy status (23.09.2026)

Build and all tests are green (`anchor test`: 15 passing, `cargo test -p flacon`: 9 passing). **Deploy to devnet has not happened yet**: the wallet holds 0 SOL and `solana airdrop` (2 and 1 SOL, ~20 attempts over ~20 min against `api.devnet.solana.com`) was rate-limited every time. As soon as the wallet has ≥ 2 SOL (web faucet <https://faucet.solana.com> with the address above, or a transfer), run the deploy + seed commands below and paste the deploy tx into the table.

## Seeded registry (what `scripts/seed-devnet.ts` writes)

| Item | Value |
|---|---|
| authority | the wallet above |
| server key | `key_id 1`, `valid_from 0`, `valid_to 0` (open-ended); pubkey = `docs/vectors.json` `serverTestKey.pubkeyHex` = `8ddafff75fe35b174d24fca867f796bc253e32363a456f3486214f01c457ee01` (**TEST ONLY** — for the real verifier use `--server-pubkey <hex>` or `--server-pubkey-from-env`) |
| partner | the wallet above (`Bsy5DFxtugs5PGqjF8ADrPYm7kt89dFpwEe9hTZokpFy`) |
| site 1 | `Parfümerie X, Düsseldorf` |
| site 2 | `FlaconVault Vault, Wickede` |

Verified end-to-end against a local validator (`anchor localnet --validator legacy`): first run creates everything, second run skips everything (idempotent).

## Commands

```bash
export PATH="$HOME/.local/node/bin:$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.avm/bin:$PATH"
cd ~/Projects/flaconvault

# build (also regenerates target/idl/flacon.json and target/types/flacon.ts)
anchor build

# unit tests (message reconstruction vs docs/vectors.json, grade table, ed25519 parser)
cargo test -p flacon

# integration tests on a local validator (Anchor 1.2 defaults to `surfpool`, which is not installed)
anchor test --validator legacy            # or: ANCHOR_TEST_VALIDATOR=legacy anchor test

# devnet
solana config set --url https://api.devnet.solana.com
solana airdrop 2                          # retry; devnet rate-limits
anchor deploy --provider.cluster devnet   # prints the deploy signature → put it in the table above
npx tsx scripts/seed-devnet.ts            # idempotent; defaults: devnet + ~/.config/solana/id.json + vectors test key
npx tsx scripts/seed-devnet.ts --server-pubkey-from-env   # derive the key from FV_SERVER_ED25519_SEED in apps/verify/.env
npx tsx scripts/seed-devnet.ts --server-pubkey <32-byte-hex>

# copy the IDL + types for the web app (already done for the current build)
cp target/idl/flacon.json packages/proof/src/idl/flacon.json
cp target/types/flacon.ts  packages/proof/src/idl/flacon.ts

# read a registry / passport / seal / scan_proof account from devnet
solana account 4JPPCBA7DpbmfDsq1oHDuiJD1zL8VhfuJSoWQyYZXZWt --url devnet
```

`scripts/seed-devnet.ts` honours `ANCHOR_PROVIDER_URL` and `ANCHOR_WALLET`; e.g. `ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 npx tsx scripts/seed-devnet.ts` after `anchor localnet --validator legacy`.

## Program surface (for the web app)

PDAs (seeds from `docs/vectors.json` → `constants.PDA_SEEDS`):

| Account | Seeds |
|---|---|
| `Registry` | `["registry"]` |
| `Passport` | `["passport", serial_hash]` |
| `Seal` | `["seal", uid_hash]` |
| `ScanProof` | `["scan", seal_pubkey, counter u32 LE]` |
| `Origin` | `["origin", passport]` — reserved, not implemented |

Instructions: `init_registry`, `add_server_key`, `add_partner`, `add_site` (authority only); `mint_passport`, `attach_seal`, `mark_seal_dead` (partner or authority); `record_scan(args)` (any signer for tier ≤ 2 / role OWNER·SELLER·BUYER, partner for tier ≥ 3 or role VAULT·PARTNER).

`record_scan` must be sent as `[Ed25519Program.createInstructionWithPublicKey({publicKey: serverPubkey, message, signature}), flacon.record_scan(args)]` — the program reads the previous instruction from the instructions sysvar, checks that it is the ed25519 precompile, that the pubkey is the registry server key `args.server_key_id` valid at `args.ts`, and that the signed 152-byte message equals the reconstruction (`"FVSCAN1" ‖ serial_hash ‖ uid_hash ‖ counter ‖ tamper ‖ uv ‖ hum ‖ heat ‖ fill ‖ media_hash ‖ nonce ‖ ts`) byte for byte. Error codes are typed (`MissingEd25519Instruction`, `MessageMismatch`, `CounterNotIncreasing`, `SealDead`, `NotPartner`, …) — see `target/types/flacon_errors.ts`. Events: `RegistryInitialized`, `ServerKeyAdded`, `PartnerAdded`, `SiteAdded`, `PassportMinted`, `SealAttached`, `SealMarkedDead`, `ScanRecorded`.

All enum values (`tamper`, `indicator`, `tier`, `role`, `grade`, `seal_kind`, `event`), the seeds, `MSG_PREFIX`, `MSG_LEN` and the grade thresholds (`GRADE_FILL_A_MIN = 90`, `GRADE_FILL_B_MIN = 60`) are IDL constants (`program.rawIdl.constants`) and are asserted against `docs/enums.json` / `docs/vectors.json` in `tests/flacon.ts`.

## Funding the deploy wallet (manual step)

`solana airdrop` on the public devnet RPC was rate-limited for more than an hour on 2026-09-23/24. Fund the wallet once by hand:

1. Open https://faucet.solana.com, sign in with GitHub, request **5 SOL** for `Bsy5DFxtugs5PGqjF8ADrPYm7kt89dFpwEe9hTZokpFy` (devnet).
2. Then, from the repo root:

```bash
solana balance --url https://api.devnet.solana.com
anchor deploy --provider.cluster devnet
npx tsx scripts/seed-devnet.ts --server-pubkey-from-env
npx tsx scripts/seed-passports.ts
```

3. Switch the apps to devnet: `NEXT_PUBLIC_SOLANA_RPC=https://api.devnet.solana.com` in `apps/web/.env.local`, `FV_SOLANA_RPC=https://api.devnet.solana.com` in `apps/verify/.env`, restart both.

## First live scan on devnet (2026-09-24)

`/scan` with a simulator tap on `04A1B2C3D4E5F6` (SN-2026-000001), burner wallet `ENUzmguD9tUyqD8Yarhze96KLLbqjBLxtcguXEWz5Thg`, counter 17, grade A:
https://explorer.solana.com/tx/3RETYHEFCnTtYXYGKDHgFeHyeAKWf1jPhBdFcRT77LtLJLJebyNCPykBwLwmYvx2qtLLbqbKAUHHLh9heZUxKrsh?cluster=devnet
(Ed25519 verify instruction + `record_scan` in one transaction; the server event was confirmed with this signature.)

---

# `escrow` (briefing §11, demo scene 6)

Program id `9vabByStbAqKH6sM6fuf8HhfGZbV3993Ncp3uZScexKL` (in `Anchor.toml` localnet + devnet, `declare_id!`, `.env.example` `NEXT_PUBLIC_ESCROW_PROGRAM_ID`). Keypair: `target/deploy/escrow-keypair.json` (git-ignored). **Not yet deployed to devnet** (the coordinator deploys it; then `FV_USDC_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU npx tsx scripts/seed-escrow.ts` with `ANCHOR_PROVIDER_URL=https://api.devnet.solana.com` creates the config against real devnet USDC).

## Localnet (validator on http://127.0.0.1:8899, seeded 24.09.2026)

| What | Value |
|---|---|
| Escrow config PDA `["config"]` | `CJWph4fTD2sJFZoei1x5xCjq18UEAVyHnLQSnLX7JVa7` (admin = CLI wallet, dispute window 604800 s) |
| Test USDC mint (6 dp, mint authority = CLI wallet) | `CNbFcFFupJdDeSyzrTAGbCHMxEq3dst6Y2JrUw7sc68y` → `NEXT_PUBLIC_USDC_MINT` / `FV_USDC_MINT` for localnet |
| Wallet USDC ATA | `7yu9djzfsK9CQ44dy2yE7XvSm5uQhVX3yBvf25AfBhQC` |

```bash
anchor build && anchor deploy --provider.cluster localnet --program-name escrow   # or anchor localnet --validator legacy (deploys both)
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 npx tsx scripts/seed-escrow.ts           # idempotent: mint (if none), init_config(7 d), 1000 USDC to the wallet
anchor test --validator legacy                                                     # tests/escrow.ts + tests/flacon.ts on a fresh validator
```
`scripts/seed-escrow.ts` env: `ANCHOR_PROVIDER_URL` (default localnet), `ANCHOR_WALLET`, `FV_USDC_MINT` (use an existing mint instead of creating one), `FV_DISPUTE_AFTER_S` (default 604800; an existing config is updated to it when the wallet is admin). Mint more test USDC to any wallet with the helpers in `scripts/lib/spl.ts` (`mintTo`, mint authority = CLI wallet).

## Flow

```
list(price) ─────────────► LISTED ──cancel()──► CANCELLED ──close_order()──► (account closed, re-listable)
   │ deposit_asset() (optional, Core asset → Order PDA)
reserve() [buyer, USDC → vault] ─► RESERVED
record_pre_ship_scan() [seller, flacon ScanProof attested by seller] ─► PRESHIP_SCANNED
ship() [seller] ─► SHIPPED
record_receipt_scan() [buyer, ScanProof attested by buyer] ─► heat ==, hum ==, |Δfill| ≤ 5 ? RECEIPT_SCANNED : MISMATCH
release() [anyone, from RECEIPT_SCANNED] ─► USDC → seller, asset → buyer, RELEASED
dispute() ─► USDC → buyer, asset → seller, DISPUTE:  admin from RESERVED/PRESHIP_SCANNED/SHIPPED/MISMATCH ·
             buyer from MISMATCH (= refund_mismatch) · buyer from SHIPPED when clock > shipped_at + dispute_after_s ·
             buyer from any funded state with a dead flacon Seal passed in
```
States (u8, IDL constants `ORDER_STATE_*`): 0 LISTED · 1 RESERVED · 2 PRESHIP_SCANNED · 3 SHIPPED · 4 RECEIPT_SCANNED · 5 RELEASED · 6 MISMATCH · 7 DISPUTE · 8 CANCELLED. Dispute reasons in the `OrderDisputed` event (`DISPUTE_REASON_*`): 0 ADMIN · 1 TIMEOUT · 2 SEAL_DEAD · 3 MISMATCH.

Vault: SPL token account PDA `["vault", order]`, authority = Order PDA, created at `reserve` (rent paid by the buyer) and closed at `release`/`dispute` (rent back to the buyer). flacon accounts are typed via the `flacon` crate (`Account<'info, flacon::Passport|Seal|ScanProof>`: owner + discriminator enforced). Core asset custody: `deposit_asset` (LISTED only) moves the asset to the Order PDA with a hand-rolled mpl-core `TransferV1` CPI; `release`/`dispute`/`cancel` then take the optional `asset` + `mpl_core_program` accounts (pass `null` when nothing was deposited). Metaplex Core must be on the validator for that path (Anchor.toml clones it from devnet for `anchor test`/`anchor localnet`).

## Account layouts (byte offsets after the 8-byte Anchor discriminator)

`EscrowConfig` (81 bytes): `admin` Pubkey @8 · `usdc_mint` Pubkey @40 · `dispute_after_s` i64 LE @72 · `bump` u8 @80.

`Order` (244 bytes): `passport` Pubkey @8 · `seller` @40 · `buyer` @72 (zero until reserved) · `asset` @104 · `price` u64 LE @136 · `state` u8 @144 · `listed_at` i64 @145 · `reserved_at` i64 @153 · `shipped_at` i64 @161 · `seller_scan` Pubkey @169 · `buyer_scan` Pubkey @201 · `dispute_after_s` i64 @233 · `asset_deposited` bool @241 · `bump` u8 @242 · `vault_bump` u8 @243.

Useful `memcmp` filters for `getProgramAccounts(escrow)`: orders of a seller → offset 40; of a buyer → offset 72; for a passport → offset 8; by state → offset 144 (1 byte).

## Instruction accounts (TS names)

| ix | accounts (`accountsStrict`) |
|---|---|
| `initConfig(disputeAfterS)` | config, admin (signer), usdcMint, systemProgram |
| `setDisputeWindow(disputeAfterS)` | config, admin |
| `list(price)` | config, passport (flacon), order, seller (signer), systemProgram |
| `depositAsset()` | order, seller, asset, mplCoreProgram, systemProgram |
| `cancel()` | order, seller, asset?, mplCoreProgram?, systemProgram |
| `closeOrder()` | order, seller |
| `reserve()` | config, order, buyer (signer), buyerToken, usdcMint, vault, tokenProgram, systemProgram |
| `recordPreShipScan()` | order, seller, scanProof (flacon), seal (flacon) |
| `ship()` | order, seller |
| `recordReceiptScan()` | order, buyer, scanProof, seal, sellerScan (= order.sellerScan) |
| `release()` | config, order, vault, sellerToken, buyer, caller (signer), asset?, mplCoreProgram?, tokenProgram, systemProgram |
| `dispute()` | config, order, vault, buyerToken, buyer, seller, signer, seal?, asset?, mplCoreProgram?, tokenProgram, systemProgram |

IDL + TS types: `packages/proof/src/idl/escrow.json`, `packages/proof/src/idl/escrow.ts`.
