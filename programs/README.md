# On-chain programs

Two Anchor 1.2 programs, deployed on devnet:

| Program | Id | What it does |
|---|---|---|
| `flacon` | `7dCr825ibTyE6Y5oPHP2RCmUi5qFPCaKdZmE9TYeAcWL` | Registry (authority, server keys, partners, sites), `Passport`, `Seal`, one `ScanProof` per server-signed scan (v1); the public record (v2, [`docs/public-record.md`](../docs/public-record.md)): `HolderConfig`, one `Holding` per passport, `record_scan_v2` without a rent account |
| `escrow` | `9vabByStbAqKH6sM6fuf8HhfGZbV3993Ncp3uZScexKL` | USDC escrow with scan-verified handover and optional Metaplex Core custody |

Toolchain (pinned in `Anchor.toml` `[toolchain]` and `rust-toolchain.toml`): Anchor CLI 1.2.0, Solana/Agave 4.1.2, Rust 1.89.0.

## Build, test, IDLs

```bash
# needs on PATH: Anchor CLI (via avm), the Solana CLI (Agave installer), Rust (rustup), Node 22.18 or newer
anchor build                         # target/deploy/*.so, target/idl/*.json, target/types/*.ts
cargo test -p flacon -p escrow       # unit tests: FVSCAN1/FVSCAN2 layout, field rules and hashes vs docs/vectors.json, grade rules, freshness, escrow rules
anchor test --validator legacy       # integration tests in tests/ on a local validator (clones Metaplex Core from devnet)
scripts/test-flacon-litesvm.sh       # record_scan_v2 in LiteSVM: Clock override, actor rules, replay of the v2 vectors (see below)
scripts/test-escrow-time-travel.sh   # escrow window branches and the PassHeldInAccount guard in LiteSVM (see below)

# the web app and the scripts read the committed IDLs; .github/scripts/idl-check.sh (CI: programs.yml) compares them:
cp target/idl/flacon.json packages/proof/src/idl/flacon.json && cp target/types/flacon.ts packages/proof/src/idl/flacon.ts
cp target/idl/escrow.json packages/proof/src/idl/escrow.json && cp target/types/escrow.ts packages/proof/src/idl/escrow.ts
```

`[test] upgradeable = true` deploys the workspace programs upgradeable with the provider wallet as upgrade authority,
because `init_registry` and `init_config` only accept the upgrade authority recorded in the ProgramData account.

The local validator cannot move its clock, so the branches that only open after a dispute window (at least one hour)
run in `programs/escrow/tests/time_travel.rs`: LiteSVM loads the escrow program, the test writes an order in the state
under test and moves the `Clock` sysvar to just before and just after `reserved_at + window` (buyer TIMEOUT refund) and
`shipped_at + window` (`release_after_timeout`); `programs/escrow/tests/held_in_account.rs` writes a LISTED order
for a pass held in an account, which `list` can no longer create, and checks that `reserve` refuses it. LiteSVM 0.10
(Agave 3.1) cannot load the SBPF v3 binary that `anchor build` produces, so `scripts/test-escrow-time-travel.sh` builds
the same source for SBPF v2 into `target/sbf-v2/` first; a plain `cargo test` lists these tests as ignored.

`programs/flacon/tests/record_scan_v2.rs` (`scripts/test-flacon-litesvm.sh`, same SBPF v2 build) sends
`record_scan_v2` from a fee payer that is in no instruction: the ±600 s boundaries and key validity at `ts` and at the
clock under a `Clock` override, every actor rule, the setup instructions, and the six `docs/vectors.json` `v2.scans`
byte for byte at their signed `ts` (grade, void and `scan_head` after each equal the TypeScript generator). This
LiteSVM build has no precompiles, so the test registers a builtin at the Ed25519 program id that verifies each
signature itself; the real precompile runs in `tests/public-record.ts`. The vectors are signed for `7dCr…`, so this
script runs before `anchor keys sync` (CI does).

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

Deploy (and upgrade) only binaries from `anchor build --verifiable`, which writes them to `target/verifiable/*.so`:
`anchor deploy --verifiable`, or `anchor upgrade target/verifiable/<program>.so` (`target/deploy/` holds the last plain
build). Note the commit next to the deploy signature in `docs/devnet.md`; a plain `anchor build` is not
byte-reproducible across machines.

## Upgrade compatibility

Every account layout is frozen (`Registry`, `ServerKey`, `Site`, `Passport`, `Seal`, `ScanProof`, `EscrowConfig`,
`Order`; compile-time size asserts in both `state.rs`), the signed 152-byte scan message is unchanged, new error
variants are appended after the existing ones (existing codes keep their numbers), and new accounts are appended at the
end of an instruction's account list. The v2 accounts `HolderConfig` (8 + 219 bytes) and `Holding` (8 + 221 bytes) are
new, with their final layout and size asserts (`_ASSERT_V2_LAYOUTS`) from P1. An upgrade therefore keeps every devnet
account readable. Behaviour that changed for existing accounts:

