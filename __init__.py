"""Gemini Live for Hermes — agent half.

The call itself lives in the Desktop pane (``desktop/plugin.js``) and the web dashboard tab
(``dashboard/``); both reach ``dashboard/plugin_api.py`` for the session token and server tools.
This half adds ``hermes gemini-live`` for setup checks from a terminal.
"""

from __future__ import annotations

import json


def _core():
    # Imported on use: `hermes --help` loads every plugin, and this half only needs the core
    # when a `hermes gemini-live` command actually runs.
    from . import glive_core
    return glive_core


def _doctor(_args) -> int:
    core = _core()
    key, source = core.resolve_api_key()
    settings = core.load_settings()
    print(f"Gemini Live plugin {core.VERSION}")
    if not key:
        print("✗ No Gemini API key. Set one with:  hermes config set GEMINI_LIVE_API_KEY <key>")
        print("  (or add it in Desktop → Settings → Plugins → Gemini Live). Get a key at aistudio.google.com/apikey")
        return 1
    print(f"✓ API key found ({source})")
    try:
        models = core.list_live_models(key)
    except core.GeminiApiError as exc:
        print(f"✗ Could not list models: {exc}")
        return 1
    ids = [m["id"] for m in models]
    print(f"✓ {len(ids)} Live models available: {', '.join(ids)}")
    if settings["model"] not in ids:
        print(f"! Configured model {settings['model']!r} is not in that list; calls may fail.")
    try:
        session = core.create_session({})
    except core.GeminiApiError as exc:
        print(f"✗ Could not mint a session token: {exc}")
        return 1
    print(f"✓ Session token minted for {session['model']} ({session['voice']}, persona {session['persona']}),"
          f" {len(session['tools'])} tools")
    print(f"  memory: {core.status()['memory_provider']}; thread control "
          f"{'on' if settings['thread_control'] else 'off'}; system checks "
          f"{'on' if settings['system_checks'] else 'off'}")
    return 0


def _models(args) -> int:
    core = _core()
    key, _ = core.resolve_api_key()
    if not key:
        print("No Gemini API key set.")
        return 1
    models = core.list_live_models(key, include_all=getattr(args, "all", False))
    if getattr(args, "json", False):
        print(json.dumps(models, indent=2))
    else:
        for m in models:
            print(f"{m['id']:<48} {m['label']}")
    return 0


def _dispatch(args) -> int:
    sub = getattr(args, "gemini_live_command", None)
    if sub == "models":
        return _models(args)
    return _doctor(args)


def _setup(parser) -> None:
    subs = parser.add_subparsers(dest="gemini_live_command")
    subs.add_parser("doctor", help="Check the key, list models and mint a test session token")
    models = subs.add_parser("models", help="List the Gemini Live models your key can use")
    models.add_argument("--all", action="store_true", help="Include transcription/translation models")
    models.add_argument("--json", action="store_true")
    parser.set_defaults(func=_dispatch)


def register(ctx) -> None:
    ctx.register_cli_command(name="gemini-live", help="Gemini Live voice: setup checks and model list",
                             setup_fn=_setup, handler_fn=_dispatch)
