# Public record (P1): binding technical spec

Status: binding for phase P1 of "Relay and Register". Every builder follows this document. When code and this
document disagree, this document wins until it is changed; the generated fixtures (`docs/vectors.json`,
`docs/enums.json`) win over the hex in §5 only if the generator implements this text and the hex here was
mistyped.

P1 goal: every genuine iPhone tap of a FlaconVault seal can land in a public on-chain record without the visitor
needing a wallet, an account, a fee or a signature. The verifier signs the scan (FVSCAN2); a separate fee-payer key
(the relayer) sends `record_scan_v2`, which creates no rent account.

Not in P1 (P2 and later): `transfer_holding`, claims, FVMOVE1, pause/unpause, `retire_pass`, site tickets (only a
stub interface), the market seal lane, the Arweave mirror of relayed scans, v2 MINT/SEAL_ATTACH in
`POST /api/events`, a sealing script, mainnet. The Holding layout already carries the fields those phases need.

Words: **visitor** = actor kind NONE. **holder** = HOLDER or WALLET. **relay scan** = a scan sent by the relayer.
**v1** = FVSCAN1 / `record_scan` / ScanProof, which stays exactly as it is.

---

## 1. Decisions (including fixes to the plan)

| # | Decision | Why |
|---|---|---|
| D1 | `POST /api/verify` field `anchor` defaults to `"wallet"`. The new consumer UI always sends `"relay"`. | Existing clients, scripts and tests keep the v1 path byte for byte. |
| D2 | The relay status endpoint is `GET /api/verify/{eventId}/record?token=…`, not `GET /api/verify/{eventId}`. | `GET /api/verify/{eventId}?token=` is the wallet resume link; its "404 unless pending" contract is used by the web app and tested. |
| D3 | A sixth actor kind `RECIPIENT = 4` exists from P1 on: actor = a prepared commitment that is not the current one, purpose RECEIPT only, evidence only. | The plan's P3 sale needs the buyer's RECEIPT under the *new* commitment; a HOLDER check against `Holding.commitment` (the seller's) would reject it. FVSCAN2 must not change after P1. |
| D4 | `FILL_NONE = 255` marks "no fill reading". Tier SIGHTING (0) ⇔ fill FILL_NONE. A TAP is a tier-0 sighting. A scan with FILL_NONE never changes A/B/D. | A TAP has no reading; without the sentinel a holder's TAP (P2) would read as fill 0 → grade D. |
| D5 | `cluster_tag` lives in `HolderConfig` (set once by `init_holder_config`, immutable). `record_scan_v2` requires `msg.cluster_tag == holder_config.cluster_tag`. Values: MAINNET 1, DEVNET 2, LOCALNET 3; 0 is never valid. | A program cannot detect its cluster, and devnet and mainnet may share the program id. |
| D6 | `record_scan_v2(server_key_id: u8)` has no field arguments. The program parses the FVSCAN2 message out of the Ed25519 instruction and checks it against the accounts. | One source of truth for the fields, smaller transactions, no "args vs message" mismatch class. |
| D7 | `record_scan_v2` has no payer account. The transaction fee payer is whoever sends it. NONE, HOLDER and RECIPIENT scans need no signer at all; WALLET and PARTNER need the actor as an extra signer. | The relayer then appears only as fee payer and in no instruction, which the shape allowlist enforces. |
| D8 | `record_scan_v2` must be a top-level instruction (stack height 1), error `CpiNotAllowed`. | The Ed25519 check reads the top-level instruction list; and `verify-pass` then only has to read top-level instructions. |
| D9 | `verify-pass` lists transactions with `getSignaturesForAddress` on the **Holding PDA**, not the seal PDAs. | Every `record_scan_v2` writes the Holding, so one address covers both seals and nothing else is needed. |
| D10 | Holding gains `head_count u32` and `last_actor_kind u8`; the plan's `pending_wallet` becomes `pending_target` (wallet for CLAIM, new commitment for NOTAP). Size 221 + 8 bytes. | `head_count` lets `verify-pass` say "found 11 of 12"; P3 NOTAP must store its new commitment until finalize. |
| D11 | `init_holding_v1` creates the Holding of a v1 passport in state `WALLET` (= "Passport.asset is not this Holding; the Core-asset owner rule applies"). | v1 passports point at a Core asset (or, for very old ones, a placeholder). |
| D12 | RPC env: primary stays `FV_SOLANA_RPC` (exists); the fallback is `FV_SOLANA_RPC_FALLBACK`. The plan's `FV_RPC_URL` / `FV_RPC_FALLBACK_URL` are not introduced. | One name per setting, matching the existing variable. |
| D13 | The FVSCAN2 message is built and signed once, when the relay row is created (TAP at `/t`, CHECK at `/api/verify`), with `ts` = the time of that event. It is never re-signed. Sending stops at `ts + 570` s. | `ts` keeps meaning "when the seal was checked"; the program accepts ±600 s. |
| D14 | Visitor scans (NONE) never change the passport grade, void flag, or the passport header reading in the verifier either; P1 does not archive relay scans to Arweave. | Same rule off chain as on chain; the archived v1 bundle carries city/note/platform/attester, which v2 keeps out of public bundles. |
| D15 | The verifier never signs FVSCAN1 (`anchor: "wallet"`) for a passport held in an account (`passports.asset` = its Holding PDA): 409 `wallet_anchor_not_allowed`. | v1 `record_scan` stays unchanged and lets any attester change the grade; the verifier signature is the only gate. |
| D16 | Visitor caps are code constants (3 TAP + 1 CHECK per seal per rolling 24 h), not env variables. | Owner decision; no drift between deployments. |
| D17 | `FV_HOLDER_KEY` and `FV_ISSUER_KEY` are parsed and validated in P1 and shown as public keys in the admin status; nothing uses them. No sealing script in P1. | Sealing at the counter is flow (b), P2. |
| D18 | `HolderConfig.paused` does not affect scans. | Pause guards moves (P5); scans are evidence. |
| D19 | The same verifier scan key (`FV_SERVER_ED25519_SEED`) signs FVSCAN1 and FVSCAN2 in P1. | Prefix and length separate the two domains: the v1 parser accepts only 152 bytes, the v2 parser only 256. Key rotation is P0 ops. |
| D20 | Without `FV_PROGRAM_ID`, FVSCAN2 messages use the default flacon id `7dCr825ibTyE6Y5oPHP2RCmUi5qFPCaKdZmE9TYeAcWL` (`DEFAULT_PROGRAM_ID`, like `DEFAULT_ESCROW_PROGRAM_ID`); the relay itself requires `FV_PROGRAM_ID` explicitly. | The consumer flow works on an offline dev server; nothing is sent there. |
| D21 | `apps/verify/fv/enums.json` is **not** generated by `npm run vectors`; it is copied by `apps/verify/scripts/sync_enums.py`. It belongs to the verify group. `docs/layout.py` is card geometry, unrelated, owned by nobody. | Checked in the code. |

---

## 2. Constants and enums

`packages/proof/src/enums.ts` is the source of truth. `npm run vectors` writes them to `docs/enums.json` /
`docs/vectors.json`. Rust exposes each with `#[constant]` (the IDL test in `tests/flacon.ts` requires
`<GROUP>_<KEY>` for every enum group in `docs/enums.json` and `<KEY>_SEED` for every `PDA_SEEDS` key).

### 2.1 New enum groups (appended to `ENUMS` in this order)

| group (`docs/enums.json` key) | values | Rust / IDL constant names |
|---|---|---|
| `purpose` | `TAP 0`, `CHECK 1`, `LIST 2`, `SHIP 3`, `RECEIPT 4`, `CLAIM 5`, `BIRTH 6` | `PURPOSE_TAP` … `PURPOSE_BIRTH` |
| `actor_kind` | `NONE 0`, `HOLDER 1`, `WALLET 2`, `PARTNER 3`, `RECIPIENT 4` | `ACTOR_KIND_NONE` … `ACTOR_KIND_RECIPIENT` |
| `cluster` | `MAINNET 1`, `DEVNET 2`, `LOCALNET 3` | `CLUSTER_MAINNET`, `CLUSTER_DEVNET`, `CLUSTER_LOCALNET` |
| `holding_state` | `ACCOUNT 0`, `CLAIM_PENDING 1`, `WALLET 2` | `HOLDING_STATE_ACCOUNT` … `HOLDING_STATE_WALLET` |

Exact JSON the four groups take in `docs/enums.json` (and therefore in `apps/verify/fv/enums.json`):

```json
"purpose": { "TAP": 0, "CHECK": 1, "LIST": 2, "SHIP": 3, "RECEIPT": 4, "CLAIM": 5, "BIRTH": 6 },
"actor_kind": { "NONE": 0, "HOLDER": 1, "WALLET": 2, "PARTNER": 3, "RECIPIENT": 4 },
"cluster": { "MAINNET": 1, "DEVNET": 2, "LOCALNET": 3 },
"holding_state": { "ACCOUNT": 0, "CLAIM_PENDING": 1, "WALLET": 2 }
```

TS exports: `Purpose`, `ActorKind`, `Cluster`, `HoldingState`, plus `PurposeName`, `ActorKindName`, `ClusterName`,
`HoldingStateName` (inverted maps). Python (`fv/enums.py`): `Purpose`, `ActorKind`, `Cluster`, `HoldingState` as
`_Enum`. Reserved for P3/P4, **not** in `enums.json` in P1: `pending_kind` = `NONE 0`, `NOTAP 1`, `CLAIM 2`.

Cluster names used in env/config are lowercase (`devnet`, `mainnet`, `localnet`) and map to the enum by upper-casing.

### 2.2 New constants

| name (TS, Python, Rust) | value | `vectors.constants` key |
|---|---|---|
| `MSG2_PREFIX` | `"FVSCAN2"` (Rust `b"FVSCAN2"`) | `MSG2_PREFIX` |
| `MSG2_LEN` | `256` (Rust `u16`, plus `MSG2_LEN_BYTES: usize`) | `MSG2_LEN` |
| `SCAN_HEAD_PREFIX` | `"FVHEAD1"` | `SCAN_HEAD_PREFIX` |
| `COMMITMENT_PREFIX` | `"FVHOLD1"` | `COMMITMENT_PREFIX` |
| `FILL_NONE` | `255` | `FILL_NONE` |
| `BUNDLE2_SCHEMA` | `"flaconvault.scanbundle.v2"` | `BUNDLE2_SCHEMA` |
| `PDA_SEEDS.holder_config` / `HOLDER_CONFIG_SEED` | `"holder_config"` | `PDA_SEEDS.holder_config` |
| `PDA_SEEDS.holding` / `HOLDING_SEED` | `"holding"` | `PDA_SEEDS.holding` |
| `MAX_PURPOSE` / `MAX_ACTOR_KIND` (Rust only) | `6` / `4` | – |
| `DEFAULT_CLAIM_DELAY_S` / `DEFAULT_NOTAP_DELAY_S` (Rust `#[constant]`) | `259_200` / `604_800` | – |
| `MIN_HOLD_DELAY_S` / `MAX_HOLD_DELAY_S` (Rust `#[constant]`) | `86_400` / `2_592_000` | – |

Anchor's own event-authority seed `"__event_authority"` is not one of ours and is **not** added to `PDA_SEEDS`.

Discriminators (Anchor: first 8 bytes of sha256 of the shown string):

| item | preimage | bytes (hex) |
|---|---|---|
| ix `record_scan_v2` | `global:record_scan_v2` | `047bf48d93f81ff1` |
| ix `init_holder_config` | `global:init_holder_config` | `d0bac1da36e4ea2b` |
| ix `set_holder_config` | `global:set_holder_config` | `8d2acb3f37c81ab1` |
| ix `init_holding_v1` | `global:init_holding_v1` | `cd98809bc067bb03` |
| ix `mint_passport_v2` | `global:mint_passport_v2` | `c628647296de125a` |
| ix `attach_seal_v2` | `global:attach_seal_v2` | `3faca25aa6fd31e4` |
| account `HolderConfig` | `account:HolderConfig` | `79692a385ecd9930` |
| account `Holding` | `account:Holding` | `176040faebbf0090` |
| event `ScanRecordedV2` | `event:ScanRecordedV2` | `279d104913163f04` |

---

## 3. FVSCAN2: the server-signed scan message (256 bytes)

### 3.1 Layout

All integers little endian. Hashes and keys are raw bytes. No padding.

| offset | width | field | type | content |
|---:|---:|---|---|---|
| 0 | 7 | prefix | bytes | ASCII `FVSCAN2` (`46565343414e32`) |
| 7 | 32 | program_id | pubkey | flacon program id this message is for |
| 39 | 1 | cluster_tag | u8 | `cluster` enum (1 MAINNET, 2 DEVNET, 3 LOCALNET) |
| 40 | 32 | serial_hash | [u8;32] | sha256(serial, UTF-8) = `Passport.serial_hash` |
| 72 | 32 | uid_hash | [u8;32] | sha256(7 raw UID bytes) = `Seal.uid_hash` |
| 104 | 4 | counter | u32 | SUN counter of the tap (≤ 0x00FFFFFF) |
| 108 | 1 | tier | u8 | `tier` enum 0..4 |
| 109 | 1 | role | u8 | `role` enum 0..4 (self-declared; the UI labels by actor kind) |
| 110 | 1 | tamper | u8 | `tamper` enum 0..3 (UNKNOWN 3 for non-TT stickers) |
| 111 | 1 | uv | u8 | `indicator` enum 0..3 |
| 112 | 1 | hum | u8 | `indicator` enum 0..3 |
| 113 | 1 | heat | u8 | `indicator` enum 0..3 |
| 114 | 1 | heat_levels | u8 | 6-bit mask, bit i = Thermax field i |
| 115 | 1 | fill | u8 | 0..100, or 255 = FILL_NONE (no reading) |
| 116 | 2 | site_id | u16 | 0 = none; else a registry site (pro roles only) |
| 118 | 1 | purpose | u8 | `purpose` enum 0..6 |
| 119 | 1 | actor_kind | u8 | `actor_kind` enum 0..4 |
| 120 | 32 | actor | [u8;32] | see §3.2 |
| 152 | 32 | media_hash | [u8;32] | sha256 of the seal frames; 32 zero bytes when none |
| 184 | 32 | bundle_hash | [u8;32] | sha256 of the canonical v2 bundle (§4.3) |
| 216 | 32 | nonce | [u8;32] | see §3.3 |
| 248 | 8 | ts | i64 | unix seconds, see §3.3 |
| 256 | | end | | |

Rust offset constants (`message_v2.rs`): `V2_OFF_PROGRAM_ID = 7`, `V2_OFF_CLUSTER = 39`, `V2_OFF_SERIAL_HASH = 40`,
`V2_OFF_UID_HASH = 72`, `V2_OFF_COUNTER = 104`, `V2_OFF_TIER = 108`, `V2_OFF_ROLE = 109`, `V2_OFF_TAMPER = 110`,
`V2_OFF_UV = 111`, `V2_OFF_HUM = 112`, `V2_OFF_HEAT = 113`, `V2_OFF_HEAT_LEVELS = 114`, `V2_OFF_FILL = 115`,
`V2_OFF_SITE_ID = 116`, `V2_OFF_PURPOSE = 118`, `V2_OFF_ACTOR_KIND = 119`, `V2_OFF_ACTOR = 120`,
`V2_OFF_MEDIA_HASH = 152`, `V2_OFF_BUNDLE_HASH = 184`, `V2_OFF_NONCE = 216`, `V2_OFF_TS = 248`, with
`const _: () = assert!(V2_OFF_TS + 8 == MSG2_LEN_BYTES)` and `assert!(MSG2_PREFIX.len() == V2_OFF_PROGRAM_ID)`.

### 3.2 actor per actor_kind

| actor_kind | actor (32 bytes) | who may send | changes grade/void |
|---|---|---|---|
| NONE 0 (visitor) | 32 zero bytes | anyone (relayer) | no, evidence only |
| HOLDER 1 | `Holding.commitment` (current) | anyone; the verifier vouches via a site ticket (P2) | yes |
| WALLET 2 | wallet pubkey = owner of the Core asset at `Passport.asset` | the wallet co-signs | yes |
| PARTNER 3 | registry partner pubkey | the partner co-signs | yes |
| RECIPIENT 4 | a prepared commitment ≠ the current one | anyone; ticket (P3) | no, evidence only |

### 3.3 nonce and ts

- `nonce`: 32 bytes that make each message unique. CHECK (and every scan from `POST /api/verify`): the session nonce
  of `/api/session`, consumed by this scan (single use, `NONCE_TTL_S`). TAP: 32 fresh bytes from the verifier's CSPRNG
  (`os.urandom(32)`), since a `/t` tap has no session. The program does not check the nonce.
- `ts`: the verifier's unix time when it checked the tap and signed (TAP: the `/t` request time; CHECK: the
  `/api/verify` request time). The program requires `|ts − cluster clock| ≤ MAX_SCAN_TS_SKEW_S (600)` and the server
  key to be valid at `ts` **and** at the cluster clock (same `check_key_and_freshness` as v1).

