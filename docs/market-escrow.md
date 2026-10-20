# Market escrow (`programs/market_escrow`)

Non-custodial escrow for crypto payment in the marketplace (blueprint `04-marketplace-blueprint.md` §7.2 and §7.3 in the marketplace repository). The buyer pays USDC or EURC from their own wallet. The program holds the money in a vault per order. Fixed rules decide whether the money goes to the seller or back to the buyer. No FlaconVault key can move it.

Devnet only. Mainnet needs the legal opinion (blueprint §16, questions 2 to 4), an audit, a verifiable build and the data protection impact assessment first. Devnet addresses: [`devnet.md`](devnet.md#market-escrow).

## Guarantees

The guarantees hold by construction and are tested in `programs/market_escrow/src/rules.rs` and `tests/market-escrow.ts`.

- **Where money can go.** Only to the buyer's and the seller's associated token accounts, and on release to the program-owned fee vault of the mint. The accounts fix every destination (`associated_token::authority = order.buyer` / `order.seller`, fee vault PDA `["fees", mint]`). A caller chooses *when* a payout happens, never *where* it goes.
- **No admin instructions.** The config is created once by the upgrade authority. No instruction changes it, pauses, freezes or sweeps. The program has 14 instructions; `tests/market-escrow.ts` asserts the exact list.
- **The offer key fixes terms, nothing else.** `open_and_deposit` only accepts terms signed by the offer key. The buyer still signs and pays the deposit. The program bounds the signed terms, so even a misused key cannot sign fees above 20 %, a review window other than the lane's, or deadlines outside the ranges below.
- **The arbiter only halts and rules.** It can open a dispute on a shipped order inside the review window. It can rule `RELEASE` or full `REFUND` before T_max, with a published reason hash. The ruling waits for the order's 48–72 h timelock. During the timelock, buyer and seller can still settle between themselves.
- **No key is needed for the money to leave.** Every state that holds money has an exit that anyone may trigger after a bounded time. Losing or withholding the offer key, the arbiter key or the upgrade authority cannot lock funds. The longest possible lock is 30 + 14 + 60 days + 72 h = 107 days.

| State | Exit anyone can trigger | When |
|---|---|---|
| `PAID` | `refund_unshipped`, everything to the buyer | after the signed ship deadline |
| `SHIPPED` | `release_after_window`, to the seller and the fee vault | after the lane's review window (S 10 days, A 14 days) |
| `DISPUTED` | `refund_after_tmax`, everything to the buyer | after T_max (the signed ruling window after the dispute) |
| `RULED` | `execute_ruling`, as ruled | after the signed timelock |

- **Fees leave the vault only on release.** A full refund returns the buyer fee too. A settlement splits the whole deposit between buyer and seller without fees. Fees in the fee vault go only to the fixed fee recipient: `collect_fees` (anyone) sends them to its associated token account. The program owns the fee vaults, so FlaconVault cannot block a seller's release by closing or reassigning its own fee account.
- **Independent of the passport program.** The program reads no `flacon` accounts, and no `flacon` key (registry authority, server keys, partners) touches the money.
- **Rent.** `rent_payer` (the sponsor, or the buyer) pays the rent of the order account and its vault. `close_order` (anyone, once the order is terminal and its offer has expired) gives the rent back to that payer. Tokens sent to an emptied vault go to the buyer.

## Flow

```text
open_and_deposit ─▶ PAID ─mark_shipped─▶ SHIPPED ─confirm / release_after_window─▶ RELEASED
                     │                     └─dispute─▶ DISPUTED ─rule─▶ RULED ─execute_ruling─▶ RELEASED | REFUNDED
                     │                                  │  └─refund_after_tmax─▶ REFUNDED   │
                     │                                  └──propose + accept_settlement──────┴─▶ SETTLED
                     └─refund_unshipped (after the ship deadline)─▶ REFUNDED
RELEASED | REFUNDED | SETTLED ─close_order─▶ accounts closed, rent back to the rent payer
```

| Instruction | Who | Allowed when | Money |
|---|---|---|---|
| `init_config(offer_key, arbiter, fee_recipient)` | upgrade authority, once | no config yet | creates the fee vaults of both mints |
| `open_and_deposit(args)` | buyer (+ `rent_payer`) | directly after the Ed25519 instruction with the offer key's signature; terms within bounds | buyer → vault: `amount + buyer_fee` |
| `mark_shipped()` | seller | `PAID`, `now ≤ ship_deadline` | none; starts the review window |
| `confirm()` | buyer | `SHIPPED`, or `DISPUTED` (withdraws the dispute) | release |
| `release_after_window()` | anyone | `SHIPPED`, `now > shipped_at + review window` | release |
| `refund_unshipped()` | anyone | `PAID`, `now > ship_deadline` | full refund |
| `dispute()` | buyer or arbiter | `SHIPPED`, `now ≤ shipped_at + review window` | none; halts |
| `propose_settlement(to_buyer)` | buyer or seller | `DISPUTED` or `RULED`; `to_buyer ≤ deposit` | none; replaces an earlier proposal |
| `accept_settlement(expected_to_buyer)` | the other party | the open proposal, exactly `expected_to_buyer` | `to_buyer` → buyer, the rest → seller |
| `rule(ruling, reason_hash)` | arbiter | `DISPUTED`, `now ≤ disputed_at + ruling window` (T_max); `RELEASE` or `REFUND`; non-zero hash | none; starts the timelock |
| `execute_ruling()` | anyone | `RULED`, `now > ruled_at + timelock` | release or full refund |
| `refund_after_tmax()` | anyone | `DISPUTED`, `now > T_max` | full refund |
| `collect_fees()` | anyone | any time | fee vault → the fee recipient's associated token account |
| `close_order()` | anyone | terminal, `now > offer expiry` | rent → `rent_payer`; leftover tokens → buyer |

The deadlines never overlap. At any instant exactly one of `mark_shipped` and `refund_unshipped` is possible, one of `dispute` and `release_after_window`, and one of `rule` and `refund_after_tmax`.

- **Release:** the seller gets `amount − seller_fee`, the fee vault gets `buyer_fee + seller_fee`. For the 300 € example of blueprint §8 that is 315 deposited, 291 to the seller and 24 in fees.
- **Full refund:** `amount + buyer_fee` back to the buyer.

## Bounds on the signed terms

| Term | Bound | Error |
|---|---|---|
| `expiry` | `now ≤ expiry ≤ now + 1 h` | `OfferExpired`, `OfferExpiryTooFar` |
| `amount` | `> 0`, `amount + buyer_fee` fits in u64 | `InvalidAmount` |
| `buyer_fee`, `seller_fee` | each ≤ 20 % of `amount` | `FeeTooHigh` |
| `lane` | S (1) or A (2); G (3) is not offered with crypto | `InvalidLane`, `LaneNotSupported` |
| review window | fixed by the lane: S 10 days, A 14 days (not signed) | |
| `ship_deadline` | 1 to 30 days after `open_and_deposit` | `InvalidShipDeadline` |
| `ruling_window_s` (T_max after the dispute) | 7 to 60 days | `InvalidRulingWindow` |
| `timelock_s` | 48 to 72 h | `InvalidTimelock` |
| `seller` | not the buyer, not the arbiter, not the default key | `InvalidSeller` |
| buyer | not the arbiter | `BuyerIsArbiter` |
| mint | `config.mints` (USDC, EURC: classic SPL Token, 6 decimals) | `MintNotAllowed` |

## Signed offer

The transaction is `[Ed25519Program.createInstructionWithPublicKey({ publicKey: offerKey, message, signature }), open_and_deposit(args)]`. Other instructions such as compute budget go before the pair, never between. The message is 201 bytes, integers little endian:

| Offset | Size | Field |
|---|---|---|
| 0 | 8 | `"FVMKTOF1"` |
| 8 | 32 | program id |
| 40 | 16 | `order_id` (16 random bytes, also in the order PDA seeds; not the marketplace order number) |
| 56 | 32 | buyer |
| 88 | 32 | seller (the seller's own wallet) |
| 120 | 32 | mint |
| 152 | 8 | `amount` u64, item price in base units |
| 160 | 8 | `buyer_fee` u64 (buyer protection, on top) |
| 168 | 8 | `seller_fee` u64 (commission, deducted on release) |
| 176 | 1 | `lane` u8 |
| 177 | 8 | `ship_deadline` i64, unix seconds |
| 185 | 4 | `ruling_window_s` u32 |
| 189 | 4 | `timelock_s` u32 |
| 193 | 8 | `expiry` i64, unix seconds |

The reference builder is `offerMessage` in `tests/lib/market-escrow.ts`. The Rust builder is `offer_message` in `programs/market_escrow/src/offer.rs`. Both are tested against the same golden vector:

```text
program id [01;32], buyer [02;32], mint [04;32], order_id [a5;16], seller [03;32], amount 300000000, buyer_fee 15000000,
seller_fee 9000000, lane 1, ship_deadline 1790000000, ruling_window_s 1814400, timelock_s 172800, expiry 1789000600
→ 46564d4b544f4631 01…01 a5…a5 02…02 03…03 04…04 00a3e11100000000 c0e1e40000000000 4054890000000000 01
  803bb16a00000000 80af1b00 00a30200 98fba16a00000000
```

Before a label is issued, the server checks the on-chain order against its own order (blueprint §7.2). The order address is `["morder", buyer, order_id]` under the program id.

## Accounts

| Account | Seeds | Size |
|---|---|---|
| `MarketConfig` | `["config"]` | 171 bytes |
| `MarketOrder` | `["morder", buyer, order_id]` | 292 bytes (offsets in `programs/market_escrow/src/state.rs`) |
| order vault (SPL token account, authority = order PDA) | `["vault", order]` | 165 bytes |
| fee vault (SPL token account, authority = config PDA) | `["fees", mint]` | 165 bytes |

Order states (`STATE_*`): 1 PAID · 2 SHIPPED · 3 DISPUTED · 4 RULED · 5 RELEASED · 6 REFUNDED · 7 SETTLED. `resolution` records why a terminal state was reached: 1 CONFIRMED · 2 WINDOW · 3 RULING_RELEASE · 4 UNSHIPPED · 5 RULING_REFUND · 6 TMAX · 7 SETTLEMENT. All constants are in the IDL.

## Tests

```bash
cargo test -p market_escrow           # rules, offer message (golden vector), Ed25519 parser
anchor test --validator legacy        # tests/market-escrow.ts, with the other programs' tests
npx tsx scripts/market-escrow-fixtures.ts --check   # the committed fixtures match tests/lib/market-escrow.ts
```

The local validator cannot move its clock. The branches that only open days after a step therefore run on aged fixture orders: the refund after the ship deadline, the release after the review window, the execution after the timelock and the refund after T_max. The fixture orders reached that step on 2026-01-01. `Anchor.toml` (`[[test.validator.account_dir]]`) loads them at genesis from `tests/fixtures/market-escrow`. The live orders in the same test cover the "not yet" side of each deadline and check that the program stores the timestamps those branches read.

The fixtures are generated by `scripts/market-escrow-fixtures.ts`. Re-run it after changing `MarketOrder` or the fixtures. Every key in the fixtures and tests is a TEST ONLY key derived from a public label.

## Design choices (deviations from the brief are marked)

1. **Fee vault per mint, owned by the program, plus a permissionless `collect_fees` (deviation: the brief says "fixed fee account").** A fee token account of FlaconVault's own could be closed, reassigned or never created, and every release would then fail. That would give FlaconVault a lever over sellers' money. With a program-owned vault, a release depends only on the seller's own account.
2. **`refund_unshipped` can be sent by anyone (deviation: the brief says the buyer).** The money can only go to the buyer, and the server can cancel automatically at `cancelAt` as in the fiat flow.
3. **The review window comes from the lane, not from the offer.** The offer key cannot shorten the buyer's window.
4. **T_max counts from the dispute** (`ruling_window_s`, 7 to 60 days, signed per order). The arbiter always gets the whole period. A ruling after T_max is refused, so the buyer's fallback refund cannot be overtaken.
5. **Settlements only in `DISPUTED` and `RULED`, with no fees.** The brief says money goes only to buyer, seller and, on release, the fee account. A settlement is not a release. Settling without a dispute is not possible, so a fee-free settlement always leaves a visible dispute on chain.
6. **`confirm` also works in `DISPUTED`**, so the buyer can withdraw a dispute. It does not work in `RULED`: during the timelock only a settlement is possible.
7. **The order account stays until `close_order`, which waits for the offer's expiry.** Closing it earlier would let the same signed offer open the order a second time.
8. **Recipient token accounts must be the associated token accounts** of buyer and seller. Funds always land where wallets look. Clients create a missing one idempotently, paid by the sponsor.
9. **The seller does not sign the deposit.** The offer key attests the seller's terms. `mark_shipped` is the seller's first on-chain signature and is their on-chain acceptance. The seller's app should compare the on-chain terms before shipping.
10. **Fees capped at 20 % each, offer TTL at most 1 hour, and the offer key and arbiter must differ.** These limit what a misused offer key can sign and keep the two roles apart.

## Open questions for the lawyer (blueprint §16, questions 2 to 4)

1. **Arbiter as "control" (MiCA Art. 3(1)(17), ZAG).** The arbiter can only halt a shipped order and choose between release to the seller and full refund to the buyer. Its ruling waits 48–72 h, carries a published reason hash, and lapses after T_max, when the buyer is refunded. Is that control over the funds, or a payment or transfer service? Does it matter whether the arbiter is FlaconVault, an independent person or a licensed institution, and whether its key is a multisig?
2. **The arbiter's power to dispute.** Besides the buyer, the arbiter can open a dispute. If it then never rules, the buyer is refunded at T_max: in effect a refund decision without a reason hash. Should only the buyer be able to open a dispute?
3. **Upgrade authority.** Until the program is frozen, the upgrade authority can replace the code, including the rules above. Is an upgrade right in a timelocked Squads multisig "control over the means of access"? Is freezing after the audit required, or is the timelock enough?
4. **Offer key.** It cannot move funds, but it decides which orders can be opened and on which terms (within the program's bounds). Does signing terms make FlaconVault a party to the payment (ZAG, e-money), or an intermediary of a sale only?
5. **Fees in the payment flow.** On release the program sends the buyer fee and the commission to a FlaconVault-owned fee vault. Is collecting fees inside the escrow a payment service or money transmission (EBA no-action letter of 10.6.2025)? Would collecting them outside the escrow change that?
6. **Settlement without fees.** Buyer and seller can split the deposit after a dispute without FlaconVault. Is a fee-free settlement acceptable (fee evasion by staged disputes), or must the commission apply to the seller's share?
7. **Fallback at T_max.** FlaconVault bears the seller's loss when no ruling comes in time (§7.3). Is that compensation an insurance-like promise (VAG)?
8. **AML and sanctions (GwG, AMLR from 10.7.2027).** The offer key can refuse to sign for sanctioned wallets. Once an order is open, nobody can stop the payout. Is screening at offer time enough?
9. **Issuer freeze.** Circle can freeze USDC and EURC, including the order vaults and fee vaults. A frozen vault blocks every payout of that order. How should the terms cover that?
10. **Personal data on chain.** Wallet addresses, amounts and the order PDA are permanent. The marketplace order number and the tracking number are not on chain. Is a random 16-byte `order_id` enough pseudonymisation for the DPIA (EDPB guidelines 02/2025)?
