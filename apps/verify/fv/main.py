"""
FlaconVault verification server — app factory.

  uv run uvicorn fv.main:app --port 8787 --reload
"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from fv import arweave, routes_admin, routes_api, routes_chain, routes_dev, routes_tag
from fv.chain import Rpc
from fv.config import Settings, settings_from_env
from fv.db import Database
from fv.reconcile import reconcile_once
from fv.seed import count_seed_rows, run_seed

log = logging.getLogger("fv")
ARWEAVE_PROBE_S = 3600          # Irys balance probe interval of the background loop


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or settings_from_env()
    if not logging.getLogger().handlers:   # uvicorn configures only its own loggers; make fv.* visible
        logging.basicConfig(level=logging.INFO, format="%(levelname)s:     %(name)s: %(message)s")
    db = Database(settings.db_path)

    async def reconcile_loop(app: FastAPI) -> None:
        interval = settings.reconcile_interval_s
        await asyncio.sleep(min(5, interval))
        last_probe: float | None = None
        while True:
            t = asyncio.get_running_loop().time()
            if arweave.enabled(settings) and (last_probe is None or t - last_probe >= ARWEAVE_PROBE_S):
                last_probe = t
                try:   # Irys balance (read-only) → /health, so an unfunded or drained wallet is visible before uploads fail
                    await asyncio.to_thread(arweave.probe, settings)
                except Exception:  # noqa: BLE001
                    log.exception("arweave probe failed")
            try:
                summary = await asyncio.to_thread(reconcile_once, db, settings, app.state.rpc)
                if summary["checked"] or summary["failed"] or summary["refreshed"]["passports"] or summary["refreshed"]["seals"]:
                    log.info("reconcile: %s", summary)
            except Exception:  # noqa: BLE001 — keep the loop alive (validator down, RPC error, …)
                log.exception("reconcile cycle failed")
            await asyncio.sleep(interval)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        settings.check_startup()      # forgeable keys (factory / all-zero master without the simulator), simulator with real keys
        if not settings.admin_token:
            log.info("FV_ADMIN_TOKEN not set: POST /api/reconcile is disabled (the background loop still runs)")
        db.init()
        settings.media_dir.mkdir(parents=True, exist_ok=True)
        problem = arweave.config_problem(settings)
        if problem:
            log.error("arweave archiving will not work: %s", problem)
        elif arweave.enabled(settings):
            log.info("arweave archiving on (Irys %s); failures are reported by GET /api/admin/status", settings.irys_network)
        if db.is_empty() and settings.seed_path.exists():
            if settings.seed_enabled:
                counts = run_seed(db, settings)
                log.info("seeded empty database from %s (demo data, signed with a throwaway key): %s", settings.seed_path, counts)
            else:
                log.info("empty database: demo seed not loaded (FV_DEV_SIMULATOR and FV_SEED_DEMO are off)")
        elif not settings.seed_enabled and settings.seed_path.exists():
            with db.connect() as conn:
                leftover = count_seed_rows(conn, settings.seed_path)
            if leftover:
                log.warning("database holds %s events from the demo seed (fake txSigs / seed-signed scans) although this is "
                            "not a demo deployment — review POST /api/admin/purge-seed (dry run), then apply it", leftover)
        task = None
        if settings.program_id and settings.reconcile_interval_s > 0:
            task = asyncio.create_task(reconcile_loop(app))
            log.info("reconcile loop every %ss against %s (program %s)", settings.reconcile_interval_s, settings.solana_rpc, settings.program_id)
        else:
            log.info("reconcile loop disabled (%s)", "no FV_PROGRAM_ID" if not settings.program_id else "FV_RECONCILE_INTERVAL_S=0")
        try:
            yield
        finally:
            if task:
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):  # noqa: BLE001
                    pass

    app = FastAPI(title="FlaconVault verify", version="0.1.0", lifespan=lifespan)
    app.state.settings = settings
    app.state.db = db
    app.state.rpc = Rpc(settings.solana_rpc)
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=False,
                       allow_methods=["*"], allow_headers=["*"])
    app.include_router(routes_api.router)
    app.include_router(routes_tag.router)
    app.include_router(routes_chain.router)
    app.include_router(routes_dev.router)
    app.include_router(routes_admin.router)
    return app


app = create_app()