### 3.4 Field validity (what a signer may sign, what the program enforces)

Enforced by `record_scan_v2` (order and errors in §7.6); the verifier never signs anything that violates them, and
the TS/Python builders reject it with an exception:

1. Ranges: tier ≤ 4, role ≤ 4, purpose ≤ 6, actor_kind ≤ 4, tamper/uv/hum/heat ≤ 3, heat_levels < 64,
   fill ≤ 100 or fill = 255, counter ≤ 0x00FFFFFF.
2. Heat consistency (v1 rule): heat ∈ {INTACT, TRIGGERED} ⇒ heat = bit 4 of heat_levels.
3. Sighting rule: tier = SIGHTING ⇔ fill = FILL_NONE; and tier = SIGHTING ⇒ uv = hum = heat = MISSING (3),
   heat_levels = 0, media_hash = 0.
4. Role/tier: a non-pro role (OWNER/SELLER/BUYER) ⇒ tier ≤ SELF_MEDIA. A pro role (VAULT/PARTNER) or tier ≥ CERTIFIED
   ⇒ actor_kind = PARTNER.
5. Site: site_id ≠ 0 ⇒ pro role and a registered site.
6. Purpose: TAP ⇒ tier SIGHTING; tier SIGHTING ⇒ purpose ∈ {TAP, CLAIM}; BIRTH ⇒ actor PARTNER and tier BIRTH;
   NONE ⇒ purpose ∈ {TAP, CHECK}; RECIPIENT ⇒ purpose RECEIPT.
7. Actor: NONE ⇒ actor = 0; RECIPIENT ⇒ actor ≠ 0.

What the verifier signs in P1: purpose TAP (from `/t`) and CHECK (from `POST /api/verify` with `anchor: "relay"`),
both with actor NONE, `cluster_tag` from `FV_CLUSTER`, `program_id` from `FV_PROGRAM_ID` (D20). A P1 TAP is:
tier 0, role 0, tamper 3, uv/hum/heat 3, heat_levels 0, fill 255, site 0, media 0.

### 3.5 Signature

`sig = Ed25519(scan key, the 256 message bytes)` (plain Ed25519, no prehash), the same key as v1
(`FV_SERVER_ED25519_SEED`, registry entry `FV_SERVER_KEY_ID`).

### 3.6 Ed25519 precompile instruction

Program `Ed25519SigVerify111111111111111111111111111`, no accounts, data = 368 bytes, the layout of web3.js
`Ed25519Program.createInstructionWithPublicKey` (same as v1, only the message size differs):

| offset | width | value |
|---:|---:|---|
| 0 | 1 | `num_signatures = 1` |
| 1 | 1 | padding `0` |
| 2 | 2 | `signature_offset = 48` |
| 4 | 2 | `signature_instruction_index = 0xFFFF` |
| 6 | 2 | `public_key_offset = 16` |
| 8 | 2 | `public_key_instruction_index = 0xFFFF` |
| 10 | 2 | `message_data_offset = 112` |
| 12 | 2 | `message_data_size = 256` |
| 14 | 2 | `message_instruction_index = 0xFFFF` |
| 16 | 32 | server public key |
| 48 | 64 | signature |
| 112 | 256 | FVSCAN2 message |

Header hex: `0100` `3000` `ffff` `1000` `ffff` `7000` `0001` `ffff`. It must sit **immediately before**
`record_scan_v2` (index `current − 1`). Parsing accepts the instruction indices `0xFFFF` or the Ed25519
instruction's own index, exactly like v1. In `ed25519.rs`, generalise the parser to a const length
(`parse_single_ed25519_n::<N>`); `parse_single_ed25519` (v1, 152 bytes) keeps its signature and behaviour. Reuse
`MalformedEd25519Instruction` for a wrong size (its message text may be widened to mention both lengths).

### 3.7 Relation to FVSCAN1

FVSCAN1 (152 bytes, `message.rs`, `record_scan`, ScanProof) is untouched and keeps working on devnet. FVSCAN2 adds
`program_id`, `cluster_tag`, `tier`, `role`, `heat_levels`, `site_id`, `purpose`, `actor_kind`, `actor` and
`bundle_hash` to the signed bytes (v1 left them unsigned), which closes "attester binding: next". A v1 signature is
never accepted by `record_scan_v2` (size 152 ≠ 256) and a v2 signature never by `record_scan` (size 256 ≠ 152).
v1 scans are not folded into `scan_head`.

---

## 4. Hashes and the v2 bundle

### 4.1 Commitment

```
commitment = sha256( "FVHOLD1" ‖ passport (32 raw bytes of the Passport PDA) ‖ epoch (u32 LE) ‖ secret (32 bytes) )
```
75 input bytes. The secret is random per holding and epoch (site side, P2). A commitment of 32 zero bytes is never
valid (`InvalidCommitment`). P1 uses it in `mint_passport_v2` (stored) and HOLDER scans (compared); the preimage check
is P2 (Rust function `commitment()` exists from P1 and is tested against the vectors).

### 4.2 Scan head fold

```
scan_head_0 = 32 zero bytes                         (set by init_holding_v1 / mint_passport_v2)
scan_head_n = sha256( "FVHEAD1" ‖ scan_head_(n−1) ‖ sha256(msg_n) )        (71 input bytes)
head_count  = n
```
`msg_n` is the full 256-byte FVSCAN2 message of the n-th accepted `record_scan_v2` for this Holding, in execution
order. Every accepted `record_scan_v2` folds, whatever its actor.

### 4.3 v2 bundle (`flaconvault.scanbundle.v2`)

The bundle is the off-chain detail document whose sha256 is signed as `bundle_hash`. It contains no server
signature (it is hashed before signing) and none of: free-text note, city, device platform, attester pubkey, Arweave
links, logger, a second top-level `ts`. Those stay only in SQLite (erasable). Exactly these keys (strict, no others):

