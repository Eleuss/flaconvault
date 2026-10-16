"""
Settings from environment / apps/verify/.env (python-dotenv). All keys are prefixed FV_.
"""
from __future__ import annotations

import ipaddress
import os
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv

APP_DIR = Path(__file__).resolve().parent.parent          # apps/verify
REPO_DIR = APP_DIR.parent.parent                          # flaconvault/
DEFAULT_SEED_PATH = REPO_DIR / "docs" / "seed" / "passports.json"
DEFAULT_ESCROW_PROGRAM_ID = "9vabByStbAqKH6sM6fuf8HhfGZbV3993Ncp3uZScexKL"

# Load apps/verify/.env once, without overriding variables already in the environment.
load_dotenv(APP_DIR / ".env", override=False)


def _bool(v: str | None, default: bool) -> bool:
    if v is None or v.strip() == "":
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


def is_local_rpc(url: str) -> bool:
    """A JSON-RPC URL on this machine (a local test validator): localhost, *.localhost or a loopback address."""
    try:
        host = (urlparse((url or "").strip()).hostname or "").lower()
    except ValueError:
        return False
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _resolve(p: str | Path) -> Path:
    p = Path(p)
    return p if p.is_absolute() else (APP_DIR / p).resolve()


@dataclass
class Settings:
    master_key_hex: str = "00000000000000000000000000000000"
    key_mode: str = "factory"                              # factory | diversified | sdmbackend
    sdm_derive: str = "legacy"                             # FV_SDM_DERIVE for sdmbackend: legacy (NFC Developer App, sdm-backend default) | standard (derive.py)
    server_seed_hex: str = ""                              # 32 byte hex, REQUIRED
    server_key_id: int = 1
    dev_simulator: bool = False                            # FV_DEV_SIMULATOR — /api/dev/* (off unless explicitly enabled)
    seed_demo: bool = False                                # FV_SEED_DEMO — load docs/seed into an empty DB even with the simulator off
    allow_sim_with_real_keys: bool = False                 # FV_ALLOW_SIM_WITH_REAL_KEYS — local validator only (see check_startup)
    admin_token: str = ""                                  # FV_ADMIN_TOKEN — x-admin-token for POST /api/reconcile and /api/dev/reset
    nonce_ttl_s: int = 90
    irys_key: str = ""                                     # FV_IRYS_KEY — path to a Solana keypair json, or "default"
    irys_key_json: str = ""                                # FV_IRYS_KEY_JSON — the keypair inline (64-number array) for hosted deployments
    solana_rpc: str = "https://api.devnet.solana.com"
    program_id: str = ""
    escrow_program_id: str = DEFAULT_ESCROW_PROGRAM_ID     # FV_ESCROW_PROGRAM_ID — escrow program whose txs back LIST…DISPUTE events
    db_path: Path = field(default_factory=lambda: _resolve("./data/flaconvault.db"))
    media_dir: Path = field(default_factory=lambda: _resolve("./data/media"))
    web_url: str = "http://localhost:3000"
    verifier_host: str = "http://localhost:8787"
    cors_origins: list[str] = field(default_factory=lambda: ["http://localhost:3000"])
    seed_path: Path = field(default_factory=lambda: DEFAULT_SEED_PATH)
    port: int = 8787
    reconcile_interval_s: int = 60                         # 0 disables the background loop (manual POST /api/reconcile only)
    reconcile_timeout_s: int = 600                         # SCAN(pending) without ScanProof PDA after this → failed
    arweave: bool = False                                  # FV_ARWEAVE — upload media/bundles via the Irys sidecar
    arweave_timeout_s: int = 60                            # FV_ARWEAVE_TIMEOUT_S — sidecar subprocess timeout
    irys_network: str = "devnet"                           # FV_IRYS_NETWORK — devnet | mainnet
    node_bin: str = ""                                     # FV_NODE_BIN — node binary for the sidecar (default ~/.local/node/bin/node or PATH)
    sdm_lrp: bool = False                                  # FV_SDM_LRP — accept 24-byte (LRP) picc_data; production stickers are AES
    rate_limit_per_min: int = 60                           # FV_RATE_LIMIT_PER_MIN — POST routes and GET /t, per client IP
    report_limit_per_hour: int = 3                         # FV_REPORT_LIMIT_PER_HOUR — unverified SEAL_DEAD reports per client IP
    trusted_proxy_hops: int = 1                            # FV_TRUSTED_PROXY_HOPS — proxies in front of the app (X-Forwarded-For)
    max_json_body: int = 64 * 1024                         # FV_MAX_JSON_BODY — request body limit in bytes (not /api/media)
    build_sha: str = ""                                    # FV_BUILD_SHA (or RAILWAY_GIT_COMMIT_SHA) — commit shown by GET /health
    media_retention_s: int = 7 * 86400                     # FV_MEDIA_RETENTION_S — kept media no scan references is deleted after this (0 = never)

    def __post_init__(self) -> None:
        self.key_mode = self.key_mode.strip().lower()
        if self.key_mode not in ("factory", "diversified", "sdmbackend"):
            raise ValueError(f"FV_KEY_MODE must be factory|diversified|sdmbackend, got {self.key_mode!r}")
        self.sdm_derive = (self.sdm_derive or "legacy").strip().lower()
        if self.sdm_derive not in ("legacy", "standard"):
            raise ValueError(f"FV_SDM_DERIVE must be legacy|standard, got {self.sdm_derive!r}")
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
        self.program_id = (self.program_id or "").strip()
        self.escrow_program_id = (self.escrow_program_id or "").strip()
        for env, value in (("FV_PROGRAM_ID", self.program_id), ("FV_ESCROW_PROGRAM_ID", self.escrow_program_id)):
            if value:
                from solders.pubkey import Pubkey
                try:
                    Pubkey.from_string(value)
                except Exception as exc:  # noqa: BLE001
                    raise ValueError(f"{env} is not a valid base58 pubkey: {value!r}") from exc
        self.admin_token = (self.admin_token or "").strip()
        self.db_path = _resolve(self.db_path)
        self.media_dir = _resolve(self.media_dir)
        self.seed_path = Path(self.seed_path)
        for name in ("rate_limit_per_min", "report_limit_per_hour", "trusted_proxy_hops", "max_json_body"):
            if int(getattr(self, name)) < 1:
                raise ValueError(f"FV_{name.upper()} must be a positive integer")
        self.build_sha = (self.build_sha or "").strip()[:40]
        if int(self.media_retention_s) < 0:
            raise ValueError("FV_MEDIA_RETENTION_S must be 0 (keep forever) or a positive number of seconds")

    @property
    def solana_rpc_public(self) -> str:
        """RPC handed to the Irys sidecar: a local validator cannot pay the Irys devnet node, so devnet uploads use public devnet."""
        if self.rpc_is_local:
            return "https://api.devnet.solana.com" if self.irys_network == "devnet" else "https://api.mainnet-beta.solana.com"
        return self.solana_rpc

    @property
    def rpc_is_local(self) -> bool:
        """FV_SOLANA_RPC is a local test validator (nothing signed here can reach devnet or mainnet accounts)."""
        return is_local_rpc(self.solana_rpc)

    @property
    def seed_enabled(self) -> bool:
        """The demo seed (docs/seed) is loaded into an empty database only on simulator / explicit demo deployments."""
        return self.dev_simulator or self.seed_demo

    def startup_problems(self) -> list[str]:
        """Configurations that must never serve taps (empty list = fine). See check_startup."""
        problems = []
        if not self.dev_simulator:
            if self.master_key == bytes(16):
                problems.append(
                    "FV_DEV_SIMULATOR is off and FV_MASTER_KEY is all zeros — set FV_MASTER_KEY to the secret 16-byte SDM "
                    "master key of your tags (or FV_DEV_SIMULATOR=true for local development only)")
            if self.key_mode == "factory":
                problems.append(
                    "FV_KEY_MODE=factory with FV_DEV_SIMULATOR off — factory mode checks taps with the public NXP null keys "
                    "(FV_MASTER_KEY is ignored), so anyone can forge a valid tap. Use FV_KEY_MODE=sdmbackend with "
                    "FV_SDM_DERIVE=legacy (stickers written with the NFC Developer App) or FV_KEY_MODE=diversified, together "
                    "with the secret FV_MASTER_KEY")
        elif self.key_mode != "factory":
            if not self.allow_sim_with_real_keys:
                problems.append(
                    f"FV_DEV_SIMULATOR=true with FV_KEY_MODE={self.key_mode} — the simulator mints valid taps for any UID "
                    "with these keys, and a verifier that shares FV_MASTER_KEY would accept them. Run the simulator with "
                    "FV_KEY_MODE=factory, a dev-only FV_MASTER_KEY and a dev-only FV_SERVER_ED25519_SEED (never the "
                    "production values). FV_ALLOW_SIM_WITH_REAL_KEYS=true is only for tests against a local validator "
                    "(or without FV_PROGRAM_ID), and never together with the production master key or seed")
            elif self.program_id and not self.rpc_is_local:
                problems.append(
                    f"FV_ALLOW_SIM_WITH_REAL_KEYS=true with FV_PROGRAM_ID set and FV_SOLANA_RPC={self.solana_rpc} — the "
                    f"escape hatch is only accepted against a local validator (localhost / 127.0.0.1) or without a program "
                    f"id: here the simulator would mint taps with real ({self.key_mode}) tag keys and sign scans that "
                    "record_scan on a shared cluster accepts. Use FV_KEY_MODE=factory with a dev-only FV_MASTER_KEY and "
                    "a dev-only FV_SERVER_ED25519_SEED instead")
        return problems

    def registered_key_problem(self, server_keys: list[dict], now_ts: int) -> str | None:
        """
        With the simulator on against a shared cluster (FV_PROGRAM_ID set, FV_SOLANA_RPC not local), the signing key must
        not be a live server key of the on-chain registry: every scan the simulator signs — for virtual tags, or a
        virtual tag created with a real sticker's UID — would be accepted by record_scan there. `server_keys` are the
        decoded Registry.serverKeys ({keyId, pubkeyHex, validFrom, validTo}; validTo 0 = never expires).
        """
        if not self.dev_simulator or not self.program_id or self.rpc_is_local:
            return None
        from fv import proof
        pub = proof.public_key(self.server_seed).hex()
        for k in server_keys or []:
            valid_to = int(k.get("validTo") or 0)
            if str(k.get("pubkeyHex") or "").lower() == pub and (valid_to == 0 or valid_to > now_ts):
                return (f"FV_DEV_SIMULATOR=true but FV_SERVER_ED25519_SEED is registered server key {k.get('keyId')} of "
                        f"program {self.program_id} on {self.solana_rpc} — scans this simulator signs would be accepted "
                        "by record_scan there. Give the simulator a dev-only seed that is not in the registry (or run it "
                        "against a local validator)")
        return None

    def check_startup(self) -> None:
        """
        Refuse to serve real taps with a key anyone can compute, and refuse a simulator that mints taps with real tag
        keys (FV_ALLOW_SIM_WITH_REAL_KEYS lifts that only against a local validator or without a program id). Called
        from the app lifespan (startup), so a misconfigured deployment fails loudly instead of accepting forged SUN URLs.
        The lifespan also refuses a simulator whose signing key is a live registry server key (registered_key_problem).
        """
        problems = self.startup_problems()
        if problems:
            raise RuntimeError("refusing to start: " + " | ".join(problems))

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
        sdm_derive=e("FV_SDM_DERIVE") or "legacy",
        server_seed_hex=e("FV_SERVER_ED25519_SEED") or "",
        server_key_id=int(e("FV_SERVER_KEY_ID") or 1),
        dev_simulator=_bool(e("FV_DEV_SIMULATOR"), False),
        seed_demo=_bool(e("FV_SEED_DEMO"), False),
        allow_sim_with_real_keys=_bool(e("FV_ALLOW_SIM_WITH_REAL_KEYS"), False),
        admin_token=e("FV_ADMIN_TOKEN") or "",
        nonce_ttl_s=int(e("FV_NONCE_TTL_S") or 90),
        irys_key=e("FV_IRYS_KEY") or "",
        irys_key_json=e("FV_IRYS_KEY_JSON") or "",
        solana_rpc=e("FV_SOLANA_RPC") or "https://api.devnet.solana.com",
        program_id=e("FV_PROGRAM_ID") or "",
        escrow_program_id=e("FV_ESCROW_PROGRAM_ID") or DEFAULT_ESCROW_PROGRAM_ID,
        db_path=_resolve(e("FV_DB_PATH") or "./data/flaconvault.db"),
        media_dir=_resolve(e("FV_MEDIA_DIR") or "./data/media"),
        web_url=(e("FV_WEB_URL") or "http://localhost:3000").rstrip("/"),
        verifier_host=(e("FV_VERIFIER_HOST") or "http://localhost:8787").rstrip("/"),
        cors_origins=origins,
        seed_path=Path(e("FV_SEED_PATH") or DEFAULT_SEED_PATH),
        port=int(e("FV_PORT") or 8787),
        reconcile_interval_s=int(e("FV_RECONCILE_INTERVAL_S") or 60),
        reconcile_timeout_s=int(e("FV_RECONCILE_TIMEOUT_S") or 600),
        arweave=_bool(e("FV_ARWEAVE"), False),
        arweave_timeout_s=int(e("FV_ARWEAVE_TIMEOUT_S") or 60),
        irys_network=(e("FV_IRYS_NETWORK") or "devnet").strip().lower(),
        node_bin=e("FV_NODE_BIN") or "",
        sdm_lrp=_bool(e("FV_SDM_LRP"), False),
        rate_limit_per_min=int(e("FV_RATE_LIMIT_PER_MIN") or 60),
        report_limit_per_hour=int(e("FV_REPORT_LIMIT_PER_HOUR") or 3),
        trusted_proxy_hops=int(e("FV_TRUSTED_PROXY_HOPS") or 1),
        max_json_body=int(e("FV_MAX_JSON_BODY") or 64 * 1024),
        build_sha=e("FV_BUILD_SHA") or e("RAILWAY_GIT_COMMIT_SHA") or "",
        media_retention_s=int(e("FV_MEDIA_RETENTION_S") or 7 * 86400),
    )