- Server keys are checked against the cluster clock as well as the signed `ts`, and `|ts − clock| ≤ 600 s`
  (`MAX_SCAN_TS_SKEW_S`): signatures older than ten minutes (including every published seed/vector signature) can no
  longer be anchored. Retire leaked keys with `revoke_server_key`.
- VOID and C are sticky; A/B/D follow the latest scan's fill level (a fill reading is set with a slider and no tier
  verifies it, so one wrong or malicious low reading must not degrade a passport for good; a C bottle stays C at any
  fill level). A passport whose grade is VOID counts as void everywhere (no scans, no new seals, no listing, no
  reservation) even when its `void` flag was never set, e.g. after an OPENED scan before this upgrade.
- `mint_passport` requires a Metaplex Core asset owned by the issuer; passports minted earlier with a placeholder
  asset keep it and can only be listed by their issuer, and only while the issuer is still a partner.
- `reserve` checks the seller again (unless the asset is in the order's custody), so orders listed before the upgrade,
  or whose seller has given the Core asset away since, cannot be bought.
- The shipping scan must be dated no earlier than `reserved_at − 600 s` and the receipt scan no earlier than
  `shipped_at − 600 s`; orders already past those steps are not affected.
- A dead seal no longer lets the buyer refund a SHIPPED order; the admin decides (see "Escrow admin duties").
- Orders listed before the upgrade keep their stored `dispute_after_s`; the program clamps it to 1 h ..= 60 days when
  it evaluates a deadline.
- The escrow refuses to list or reserve a pass held in a FlaconVault account (`passport.asset` owned by the flacon
  program, i.e. its `Holding`): `PassHeldInAccount`. Ship it in the same upgrade as `mint_passport_v2`. v1 passports are
  not affected.
- v1 `record_scan` is unchanged and does not fold into `Holding.scan_head`; a v1 passport takes v2 scans once
  `init_holding_v1` created its Holding.

The public record makes flacon larger: a plain `anchor build` of P1 is 464,976 bytes (328,936 before P1; the devnet
ProgramData holds 342,384), escrow 420,384 (417,992; devnet 432,296). Extend flacon before `anchor upgrade` (see
[`docs/devnet.md`](../docs/devnet.md#public-record-p1-rollout)).

## flacon instructions

| Instruction | Who | Notes |
|---|---|---|
| `init_registry()` | upgrade authority | accounts `registry, authority, system_program, program, program_data` |
| `add_server_key(key_id, pubkey, valid_from, valid_to)` | authority | `valid_to = 0` open-ended |
| `revoke_server_key(key_id)` | authority | sets `valid_to = clock − 1`; the key_id stays taken |
| `add_partner(partner)` / `remove_partner(partner)` | authority | a removed partner also loses seal rights on its passports |
| `transfer_authority()` | authority **and** new authority sign | accounts `registry, authority, new_authority` |
| `add_site(site_id, label)` | authority | |
| `mint_passport(serial_hash, binding_hash, asset)` | partner or authority | extra last account `core_asset` = `asset`, must be a Core `AssetV1` owned by the issuer (`AssetNotOwnedByIssuer`) |
| `attach_seal(uid_hash, kind)` | passport issuer (while partner) or authority | not on a void passport, at most `MAX_SEALS_PER_PASSPORT` (2) |
| `mark_seal_dead()` | passport issuer (while partner) or authority | seal dead, passport void, grade VOID |
| `record_scan(args)` | any attester (partner for tier ≥ 3 / VAULT / PARTNER) | `[Ed25519, record_scan]`; key valid at ts and now; fresh ts; counter ≤ 0xFFFFFF; VOID and C sticky, A/B/D from the latest fill; OPENED tamper voids; every accepted scan increments `scan_count` |
| `init_holder_config(cluster_tag, guardian, holder_key, registrar_key)` | registry authority (separate payer) | once; `cluster_tag` 1 MAINNET / 2 DEVNET / 3 LOCALNET, immutable; delays 72 h / 7 days |
| `set_holder_config(guardian, holder_key, registrar_key, claim_delay_s, notap_delay_s)` | the current registry authority (account `registry` appended last) | delays 1 day ..= 30 days; `holder_config.authority` is re-synced to the registry authority, so a `transfer_authority` also moves this; the tag and pause stay |
| `init_holding_v1()` | registry authority (separate payer) | the Holding of a v1 passport, state WALLET (the Core-asset owner rule applies), no commitment |
| `mint_passport_v2(serial_hash, binding_hash, commitment)` | partner or authority (separate payer) | no Core asset: `passport.asset` = the new Holding PDA (state ACCOUNT, epoch 0); `commitment` ≠ 0 |
| `attach_seal_v2(uid_hash, kind)` | as `attach_seal` (separate payer) | same checks and order as `attach_seal` |
| `record_scan_v2(server_key_id)` | anyone pays the fee; WALLET / PARTNER actors co-sign (`actor_signer`) | top level only; `[Ed25519 over the 256-byte FVSCAN2, record_scan_v2]`; program id and HolderConfig cluster tag signed; same key, freshness, counter, seal and void checks as `record_scan`; creates nothing; folds `holding.scan_head`; only HOLDER, WALLET and PARTNER scans change grade and void (a scan without fill reading keeps A/B/D); event `ScanRecordedV2` via `emit_cpi!` (accounts `event_authority`, `program` last) |

## escrow instructions

| Instruction | Who | Notes |
|---|---|---|
| `init_config(dispute_after_s)` | upgrade authority | accounts `…, program, program_data`; window 1 h ..= 60 days |
| `set_dispute_window(dispute_after_s)` | admin | 1 h ..= 60 days, future orders only |
| `list(price)` | owner of the passport's Core asset (if there is none: the issuer while still a partner or the authority) | extra accounts `asset` = `passport.asset`, then the flacon `registry`; void passports refused; a pass held in a FlaconVault account (`asset` is its flacon Holding) is refused (`PassHeldInAccount`), by `reserve` too |
| `deposit_asset()` / `cancel()` / `close_order()` | seller | custody, withdraw while LISTED, reclaim a terminal order |
| `reserve(expected_price)` | buyer | `expected_price == order.price`; extra accounts `passport` (void refused), `asset` = `order.asset`, flacon `registry`: unless the asset is in custody the seller must still pass the `list` rule |
| `record_pre_ship_scan()` / `ship()` | seller | the scan must be dated ≥ `reserved_at − 600 s` (`ScanBeforeOrderStep`) |
| `record_receipt_scan()` | buyer | dated ≥ `shipped_at − 600 s`; match → RECEIPT_SCANNED, else MISMATCH |
| `release()` | anyone | RECEIPT_SCANNED → USDC to the seller (custody asset to the buyer) |
| `release_after_timeout()` | anyone | SHIPPED and no receipt scan within the window after `ship` → USDC to the seller |
| `dispute()` | admin (RESERVED / PRESHIP_SCANNED / SHIPPED); buyer when not shipped within the window after `reserve`, or with a dead seal before `ship` (after `ship`: `DeadSealAfterShipping`, the admin decides) | USDC back to the buyer |
| `resolve(to_seller)` | admin | settles MISMATCH: `true` pays the seller (RELEASED), `false` refunds the buyer (DISPUTE) |

The rules live in `programs/escrow/src/rules.rs` (unit-tested) and are mirrored for the web app in
`apps/web/src/lib/escrow-rules.ts` (tested in `tests/web-escrow-rules.ts`). The instruction builders the web app, the
Blink and `scripts/list-order.ts` send are in `apps/web/src/lib/escrow-ix.ts`; `tests/escrow.ts` pays a seller
without a USDC account through them.

## Escrow admin duties

Some outcomes the program cannot decide from chain data, so they wait for the escrow admin (`config.admin`), who
settles them with `dispute` (refund to the buyer) or `resolve` (MISMATCH):

- **Shipped, never arrived.** `ship()` needs no proof of handover. A buyer cannot record a receipt scan without the
  bottle, and after `shipped_at + window` anyone may call `release_after_timeout`, which pays the seller. A buyer who
  reports non-delivery before the receipt deadline (the order page shows them how to reach the admin, set
  `NEXT_PUBLIC_ESCROW_ADMIN_CONTACT` to a `mailto:` or `https:` link) must get an answer before that deadline: check
  the carrier's tracking with the seller and refund with `dispute` from SHIPPED if the parcel did not arrive.
- **Seal dead after shipping.** The program cannot tell whether the seal died before the parcel left or after it
  arrived (a `Seal` has no `dead_at`), and the issuer or the registry authority can mark a seal dead, so only the admin
  may refund a SHIPPED order on a dead seal.
- **Scans disagree (MISMATCH).** Review both ScanProofs and photos, then `resolve(to_seller)`.

The admin key is also the registry authority and the upgrade authority on devnet: keep it off shared machines.

## Ops scripts

`scripts/seed-devnet.ts` (registry; explicit server key, `--key-id`, keeps a key already registered under any valid
key_id so it can be re-run after a rotation), `scripts/server-key.ts` (add / revoke / list),
`scripts/partner.ts` (add / remove / list), `scripts/seed-escrow.ts`, `scripts/seed-passports.ts`,
`scripts/bind-chip.ts`, `scripts/list-order.ts`, `scripts/fund-dev-wallet.ts`, and for the public record
`scripts/holder-config.ts` (init / show) and `scripts/init-holdings.ts` (`init_holding_v1` for every v1 passport,
`--dry-run`). All honour `ANCHOR_PROVIDER_URL`
(default devnet) and `ANCHOR_WALLET`; set `ANCHOR_PROVIDER_URL=http://127.0.0.1:8899` to work against a local validator.
