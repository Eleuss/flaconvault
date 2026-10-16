"""
Solana side: PDA derivation (solders), Anchor account decoders for programs/flacon, and a tiny
JSON-RPC client (httpx). No signing — the server only *reads* the chain (briefing §10 reconcile).

Account layouts (after the 8-byte Anchor discriminator):
  ScanProof: seal(32) counter u32 tier u8 role u8 tamper u8 uv u8 hum u8 heat u8 heat_levels u8 fill u8
             site_id u16 media_hash[32] bundle_hash[32] attester(32) server_key_id u8 ts i64 bump u8
  Passport:  serial_hash[32] binding_hash[32] asset(32) issuer(32) grade u8 scan_count u32 seal_count u8
             void u8 created_at i64 bump u8
  Seal:      passport(32) kind u8 uid_hash[32] last_counter u32 dead u8 attached_at i64 bump u8
  Registry:  authority(32) Vec<ServerKey{key_id u8, pubkey(32), valid_from i64, valid_to i64}>
             Vec<Pubkey> partners  Vec<Site{site_id u16, label [32] utf-8 zero-padded}>   (all Vec: u32 LE length)
  Order (escrow): passport(32) seller(32) buyer(32) asset(32) price u64 state u8 listed_at i64 reserved_at i64
             shipped_at i64 seller_scan(32) buyer_scan(32) dispute_after_s i64 asset_deposited u8 bump u8 vault_bump u8

Every decoder checks the 8-byte Anchor account discriminator (sha256("account:<Name>")[:8]). Anything else at a PDA
address — no data at all (a plain SOL transfer to the address creates a system-owned, empty account), a truncated
buffer or another account type — raises DecodeError, and callers treat it as "account not created".
"""
from __future__ import annotations

import base64
import hashlib
import struct
from typing import Any

import httpx
from solders.pubkey import Pubkey

DISC_LEN = 8
SCAN_PROOF_LEN = DISC_LEN + 32 + 4 + 8 + 2 + 32 + 32 + 32 + 1 + 8 + 1      # 160
PASSPORT_LEN = DISC_LEN + 32 + 32 + 32 + 32 + 1 + 4 + 1 + 1 + 8 + 1         # 152
SEAL_LEN = DISC_LEN + 32 + 1 + 32 + 4 + 1 + 8 + 1                            # 87
ORDER_LEN = DISC_LEN + 32 * 4 + 8 + 1 + 8 * 3 + 32 * 2 + 8 + 1 + 1 + 1       # 244 (programs/escrow/src/state.rs)
SIGNATURE_STATUS_BATCH = 256                                                  # getSignatureStatuses accepts ≤ 256 per call

# escrow ORDER_STATE_* (programs/escrow/src/constants.rs)
ORDER_STATES = {0: "LISTED", 1: "RESERVED", 2: "PRESHIP_SCANNED", 3: "SHIPPED", 4: "RECEIPT_SCANNED", 5: "RELEASED",
                6: "MISMATCH", 7: "DISPUTE", 8: "CANCELLED"}
ORDER_RELEASED, ORDER_DISPUTE = 5, 7
DEFAULT_PUBKEY = "11111111111111111111111111111111"


def account_discriminator(name: str) -> bytes:
    """Anchor account discriminator: sha256("account:<StructName>")[:8] (matches the IDLs in packages/proof/src/idl)."""
    return hashlib.sha256(f"account:{name}".encode()).digest()[:DISC_LEN]


ACCOUNT_DISC: dict[str, bytes] = {n: account_discriminator(n) for n in ("ScanProof", "Passport", "Seal", "Registry", "Order",
                                                                        "EscrowConfig")}


class DecodeError(ValueError):
    pass


def is_account(data: bytes | None, name: str) -> bool:
    """True if `data` starts with the discriminator of account type `name` (False for None, b'' or foreign data)."""
    return bool(data) and len(data) >= DISC_LEN and data[:DISC_LEN] == ACCOUNT_DISC[name]


class RpcError(RuntimeError):
    pass


# ---------- PDAs ----------

def program_pubkey(program_id: str) -> Pubkey:
    return Pubkey.from_string(program_id)


def pda_registry(program_id: str | Pubkey) -> Pubkey:
    pid = program_id if isinstance(program_id, Pubkey) else program_pubkey(program_id)
    return Pubkey.find_program_address([b"registry"], pid)[0]


def pda_passport(program_id: str | Pubkey, serial_hash: bytes) -> Pubkey:
    pid = program_id if isinstance(program_id, Pubkey) else program_pubkey(program_id)
    return Pubkey.find_program_address([b"passport", serial_hash], pid)[0]


def pda_seal(program_id: str | Pubkey, uid_hash: bytes) -> Pubkey:
    pid = program_id if isinstance(program_id, Pubkey) else program_pubkey(program_id)
    return Pubkey.find_program_address([b"seal", uid_hash], pid)[0]


