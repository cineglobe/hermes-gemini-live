"""The dashboard routes, mounted on a bare FastAPI app (no Hermes server is started)."""

from __future__ import annotations

import importlib.util
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent


def _client():
    spec = importlib.util.spec_from_file_location("glive_plugin_api_test", ROOT / "dashboard" / "plugin_api.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    app = FastAPI()
    app.include_router(module.router, prefix="/api/plugins/gemini-live")
    return TestClient(app)


def test_status_without_key(home):
    body = _client().get("/api/plugins/gemini-live/status").json()
    assert body["configured"] is False and body["model"] == "gemini-3.8-live"
    assert {p["id"] for p in body["personas"]} >= {"hermes", "concise"}


def test_session_without_key_is_412(home):
    r = _client().post("/api/plugins/gemini-live/session", json={})
    assert r.status_code == 412


def test_server_tool_routes(home):
    c = _client()
    r = c.post("/api/plugins/gemini-live/tool", json={"name": "nope", "args": {}}).json()
    assert r["ok"] is False
    r = c.post("/api/plugins/gemini-live/tool", json={"name": "recall_memory", "args": {"query": "anything"}}).json()
    assert r["ok"] is True and "builtin" in r["result"]
    assert c.post("/api/plugins/gemini-live/tool", json={"name": "recall_memory", "args": "x"}).status_code == 400


def test_thread_rejects_bad_ids(home):
    assert _client().get("/api/plugins/gemini-live/thread/..%2F..%2Fx").status_code == 404
