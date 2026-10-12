"""FastAPI dependencies: settings and a per-request SQLite connection."""
from __future__ import annotations

import hmac
from typing import Iterator

from fastapi import HTTPException, Request

from fv.config import Settings
from fv.db import Database


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_db(request: Request) -> Database:
    return request.app.state.db


def get_conn(request: Request) -> Iterator:
    conn = request.app.state.db.connect()
    try:
        yield conn
    finally:
        conn.close()


def get_rpc(request: Request):
    return request.app.state.rpc


def admin_token_ok(settings: Settings, header_value: str | None) -> bool:
    """Constant-time check of the `x-admin-token` header against FV_ADMIN_TOKEN (False when the env is unset)."""
    if not settings.admin_token or not header_value:
        return False
    return hmac.compare_digest(header_value.encode("utf-8"), settings.admin_token.encode("utf-8"))


def require_admin(request: Request) -> None:
    """Dependency: 403 unless `x-admin-token` equals FV_ADMIN_TOKEN (also 403 when FV_ADMIN_TOKEN is not configured)."""
    if not admin_token_ok(request.app.state.settings, request.headers.get("x-admin-token")):
        raise HTTPException(403, "admin token required")