def pda_order(escrow_program_id: str | Pubkey, passport: Pubkey, seller: str | Pubkey) -> Pubkey:
    """escrow Order PDA ["order", passport, seller] (programs/escrow/src/state.rs)."""
    pid = escrow_program_id if isinstance(escrow_program_id, Pubkey) else program_pubkey(escrow_program_id)
    seller_pk = seller if isinstance(seller, Pubkey) else Pubkey.from_string(seller)
    return Pubkey.find_program_address([b"order", bytes(passport), bytes(seller_pk)], pid)[0]


def pda_scan(program_id: str | Pubkey, seal: Pubkey, counter: int) -> Pubkey:
    pid = program_id if isinstance(program_id, Pubkey) else program_pubkey(program_id)
    return Pubkey.find_program_address([b"scan", bytes(seal), struct.pack("<I", counter)], pid)[0]


# ---------- decoders ----------

class _Reader:
    def __init__(self, data: bytes | None, what: str):
        if data is None:
            raise DecodeError(f"{what}: no account data")
        self.d, self.o, self.what = bytes(data), 0, what
        disc = self.take(DISC_LEN)
        if disc != ACCOUNT_DISC[what]:
            raise DecodeError(f"{what}: foreign discriminator {disc.hex()}")

    def take(self, n: int) -> bytes:
        if self.o + n > len(self.d):
            raise DecodeError(f"{self.what}: truncated at offset {self.o} (need {n} bytes, have {len(self.d) - self.o})")
        b = self.d[self.o:self.o + n]
        self.o += n
        return b

    def u8(self) -> int: return self.take(1)[0]
    def u16(self) -> int: return struct.unpack("<H", self.take(2))[0]
    def u32(self) -> int: return struct.unpack("<I", self.take(4))[0]
    def i64(self) -> int: return struct.unpack("<q", self.take(8))[0]
    def pubkey(self) -> str: return str(Pubkey.from_bytes(self.take(32)))
    def hash32(self) -> str: return self.take(32).hex()


def decode_scan_proof(data: bytes) -> dict[str, Any]:
    r = _Reader(data, "ScanProof")
    out = {"seal": r.pubkey(), "counter": r.u32(), "tier": r.u8(), "role": r.u8(), "tamper": r.u8(), "uv": r.u8(),
           "hum": r.u8(), "heat": r.u8(), "heatLevelsMask": r.u8(), "fill": r.u8(), "siteId": r.u16(),
           "mediaHash": r.hash32(), "bundleHash": r.hash32(), "attester": r.pubkey(), "serverKeyId": r.u8(), "ts": r.i64()}
    out["bump"] = r.u8()
    return out


def decode_passport(data: bytes) -> dict[str, Any]:
    r = _Reader(data, "Passport")
    return {"serialHash": r.hash32(), "bindingHash": r.hash32(), "asset": r.pubkey(), "issuer": r.pubkey(),
            "grade": r.u8(), "scanCount": r.u32(), "sealCount": r.u8(), "void": bool(r.u8()), "createdAt": r.i64(), "bump": r.u8()}


def decode_seal(data: bytes) -> dict[str, Any]:
    r = _Reader(data, "Seal")
    return {"passport": r.pubkey(), "kind": r.u8(), "uidHash": r.hash32(), "lastCounter": r.u32(), "dead": bool(r.u8()),
            "attachedAt": r.i64(), "bump": r.u8()}


def decode_registry(data: bytes) -> dict[str, Any]:
    r = _Reader(data, "Registry")
    authority = r.pubkey()
    keys = []
    for _ in range(r.u32()):
        keys.append({"keyId": r.u8(), "pubkeyHex": r.take(32).hex(), "validFrom": r.i64(), "validTo": r.i64()})
    partners = [r.pubkey() for _ in range(r.u32())]
    sites = []
    for _ in range(r.u32()):
        site_id = r.u16()
        label = r.take(32).split(b"\x00", 1)[0].decode("utf-8", errors="replace")
        sites.append({"siteId": site_id, "label": label})
    return {"authority": authority, "serverKeys": keys, "partners": partners, "sites": sites}


def decode_order(data: bytes) -> dict[str, Any]:
    """escrow Order account. `buyer` is None until reserved (the program stores Pubkey::default())."""
    r = _Reader(data, "Order")
    out = {"passport": r.pubkey(), "seller": r.pubkey(), "buyer": r.pubkey(), "asset": r.pubkey(), "price": struct.unpack("<Q", r.take(8))[0],
           "state": r.u8(), "listedAt": r.i64(), "reservedAt": r.i64(), "shippedAt": r.i64(), "sellerScan": r.pubkey(),
           "buyerScan": r.pubkey(), "disputeAfterS": r.i64(), "assetDeposited": bool(r.u8()), "bump": r.u8(), "vaultBump": r.u8()}
    if out["buyer"] == DEFAULT_PUBKEY:
        out["buyer"] = None
    out["stateName"] = ORDER_STATES.get(out["state"], f"UNKNOWN_{out['state']}")
    return out


