"""
Settings from environment / apps/verify/.env (python-dotenv). All keys are prefixed FV_.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

APP_DIR = Path(__file__).resolve().parent.parent          # apps/verify
REPO_DIR = APP_DIR.parent.parent                          # flaconvault/
DEFAULT_SEED_PATH = REPO_DIR / "docs" / "seed" / "passports.json"

# Load apps/verify/.env once, without overriding variables already in the environment.
load_dotenv(APP_DIR / ".env", override=False)


def _bool(v: str | None, default: bool) -> bool:
    if v is None or v.strip() == "":
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


def _resolve(p: str | Path) -> Path:
    p = Path(p)
    return p if p.is_absolute() else (APP_DIR / p).resolve()


@dataclass
class Settings:
    master_key_hex: str = "00000000000000000000000000000000"
    key_mode: str = "factory"                              # factory | diversified
    server_seed_hex: str = ""                              # 32 byte hex, REQUIRED
    server_key_id: int = 1
    dev_simulator: bool = True
    nonce_ttl_s: int = 90
    irys_key: str = ""                                     # unused until week 2
    solana_rpc: str = "https://api.devnet.solana.com"
    program_id: str = ""
    db_path: Path = field(default_factory=lambda: _resolve("./data/flaconvault.db"))
    media_dir: Path = field(default_factory=lambda: _resolve("./data/media"))
    web_url: str = "http://localhost:3000"
    verifier_host: str = "http://localhost:8787"
    cors_origins: list[str] = field(default_factory=lambda: ["http://localhost:3000"])
    seed_path: Path = field(default_factory=lambda: DEFAULT_SEED_PATH)
    port: int = 8787

    def __post_init__(self) -> None:
        self.key_mode = self.key_mode.strip().lower()
        if self.key_mode not in ("factory", "diversified"):
            raise ValueError(f"FV_KEY_MODE must be factory|diversified, got {self.key_mode!r}")
        mk = self.master_key_hex.strip().lower().removeprefix("0x")
        if len(mk) != 32 or any(c not in "0123456789abcdef" for c in mk):
            raise ValueError("FV_MASTER_KEY must be 16 bytes hex")
        self.master_key_hex = mk
        seed = self.server_seed_hex.strip().lower().removeprefix("0x")
        if len(seed) != 64 or any(c not in "0123456789abcdef" for c in seed):
            raise ValueError(
                "FV_SERVER_ED25519_SEED must be 32 bytes hex — generate with: "
                "python -c \"import os;print(os.urandom(32).hex())\""
            )
        self.server_seed_hex = seed
        self.db_path = _resolve(self.db_path)
        self.media_dir = _resolve(self.media_dir)
        self.seed_path = Path(self.seed_path)

    @property
    def master_key(self) -> bytes:
        return bytes.fromhex(self.master_key_hex)

    @property
    def server_seed(self) -> bytes:
        return bytes.fromhex(self.server_seed_hex)


def settings_from_env() -> Settings:
    e = os.environ.get
    origins = [o.strip() for o in (e("FV_CORS_ORIGINS") or "http://localhost:3000").split(",") if o.strip()]
    return Settings(
        master_key_hex=e("FV_MASTER_KEY") or "00000000000000000000000000000000",
        key_mode=e("FV_KEY_MODE") or "factory",
        server_seed_hex=e("FV_SERVER_ED25519_SEED") or "",
        server_key_id=int(e("FV_SERVER_KEY_ID") or 1),
        dev_simulator=_bool(e("FV_DEV_SIMULATOR"), True),
        nonce_ttl_s=int(e("FV_NONCE_TTL_S") or 90),
        irys_key=e("FV_IRYS_KEY") or "",
        solana_rpc=e("FV_SOLANA_RPC") or "https://api.devnet.solana.com",
        program_id=e("FV_PROGRAM_ID") or "",
        db_path=_resolve(e("FV_DB_PATH") or "./data/flaconvault.db"),
        media_dir=_resolve(e("FV_MEDIA_DIR") or "./data/media"),
        web_url=(e("FV_WEB_URL") or "http://localhost:3000").rstrip("/"),
        verifier_host=(e("FV_VERIFIER_HOST") or "http://localhost:8787").rstrip("/"),
        cors_origins=origins,
        seed_path=Path(e("FV_SEED_PATH") or DEFAULT_SEED_PATH),
        port=int(e("FV_PORT") or 8787),
    )
