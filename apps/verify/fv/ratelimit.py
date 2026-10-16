"""
In-process per-IP rate limiting (token buckets) as FastAPI dependencies.

  * `rate_limit` — every POST route and GET /t: FV_RATE_LIMIT_PER_MIN requests per minute and client IP (default 60,
    burst = the same number). Over the limit → 429 `rate_limited`.
  * `report_allowed(request)` — the stricter bucket for unverified SEAL_DEAD reports (FV_REPORT_LIMIT_PER_HOUR,
    default 3 per hour and IP). Over the limit → 429 `report_limited`.

Client IP: the socket peer, unless the peer is the platform proxy (a non-global address: Railway's edge reaches the
container over its private network). Only then is X-Forwarded-For used, and only its last entry — the address the
proxy itself saw (the first hop in front of us); everything to the left of it can be written by the client.
FV_TRUSTED_PROXY_HOPS (default 1) raises the number of trusted proxies in front of the app.

The buckets live in the app process (app.state), so the limit is per replica. Idle buckets are dropped.
"""
from __future__ import annotations

import ipaddress
import os
import threading
import time

from fastapi import HTTPException, Request

DEFAULT_PER_MIN = 60
DEFAULT_REPORTS_PER_HOUR = 3
MAX_KEYS = 50_000                      # memory bound: least recently refilled buckets are dropped beyond this


def _env_float(name: str, default: float) -> float:
    try:
        v = float(os.environ.get(name, "") or default)
    except ValueError:
        return default
    return v if v > 0 else default


class TokenBucket:
    __slots__ = ("tokens", "at")

    def __init__(self, tokens: float, at: float):
        self.tokens, self.at = tokens, at


class RateLimiter:
    """`capacity` tokens per key, refilled continuously at `rate_per_s`. hit() takes one token or returns False."""

    def __init__(self, capacity: float, rate_per_s: float, max_keys: int = MAX_KEYS):
        self.capacity, self.rate, self.max_keys = float(capacity), float(rate_per_s), max_keys
        self._buckets: dict[str, TokenBucket] = {}
        self._lock = threading.Lock()

    @classmethod
    def per_minute(cls, n: float) -> "RateLimiter":
        return cls(capacity=n, rate_per_s=n / 60.0)

    @classmethod
    def per_hour(cls, n: float) -> "RateLimiter":
        return cls(capacity=n, rate_per_s=n / 3600.0)

    def hit(self, key: str, cost: float = 1.0, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        with self._lock:
            b = self._buckets.get(key)
            if b is None:
                if len(self._buckets) >= self.max_keys:
                    self._evict(now)
                b = self._buckets[key] = TokenBucket(self.capacity, now)
            else:
                b.tokens = min(self.capacity, b.tokens + (now - b.at) * self.rate)
                b.at = now
            if b.tokens >= cost:
                b.tokens -= cost
                return True
            return False

    def retry_after(self, key: str) -> int:
        with self._lock:
            b = self._buckets.get(key)
            missing = 1.0 - (b.tokens if b else 0.0)
        return max(1, int(missing / self.rate) + 1) if self.rate > 0 else 60

    def _evict(self, now: float) -> None:
        # full buckets carry no state worth keeping; otherwise drop the oldest half
        full = [k for k, b in self._buckets.items() if b.tokens + (now - b.at) * self.rate >= self.capacity]
        for k in full:
            del self._buckets[k]
        if len(self._buckets) >= self.max_keys:
            for k, _ in sorted(self._buckets.items(), key=lambda kv: kv[1].at)[: len(self._buckets) // 2]:
                del self._buckets[k]


# ---------- client identity ----------

def _is_platform_proxy(peer: str) -> bool:
    try:
        return not ipaddress.ip_address(peer).is_global
    except ValueError:
        return False


def client_ip(request: Request) -> str:
    peer = request.client.host if request.client else ""
    xff = request.headers.get("x-forwarded-for")
    if xff and _is_platform_proxy(peer):
        hops = [h.strip() for h in xff.split(",") if h.strip()]
        n = int(_env_float("FV_TRUSTED_PROXY_HOPS", 1))
        if hops:
            return hops[-min(n, len(hops))]
    return peer or "unknown"


# ---------- per-app limiters ----------

_INIT_LOCK = threading.Lock()


def _limiter(request: Request, name: str) -> RateLimiter:
    state = request.app.state
    limiters = getattr(state, "rate_limiters", None)
    if limiters is None:
        with _INIT_LOCK:
            limiters = getattr(state, "rate_limiters", None)
            if limiters is None:
                limiters = state.rate_limiters = {}
    lim = limiters.get(name)
    if lim is None:
        with _INIT_LOCK:
            lim = limiters.get(name)
            if lim is None:
                settings = getattr(state, "settings", None)
                if name == "report":
                    n = getattr(settings, "report_limit_per_hour", None) or _env_float("FV_REPORT_LIMIT_PER_HOUR", DEFAULT_REPORTS_PER_HOUR)
                    lim = RateLimiter.per_hour(n)
                else:
                    n = getattr(settings, "rate_limit_per_min", None) or _env_float("FV_RATE_LIMIT_PER_MIN", DEFAULT_PER_MIN)
                    lim = RateLimiter.per_minute(n)
                limiters[name] = lim
    return lim


def rate_limit(request: Request) -> None:
    """Dependency for every POST route and GET /t."""
    lim, key = _limiter(request, "default"), client_ip(request)
    if not lim.hit(key):
        raise HTTPException(429, "rate_limited", headers={"Retry-After": str(lim.retry_after(key))})


def report_allowed(request: Request) -> None:
    """Called by the SEAL_DEAD report path (unverified reports have their own, much smaller budget)."""
    lim, key = _limiter(request, "report"), client_ip(request)
    if not lim.hit(key):
        raise HTTPException(429, "report_limited", headers={"Retry-After": str(lim.retry_after(key))})