| key | value |
|---|---|
| `schema` | `"flaconvault.scanbundle.v2"` |
| `cluster` | `"MAINNET"` · `"DEVNET"` · `"LOCALNET"` (= msg cluster_tag) |
| `programId` | base58 of msg program_id |
| `serial` | serial string (`^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$`); sha256 must equal msg serial_hash |
| `serialHash` | `0x` + 64 lowercase hex (= msg serial_hash) |
| `seal` | `{ "kind": "BOX" \| "NECK", "uidHash": "0x…" }` (uidHash = msg uid_hash) |
| `counter` | integer = msg counter |
| `purpose` | purpose name, e.g. `"TAP"` |
| `actor` | `{ "kind": <actor_kind name>, "id": null \| "0x…" }`; `id` is null iff NONE, else `0x` + hex of msg actor |
| `attester` | `{ "tier": <u8>, "role": <u8>, "siteId": <u16> }` |
| `tamper` | integer |
| `indicators` | `{ "heat": <u8>, "humidity": <u8>, "uv": <u8> }` |
| `heatLevels` | array of 6 integers 0/1, bit i of msg heat_levels |
| `fill` | integer 0..100, or `null` iff msg fill = 255 |
| `visual` | `{ "loopIntact": null \| true \| false }` |
| `location` | `{ "country": null \| "DE" }` (two upper-case letters) |
| `media` | `[]` iff msg media_hash = 0, else `[{ "type": "SEAL_FRAMES", "sha256": "0x…" }]` (= msg media_hash) |
| `session` | `{ "nonce": "0x…" (= msg nonce), "issuedAt": <int> }` (CHECK: the nonce's issued_at; TAP: = ts) |
| `server` | `{ "keyId": <u8>, "verdict": "VALID", "ts": <int> (= msg ts) }` |

Canonical form: the existing `canonicalize` (keys sorted, no whitespace, integers, strings, booleans, null) =
Python `json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`; `bundle_hash = sha256(UTF-8)`.
TS: `ScanBundleV2Schema` (zod, `.strict()`), `canonicalBundleV2`, `bundleHashV2`, `bundleMatchesMessageV2(bundle,
msg)`. Python: `proof.build_bundle_v2(...)`, `proof.bundle_hash(proof.canonical_json(b))`.

---

## 5. Worked example (golden vector `v2.scans[1]`, "tap-visitor-sighting")

Inputs: program `7dCr825ibTyE6Y5oPHP2RCmUi5qFPCaKdZmE9TYeAcWL` (hex
`626c6d108266127300de7b13f3dbb9551b761a97a587429b497e2d909a461b29`), cluster DEVNET (2), serial `SN-2026-000001`,
NECK seal UID `04A1B2C3D4E5F6`, counter 2, visitor TAP, nonce = sha256(`"nonce-v2-2"`), ts 1790000200, server
key = the documented TEST key `vectors.serverTestKey` (key id 1, public key
`8ddafff75fe35b174d24fca867f796bc253e32363a456f3486214f01c457ee01`).

PDAs (program above): passport `5ewvSxUE88xsHkJvdx385KbjcJDs5FrArSptgnSnTwAT`
(hex `4527566c42a505d1b5fab981cff855a485020dc5abe34b365ace5fd57c225ffc`), holding
`CXiCKHkkFjgRVW1oEA6Aq5AZ9RzkRKfhFYVLZzRLGSi7`, holder_config `D8ABpujMCjKUXuP8J2jsaiUb6JFEjSp21DZUJkrWn4cb`,
seal `Hnhdd1ppPTq1Ek22VhSErfz8urfLu9w43ANovzytCxCY`, event authority `GKu94ojJCpbjg8EYt1wEXnuUJskCWna1CeLvuNUiFGXN`.

Canonical bundle (one line):

```
{"actor":{"id":null,"kind":"NONE"},"attester":{"role":0,"siteId":0,"tier":0},"cluster":"DEVNET","counter":2,"fill":null,"heatLevels":[0,0,0,0,0,0],"indicators":{"heat":3,"humidity":3,"uv":3},"location":{"country":null},"media":[],"programId":"7dCr825ibTyE6Y5oPHP2RCmUi5qFPCaKdZmE9TYeAcWL","purpose":"TAP","schema":"flaconvault.scanbundle.v2","seal":{"kind":"NECK","uidHash":"0x8150ba8e6d5dec4909903ddb831e4d8a7542928539b6d007da5e01ed9643f442"},"serial":"SN-2026-000001","serialHash":"0x4c998d75c9a8c68768696a2e66ffc2f5a9ffca930654a86195d9ac73656bb583","server":{"keyId":1,"ts":1790000200,"verdict":"VALID"},"session":{"issuedAt":1790000200,"nonce":"0x7901d90ad597c5f8487066b825a50787de157139840a90588212209db0c9b5a9"},"tamper":3,"visual":{"loopIntact":null}}
```
bundle_hash = `f71dc464e4cdfbf05594b2180103407d32180a5b14c122b58b36ed153d8892c5`

Message by field:

| off | field | hex |
|---:|---|---|
| 0 | prefix | `46565343414e32` |
| 7 | program_id | `626c6d108266127300de7b13f3dbb9551b761a97a587429b497e2d909a461b29` |
| 39 | cluster_tag | `02` |
| 40 | serial_hash | `4c998d75c9a8c68768696a2e66ffc2f5a9ffca930654a86195d9ac73656bb583` |
| 72 | uid_hash | `8150ba8e6d5dec4909903ddb831e4d8a7542928539b6d007da5e01ed9643f442` |
| 104 | counter | `02000000` |
| 108 | tier role tamper uv hum heat heat_levels fill | `00` `00` `03` `03` `03` `03` `00` `ff` |
| 116 | site_id | `0000` |
| 118 | purpose actor_kind | `00` `00` |
| 120 | actor | 32 × `00` |
| 152 | media_hash | 32 × `00` |
| 184 | bundle_hash | `f71dc464e4cdfbf05594b2180103407d32180a5b14c122b58b36ed153d8892c5` |
| 216 | nonce | `7901d90ad597c5f8487066b825a50787de157139840a90588212209db0c9b5a9` |
| 248 | ts | `483cb16a00000000` |

Full message (512 hex chars):
```
46565343414e32626c6d108266127300de7b13f3dbb9551b761a97a587429b497e2d909a461b29024c998d75c9a8c68768696a2e66ffc2f5a9ffca930654a86195d9ac73656bb5838150ba8e6d5dec4909903ddb831e4d8a7542928539b6d007da5e01ed9643f4420200000000000303030300ff0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000f71dc464e4cdfbf05594b2180103407d32180a5b14c122b58b36ed153d8892c57901d90ad597c5f8487066b825a50787de157139840a90588212209db0c9b5a9483cb16a00000000
```
- sha256(msg) = `57bfd9ce941c81cc5366e6edf0d16527881074db75319eb5c72c47b1adef4bf4`
- signature (TEST key) = `9cf4283eb2cf31048abbfd736186a3de9427f46aae760c9a8acc233225430b8d6d7822b905b2dce5d13c921770ae8ed63f2df2788ee2d4658e7c6e2d3d6e6c0f`

Scan head over `v2.scans[0]` (BIRTH, sha256(msg) = `d1d5cabfaa2495705fa2cfd6dbd467639830ce5004998feeb845e9857a1cafa0`)
then this TAP:
- head_1 = sha256("FVHEAD1" ‖ 0^32 ‖ d1d5…fa0) = `7d3c88a08935f19eb946f4f0efaa9c45da862bd5c052bb2fea3dcb74aeabbab7`
- head_2 = sha256("FVHEAD1" ‖ head_1 ‖ 57bf…bf4) = `6fcae69855734dc31f0eeef62edbe448fe3a0e2091b9c2208d55e6e5332565e7`
- head after all six `v2.scans` = `1c074c9e97d083bf8daaf4137f61b4d642ef200a46d955a74e760e797cdac843`

Commitment (passport above, epoch 0, secret = sha256(`"flaconvault:test-holder-secret:0"`) =
`9a529ee0b6ce1682b208fcb6554f1176705b04fb991134fbfe336c075bd7ce3f`):
`24088cd63896f3d8f4e55b031307f84429c5e16a039d5f6fa1e4a0e983649fe5`. Epoch 1 with secret
sha256(`"flaconvault:test-holder-secret:1"`): `09b1c3a5ff50a1f70512c08f7159f65c510e4af74f4fa56b4959a9b0925411fd`.

### 5.1 The six `v2.scans` cases (generator input)

All: program and cluster as above, serial `SN-2026-000001`, NECK seal `04A1B2C3D4E5F6`, key id 1, tamper 3, uv 3.
`partner` = Ed25519 public key of seed sha256(`"flaconvault:test-partner:1"`) =
`4n843nZud5opLJAs4kDuqsopm9RJ2dAuZHXB4TivEufJ`; `wallet` = same for `"flaconvault:test-wallet:1"` =
`C3L53rcnZDAiWRBMnDPwsqMTDEEgM9XGovU6EftDZbpC`. `media`/`nonce` = sha256 of the shown label, `—` = zero.

| # | name | ctr | tier | role | hum | heat | heatLevels | fill | site | purpose | actor | media | nonce | ts | issuedAt | country | bundle_hash | head after |
|---|---|---:|---:|---:|---:|---:|---|---:|---:|---|---|---|---|---:|---:|---|---|---|
| 0 | birth-partner-tier4 | 1 | 4 | 4 | 0 | 0 | 000000 | 100 | 1 | BIRTH | PARTNER partner | frames-v2-birth | nonce-v2-1 | 1790000100 | 1790000100 | DE | `dfacd030…1a771cbf` | `7d3c88a0…aeabbab7` |
| 1 | tap-visitor-sighting | 2 | 0 | 0 | 3 | 3 | 000000 | 255 | 0 | TAP | NONE | — | nonce-v2-2 | 1790000200 | 1790000200 | null | `f71dc464…3d8892c5` | `6fcae698…332565e7` |
| 2 | check-visitor-tier2 | 3 | 2 | 0 | 0 | 0 | 110000 | 92 | 0 | CHECK | NONE | frames-v2-3 | nonce-v2-3 | 1790000300 | 1790000288 | DE | `07c250ed…9eed3fc2` | `0a6648c2…cec7e9b5` |
| 3 | check-holder-tier1 | 4 | 1 | 0 | 0 | 0 | 000000 | 75 | 0 | CHECK | HOLDER commitment epoch 0 | — | nonce-v2-4 | 1790000400 | 1790000380 | null | `f61c6ff3…6c175181` | `7d9e035c…0a91bee6` |
| 4 | receipt-recipient-tier1 | 5 | 1 | 2 | 0 | 0 | 000000 | 75 | 0 | RECEIPT | RECIPIENT commitment epoch 1 | — | nonce-v2-5 | 1790000500 | 1790000485 | AT | `8e761d8f…f68ea81c` | `efd5e926…8337dd3c` |
| 5 | check-wallet-heat-triggered | 6 | 2 | 0 | 0 | 1 | 111110 | 92 | 0 | CHECK | WALLET wallet | frames-v2-6 | nonce-v2-6 | 1790000600 | 1790000590 | DE | `a1bbb652…8182029e` | `1c074c9e…7cdac843` |

`heatLevels` is written field 0 first (`110000` = `[1,1,0,0,0,0]`, mask 3; `111110` = mask 31). Grade chain under
§7.7 starting from A / not void: A, A, A, B, B, C (`affectsGrade`: true, false, false, true, false, true).

---

## 6. Accounts

Existing `Registry`, `Passport`, `Seal`, `ScanProof` layouts stay **frozen** (the escrow deserializes
`flacon::Passport`; `_ASSERT_LAYOUTS` stays as is). Two new accounts, both Borsh, packed, after the 8-byte Anchor
discriminator. Add `const _ASSERT_V2_LAYOUTS` with `HolderConfig::INIT_SPACE == 219` and `Holding::INIT_SPACE == 221`.

### 6.1 HolderConfig: seeds `["holder_config"]`, 227 bytes

| data offset | width | field | type | P1 value |
|---:|---:|---|---|---|
| 8 | 32 | authority | Pubkey | registry authority at init; re-synced to `registry.authority` by `set_holder_config` (a record, never a governance root: P2+ instructions that read `holder_key`, `registrar_key` or `guardian` gate on `registry.authority`) |
| 40 | 32 | guardian | Pubkey | arg (may be zero; P5) |
| 72 | 32 | holder_key | Pubkey | arg (may be zero; P2) |
| 104 | 32 | registrar_key | Pubkey | arg (may be zero; P2) |
| 136 | 1 | cluster_tag | u8 | arg, 1..3, immutable |
| 137 | 8 | claim_delay_s | i64 | `259_200` |
| 145 | 8 | notap_delay_s | i64 | `604_800` |
| 153 | 1 | paused | bool | false (P5) |
| 154 | 8 | last_heartbeat | i64 | 0 (P5) |
| 162 | 1 | bump | u8 | |
| 163 | 64 | reserved | [u8;64] | zero |

### 6.2 Holding: seeds `["holding", passport]`, 229 bytes (final layout from P1)

| data offset | width | field | type | P1 |
|---:|---:|---|---|---|
| 8 | 32 | passport | Pubkey | set at init |
| 40 | 1 | state | u8 | `holding_state`: ACCOUNT (mint_passport_v2) or WALLET (init_holding_v1) |
| 41 | 4 | epoch | u32 | 0 |
| 45 | 32 | commitment | [u8;32] | mint_passport_v2: arg; init_holding_v1: zero |
| 77 | 32 | scan_head | [u8;32] | zero at init; folded by record_scan_v2 |
| 109 | 4 | head_count | u32 | 0 at init; +1 per record_scan_v2 |
| 113 | 1 | last_actor_kind | u8 | of the last record_scan_v2 |
| 114 | 32 | last_actor | [u8;32] | of the last record_scan_v2 (zero for NONE) |
| 146 | 1 | last_purpose | u8 | of the last record_scan_v2 |
| 147 | 8 | last_scan_ts | i64 | signed `ts` of the last record_scan_v2 |
| 155 | 1 | pending_kind | u8 | 0 (P3/P4: NONE 0, NOTAP 1, CLAIM 2) |
| 156 | 32 | pending_target | [u8;32] | zero (P3: new commitment for NOTAP; P4: wallet for CLAIM) |
| 188 | 8 | unlock_at | i64 | 0 (P3/P4) |
| 196 | 1 | bump | u8 | |
| 197 | 32 | reserved | [u8;32] | zero |

`last_*` are 0 until the first scan. Ownership rule anyone can apply: `Passport.asset == Holding PDA` ⇒ held in a
FlaconVault account; otherwise the Core-asset owner rule applies.

---

## 7. Program `flacon`: new instructions

`Cargo.toml`: `anchor-lang = { version = "1.2.0", features = ["init-if-needed", "event-cpi"] }`. New instructions
are appended to `#[program]` in this order. Error codes are appended to `FlaconError` after
`AssetNotOwnedByIssuer` (6043) and never renumbered (§7.8). Account lists below are in IDL order; new accounts are
only ever appended later.

### 7.1 `init_holder_config(cluster_tag: u8, guardian: Pubkey, holder_key: Pubkey, registrar_key: Pubkey)`

| # | account | flags | constraint |
|---|---|---|---|
| 0 | registry | | seeds `["registry"]` |
| 1 | holder_config | mut, init, payer = payer, space 8 + 219 | seeds `["holder_config"]` |
| 2 | authority | signer | |
| 3 | payer | signer, mut | |
| 4 | system_program | | |

Checks: `authority == registry.authority` (`Unauthorized`); `cluster_tag ∈ {1,2,3}` (`InvalidClusterTag`).
Writes §6.1 with the defaults. Event `HolderConfigInitialized { holder_config, authority, cluster_tag, guardian,
holder_key, registrar_key }` (`emit!`).

### 7.2 `set_holder_config(guardian: Pubkey, holder_key: Pubkey, registrar_key: Pubkey, claim_delay_s: i64, notap_delay_s: i64)`

| # | account | flags | constraint |
|---|---|---|---|
| 0 | holder_config | mut | seeds `["holder_config"]` |
| 1 | authority | signer | |
| 2 | registry | | seeds `["registry"]` (appended, so positions 0 and 1 stay) |

Checks: `authority == registry.authority` (`Unauthorized`) — the *current* registry authority, so after
`transfer_authority` the old key is out and the new one is in; both delays in `MIN_HOLD_DELAY_S..=MAX_HOLD_DELAY_S`
(`InvalidDelay`). Writes `holder_config.authority = registry.authority` (re-sync). `cluster_tag`, `paused`,
`last_heartbeat` are not changeable here. Event `HolderConfigUpdated { guardian, holder_key, registrar_key,
claim_delay_s, notap_delay_s }`.

### 7.3 `init_holding_v1()` (existing v1 passports)

| # | account | flags | constraint |
|---|---|---|---|
| 0 | registry | | seeds |
| 1 | passport | | seeds `["passport", passport.serial_hash]` |
| 2 | holding | mut, init, payer = payer, space 8 + 221 | seeds `["holding", passport]` |
| 3 | authority | signer | |
| 4 | payer | signer, mut | |
| 5 | system_program | | |

Checks: `authority == registry.authority` (`Unauthorized`). Writes: passport, state WALLET, epoch 0, everything else
zero, bump. A v2 passport already has its Holding, so `init` fails there. Event `HoldingInitialized { passport,
holding, state, epoch, commitment }`.

### 7.4 `mint_passport_v2(serial_hash: [u8;32], binding_hash: [u8;32], commitment: [u8;32])`

| # | account | flags | constraint |
|---|---|---|---|
| 0 | registry | | seeds |
| 1 | passport | mut, init, payer = payer, space 8 + Passport::INIT_SPACE | seeds `["passport", serial_hash]` |
| 2 | holding | mut, init, payer = payer, space 8 + 221 | seeds `["holding", passport]` |
| 3 | issuer | signer | |
| 4 | payer | signer, mut | |
| 5 | system_program | | |

Checks in order: `registry.is_partner_or_authority(issuer)` (`NotPartner`); `commitment != 0` (`InvalidCommitment`).
Writes Passport exactly as v1 `mint_passport` except `asset = holding PDA` (grade A, counts 0, void false,
created_at = clock, bump); Holding: state ACCOUNT, epoch 0, commitment = arg, rest zero. No Core asset, no CPI.
Events `PassportMinted` (existing struct, `asset` = holding) then `HoldingInitialized`.

### 7.5 `attach_seal_v2(uid_hash: [u8;32], kind: u8)`

Accounts: 0 registry · 1 passport (mut, seeds) · 2 seal (mut, init, payer = payer, seeds `["seal", uid_hash]`) ·
3 signer (signer) · 4 payer (signer, mut) · 5 system_program. Checks, writes and event `SealAttached` exactly as
`attach_seal`, in the same order (`NotIssuerOrAuthority`, `InvalidSealKind`, `PassportVoid`, `TooManySeals`).

### 7.6 `record_scan_v2(server_key_id: u8)`

Instruction data: `047bf48d93f81ff1` ‖ `server_key_id` (9 bytes). Accounts struct carries `#[event_cpi]`.

| # | account | flags | constraint |
|---|---|---|---|
| 0 | registry | | seeds `["registry"]` |
| 1 | holder_config | | seeds `["holder_config"]` |
| 2 | passport | mut | seeds `["passport", passport.serial_hash]` |
| 3 | seal | mut | seeds `["seal", seal.uid_hash]` |
| 4 | holding | mut | seeds `["holding", passport]` |
| 5 | instructions | | address = instructions sysvar (`InvalidInstructionsSysvar`) |
| 6 | actor_signer | optional, signer | WALLET / PARTNER only; else the program id placeholder |
| 7 | asset | optional | WALLET only; else the program id placeholder |
| 8 | event_authority | | added by `#[event_cpi]`, PDA `["__event_authority"]` |
| 9 | program | | added by `#[event_cpi]` (flacon) |

If Anchor orders the two `#[event_cpi]` accounts differently, the generated IDL is authoritative and the relayer and
`txverify` use IDL positions. No payer and no system program: nothing is created (D7).

Checks, in this order (errors in brackets; same order as `record_scan.rs` where it overlaps):

0. Stack height is the transaction level (`get_stack_height() == TRANSACTION_LEVEL_STACK_HEIGHT`)
   [`CpiNotAllowed`].
1. Ed25519 (as v1): `current_index > 0` and the instruction at `current_index − 1` is the Ed25519 program
   [`MissingEd25519Instruction`]; single signature, 256-byte message, valid indices [`MalformedEd25519Instruction`];
   `registry.server_key(server_key_id)` [`UnknownServerKey`]; its pubkey equals the Ed25519 pubkey
   [`ServerKeyMismatch`]; prefix `FVSCAN2` [`InvalidMessagePrefix`]; `msg.program_id == crate::ID`
   [`WrongProgramId`]; `msg.cluster_tag == holder_config.cluster_tag` [`WrongCluster`];
   `check_key_and_freshness(key, msg.ts, clock)` [`ServerKeyNotValidAtTs` / `ServerKeyNotValidNow` /
   `StaleScanTimestamp`]; `msg.serial_hash == passport.serial_hash` and `msg.uid_hash == seal.uid_hash`
   [`MessageMismatch`].
2. State: `seal.passport == passport` [`SealPassportMismatch`]; `!seal.dead` [`SealDead`]; passport not voided
   [`PassportVoid`]; `msg.counter > seal.last_counter` [`CounterNotIncreasing`]; `msg.counter ≤ MAX_COUNTER`
   [`CounterOutOfRange`].
3. Fields (§3.4): role [`InvalidRole`]; tier [`InvalidTier`]; purpose [`InvalidPurpose`]; actor_kind
   [`InvalidActorKind`]; tamper/uv/hum/heat [`InvalidIndicator`]; fill [`InvalidFill`]; heat_levels
   [`InvalidHeatLevels`]; heat consistency [`HeatInconsistent`]; sighting rule [`InvalidSighting`]; non-pro role ⇒
   tier ≤ 2 [`TierNotAllowedForRole`]; pro role or tier ≥ 3 ⇒ actor PARTNER [`NotPartner`]; site_id ≠ 0 ⇒ pro role
   [`SiteIdNotAllowed`] and registered [`UnknownSite`]; purpose rules [`PurposeNotAllowed`].
4. Actor (§3.2):
   - NONE: `actor == 0` [`ActorMismatch`].
   - HOLDER: `holding.state == ACCOUNT && passport.asset == holding.key()` [`HoldingNotInAccount`];
     `actor == holding.commitment` [`ActorMismatch`].
   - RECIPIENT: same state check [`HoldingNotInAccount`]; `actor != 0 && actor != holding.commitment`
     [`ActorMismatch`].
   - WALLET: `actor_signer` present [`MissingActorSigner`], its key == actor [`ActorMismatch`]; `asset` present with
     key == `passport.asset` [`AssetMismatch`]; it is a Core `AssetV1` owned by actor (`core_asset_owner` from
     `mint_passport.rs`) [`NotAssetOwner`].
   - PARTNER: `actor_signer` present [`MissingActorSigner`], key == actor [`ActorMismatch`];
     `registry.is_partner(actor)` [`NotPartner`].
   - For NONE, HOLDER and RECIPIENT the optional accounts are ignored.
5. Write: `seal.last_counter = msg.counter`; `passport.scan_count += 1` [`ScanCountOverflow`]; for HOLDER, WALLET
   and PARTNER only `(passport.grade, passport.void) = passport_after_scan_v2(...)` (§7.7); `holding.scan_head =
   fold(holding.scan_head, msg)`; `holding.head_count += 1` [`HeadCountOverflow`]; `holding.last_actor_kind`,
   `last_actor`, `last_purpose` from msg, `last_scan_ts = msg.ts`. No ScanProof.
6. `emit_cpi!(ScanRecordedV2 { passport, seal, holding, server_key_id, message: [u8;256], grade, void, scan_count,
   scan_head, head_count })` with the values after step 5 (field order as listed).

Pure, unit-tested helpers: `parse_scan_message_v2(&[u8;256]) -> ScanMessageV2`, `build_scan_message_v2(&ScanMessageV2)`,
`check_fields_v2(&msg, role_is_pro…) -> Result<()>` (step 3 without accounts), `fold_scan_head`, `commitment`,
`passport_after_scan_v2`.

### 7.7 Grade rule v2

```
passport_after_scan_v2(old_grade, old_void, tamper, heat, hum, fill):
  if fill == FILL_NONE:
      if old_void or old_grade == VOID or is_opened(tamper): return (VOID, true)
      if old_grade == C or is_triggered(heat, hum):          return (C, false)
      return (old_grade, false)                               # no reading: A/B/D unchanged
  return passport_after_scan(old_grade, old_void, tamper, heat, hum, fill)   # v1 rule, grade.rs
```
Applied only for HOLDER, WALLET, PARTNER. NONE and RECIPIENT leave grade and void unchanged. TS mirror in
`grade.ts`: `actorChangesGrade(actorKind)` and `passportAfterScanV2({grade, void}, fields)`; the generator writes
`affectsGrade`, `gradeAfter`, `voidAfter` into `v2.scans`.

### 7.8 New errors (appended, in this order)

| code | name | message |
|---:|---|---|
| 6044 | `InvalidClusterTag` | cluster_tag must be 1 (MAINNET), 2 (DEVNET) or 3 (LOCALNET) |
| 6045 | `InvalidDelay` | Delay must be within MIN_HOLD_DELAY_S..=MAX_HOLD_DELAY_S |
| 6046 | `InvalidCommitment` | Commitment must not be all zeros |
| 6047 | `CpiNotAllowed` | record_scan_v2 must be a top-level instruction |
| 6048 | `InvalidMessagePrefix` | Signed message is not an FVSCAN2 message |
| 6049 | `WrongProgramId` | FVSCAN2 message is bound to another program id |
| 6050 | `WrongCluster` | FVSCAN2 message is bound to another cluster |
| 6051 | `InvalidPurpose` | purpose must be 0..=6 |
| 6052 | `InvalidActorKind` | actor_kind must be 0..=4 |
| 6053 | `InvalidSighting` | A sighting (tier 0) has fill FILL_NONE, uv/hum/heat MISSING, heat_levels 0 and no media; FILL_NONE only with tier 0 |
| 6054 | `PurposeNotAllowed` | purpose is not allowed for this actor kind or tier |
| 6055 | `ActorMismatch` | actor does not match its kind (zero for NONE, Holding.commitment for HOLDER, the signer for WALLET/PARTNER) |
| 6056 | `MissingActorSigner` | WALLET and PARTNER scans need the actor as signer |
| 6057 | `NotAssetOwner` | The WALLET actor does not own the passport's Core asset |
| 6058 | `HoldingNotInAccount` | HOLDER and RECIPIENT scans need a pass held in an account (Passport.asset == Holding) |
| 6059 | `HeadCountOverflow` | Holding head_count overflow |

Reused: `Unauthorized`, `NotPartner`, `NotIssuerOrAuthority`, `InvalidSealKind`, `PassportVoid`, `TooManySeals`,
`SealCountOverflow`, all `record_scan` step 1–3 errors, `AssetMismatch`, `ScanCountOverflow`.

### 7.9 Escrow: `PassHeldInAccount`

Only change in `programs/escrow`:
- `error.rs`: append `PassHeldInAccount` (code 6028), message "The pass is held in a FlaconVault account
  (Passport.asset is its Holding): it cannot be sold through the escrow".
- `rules.rs`: pure `check_not_held_in_account(asset_owner_program: &Pubkey) -> Result<()>`: fails with
  `PassHeldInAccount` when `asset_owner_program == flacon::ID`; unit test.
- `instructions/list.rs` `check_seller_of`: call it first, before `core_asset_owner`. Because `reserve` uses
  `check_seller_of` too, both refuse a Holding-held pass.
Must ship in the same devnet upgrade as `mint_passport_v2` (owner's deploy).

---

## 8. `packages/proof`

New or changed (TS source of truth, no new dependencies, Node ≥ 22.18 type stripping as today):
- `enums.ts`: §2 enums and constants, `PDA_SEEDS` + `holder_config`, `holding`.
- `message2.ts`: `ScanMessageV2Fields`, `buildScanMessageV2`, `parseScanMessageV2`, `MSG2_OFFSETS`,
  `buildEd25519InstructionData(pubkey, sig, msg)`, `parseEd25519InstructionData(data)` (§3.6).
- `holding.ts`: `commitment(passport32, epoch, secret32)`, `foldScanHead(head32, msg256)`, `SCAN_HEAD_ZERO`.
- `bundle.ts`: §4.3 schema and helpers (v1 unchanged).
- `grade.ts`: §7.7.
- `b58.ts`, `pda.ts`: base58, `findProgramAddress(seeds, programId)` (off-curve check with `@noble/ed25519` point
  decoding), helpers `pdaRegistry`, `pdaPassport`, `pdaSeal`, `pdaHolderConfig`, `pdaHolding`, `pdaEventAuthority`.
- `verify-pass.ts` (pure, takes an RPC interface) + `scripts/verify-pass.ts` (CLI, global `fetch` JSON-RPC).
- `scripts/gen-vectors.ts`: writes the new sections; schema strings stay `flaconvault.vectors.v1` /
  `flaconvault.enums.v1` (additive).
- root `package.json`: script `"verify-pass": "npm run verify-pass -w @flaconvault/proof --"`; proof
  `package.json`: `"verify-pass": "node scripts/verify-pass.ts"`.

### 8.1 New `docs/vectors.json` content

`constants` gains the §2.2 keys. New top-level object `v2`:
```
"v2": {
  "programId": "7dCr…", "programIdHex": "626c…", "cluster": "DEVNET", "clusterTag": 2,
  "pdas": { "registry", "passport", "seal", "holderConfig", "holding", "eventAuthority" },          // base58
  "actors": { "partner": { "seedLabel", "pubkey", "pubkeyHex" }, "wallet": { … } },
  "commitments": [ { "passport", "passportHex", "epoch", "secretLabel", "secretHex", "commitmentHex" } ],   // epoch 0, 1
  "scans": [ { "name",
               "input": { "serial", "uidHex", "sealKind", "counter", "tier", "role", "tamper", "uv", "hum", "heat",
                          "heatLevels", "fill", "siteId", "purpose", "actorKind", "actorHex", "mediaHashHex",
                          "nonceHex", "ts", "issuedAt", "country" },          // enum fields as integer codes
               "heatMask", "bundleCanonical", "bundleHashHex", "msgHex", "msgSha256Hex", "sigHex", "ed25519IxHex",
               "affectsGrade", "gradeAfter", "voidAfter", "headAfterHex" } ],          // the six cases of §5.1
  "scanHead": { "initialHex": "00…00", "count": 6, "finalHex": "1c07…c843" },
  "discriminators": { "global:record_scan_v2": "047bf48d93f81ff1", … },          // the §2.2 table, preimage → hex
  "rejects": [ { "name", "base", "set", "msgHex", "error" } ]   // a v2.scans message (`base`) with the fields in `set`
                                                                 // patched; `error` = what record_scan_v2 must return
}
```
Signatures use `serverTestKey` (public TEST key, never registered on a shared cluster). `v2.note` is a one-line
description. `discriminators` and `rejects` were added by the proof builder (integration note); the TS builder and the
Rust `check_fields_v2` unit test must both refuse every `rejects` message with its `error`.

### 8.2 verify-pass

`npm run verify-pass -- --rpc <url> --program <id> --cluster devnet --serial SN-… [--json]`. Exit 0 = complete and
in order, 1 = not, 2 = input/RPC error. Steps:
1. Derive passport and holding PDAs; read Passport, Holding (discriminator checked) and Registry (server keys:
   `u32` length + n × {key_id u8, pubkey 32, valid_from i64, valid_to i64}).
2. `getSignaturesForAddress(holding)` paginated with `before` until exhausted; keep `err == null`; order oldest
   first (ascending slot, then the reverse of the RPC order inside a slot).
3. For each `getTransaction(sig, {maxSupportedTransactionVersion: 0})`, every **top-level** instruction to the flacon
   program whose data starts with `047bf48d93f81ff1`: the previous instruction must be Ed25519; parse §3.6; verify
   the Ed25519 signature locally; check prefix, `program_id`, `cluster_tag`, `serial_hash` = passport's, seal account
   (index 3) = PDA of `msg.uid_hash`, key id from the ix data present in the registry with that pubkey and
   `is_valid_at(msg.ts)` (`valid_from ≤ ts` and (`valid_to == 0` or `ts ≤ valid_to`)).
4. Fold all accepted messages from zero; compare with `Holding.scan_head` and `head_count`.
5. Print each scan (ts, counter, purpose, actor kind) and the verdict: `complete and in order` on a match, otherwise
   `incomplete or out of order (found N, holding says M)`. v1 ScanProof scans are not covered and are not listed.

---

## 9. Verifier (`apps/verify`)

### 9.1 Configuration

New settings (all read in `fv/config.py`; every one documented in `apps/verify/README.md`, `apps/verify/.env.example`
and `docs/deploy.md`, which `tests/test_deploy_config.py` enforces):

| variable | default | meaning |
|---|---|---|
| `FV_CLUSTER` | `devnet` | `devnet` · `mainnet` · `localnet`; `cluster_tag` of every FVSCAN2; must equal `HolderConfig.cluster_tag` |
| `FV_RELAY_ENABLED` | `false` (unset or empty = false) | kill switch: nothing is ever sent while false |
| `FV_RELAYER_KEY` | empty, **secret** | Solana keypair JSON (64 numbers); fee payer only, no program authority |
| `FV_HOLDER_KEY` | empty, **secret** | P2; parsed and validated only (D17) |
| `FV_ISSUER_KEY` | empty, **secret** | registry partner key for sealing (P2); parsed and validated only |
| `FV_SOLANA_RPC_FALLBACK` | empty | second RPC for relay sends and status reads (D12) |
| `FV_RELAY_DAILY_LAMPORTS` | `10000000` | global fee cap per UTC day |
| `FV_RELAY_LOW_BALANCE_LAMPORTS` | `100000000` | relayer balance alert threshold (0.1 SOL) |
| `FV_RELAY_CU_LIMIT` | `150000` | compute unit limit of a relay transaction |
| `FV_RELAY_MAX_PRIORITY_MICROLAMPORTS` | `10000` | ceiling of the priority fee price (µlamports per CU) |
| `FV_RELAY_INTERVAL_S` | `2` | relay loop interval (the loop is also woken when a CHECK is queued) |

`.env.example` stays startable as a local simulator (`FV_RELAY_ENABLED=false`, keys empty, no `#` in values).
Keys: parse with solders, require 64 bytes whose public half matches the secret half; keep only the keypair object;
never log, print, return or write a secret; expose public keys only. `DEFAULT_PROGRAM_ID` per D20.

Startup refuses to serve (added to `startup_problems`):
- `FV_RELAY_ENABLED=true` without `FV_RELAYER_KEY` or without `FV_PROGRAM_ID`;
- a malformed key in any of the three key variables;
- two equal public keys among the scan key, relayer, holder and issuer keys;
- `FV_CLUSTER` not in the set; `localnet` with a non-local `FV_SOLANA_RPC`; `FV_RELAY_ENABLED=true` with `devnet` or
  `mainnet` against a local RPC; `mainnet` with `FV_DEV_SIMULATOR=true`;
- `FV_RELAY_ENABLED=true` with `FV_DEV_SIMULATOR=true` and a non-local RPC.

### 9.2 Builders (`fv/proof.py`)

`MSG2_PREFIX`, `MSG2_LEN`, `FILL_NONE`, `BUNDLE2_SCHEMA`, `build_message_v2(**fields) -> bytes`,
`parse_message_v2(bytes) -> dict`, `build_bundle_v2(...) -> dict`, `fold_scan_head(head, msg)`,
`commitment(passport32, epoch, secret32)`, `ed25519_ix_data(pubkey, sig, msg)`. Byte-identical to TS (vectors).
The v1 functions are unchanged.

### 9.3 Tables (`fv/schema.sql`, `TABLES` in `fv/db.py`)

```sql
CREATE TABLE IF NOT EXISTS relay_tx (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL DEFAULT 'scan',     -- 'scan' (P1); later 'holding', 'claim'
  ref           TEXT NOT NULL,                    -- idempotency key; kind 'scan': '<seal uid_hash hex>:<counter>'
  event_id      INTEGER REFERENCES events(id) ON DELETE SET NULL,   -- the SCAN event this row records
  seal_uid_hash TEXT NOT NULL,
  counter       INTEGER NOT NULL,
  purpose       INTEGER NOT NULL,                 -- purpose enum
  actor_kind    INTEGER NOT NULL,                 -- actor_kind enum
  msg_hex       TEXT,                             -- FVSCAN2 (256 bytes)
  server_sig    TEXT,                             -- hex, Ed25519 over msg
  key_id        INTEGER,
  server_pubkey TEXT,                             -- hex, the scan key that signed msg (sent in the Ed25519 instruction)
  bundle_json   TEXT,                             -- canonical v2 bundle
  due_at        INTEGER NOT NULL,
  deadline_at   INTEGER NOT NULL,                 -- msg ts + 570
  status        TEXT NOT NULL CHECK (status IN ('queued','sending','recorded','over_cap','failed','replaced')),
  reason        TEXT,                             -- §9.6
  sig           TEXT,                             -- tx signature of the current attempt; the landed one once recorded
  last_valid_height INTEGER,                      -- lastValidBlockHeight of the current attempt
  earlier_sigs  TEXT,                             -- JSON [{sig, estimate}]: attempts sent and given up on (§9.5)
  attempts      INTEGER NOT NULL DEFAULT 0,
  lamports      INTEGER NOT NULL DEFAULT 0,       -- fee actually paid (meta.fee)
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS relay_tx_live_ref ON relay_tx(kind, ref) WHERE status IN ('queued','sending','recorded');
CREATE INDEX IF NOT EXISTS relay_tx_seal ON relay_tx(seal_uid_hash, created_at);
CREATE INDEX IF NOT EXISTS relay_tx_due ON relay_tx(status, due_at);
CREATE TABLE IF NOT EXISTS relay_budget (day TEXT PRIMARY KEY, lamports INTEGER NOT NULL DEFAULT 0);  -- 'YYYY-MM-DD' UTC
```
The partial unique index is the idempotency guarantee: at most one live row per (seal, counter). `server_pubkey` is
written when the row is signed (D13) and used for its Ed25519 instruction and the allowlist, so a scan-key rotation
does not strand the rows signed before it (the program still checks `registry.server_key(key_id)` and its validity).
`earlier_sigs` keeps the signature and charged estimate of every attempt the row sent and then gave up on (§9.5), so a
transaction that landed after all is never lost. `fv/db.py migrate` adds both columns to a database of an earlier P1
build, whose rows fall back to the current key and have no earlier attempts.

### 9.4 Queueing (`fv/relayer.py`, called inside the existing write transactions)

`queue_scan(conn, settings, *, event, seal, counter, purpose, actor_kind, ts, due_at, bundle_fields) -> row` builds
the v2 bundle and FVSCAN2, signs it (D13), and inserts one row whose status is decided in this order:
1. `FV_RELAY_ENABLED` false → `failed`, reason `relay_off` (the message is still built and signed).
2. Visitor cap (actor NONE only), counting rows of the same seal with the same purpose, status in
   (`queued`, `sending`, `recorded`) and `created_at > now − 86400`: TAP ≥ 3 or CHECK ≥ 1 → `over_cap`, reason
   `seal_daily`.
3. Otherwise `queued`.

Constants: `VISITOR_TAPS_PER_SEAL_24H = 3`, `VISITOR_CHECKS_PER_SEAL_24H = 1`, `CAP_WINDOW_S = 86400`,
`TAP_DUE_DELAY_S = ADOPT_WINDOW_S + 5 = 185`, `DEADLINE_MARGIN_S = 30` (deadline = ts + 600 − 30). No row for a
passport the verifier knows is void, a dead seal or an unregistered tag.

`routes_tag.py`, after a VALID `/t` tap on a registered, live seal: insert the Tier-0 sighting as today, then
`queue_scan(event=sighting, purpose=TAP, actor=NONE, ts=tap ts, due_at=ts + 185, nonce=os.urandom(32))` in the same
transaction.

`POST /api/verify` with `anchor: "relay"` (actor NONE, purpose CHECK in P1):
- adopting a `/t` tap (`tapId`): look up the live row of `(seal, counter)`.
  - `queued` TAP and the CHECK cap allows: TAP row → `replaced`; insert the CHECK row `queued`, `due_at = now`; wake
    the loop.
  - `queued` TAP and the CHECK cap is full: insert the CHECK row `over_cap` (`seal_daily`); the TAP row stays queued.
  - `sending` or `recorded`: refuse the adoption with verdict `REPLAY` (the counter is already used on chain); the
    transaction rolls back, nothing is consumed.
- a tap read by the scan page itself (no `tapId`): no TAP row exists for its counter; queue the CHECK row
  (`due_at = now`).

`POST /api/verify` with `anchor: "wallet"` adopting a tap: a `queued` TAP row → `replaced` (the wallet's v1 scan will
use the counter); `sending`/`recorded` → `REPLAY`.

### 9.5 Sending and confirming (relay loop)

An asyncio task in the lifespan (only while `FV_RELAY_ENABLED` and `FV_PROGRAM_ID` are set), every
`FV_RELAY_INTERVAL_S`, work in a thread, RPC never inside a SQLite write transaction (same pattern as reconcile).

Selection: per seal at most one row `sending`; among `queued` rows the lowest counter of a seal is due when its
`due_at ≤ now` **or** a higher-counter row of the same seal is due and the lowest row is not backing off
(`attempts = 0`) (pull-forward, so counters land in order; a row in backoff waits for its own `due_at`).

Per due row (`now` is the wall clock when the row is processed, read again right before the claim in step 5):
1. `now > deadline_at` → `failed`, `expired`.
2. Estimate `fee = 5000 × 2 + ceil(price × FV_RELAY_CU_LIMIT / 1e6)` (the Ed25519 precompile signature is charged
   like a transaction signature). `price` = 75th percentile of `getRecentPrioritizationFees([passport, seal,
   holding])`, clamped to `0..FV_RELAY_MAX_PRIORITY_MICROLAMPORTS` (0 when the call fails). Spent today + fee >
   `FV_RELAY_DAILY_LAMPORTS` → `over_cap`, `budget`.
3. `getMultipleAccounts([passport, seal, holding])`: passport or seal missing → `failed`, `not_on_chain`; holding
   missing → `failed`, `no_holding`; `seal.last_counter ≥ counter` → `failed`, `counter_used`; seal dead or passport
   void → `failed`, `rejected`. A row with earlier attempts looks them up first (below): the counter may be used by
   one of them.
4. Build `[SetComputeUnitLimit(FV_RELAY_CU_LIMIT), SetComputeUnitPrice(price), Ed25519(§3.6),
   record_scan_v2(key_id)]` with a `confirmed` blockhash, the relayer as fee payer and only signer, the Ed25519
   instruction with the row's `server_pubkey`; run `check_relay_shape` (§9.7) on the message; only then sign.
5. Claim (one write transaction, before `sendTransaction`): still `queued` and `deadline_at ≥ now` (fresh clock) →
   `sending`, store `sig`, `last_valid_height`; `relay_budget[today] += fee`. Past the deadline by now → `failed`,
   `expired`, nothing sent.
6. `sendTransaction` with preflight (`preflightCommitment: confirmed`). Preflight program error → `failed`,
   `rejected` (error name in `last_error` log only); a row with earlier attempts goes back to `queued` and looks them
   up first (`CounterNotIncreasing` may mean one of them landed). A node's JSON-RPC error that is not a program error
   (including blockhash not found) → back to `queued`, `attempts + 1`, retry with backoff 2, 4, 8, 16, 30 s, using
   `FV_SOLANA_RPC_FALLBACK` after a primary failure. A transport error (or AlreadyProcessed) → the outcome is unknown:
   the row stays `sending` with its signature until its status or the expiry of its blockhash is known; that includes
   a primary transport error followed by any failure of the fallback (the primary may have forwarded it).

Confirmation (`confirm_sending`, also called by `reconcile_once` and at startup). Status reads ask each RPC on its own,
not through the generic fallback: `FV_SOLANA_RPC` (the primary) is the source with the full transaction history
(`getSignatureStatuses` with `searchTransactionHistory: true`); `FV_SOLANA_RPC_FALLBACK` may keep none, so a "not
found" from it alone never counts. The block height is always the primary's.
- `getSignatureStatuses([sig])` confirmed/finalized with `err == null` → `recorded`: read `meta.fee` with
  `getTransaction`, correct the budget by `fee − estimate`, store `lamports`, then apply §9.8;
- `err != null` → `failed`, `rejected` (budget corrected with the paid fee), unless an earlier attempt of the row
  landed with `err == null` (look-up below): then `recorded` with that attempt's signature;
- not found by the primary, not found by the fallback either (asked as a second source; a fallback error leaves the
  primary's answer standing), and the primary's finalized block height > `last_valid_height` → the attempt is given
  up: its signature and estimate are appended to `earlier_sigs`, the estimate is refunded, and the row goes back to
  `queued` (re-sent with a new blockhash) or, past the deadline, `failed`, `expired` (after the look-up below);
- the primary's `getSignatureStatuses` fails → the fallback's answer counts only where it finds the signature
  (confirmed/finalized, as above); a signature it does not know waits (no block height read, nothing requeued).

A row is never re-sent while its previous attempt could still land; if two ever land, the second fails on chain with
`CounterNotIncreasing`, so nothing is recorded twice.

Earlier attempts (`earlier_sigs`): a row never ends without being recorded — `counter_used` above all, but also
`rejected`, `expired`, `over_cap`, `not_on_chain`, `no_holding`, `cluster_mismatch` — while one of its own earlier
attempts landed. Before such an end, a row with earlier attempts looks them up (`getSignatureStatuses`, full history,
on the primary, then on the fallback for what the primary does not know):
- one landed with `err == null` → `recorded` with its signature (the record's `txSig`), §9.8; nothing is sent again;
- none landed → the end as before;
- not known yet (the primary did not answer and the fallback does not know them all, or one is only `processed`) →
  the row stays `queued` (`pending`) and is tried again after the backoff. `expire_overdue` without an RPC (DB only)
  leaves such a row to the relay loop or the reconcile job, which look it up once its `due_at` has come.

Budget: an attempt's estimate is charged at the claim and refunded when the attempt is given up; an earlier attempt
found landed (with or without an error) is charged its `meta.fee` (else its estimate) once, when the row settles. So
every landed transaction is paid exactly once in `relay_budget`, and `lamports` holds what the row's landed attempts
paid. D13 holds throughout: the FVSCAN2 is never re-signed and nothing is sent after `ts + 570` s; recording a row with
an attempt that landed in time sends nothing.

Balance: `getBalance(relayer)` at most every 60 s and after each recorded row; below
`FV_RELAY_LOW_BALANCE_LAMPORTS` → `log.warning` (at most hourly) and `lowBalance: true` in health/admin. On start the
loop reads HolderConfig once (then every 60 s until it succeeds) and sends nothing before that read succeeded (due
rows wait and expire at their deadline); a `cluster_tag` ≠ `FV_CLUSTER` stops sending: due rows fail with
`cluster_mismatch`.

### 9.6 Record states (API) and reasons

| `relay_tx.status` | API `record.state` | reasons |
|---|---|---|
| `queued`, `sending` | `pending` | – |
| `recorded` | `recorded` | – (`txSig` set) |
| `over_cap` | `over_cap` | `seal_daily`, `budget` |
| `failed` | `failed` | `relay_off`, `expired`, `not_on_chain`, `no_holding`, `counter_used`, `rejected`, `cluster_mismatch` |
| `replaced` | never shown; the tap shows its replacing row | – |

### 9.7 Shape allowlist (`check_relay_shape(message, relayer, scan_pubkey, program_id, cluster_tag, max_price)`)

Pure function, raises on anything else:
1. exactly 4 instructions; account 0 (fee payer) = relayer; exactly one required signature;
2. ix 0: ComputeBudget, no accounts, data `02` ‖ u32 (5 bytes); ix 1: ComputeBudget, no accounts, data `03` ‖ u64
   (9 bytes), price ≤ `max_price`;
3. ix 2: Ed25519, no accounts, data exactly §3.6 with pubkey = scan key, a 256-byte message with prefix FVSCAN2,
   `program_id` = `FV_PROGRAM_ID`, `cluster_tag` = `FV_CLUSTER`;
4. ix 3: program = `FV_PROGRAM_ID`, data = `047bf48d93f81ff1` ‖ u8, accounts exactly §7.6 in order with optional
   accounts as the program-id placeholder; writable = passport, seal, holding only; no signer;
5. the relayer appears in no instruction's account list; the message's writable accounts are exactly {relayer,
   passport, seal, holding}.

P2 extends this list; nothing else may be signed by the relayer.

### 9.8 Event and state invariants

- TAP: the `/t` sighting event (status `confirmed`, no `tx_sig`, as today). When recorded: `tx_sig` = the relay
  signature and the payload gains `anchor: "relay"`, `purpose: "TAP"`, `actorKind: "NONE"`, `msgHex` (FVSCAN2),
  `bundleHash`, `bundleV2`. It then counts in `stats.onChainScanCount` (the chain counts it in `passport.scan_count`,
  and "Check live on-chain" compares both).
- CHECK (relay): `insert_event(status="pending")` with the full v1-style detail in the payload (city, note, platform,
  claimed attester stay in SQLite only) plus `anchor: "relay"`, `purpose`, `actorKind`, `msgHex` (FVSCAN2),
  `bundleHash`, `bundleV2`. When its row is terminal: `recorded` → status `confirmed` + `tx_sig`; `over_cap` or
  `failed` → status `confirmed`, no `tx_sig` (a genuine, off-chain scan, never `failed`, so the timeline keeps it).
  Then `apply_relayed_scan`: `payload.confirmed` from the FVSCAN2 fields (`source: "fvscan2"`, no attester), **no**
  passport grade or void change for NONE, no attester stats; the sighting of the same tap is dropped unless a TAP row
  of that counter is still `queued`, `sending` or `recorded` (one physical tap shows once, as on the v1 path, also
  when the TAP row failed `relay_off` or was `over_cap`). A queued TAP that a CHECK over cap left in place and that
  then ends without being recorded drops its sighting the same way.
- Public view (`GET /api/passport`): a relay scan never shows the v1-style detail kept in SQLite — the payload loses
  `visual.note`, `device`, `attester.pubkey` and `location.city`, the event's `location.city` is null and
  `events.city` stays empty — pending or recorded.
- Visitor scans never set the passport header (`latest_scan_with_indicators`) and never count in
  `newer_confirmed_scan_exists`; v1 rules for v1 scans are unchanged.
- Reconcile: `scan_events_to_reconcile` excludes events with `payload.anchor == "relay"` (they never get a
  ScanProof and must not time out to `failed`); a new step calls `confirm_sending`. Arweave backfill skips relay
  events in P1 (D14). Resume (`GET /api/verify/{id}?token=`) answers 404 `resume_not_found` for relay events.

### 9.9 API contract

**`POST /api/verify`** new body fields:

| field | type | default | rule |
|---|---|---|---|
| `anchor` | `"relay"` \| `"wallet"` | `"wallet"` | D1 |
| `purpose` | `"CHECK"`, `"LIST"`, `"SHIP"`, `"RECEIPT"`, `"CLAIM"`, `"BIRTH"` | `"CHECK"` | relay only; `"TAP"` or other values → 422 `purpose_invalid`; with `anchor: "wallet"` only absent or `"CHECK"` |
| `ticket` | string ≤ 2048 \| null | null | site attester ticket (P2). P1 stub `fv/tickets.py` `verify_ticket(settings, ticket) -> TicketClaims \| None` always returns None |

Checked before any tap is consumed, in this order: `purpose_invalid` (422); a ticket present → 403 `ticket_invalid`
(always in P1); relay without ticket and purpose ≠ CHECK → 403 `ticket_required`; relay (actor NONE) with tier ≥ 3 or
role VAULT/PARTNER → 422 `relay_not_for_certified`. `attester` is ignored for the relay path (kept in SQLite only).
After the tap check, inside the transaction (rolled back on error): `anchor: "wallet"` on a passport held in an
account → 409 `wallet_anchor_not_allowed` (D15); adoption refused per §9.4 → verdict `REPLAY`.
`TicketClaims` (P2 fills it): `aud`, `jti`, `exp`, `serial`, `purpose`, `actor_kind`, `actor_commitment`,
`order_ref`; HMAC-SHA256 with `VERIFY_TICKET_SECRET`, single-use `jti`, `exp ≤ 5 min`.

VALID answer: every existing key, plus `anchor`, `purpose` (null for wallet), `actorKind` (null for wallet),
`cluster` (`"DEVNET"`…), `record` (null for wallet). For relay, `msgHex`/`serverSig` are the FVSCAN2 message and its
signature, `bundle`/`bundleHash` the v2 bundle; `resumeToken` is issued as before (used by the record endpoint).
Non-VALID answers carry `record: null`. The wallet path is otherwise byte-for-byte unchanged.

**Record object**:
```json
{ "state": "pending", "purpose": "CHECK", "eventId": 123, "dueAt": 1790000300, "txSig": null, "reason": null, "cluster": "DEVNET" }
```
`dueAt` only while pending; `txSig` only when recorded; `reason` only for over_cap/failed.

**`GET /api/verify/{eventId}/record?token=…`** (rate limited like resume) → 200 `{"eventId": n, "record": {…}}` for a
relay scan in any state with its resume token; anything else 404 `record_not_found` (constant-time token check, as
resume).

**`GET /api/tap/{tapId}`** and **`GET /t?format=json`** → existing tap view plus `record` of the tap's live row (the
CHECK's once it replaced the TAP), or null.

**`GET /api/passport/{serial}`** → each SCAN event gains `scanBy` and `purpose`:
`scanBy` = `"VISITOR"` (actor NONE, Tier-0 sightings, v1 scans whose verified attester is not a registry partner),
`"HOLDER"` (HOLDER, WALLET), `"PARTNER"` (PARTNER; v1 scans by a registry partner or with verified tier ≥ 3),
`"RECIPIENT"` (RECIPIENT; not produced in P1). `purpose` = name for v2 scans, null for v1.

**`GET /health`** gains `"cluster": "devnet"` and `"relay": {"enabled": bool, "ok": bool}` (ok = enabled, balance
not low, budget left, cluster matches). No balances, no keys. It keeps answering when the relay is off (TapGate
uses it).

**`GET /api/admin/status`** gains `relay`: `enabled`, `cluster`, `holderConfigCluster`, `relayer`, `holderKey`,
`issuerKey` (public keys or null), `balanceLamports`, `lowBalance`, `spentTodayLamports`, `dailyCapLamports`,
`queued`, `sending`, `recorded24h`, `overCap24h`, `failed24h`, `lastError` (short code).

New error codes: `purpose_invalid` 422, `ticket_invalid` 403, `ticket_required` 403, `relay_not_for_certified` 422,
`wallet_anchor_not_allowed` 409, `record_not_found` 404, and `scan_fields_invalid` 422 (integration note: a relay
body whose fields break §3.4 for a visitor CHECK, refused after the existing input checks (heat consistency,
`mediaHash`) and before the tap is used).

---

## 10. Web (`apps/web`)

### 10.1 Configuration

`CLUSTER` comes from `NEXT_PUBLIC_SOLANA_CLUSTER` (`devnet` · `mainnet` · `localnet`, default `devnet`; anything else
→ `devnet`). Explorer links: no `cluster` parameter on mainnet. Add the variable to `apps/web/.env.example`. Its
row in the `docs/deploy.md` web table is written by the verify group exactly as:

```
| `NEXT_PUBLIC_SOLANA_CLUSTER` | `devnet` | `devnet`, `mainnet` or `localnet`; the test-phase notice on scan results and passport pages shows unless it is `mainnet` |
```

### 10.2 Exact user-facing strings

Put them in one module (e.g. `src/lib/public-record.ts`). Characters: `…` is U+2026, `✓` U+2713, `·` U+00B7.

| where | string |
|---|---|
| TapGate, health check failed | `Seal check unavailable right now. Try again in a minute.` + button `Try again` |
| scan-flow consumer button | `Save to the public record` |
| record pending (CHECK, or a TAP being sent) | `Saving…` |
| record pending (TAP, `dueAt` in the future) | `Saving to the public record within about 3 minutes.` |
| record recorded | `Saved to the public record ✓ · view record` (`view record` links to `/p/<serial>#e<eventId>`) |
| record over_cap, reason `seal_daily` | `Kept by FlaconVault only: this seal already has its public entries for the last 24 hours.` |
| record failed; over_cap with any other reason (`budget`, none, unknown); a VALID relay answer with `record` null | `Not saved to the public record this time. FlaconVault keeps the check.` |
| scan-flow disclosure (collapsed) | `Advanced` |
| first line inside Advanced | `For partners and your own wallet: sign and pay for this scan yourself.` |
| history labels (`scanBy`) | `Visitor` · `Holder` · `Partner` · `Recipient` |
| history link of a recorded scan (was `tx`) | `Public record` |
| /p drawer title | `How this record is checked` |
| /p drawer text | `Public record signed by FlaconVault. Anyone can check our signature and that this list is complete; the seal's secret check itself can only be done by FlaconVault.` |
| test-phase notice | `Test phase: records are saved on Solana's test network until launch.` |
| /p header pill | `Witnessed by <n> signer(s), <m> of them certified` |
| /p footer | `This passport is publicly readable, without an account and without login.` |
| error `ticket_invalid` / `ticket_required` | `This kind of scan needs a FlaconVault account. It is not available yet.` |
| error `relay_not_for_certified` | `Certified scans are signed by the partner (Advanced).` |
| error `wallet_anchor_not_allowed` | `This pass is held in a FlaconVault account. Use "Save to the public record".` |
| error `record_not_found` | `The public record status of this scan is not available.` |
| error `scan_fields_invalid` | `This scan cannot be saved to the public record with these readings. Start a new scan.` |

Rules: never "guaranteed" or "trustless" anywhere. The consumer path (TapGate, `/t` result, scan-flow outside
Advanced, the `/p` header, history and notice) never says blockchain, wallet, NFT, token or crypto; "public record"
is the term. Inside Advanced and inside the proof drawer's technical block the existing wording may stay. Dev-Briefing
§16 still applies.

### 10.3 Behaviour

- **TapGate** (raw SUN parameters on `/t`): before redirecting to `{PUBLIC_VERIFY_URL}/t?…`, `fetch(
  {PUBLIC_VERIFY_URL}/health, {cache: "no-store"})` with a 2000 ms abort; redirect only on HTTP 2xx with JSON
  `ok === true`. Otherwise show the fallback string; `Try again` reloads the same URL (the tap was not consumed). The
  hand-over to a running scan session is unchanged and needs no health check. Keep the decision a pure function.
- **`/t` result**: a client component under the verdict shows the record line for `tap.record` (polls
  `GET /api/tap/{tapId}` every 5 s while pending, at most 10 minutes) and the test-phase notice.
- **scan-flow**: for tier ≤ 2 and roles OWNER/SELLER/BUYER the save step shows `Save to the public record` →
  `POST /api/verify` with `anchor: "relay"`, `purpose: "CHECK"`, no `attester`, no ticket → `Saving…` → poll
  `GET /api/verify/{eventId}/record?token=<resumeToken>` every 2 s for 2 minutes, then every 10 s up to 10 minutes,
  stop at a terminal state → the record line, the notice and "View passport with history". No wallet connect, no
  wallet gate on this path. A VALID answer with `anchor: "relay"` always goes to the record step; with `record` null
  (nothing queued, e.g. a void passport) it shows the failed string. Only an answer without `anchor` (an older
  verifier, FVSCAN1) goes to the wallet's tx step. `Advanced` (collapsed) holds today's wallet flow unchanged
  (`anchor` omitted or `"wallet"`). Certified scans (tier ≥ 3 or VAULT/PARTNER) keep today's wallet flow directly,
  without the relay button, and so do an escrow order's shipping and receipt scans: the order page links to
  `/scan?role=1&flow=wallet` and `/scan?role=2&flow=wallet` (the order needs a v1 ScanProof signed by the order party;
  `flow=wallet` survives the tap hand-over). Without the query, seller and buyer get the relay button and a note
  pointing to Advanced.
- **`/p/[serial]`**: each SCAN row shows its `scanBy` label; rows get `id="e<eventId>"`; the drawer (`<details>`,
  closed by default) holds the drawer text plus the existing "On-chain" block and "Check live on-chain"; the
  test-phase notice sits under the header. Nothing else on `/p` changes in P1.

---

## 11. Devnet rollout (owner actions; builders never run them)

Order, documented in `docs/devnet.md` and `docs/deploy.md`: (1) upgrade flacon and escrow together, escrow first (two
upgrades are two transactions; the escrow's `PassHeldInAccount` guard must be live before flacon can run
`mint_passport_v2`); (2)
`init_holder_config(DEVNET, …)` by the registry authority; (3) `init_holding_v1` for every existing devnet passport
(script `scripts/init-holdings.ts`, written in P1, run by the owner); (4) set the verifier variables, fund the relayer
with at most 0.5 SOL, set `FV_RELAY_ENABLED=true`; (5) check `/health` → `relay.ok`. Builders do not deploy, send
transactions, airdrop or call paid APIs; local validator and LiteSVM only. No keypair files in the repo
(`target/deploy/*.json` stays untracked), no secrets in docs, no absolute home paths and no machine PATH lines in
tracked files (`.github/scripts/hygiene.sh`).

---

## 12. File ownership (three parallel builders plus web)

| group | owns (only this group edits) |
|---|---|
| **proof** | `packages/proof/**` except `packages/proof/src/idl/**`; `docs/vectors.json`, `docs/enums.json` (generated by `npm run vectors`, never hand-edited); root `package.json` (the one `verify-pass` script line) |
| **programs** | `programs/**` (incl. `programs/*/tests/*.rs`, `programs/README.md`); `tests/**` (incl. `tests/lib/**`, `tests/docs-runbooks.ts`); `scripts/**`; `Anchor.toml`, `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `migrations/**`; `packages/proof/src/idl/*` (regenerated after `anchor build`, never hand-edited); `docs/devnet.md`; `.github/**` |
| **verify** | `apps/verify/**` (incl. `fv/enums.json`, `README.md`, `.env.example`, `scripts/`); `docs/deploy.md` (also the web row in §10.1); `Dockerfile.verify`, `railway.json` |
| **web** | `apps/web/**` (incl. `.env.example`, `README.md`) |
| nobody | `docs/public-record.md` (this spec), `docs/Dev-Briefing_v2.md`, root `README.md`, `package-lock.json`, `apps/verify/uv.lock` content, `docs/layout.py`, `docs/card/**`, `docs/seed/**` |

Contended files and their owner: `docs/enums.json` → proof; `apps/verify/fv/enums.json` → verify (run
`uv run python scripts/sync_enums.py` after proof's file exists; until then it may pre-stage the §2.1 groups by hand,
but the final file must equal `docs/enums.json`); `docs/vectors.json` → proof (programs and verify read it, and may
hard-code the §5 example in a unit test like `scans0_hardcoded`); IDL files → programs; `docs/deploy.md` → verify.
No group adds an npm or Python dependency; if one seems required, stop and report. Cross-group test dependencies:
`tests/docs-runbooks.ts` (programs) needs the web `.env.example` entry and the verify-written `deploy.md` row;
`tests/flacon.ts` (g) needs proof's `docs/enums.json` and the programs' `#[constant]`s.

---

## 13. Test plan

Shared: every group's tests read `docs/vectors.json` `v2.*`; the §5 example is also pinned as a hard-coded test in
Rust and Python. All existing tests stay green (v1 untouched). Keys in tests: the documented TEST server key for
vectors; fresh ephemeral keypairs for fee payers, partners, wallets and new server keys; never a real key.

**proof** (`npm run proof:test`, `npm run vectors:check`)
- parity: `docs/enums.json` and `vectors.constants` equal enums.ts (update the deepEqual), `v2.scans` messages,
  bundles, hashes, Ed25519 data and signatures reproduce and verify; heads, commitments and PDAs reproduce;
- builders reject every §3.4 violation; round trip build/parse; offsets table; 256 bytes;
- bundle v2: strict keys, `fill` null ⇔ 255, `media` [] ⇔ zero hash, `actor.id` null ⇔ NONE, field equality with
  the message;
- verify-pass with a fake RPC built from the vectors: complete → match; a missing tx → incomplete; swapped order →
  mismatch; wrong cluster, wrong program id, key not in registry, key not valid at ts, bad signature → scan
  rejected; CPI-only instruction ignored.

**programs** (`cargo test -p flacon -p escrow`, `anchor test --validator legacy`, LiteSVM tests `#[ignore]`d and run
by a script like `scripts/test-escrow-time-travel.sh`)
- Rust unit: v2 message vs vectors and hard-coded §5; Ed25519 parser for 256 bytes and rejection of 152 for v2 /
  256 for v1; field rules (every error in step 3); `passport_after_scan_v2` table incl. FILL_NONE; fold and
  commitment vs vectors; layout size asserts; escrow `check_not_held_in_account`.
- Local validator: `init_holder_config` (authority only, invalid tag, no second init); `set_holder_config` (authority
  only, delay bounds, tag unchanged); `init_holding_v1` on a v1 passport (state WALLET, authority only, separate
  payer); `mint_passport_v2` (partner, separate payer pays, asset = holding, zero commitment and non-partner
  refused); `attach_seal_v2` (separate payer); `record_scan_v2` from an ephemeral fee payer that is in no
  instruction: visitor TAP and CHECK leave grade/void unchanged and advance `last_counter`, `scan_count`,
  `scan_head` (= TS fold), `head_count`, `last_*`; `ScanRecordedV2` decoded from the inner instruction with the full
  message; HOLDER scan with the right commitment changes the grade, wrong commitment → `ActorMismatch`, on a WALLET
  holding → `HoldingNotInAccount`; WALLET with the Core owner as co-signer changes the grade, another signer →
  `NotAssetOwner`, missing signer → `MissingActorSigner`; PARTNER co-signed BIRTH tier 4 with a site; NONE tier 3 →
  `NotPartner`; NONE RECEIPT → `PurposeNotAllowed`; sighting violations → `InvalidSighting`; wrong cluster tag →
  `WrongCluster`; other program id bytes → `WrongProgramId`; FVSCAN1 bytes padded to 256 → `InvalidMessagePrefix`;
  revoked key → `ServerKeyNotValidNow`; counter replay → `CounterNotIncreasing`; v1 Ed25519 before v2 and v2 before
  v1 → `MalformedEd25519Instruction`; no Ed25519 instruction right before → `MissingEd25519Instruction`.
- LiteSVM with a clock override: ±600 s boundaries (600 ok, 601 `StaleScanTimestamp`) and key validity at ts vs now;
  `record_scan_v2` via CPI (a test builtin forwarding it) → `CpiNotAllowed`, nothing changed, the same scan at top
  level accepted; `set_holder_config` after `transfer_authority`: the old key → `Unauthorized`, the new one succeeds
  and `holder_config.authority` follows it.
- Escrow (`tests/escrow.ts`): `list` and `reserve` of a `mint_passport_v2` passport fail with `PassHeldInAccount`;
  all v1 escrow tests pass.
- IDL test (g) passes with the new enum groups and seeds; `.github/scripts/idl-check.sh` passes with the
  regenerated IDLs.

**verify** (`cd apps/verify && uv run pytest`; fake RPC, no network)
- `proof.py` v2 builders, bundle, fold, commitment, Ed25519 data vs vectors and the hard-coded §5 example;
- `check_relay_shape`: accepts the one shape; rejects an extra or reordered instruction, wrong program, relayer in an
  account list, an extra writable, wrong Ed25519 key, 152-byte message, wrong cluster, price above the ceiling;
- transaction built with ephemeral keys parses back to the allowlisted shape;
- caps: 3 TAPs recorded, the 4th `over_cap`; 1 CHECK, the 2nd `over_cap`; after 24 h allowed again; `replaced` and
  `failed` rows do not count; seals are independent; non-NONE purposes are not capped (unit level);
- idempotency: one live row per (seal, counter) (unique index); re-send only after blockhash expiry; a landed earlier
  attempt is detected; `counter_used`; a primary transport error on send followed by a fallback error stays
  `sending` and is sent once; the deadline is checked at the claim (a slow cycle expires the row unsent); a row in
  backoff is not pulled forward; the allowlist runs before the relayer signs; a row is sent with the key that signed
  it after a key rotation;
- kill switch: unset → false; rows `failed`/`relay_off`; the loop does not start; the fake RPC sees no
  `sendTransaction`;
- budget → `over_cap`/`budget`; low balance flag; deadline → `expired`; pull-forward order per seal;
- adoption: CHECK replaces the queued TAP (same counter); CHECK over cap keeps the TAP; adoption after the TAP was
  sent → `REPLAY`; wallet adoption replaces the TAP;
- events: a relay CHECK adopting a `/t` tap shows that tap once, also with the relay off; the public passport view
  of a relay scan carries no note, place, platform or attester pubkey;
- API: existing `/api/verify` tests unchanged (default wallet); relay answer shape; ticket → 403 without consuming
  the tap; purpose without ticket → 403; relay tier 3 → 422; `wallet_anchor_not_allowed`; `/record` states and token
  checks; `/api/tap` record; `/api/passport` `scanBy`; `/health` and admin relay blocks contain no secret;
- reconcile ignores relay events in the v1 ScanProof pass and confirms `sending` rows; a recorded or off-chain
  visitor CHECK leaves passport grade and header unchanged; a recorded TAP counts in `onChainScanCount`;
- startup refusals of §9.1; `test_deploy_config.py` (all new `FV_*` documented); `test_enums.py` after the sync.

**web** (`npm run web:typecheck`, `web:lint`, `web:test`, `web:build`)
- TapGate gate function: ok → redirect; timeout at 2 s, non-2xx, `ok !== true`, network error → fallback string;
- record state → string mapping (incl. TAP pending with future `dueAt`, over_cap `seal_daily` vs `budget`); the
  step after a VALID relay answer with `record` null; the order page's `flow=wallet`; `scanBy` → label; notice shown for
  `devnet`/`localnet`, hidden for `mainnet`; `CLUSTER` parsing; explorer cluster parameter;
- the strings module contains none of: blockchain, wallet, NFT, token, crypto, guaranteed, trustless (except the
  Advanced line, which may say wallet, kept separate);
- new verifier error codes have messages in `lib/errors.ts`.

Done for P1 when, on a clean checkout of the branch: `npm run vectors:check`, `npm run proof:test`,
`cargo test -p flacon -p escrow`, the LiteSVM scripts, `anchor test --validator legacy`, `uv run pytest`,
`npm run web:typecheck && npm run web:lint && npm run web:test && npm run web:build`, `npm run mocha:unit` and
`bash .github/scripts/hygiene.sh` all pass.
