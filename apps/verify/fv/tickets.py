"""
Site attester tickets for POST /api/verify (docs/public-record.md §9.9) — the P1 stub.

A ticket lets the FlaconVault site vouch for who scans (a holder, a recipient) and why (LIST, SHIP, RECEIPT, CLAIM,
BIRTH), so the verifier can sign an FVSCAN2 with that actor kind. The site side ships in P2: then `verify_ticket`
checks an HMAC-SHA256 with VERIFY_TICKET_SECRET, `aud == "verify"`, a single-use `jti` and `exp` at most 5 minutes
ahead, and returns the claims. In P1 no ticket is valid: `verify_ticket` always answers None, so a request with a
ticket gets 403 `ticket_invalid` before any tap is consumed, and every relay scan is a visitor scan (actor NONE).
"""
from __future__ import annotations

from dataclasses import dataclass

from fv.config import Settings

MAX_TICKET_LEN = 2048


@dataclass(frozen=True)
class TicketClaims:
    """What a verified ticket says (filled from P2 on)."""
    aud: str
    jti: str
    exp: int
    serial: str
    purpose: int              # purpose enum
    actor_kind: int           # actor_kind enum (HOLDER, RECIPIENT)
    actor_commitment: bytes   # 32 bytes: the Holding commitment the scan is made under
    order_ref: str | None


def verify_ticket(settings: Settings, ticket: str | None) -> TicketClaims | None:
    """The claims of a valid ticket, else None. P1: always None (the site does not issue tickets yet)."""
    del settings, ticket
    return None
