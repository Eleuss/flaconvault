# On-chain programs

Two Anchor 1.2 programs, deployed on devnet:

| Program | Id | What it does |
|---|---|---|
| `flacon` | `7dCr825ibTyE6Y5oPHP2RCmUi5qFPCaKdZmE9TYeAcWL` | Registry (authority, server keys, partners, sites), `Passport`, `Seal`, one `ScanProof` per server-signed scan |
| `escrow` | `9vabByStbAqKH6sM6fuf8HhfGZbV3993Ncp3uZScexKL` | USDC escrow with scan-verified handover and optional Metaplex Core custody |

Toolchain (pinned in `Anchor.toml` `[toolchain]` and `rust-toolchain.toml`): Anchor CLI 1.2.0, Solana/Agave 4.1.2, Rust 1.89.0.

## Build, test, IDLs

```bash
export PATH="$HOME/.local/node/bin:$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.avm/bin:$PATH"
anchor build                         # target/deploy/*.so, target/idl/*.json, target/types/*.ts
cargo test -p flacon -p escrow       # unit tests: message layout vs docs/vectors.json, grade rule, freshness, escrow rules
anchor test --validator legacy       # integration tests in tests/ on a local validator (clones Metaplex Core from devnet)

# the web app and the scripts read the committed IDLs:
cp target/idl/flacon.json packages/proof/src/idl/flacon.json && cp target/types/flacon.ts packages/proof/src/idl/flacon.ts
cp target/idl/escrow.json packages/proof/src/idl/escrow.json && cp target/types/escrow.ts packages/proof/src/idl/escrow.ts
```

`[test] upgradeable = true` deploys the workspace programs upgradeable with the provider wallet as upgrade authority,
because `init_registry` and `init_config` only accept the upgrade authority recorded in the ProgramData account.

## Verifiable builds

The pitch is "verify it on chain", so anyone must be able to check that the deployed bytecode was built from this
source. Build inside Anchor's pinned Docker image (needs Docker) and compare with the chain:

```bash
anchor build --verifiable                      # deterministic build in the solanafoundation/anchor image for anchor_version
# verify each program against a commit of the public repository
(cd programs/flacon && anchor verify 7dCr825ibTyE6Y5oPHP2RCmUi5qFPCaKdZmE9TYeAcWL --provider.cluster devnet \
    --repo-url https://github.com/Eleuss/flaconvault --commit-hash <commit>)
(cd programs/escrow && anchor verify 9vabByStbAqKH6sM6fuf8HhfGZbV3993Ncp3uZScexKL --provider.cluster devnet \
    --repo-url https://github.com/Eleuss/flaconvault --commit-hash <commit>)
```

Deploy (and upgrade) only binaries from `anchor build --verifiable`, and note the commit next to the deploy signature in
`docs/devnet.md`; a plain `anchor build` is not byte-reproducible across machines.

## Upgrade compatibility

Every account layout is frozen (`Registry`, `ServerKey`, `Site`, `Passport`, `Seal`, `ScanProof`, `EscrowConfig`,
`Order`; compile-time size asserts in both `state.rs`), the signed 152-byte scan message is unchanged, new error
variants are appended after the existing ones (existing codes keep their numbers), and new accounts are appended at the
end of an instruction's account list. An upgrade therefore keeps every devnet account readable. Behaviour that changed
for existing accounts:

- Server keys are checked against the cluster clock as well as the signed `ts`, and `|ts − clock| ≤ 600 s`
  (`MAX_SCAN_TS_SKEW_S`): signatures older than ten minutes (including every published seed/vector signature) can no
  longer be anchored. Retire leaked keys with `revoke_server_key`.
- Grades only get worse. A passport whose grade is VOID counts as void everywhere (no scans, no new seals, no listing,
  no reservation) even when its `void` flag was never set, e.g. after an OPENED scan before this upgrade.
