# `flacon` on Devnet

Anchor program `programs/flacon` (briefing §6). Toolchain: Anchor CLI 1.2.0, Solana CLI 4.1.x (Agave), Rust 1.89 (`rust-toolchain.toml`), Node 24, `@anchor-lang/core` 1.2.0 (the npm client for Anchor 1.x — `@coral-xyz/anchor` 0.32 cannot read 1.x IDLs).

## Addresses

| What | Value |
|---|---|
| Program id | `7dCr825ibTyE6Y5oPHP2RCmUi5qFPCaKdZmE9TYeAcWL` — [explorer](https://explorer.solana.com/address/7dCr825ibTyE6Y5oPHP2RCmUi5qFPCaKdZmE9TYeAcWL?cluster=devnet) |
| Upgrade authority / deploy wallet | `Bsy5DFxtugs5PGqjF8ADrPYm7kt89dFpwEe9hTZokpFy` (`~/.config/solana/id.json`) — [explorer](https://explorer.solana.com/address/Bsy5DFxtugs5PGqjF8ADrPYm7kt89dFpwEe9hTZokpFy?cluster=devnet) |
| Registry PDA `["registry"]` | `4JPPCBA7DpbmfDsq1oHDuiJD1zL8VhfuJSoWQyYZXZWt` — [explorer](https://explorer.solana.com/address/4JPPCBA7DpbmfDsq1oHDuiJD1zL8VhfuJSoWQyYZXZWt?cluster=devnet) |
| Deploy tx | **pending** — see status below |

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
