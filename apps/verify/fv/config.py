"""
Settings from environment / apps/verify/.env (python-dotenv). All keys are prefixed FV_.
"""
from __future__ import annotations

import ipaddress
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv

APP_DIR = Path(__file__).resolve().parent.parent          # apps/verify
REPO_DIR = APP_DIR.parent.parent                          # flaconvault/
DEFAULT_SEED_PATH = REPO_DIR / "docs" / "seed" / "passports.json"
DEFAULT_ESCROW_PROGRAM_ID = "9vabByStbAqKH6sM6fuf8HhfGZbV3993Ncp3uZScexKL"
# FVSCAN2 messages name this flacon program while FV_PROGRAM_ID is unset (offline dev server, nothing is sent: D20)
DEFAULT_PROGRAM_ID = "7dCr825ibTyE6Y5oPHP2RCmUi5qFPCaKdZmE9TYeAcWL"
CLUSTERS = ("mainnet", "devnet", "localnet")             # FV_CLUSTER; upper-cased = the cluster enum (cluster_tag)

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


def parse_keypair(value: str | None, env: str):
    """
    (solders Keypair, None) for a Solana keypair JSON (64 numbers whose second half is the public key of the first),
    (None, None) when empty, (None, problem) otherwise. The problem text never contains any part of the value.
    """
    v = (value or "").strip()
    if not v:
        return None, None
    try:
        raw = json.loads(v)
        if (not isinstance(raw, list) or len(raw) != 64
                or any(isinstance(x, bool) or not isinstance(x, int) or not 0 <= x <= 255 for x in raw)):
            raise ValueError
        from solders.keypair import Keypair
        b = bytes(raw)
        kp = Keypair.from_seed(b[:32])
        if bytes(kp.pubkey()) != b[32:]:
            raise ValueError
    except Exception:  # noqa: BLE001 — never chain or echo the parser's message: it may quote the secret
        return None, (f"{env} is not a Solana keypair (a JSON array of 64 numbers whose second half is the public key "
                      "of the first)")
    return kp, None


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
    # public record relay (docs/public-record.md §9.1)
    cluster: str = "devnet"                                # FV_CLUSTER — devnet | mainnet | localnet: cluster_tag of every FVSCAN2
    relay_enabled: bool = False                            # FV_RELAY_ENABLED — kill switch: nothing is ever sent while false
    relayer_key_json: str = field(default="", repr=False)  # FV_RELAYER_KEY — fee payer only (secret; cleared once parsed)
    holder_key_json: str = field(default="", repr=False)   # FV_HOLDER_KEY — P2, parsed and validated only (secret)
    issuer_key_json: str = field(default="", repr=False)   # FV_ISSUER_KEY — P2, parsed and validated only (secret)
    solana_rpc_fallback: str = ""                          # FV_SOLANA_RPC_FALLBACK — second RPC for relay sends and status reads
    relay_daily_lamports: int = 10_000_000                 # FV_RELAY_DAILY_LAMPORTS — global fee cap per UTC day
    relay_low_balance_lamports: int = 100_000_000          # FV_RELAY_LOW_BALANCE_LAMPORTS — relayer balance alert (0.1 SOL)
    relay_cu_limit: int = 150_000                          # FV_RELAY_CU_LIMIT — compute unit limit of a relay transaction
    relay_max_priority_microlamports: int = 10_000         # FV_RELAY_MAX_PRIORITY_MICROLAMPORTS — priority fee price ceiling
    relay_interval_s: float = 2.0                          # FV_RELAY_INTERVAL_S — relay loop interval (woken early by a CHECK)
    relayer_keypair: object = field(default=None, init=False, repr=False, compare=False)
    holder_keypair: object = field(default=None, init=False, repr=False, compare=False)
    issuer_keypair: object = field(default=None, init=False, repr=False, compare=False)
    key_problems: list = field(default_factory=list, init=False, repr=False, compare=False)

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
        self.cluster = (self.cluster or "devnet").strip().lower()
        self.solana_rpc_fallback = (self.solana_rpc_fallback or "").strip()
        for name in ("relay_daily_lamports", "relay_low_balance_lamports", "relay_max_priority_microlamports"):
            if int(getattr(self, name)) < 0:
                raise ValueError(f"FV_{name.upper()} must be 0 or a positive integer")
        if not 1 <= int(self.relay_cu_limit) <= 1_400_000:
            raise ValueError("FV_RELAY_CU_LIMIT must be 1..1400000")
        if not float(self.relay_interval_s) > 0:
            raise ValueError("FV_RELAY_INTERVAL_S must be a positive number of seconds")
        # keys: keep only the keypair objects (public keys are exposed, the secret never leaves the object)
        self.key_problems = []
        for env, attr in (("FV_RELAYER_KEY", "relayer"), ("FV_HOLDER_KEY", "holder"), ("FV_ISSUER_KEY", "issuer")):
            kp, problem = parse_keypair(getattr(self, f"{attr}_key_json"), env)
            setattr(self, f"{attr}_keypair", kp)
            setattr(self, f"{attr}_key_json", "")
            if problem:
                self.key_problems.append(problem)

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
    def fallback_rpc_is_local(self) -> bool:
        return is_local_rpc(self.solana_rpc_fallback) if self.solana_rpc_fallback else self.rpc_is_local

    @property
    def cluster_tag(self) -> int:
        """cluster enum value of FV_CLUSTER (1 MAINNET, 2 DEVNET, 3 LOCALNET); startup refuses any other FV_CLUSTER."""
        from fv.enums import Cluster
        return getattr(Cluster, self.cluster.upper())

    @property
    def v2_program_id(self) -> str:
        """The flacon program FVSCAN2 messages are bound to: FV_PROGRAM_ID, else DEFAULT_PROGRAM_ID (D20)."""
        return self.program_id or DEFAULT_PROGRAM_ID

    def _pub(self, kp) -> str | None:
        return str(kp.pubkey()) if kp is not None else None

    @property
    def relayer_pubkey(self) -> str | None:
        return self._pub(self.relayer_keypair)

    @property
    def holder_pubkey(self) -> str | None:
        return self._pub(self.holder_keypair)

    @property
    def issuer_pubkey(self) -> str | None:
        return self._pub(self.issuer_keypair)

    def relay_problems(self) -> list[str]:
        """Public-record relay configurations that must never serve (part of startup_problems, spec §9.1)."""
        problems = list(self.key_problems)
        if self.cluster not in CLUSTERS:
            problems.append(f"FV_CLUSTER must be devnet, mainnet or localnet, got {self.cluster!r}")
            return problems
        local = self.rpc_is_local and self.fallback_rpc_is_local
        remote = not self.rpc_is_local and not self.fallback_rpc_is_local
        if self.cluster == "localnet" and not local:
            problems.append("FV_CLUSTER=localnet with a non-local FV_SOLANA_RPC / FV_SOLANA_RPC_FALLBACK — localnet scans "
                            "are only sent to a local validator")
        if self.cluster == "mainnet" and self.dev_simulator:
            problems.append("FV_CLUSTER=mainnet with FV_DEV_SIMULATOR=true — the simulator mints taps")
        if self.relay_enabled:
            if not self.relayer_keypair and not any(p.startswith("FV_RELAYER_KEY") for p in problems):
                problems.append("FV_RELAY_ENABLED=true without FV_RELAYER_KEY (the fee payer keypair)")
            if not self.program_id:
                problems.append("FV_RELAY_ENABLED=true without FV_PROGRAM_ID")
            if self.cluster in ("devnet", "mainnet") and not remote:
                problems.append(f"FV_RELAY_ENABLED=true with FV_CLUSTER={self.cluster} against a local RPC — the messages "
                                "would carry the wrong cluster tag")
            if self.dev_simulator and not local:
                problems.append("FV_RELAY_ENABLED=true with FV_DEV_SIMULATOR=true against a shared cluster — simulated taps "
                                "would be sent to the public record")
        pubs = [("FV_SERVER_ED25519_SEED", str(self._scan_pubkey())), ("FV_RELAYER_KEY", self.relayer_pubkey),
                ("FV_HOLDER_KEY", self.holder_pubkey), ("FV_ISSUER_KEY", self.issuer_pubkey)]
        seen: dict[str, str] = {}
        for env, pub in pubs:
            if pub is None:
                continue
            if pub in seen:
                problems.append(f"{env} and {seen[pub]} are the same key — every role needs its own key")
            else:
                seen[pub] = env
        return problems

    def _scan_pubkey(self):
        from solders.pubkey import Pubkey
        from fv import proof
        return Pubkey.from_bytes(proof.public_key(self.server_seed))

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
        return problems + self.relay_problems()

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
        cluster=e("FV_CLUSTER") or "devnet",
        relay_enabled=_bool(e("FV_RELAY_ENABLED"), False),
        relayer_key_json=e("FV_RELAYER_KEY") or "",
        holder_key_json=e("FV_HOLDER_KEY") or "",
        issuer_key_json=e("FV_ISSUER_KEY") or "",
        solana_rpc_fallback=e("FV_SOLANA_RPC_FALLBACK") or "",
        relay_daily_lamports=int(e("FV_RELAY_DAILY_LAMPORTS") or 10_000_000),
        relay_low_balance_lamports=int(e("FV_RELAY_LOW_BALANCE_LAMPORTS") or 100_000_000),
        relay_cu_limit=int(e("FV_RELAY_CU_LIMIT") or 150_000),
        relay_max_priority_microlamports=int(e("FV_RELAY_MAX_PRIORITY_MICROLAMPORTS") or 10_000),
        relay_interval_s=float(e("FV_RELAY_INTERVAL_S") or 2),
    )
