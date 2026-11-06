"""Shared fixtures: a throwaway HERMES_HOME bound the way the gateway binds a request.

Run with Hermes' own interpreter so the real ``agent.secret_scope`` / ``hermes_cli.config``
imports are exercised (see README → Development). Nothing here touches the network or ``~/.hermes``.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


@pytest.fixture
def home(tmp_path, monkeypatch):
    """A profile home with config + .env, and a secret scope bound to it (like a gateway request)."""
    from agent.secret_scope import build_profile_secret_scope, reset_secret_scope, set_secret_scope

    for name in ("GEMINI_LIVE_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    h = tmp_path / "home"
    (h / "memories").mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(h))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)

    tokens = []

    def bind():
        from agent.secret_scope import invalidate_env_file_cache
        invalidate_env_file_cache()
        if tokens:
            reset_secret_scope(tokens.pop())
        tokens.append(set_secret_scope(build_profile_secret_scope(h), profile_home=str(h)))

    def write(config: str = "", env: str = "") -> Path:
        (h / "config.yaml").write_text(config or "model:\n  provider: auto\n", encoding="utf-8")
        (h / ".env").write_text(env, encoding="utf-8")
        bind()
        return h

    write()
    h_obj = type("Home", (), {"path": h, "write": staticmethod(write), "bind": staticmethod(bind)})
    yield h_obj
    while tokens:
        reset_secret_scope(tokens.pop())


@pytest.fixture
def core():
    import glive_core
    return importlib.reload(glive_core)
