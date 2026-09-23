"""
FlaconVault verification server — app factory.

  uv run uvicorn fv.main:app --port 8787 --reload
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from fv import routes_api, routes_dev, routes_tag
from fv.config import Settings, settings_from_env
from fv.db import Database
from fv.seed import run_seed

log = logging.getLogger("fv")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or settings_from_env()
    db = Database(settings.db_path)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        db.init()
        settings.media_dir.mkdir(parents=True, exist_ok=True)
        if db.is_empty() and settings.seed_path.exists():
            counts = run_seed(db, settings)
            log.info("seeded empty database from %s: %s", settings.seed_path, counts)
        yield

    app = FastAPI(title="FlaconVault verify", version="0.1.0", lifespan=lifespan)
    app.state.settings = settings
    app.state.db = db
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=False,
                       allow_methods=["*"], allow_headers=["*"])
    app.include_router(routes_api.router)
    app.include_router(routes_tag.router)
    app.include_router(routes_dev.router)
    return app


app = create_app()
