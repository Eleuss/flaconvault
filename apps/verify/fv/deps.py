"""FastAPI dependencies: settings and a per-request SQLite connection."""
from __future__ import annotations

from typing import Iterator

from fastapi import Request

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
