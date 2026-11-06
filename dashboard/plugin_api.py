"""Gemini Live backend routes, mounted at ``/api/plugins/gemini-live/``.

Shared by the Desktop half (``ctx.rest``) and the web dashboard tab (``fetchJSON``). Every
request runs inside the requesting profile's scope (the dashboard mount binds it), so the key,
settings and memory all resolve per profile. The Gemini key never leaves this process: the client
gets a single-use ephemeral token whose constraints lock the whole voice session.
"""

from __future__ import annotations

import asyncio
import importlib.util
import sys
from pathlib import Path
from typing import Any, NoReturn

from fastapi import APIRouter, HTTPException

_CORE_PATH = Path(__file__).resolve().parent.parent / "glive_core.py"
_CORE_NAME = "hermes_gemini_live_core"


def _core():
    module = sys.modules.get(_CORE_NAME)
    if module is not None and getattr(module, "__file__", None) == str(_CORE_PATH):
        return module
    spec = importlib.util.spec_from_file_location(_CORE_NAME, _CORE_PATH)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {_CORE_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[_CORE_NAME] = module
    spec.loader.exec_module(module)
    return module


router = APIRouter()


def _raise(exc: Exception) -> NoReturn:
    core = _core()
    if isinstance(exc, core.GeminiApiError):
        status = int(getattr(exc, "status", 0) or 0)
        code = status if 400 <= status < 600 else 502
        raise HTTPException(status_code=code, detail=str(exc)) from None
    raise exc


@router.get("/status")
async def get_status() -> dict[str, Any]:
    return await asyncio.to_thread(_core().status)


@router.get("/models")
async def get_models(all: bool = False) -> dict[str, Any]:
    core = _core()
    key, _ = await asyncio.to_thread(core.resolve_api_key)
    if not key:
        return {"ok": False, "models": [], "reason": "No Gemini API key is set."}
    try:
        models = await asyncio.to_thread(core.list_live_models, key, include_all=all)
    except Exception as exc:
        _raise(exc)
    return {"ok": True, "models": models, "default": core.DEFAULT_MODEL}


@router.post("/session")
async def create_session(body: dict[str, Any]) -> dict[str, Any]:
    try:
        return {"ok": True, **await asyncio.to_thread(_core().create_session, body or {})}
    except Exception as exc:
        _raise(exc)


@router.post("/tool")
async def run_tool(body: dict[str, Any]) -> dict[str, Any]:
    name = str((body or {}).get("name") or "")
    args = (body or {}).get("args") or {}
    if not isinstance(args, dict):
        raise HTTPException(status_code=400, detail="args must be an object")
    context = (body or {}).get("context")
    result = await asyncio.to_thread(_core().run_server_tool, name, args,
                                     context if isinstance(context, dict) else None)
    return {"ok": "error" not in result, "result": result}


@router.get("/thread/{session_id}")
async def read_thread(session_id: str, limit: int = 8) -> dict[str, Any]:
    result = await asyncio.to_thread(_core().read_stored_thread, session_id, limit)
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return {"ok": True, **result}