- `mint_passport` requires a Metaplex Core asset; passports minted earlier with a placeholder asset keep it and can
  only be listed by their issuer.
- Orders listed before the upgrade keep their stored `dispute_after_s`; the program clamps it to 1 h ..= 60 days when
  it evaluates a deadline.

## flacon instructions

| Instruction | Who | Notes |
|---|---|---|
| `init_registry()` | upgrade authority | accounts `registry, authority, system_program, program, program_data` |
| `add_server_key(key_id, pubkey, valid_from, valid_to)` | authority | `valid_to = 0` open-ended |
| `revoke_server_key(key_id)` | authority | sets `valid_to = clock − 1`; the key_id stays taken |
| `add_partner(partner)` / `remove_partner(partner)` | authority | a removed partner also loses seal rights on its passports |
| `transfer_authority()` | authority **and** new authority sign | accounts `registry, authority, new_authority` |
| `add_site(site_id, label)` | authority | |
| `mint_passport(serial_hash, binding_hash, asset)` | partner or authority | extra last account `core_asset` = `asset`, must be a Core `AssetV1` |
| `attach_seal(uid_hash, kind)` | passport issuer (while partner) or authority | not on a void passport, at most `MAX_SEALS_PER_PASSPORT` (2) |
| `mark_seal_dead()` | passport issuer (while partner) or authority | seal dead, passport void, grade VOID |
| `record_scan(args)` | any attester (partner for tier ≥ 3 / VAULT / PARTNER) | `[Ed25519, record_scan]`; key valid at ts and now; fresh ts; counter ≤ 0xFFFFFF; `grade = worst(old, scan)`; OPENED tamper voids; every accepted scan increments `scan_count` |

## escrow instructions

| Instruction | Who | Notes |
|---|---|---|
| `init_config(dispute_after_s)` | upgrade authority | accounts `…, program, program_data`; window 1 h ..= 60 days |
| `set_dispute_window(dispute_after_s)` | admin | 1 h ..= 60 days, future orders only |
| `list(price)` | owner of the passport's Core asset (issuer if there is none) | extra last account `asset` = `passport.asset`; void passports refused |
| `deposit_asset()` / `cancel()` / `close_order()` | seller | custody, withdraw while LISTED, reclaim a terminal order |
| `reserve(expected_price)` | buyer | `expected_price == order.price`; extra last account `passport` (void refused) |
| `record_pre_ship_scan()` / `ship()` | seller | |
| `record_receipt_scan()` | buyer | match → RECEIPT_SCANNED, else MISMATCH |
| `release()` | anyone | RECEIPT_SCANNED → USDC to the seller (custody asset to the buyer) |
| `release_after_timeout()` | anyone | SHIPPED and no receipt scan within the window after `ship` → USDC to the seller |
| `dispute()` | admin (RESERVED / PRESHIP_SCANNED / SHIPPED); buyer when not shipped within the window after `reserve`, or with a dead seal before a matching receipt | USDC back to the buyer |
| `resolve(to_seller)` | admin | settles MISMATCH: `true` pays the seller (RELEASED), `false` refunds the buyer (DISPUTE) |

The rules live in `programs/escrow/src/rules.rs` (unit-tested) and are mirrored for the web app in
`apps/web/src/lib/escrow-rules.ts` (tested in `tests/web-escrow-rules.ts`).

## Ops scripts

`scripts/seed-devnet.ts` (registry; explicit server key), `scripts/server-key.ts` (add / revoke / list),
`scripts/partner.ts` (add / remove / list), `scripts/seed-escrow.ts`, `scripts/seed-passports.ts`,
`scripts/bind-chip.ts`, `scripts/list-order.ts`, `scripts/fund-dev-wallet.ts`. All honour `ANCHOR_PROVIDER_URL`
(default devnet) and `ANCHOR_WALLET`; set `ANCHOR_PROVIDER_URL=http://127.0.0.1:8899` to work against a local validator.