# ---------- RPC ----------

class Rpc:
    """Minimal Solana JSON-RPC client. All account data is requested base64 and returned as raw bytes."""

    def __init__(self, url: str, timeout: float = 5.0):
        self.url = url
        self.timeout = timeout
        self._id = 0

    def call(self, method: str, params: list[Any]) -> Any:
        self._id += 1
        try:
            resp = httpx.post(self.url, json={"jsonrpc": "2.0", "id": self._id, "method": method, "params": params},
                              timeout=self.timeout)
            resp.raise_for_status()
            body = resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise RpcError(f"{method}: {exc}") from exc
        if "error" in body:
            raise RpcError(f"{method}: {body['error']}")
        return body.get("result")

    @staticmethod
    def _data(value: dict | None) -> bytes | None:
        if not value:
            return None
        data = value.get("data")
        if isinstance(data, list):        # ["<base64>", "base64"]
            return base64.b64decode(data[0])
        if isinstance(data, str):
            return base64.b64decode(data)
        return None

    def get_account_info(self, pubkey: str | Pubkey) -> bytes | None:
        res = self.call("getAccountInfo", [str(pubkey), {"encoding": "base64", "commitment": "confirmed"}])
        return self._data((res or {}).get("value"))

    def get_multiple_accounts(self, pubkeys: list[str | Pubkey]) -> list[bytes | None]:
        out: list[bytes | None] = []
        for i in range(0, len(pubkeys), 100):
            chunk = [str(p) for p in pubkeys[i:i + 100]]
            res = self.call("getMultipleAccounts", [chunk, {"encoding": "base64", "commitment": "confirmed"}])
            values = (res or {}).get("value") or [None] * len(chunk)
            out.extend(self._data(v) for v in values)
        return out

    def get_transaction(self, signature: str) -> dict | None:
        """Confirmed transaction (json encoding, v0 allowed) or None while it is not visible yet."""
        return self.call("getTransaction", [signature, {"encoding": "json", "commitment": "confirmed",
                                                        "maxSupportedTransactionVersion": 0}])

    def get_signatures_for_address(self, pubkey: str | Pubkey, limit: int = 5) -> list[str]:
        """Successful signatures touching `pubkey`, newest first (failed txs are dropped)."""
        res = self.call("getSignaturesForAddress", [str(pubkey), {"limit": limit, "commitment": "confirmed"}]) or []
        return [r["signature"] for r in res if r.get("signature") and not r.get("err")]

    def get_signature_statuses(self, signatures: list[str]) -> list[dict | None]:
        """
        Status of each signature (None = unknown to the cluster), searching the full transaction history. Batched by
        256 (the RPC limit); a signature that is not 64 bytes of base58 can never exist and is answered None locally.
        """
        out: list[dict | None] = [None] * len(signatures)
        valid = [(i, s) for i, s in enumerate(signatures) if is_signature(s)]
        for i in range(0, len(valid), SIGNATURE_STATUS_BATCH):
            chunk = valid[i:i + SIGNATURE_STATUS_BATCH]
            res = self.call("getSignatureStatuses", [[s for _, s in chunk], {"searchTransactionHistory": True}])
            values = (res or {}).get("value") or [None] * len(chunk)
            for (idx, _s), v in zip(chunk, values):
                out[idx] = v
        return out

    def get_program_accounts(self, program_id: str | Pubkey, *, data_size: int | None = None) -> list[tuple[str, bytes]]:
        """(pubkey, data) of every account owned by `program_id`, optionally filtered by exact data size."""
        cfg: dict[str, Any] = {"encoding": "base64", "commitment": "confirmed"}
        if data_size is not None:
            cfg["filters"] = [{"dataSize": int(data_size)}]
        res = self.call("getProgramAccounts", [str(program_id), cfg]) or []
        if isinstance(res, dict):            # withContext responses
            res = res.get("value") or []
        out = []
        for item in res:
            data = self._data(item.get("account"))
            if item.get("pubkey") and data is not None:
                out.append((item["pubkey"], data))
        return out


def is_signature(sig: str | None) -> bool:
    """A transaction signature: 64 bytes of base58."""
    if not isinstance(sig, str) or not 64 <= len(sig) <= 88:
        return False
    try:
        from solders.signature import Signature
        Signature.from_string(sig)
    except Exception:  # noqa: BLE001 — solders raises ValueError / its own errors
        return False
    return True
