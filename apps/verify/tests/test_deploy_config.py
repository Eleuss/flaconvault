"""Deployment files stay consistent with the code: pinned, non-root image (S14), a startable example env (M11), and every
FV_* setting documented."""
import json
import re
from pathlib import Path

from dotenv import dotenv_values

from fv.config import Settings

APP = Path(__file__).resolve().parents[1]
REPO = APP.parents[1]
DOCKERFILE = (REPO / "Dockerfile.verify").read_text(encoding="utf-8")
ENTRYPOINT = (APP / "docker-entrypoint.sh").read_text(encoding="utf-8")


def _env_vars_read_by_config() -> set[str]:
    return set(re.findall(r'e\("(FV_[A-Z0-9_]+)"\)', (APP / "fv" / "config.py").read_text(encoding="utf-8")))


def test_example_env_starts_as_a_local_simulator():
    env = dotenv_values(APP / ".env.example")
    assert all("#" not in (v or "") for v in env.values()), "inline comment parsed as a value"
    assert env["FV_DEV_SIMULATOR"] == "true" and env["FV_KEY_MODE"] == "factory"
    s = Settings(master_key_hex=env["FV_MASTER_KEY"], key_mode=env["FV_KEY_MODE"], server_seed_hex="11" * 32,
                 dev_simulator=True, seed_demo=env["FV_SEED_DEMO"] == "true",
                 allow_sim_with_real_keys=env["FV_ALLOW_SIM_WITH_REAL_KEYS"] == "true")
    s.check_startup()
    assert env["FV_SERVER_ED25519_SEED"] == ""                                       # never a real seed in the repo


def _env_vars_read_anywhere() -> set[str]:
    """FV_* names the verifier reads: Settings (config.py) and the limits read through ratelimit.setting / _env_float."""
    names = set()
    for f in (APP / "fv").glob("*.py"):
        text = f.read_text(encoding="utf-8")
        names |= set(re.findall(r'e\("(FV_[A-Z0-9_]+)"\)', text))
        names |= set(re.findall(r'(?:setting|_setting|_env_float)\([^)]*?"(FV_[A-Z0-9_]+)"', text, re.S))
    return names


def test_every_setting_is_documented():
    names = _env_vars_read_by_config()
    assert {"FV_SEED_DEMO", "FV_ALLOW_SIM_WITH_REAL_KEYS", "FV_KEY_MODE", "FV_MEDIA_RETENTION_S"} <= names
    readme = (APP / "README.md").read_text(encoding="utf-8")
    example = (APP / ".env.example").read_text(encoding="utf-8")
    assert [n for n in sorted(names) if f"`{n}`" not in readme] == []
    assert [n for n in sorted(names) if n not in example and n not in ("FV_SEED_PATH", "FV_PORT", "FV_NODE_BIN")] == []


def test_every_variable_read_anywhere_is_documented_in_readme_example_and_deploy():
    names = _env_vars_read_anywhere()
    assert {"FV_MEDIA_MIN_FREE_BYTES", "FV_MEDIA_MAX_BYTES_PER_IP_DAY", "FV_MEDIA_MAX_BYTES_PER_HOUR", "FV_RATE_LIMIT_PER_MIN",
            "FV_TRUSTED_PROXY_HOPS", "FV_MAX_JSON_BODY", "FV_BUILD_SHA", "FV_ESCROW_PROGRAM_ID"} <= names
    readme = (APP / "README.md").read_text(encoding="utf-8")
    example = dotenv_values(APP / ".env.example")
    deploy = (REPO / "docs" / "deploy.md").read_text(encoding="utf-8")
    assert [n for n in sorted(names) if f"`{n}`" not in readme] == []
    assert [n for n in sorted(names) if n not in example and n not in ("FV_SEED_PATH", "FV_PORT", "FV_NODE_BIN")] == []
    assert [n for n in sorted(names) if f"`{n}`" not in deploy] == []


def test_example_media_limits_equal_the_code_defaults():
    from fv import media_store
    env = dotenv_values(APP / ".env.example")
    assert int(env["FV_MEDIA_MIN_FREE_BYTES"]) == media_store.DEFAULT_MIN_FREE_BYTES
    assert int(env["FV_MEDIA_MAX_BYTES_PER_IP_DAY"]) == media_store.DEFAULT_MAX_BYTES_PER_IP_DAY
    assert int(env["FV_MEDIA_MAX_BYTES_PER_HOUR"]) == media_store.DEFAULT_MAX_BYTES_PER_HOUR
    assert int(env["FV_MEDIA_RETENTION_S"]) == Settings(server_seed_hex="11" * 32).media_retention_s
    assert int(env["FV_MAX_JSON_BODY"]) == Settings(server_seed_hex="11" * 32).max_json_body


def test_image_is_pinned_and_verified():
    froms = re.findall(r"^FROM\s+(\S+)", DOCKERFILE, re.M)
    assert len(froms) == 3
    for image in froms:
        assert re.search(r":\d+\.\d+\.\d+", image), image                           # exact version, never a moving tag
        # ... and the image digest: official images are re-pushed under the same tag, the digest cannot move
        assert re.search(r":\d+\.\d+\.\d+[^@\s]*@sha256:[0-9a-f]{64}$", image), image
    assert "latest" not in DOCKERFILE
    assert "COPY --from=ghcr.io/astral-sh/uv:latest" not in DOCKERFILE and "nodejs.org/dist" not in DOCKERFILE
    assert re.search(r"npm ci .*--ignore-scripts", DOCKERFILE)
    assert "uv run" not in DOCKERFILE.split("CMD", 1)[1]                            # runtime needs no uv / cache dir


def test_image_runs_as_an_unprivileged_user():
    assert re.search(r"useradd .*--uid 10001", DOCKERFILE)
    assert 'ENTRYPOINT ["/app/apps/verify/docker-entrypoint.sh"]' in DOCKERFILE
    assert "os.setuid(pw.pw_uid)" in ENTRYPOINT and "refusing to run as root" in ENTRYPOINT
    assert ENTRYPOINT.index("os.setgid") < ENTRYPOINT.index("os.setuid")             # drop the group first
    assert "chown" in ENTRYPOINT and ENTRYPOINT.startswith("#!/bin/sh")
    assert (APP / "docker-entrypoint.sh").stat().st_mode & 0o111                     # executable in the repo too


def test_railway_healthcheck():
    cfg = json.loads((REPO / "railway.json").read_text(encoding="utf-8"))
    assert cfg["build"]["dockerfilePath"] == "Dockerfile.verify" and cfg["deploy"]["healthcheckPath"] == "/health"
