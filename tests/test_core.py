"""Behaviour contracts for the Gemini Live backend core (no network: Google calls are stubbed)."""

from __future__ import annotations

import json
from pathlib import Path


def _stub_google(core, monkeypatch):
    calls = []

    def fake(url, key, body=None):
        calls.append({"url": url, "key": key, "body": body})
        if url.startswith(core.TOKEN_URL):
            return {"name": "auth_tokens/test-token"}
        return {"models": [
            {"name": "models/gemini-3.8-live", "displayName": "Gemini 3.8 Live",
             "supportedGenerationMethods": ["bidiGenerateContent"]},
            {"name": "models/gemini-3.5-transcribe-live", "displayName": "Transcribe",
             "supportedGenerationMethods": ["bidiGenerateContent"]},
            {"name": "models/gemini-3.6-flash", "supportedGenerationMethods": ["generateContent"]},
        ]}

    monkeypatch.setattr(core, "_google_request", fake)
    return calls


def test_session_locks_setup_and_never_returns_the_key(home, core, monkeypatch):
    home.write(env="GEMINI_LIVE_API_KEY=sk-test-123\n")
    calls = _stub_google(core, monkeypatch)
    out = core.create_session({"voice": "Kore", "persona": "concise"})

    assert out["token"] == "auth_tokens/test-token"
    assert "sk-test-123" not in json.dumps(out)
    mint = calls[-1]
    assert mint["key"] == "sk-test-123" and mint["body"]["uses"] == 1
    setup = mint["body"]["bidiGenerateContentSetup"]
    assert setup["model"] == "models/gemini-3.8-live"
    assert setup["generationConfig"]["speechConfig"]["voiceConfig"]["prebuiltVoiceConfig"]["voiceName"] == "Kore"
    names = {d["name"] for d in setup["tools"][0]["functionDeclarations"]}
    assert {"ask_hermes", "list_threads", "message_thread", "recall_memory", "end_call"} <= names
    assert {r["name"] for r in out["tools"]} == names  # every declared tool has a client route


def test_profile_key_resolution_is_scoped(home, core, tmp_path):
    from agent.secret_scope import build_profile_secret_scope, reset_secret_scope, set_secret_scope

    home.write(env="GEMINI_API_KEY=key-from-a\n")
    other = tmp_path / "other"
    other.mkdir()
    (other / ".env").write_text("GOOGLE_API_KEY=key-from-b\n", encoding="utf-8")
    assert core.resolve_api_key() == ("key-from-a", "GEMINI_API_KEY")
    token = set_secret_scope(build_profile_secret_scope(other), profile_home=str(other))
    try:
        assert core.resolve_api_key() == ("key-from-b", "GOOGLE_API_KEY")
    finally:
        reset_secret_scope(token)


def test_no_key_is_a_clear_412(home, core):
    try:
        core.create_session({})
    except core.GeminiApiError as exc:
        assert exc.status == 412 and "key" in str(exc).lower()
    else:
        raise AssertionError("expected GeminiApiError")


def test_overrides_are_validated(home, core, monkeypatch):
    home.write(env="GEMINI_LIVE_API_KEY=k\n")
    calls = _stub_google(core, monkeypatch)
    try:
        core.create_session({"model": "../../etc/passwd"})
    except core.GeminiApiError as exc:
        assert exc.status == 400
    else:
        raise AssertionError("bad model accepted")
    out = core.create_session({"persona": "not-a-persona", "voice": "x; rm -rf", "model": "gemini-2.5-flash-native-audio-latest"})
    assert out["persona"] == "hermes" and out["voice"] == core.DEFAULT_VOICE
    assert calls[-1]["body"]["bidiGenerateContentSetup"]["model"] == "models/gemini-2.5-flash-native-audio-latest"


def test_settings_drive_tools_and_personas(home, core, monkeypatch):
    home.write(
        config=("plugins:\n  entries:\n    gemini-live:\n      settings:\n        system_checks: true\n"
                "        thread_control: false\n        google_search: false\n        model: gemini-3.8-live-extended-thinking\n"
                "        custom_personas: {Pirate Captain: 'Talk like a friendly pirate.'}\n"),
        env="GEMINI_LIVE_API_KEY=k\n")
    calls = _stub_google(core, monkeypatch)
    out = core.create_session({"persona": "pirate-captain"})
    setup = calls[-1]["body"]["bidiGenerateContentSetup"]
    names = {d["name"] for d in setup["tools"][0]["functionDeclarations"]}
    assert "system_check" in names and "list_threads" not in names
    assert not any("googleSearch" in t for t in setup["tools"])
    assert setup["model"] == "models/gemini-3.8-live-extended-thinking"
    assert out["persona"] == "pirate-captain"
    assert "friendly pirate" in setup["systemInstruction"]["parts"][0]["text"]


def test_resume_handle_and_context_ride_in_the_locked_setup(home, core, monkeypatch):
    home.write(env="GEMINI_LIVE_API_KEY=k\n")
    calls = _stub_google(core, monkeypatch)
    core.create_session({"resume_handle": "CiQabc123-handle", "context": {
        "chat_title": "Fix the build", "recent": [{"role": "user", "text": "the CI is red"}]}})
    setup = calls[-1]["body"]["bidiGenerateContentSetup"]
    assert setup["sessionResumption"] == {"handle": "CiQabc123-handle"}
    text = setup["systemInstruction"]["parts"][0]["text"]
    assert "Fix the build" in text and "the CI is red" in text


def test_model_list_keeps_conversational_live_models(home, core, monkeypatch):
    _stub_google(core, monkeypatch)
    ids = [m["id"] for m in core.list_live_models("k2")]
    assert ids == ["gemini-3.8-live"]
    assert "gemini-3.5-transcribe-live" in [m["id"] for m in core.list_live_models("k2", include_all=True)]


def test_builtin_memory_recall(home, core):
    (home.path / "memories" / "USER.md").write_text(
        "User prefers metric units.\n§\nProject codename is BLUEBIRD.\n", encoding="utf-8")
    out = core.recall_memory("what is the codename of the project")
    assert any("BLUEBIRD" in e for e in out["builtin"])
    assert not any("metric" in e for e in out["builtin"])


def test_system_checks_are_opt_in_and_fixed(home, core):
    assert "error" in core.system_check("time")
    home.write(config="plugins:\n  entries:\n    gemini-live:\n      settings:\n        system_checks: true\n")
    assert core.system_check("time")["output"]
    assert "error" in core.system_check("rm -rf /")


def test_condense_messages_is_speakable():
    import glive_core as core
    rows = core.condense_messages([
        {"role": "user", "content": "deploy it"},
        {"role": "assistant", "content": None, "tool_calls": [{"function": {"name": "terminal"}}]},
        {"role": "tool", "name": "terminal", "content": "ok"},
        {"role": "assistant", "content": [{"type": "text", "text": "Deployed   to prod."}]},
    ], limit=8)
    assert rows[-1] == {"role": "assistant", "text": "Deployed to prod."}
    assert rows[1]["text"] == "[calling terminal]"


def test_mcp_catalog_reaches_the_instructions_and_can_be_turned_off(home, core, monkeypatch):
    home.write(env="GEMINI_LIVE_API_KEY=k\n")
    calls = _stub_google(core, monkeypatch)
    core.create_session({"context": {"mcp": [{"server": "ledger", "tools": ["mcp_ledger_search", "bad name;rm"]}]}})
    setup = calls[-1]["body"]["bidiGenerateContentSetup"]
    text = setup["systemInstruction"]["parts"][0]["text"]
    assert "- ledger: mcp_ledger_search, badnamerm" in text
    names = {d["name"] for d in setup["tools"][0]["functionDeclarations"]}
    assert {"list_mcp_tools", "use_mcp_tool"} <= names

    home.write(config="plugins:\n  entries:\n    gemini-live:\n      settings:\n        mcp_tools: false\n",
               env="GEMINI_LIVE_API_KEY=k\n")
    core.create_session({"context": {"mcp": [{"server": "ledger", "tools": ["mcp_ledger_search"]}]}})
    setup = calls[-1]["body"]["bidiGenerateContentSetup"]
    assert "MCP tools connected" not in setup["systemInstruction"]["parts"][0]["text"]
    assert "use_mcp_tool" not in {d["name"] for d in setup["tools"][0]["functionDeclarations"]}


def test_external_memory_goes_through_hermes_not_a_private_import(home, core, monkeypatch):
    monkeypatch.setattr(core, "_active_memory_provider_name", lambda: "honcho")
    out = core.recall_memory("how I like apps to look")
    assert out["provider"] == "honcho" and "ask_hermes" in out["note"]
    source = Path(core.__file__).read_text(encoding="utf-8")
    assert "plugins.memory" not in source


def test_session_can_drop_search_after_a_quota_close(home, core, monkeypatch):
    home.write(env="GEMINI_LIVE_API_KEY=k\n")
    calls = _stub_google(core, monkeypatch)
    core.create_session({"no_search": True})
    setup = next(c for c in calls if c["url"].startswith(core.TOKEN_URL))["body"]["bidiGenerateContentSetup"]
    assert not any("googleSearch" in t for t in setup["tools"])



def test_voice_tries_before_it_says_no(home, core):
    text = core.build_system_instruction(core.load_settings(), persona="hermes", context={})
    assert "unless Hermes has tried" in text
    assert "still do the job" in text
    assert "never drop the task" in text
    assert "only if the update says so" in text


class _FakePhone:
    def __init__(self, grants=("alarms.manage", "reminders.read", "reminders.write"), result=None):
        self.grants, self.result, self.calls = list(grants), result or {"status": "succeeded"}, []

    def dispatch(self, name, args):
        self.calls.append((name, args))
        if name == "mobile_devices":
            return json.dumps({"profile": "default", "devices": [{"id": "d1", "grants": self.grants}]})
        return json.dumps({"id": "r1", "device_id": "d1", "profile": "default", "current_access": {}, **self.result})


def _tool_names(core, settings):
    return {t["declaration"]["name"] for t in core.tool_catalog(settings)}


def test_phone_tools_follow_the_grants_on_the_phone(home, core, monkeypatch):
    settings = core.load_settings()
    monkeypatch.setattr(core, "_phone_registry", lambda: None)
    assert not any(n.startswith("mobile_") for n in _tool_names(core, settings))

    monkeypatch.setattr(core, "_phone_registry", lambda: _FakePhone(grants=["alarms.manage"]))
    names = _tool_names(core, settings)
    assert {"mobile_alarm_create", "mobile_timer_start", "mobile_request_result"} <= names
    assert "mobile_reminder_create" not in names

    monkeypatch.setattr(core, "_phone_registry", lambda: _FakePhone(grants=["health.read", "location.read"]))
    assert not any(n.startswith("mobile_") for n in _tool_names(core, settings))

    monkeypatch.setattr(core, "_phone_registry", lambda: _FakePhone())
    assert "mobile_reminder_create" in _tool_names(core, settings)
    assert not any(n.startswith("mobile_") for n in _tool_names(core, {**settings, "phone_tools": False}))
    setup, routes = core.build_setup(settings, model="m", voice="Kore", persona="hermes", context={"time_zone": "Europe/London"})
    text = setup["systemInstruction"]["parts"][0]["text"]
    assert "iPhone is paired" in text and "Europe/London" in text
    assert {"name": "mobile_alarm_create", "where": "server"} in routes


def test_phone_tools_come_from_the_registry_only(core, monkeypatch):
    import sys
    import types

    class Registry:
        def __init__(self, entries):
            self.entries = entries

        def get_entry(self, name):
            return self.entries.get(name)

    loaded = []
    plugins = types.ModuleType("hermes_cli.plugins")
    plugins.discover_plugins = lambda: loaded.append(True)
    monkeypatch.setitem(sys.modules, "hermes_cli.plugins", plugins)
    tools_pkg = types.ModuleType("tools")
    registry_mod = types.ModuleType("tools.registry")
    monkeypatch.setitem(sys.modules, "tools", tools_pkg)
    monkeypatch.setitem(sys.modules, "tools.registry", registry_mod)

    registry_mod.registry = Registry({})
    assert core._phone_registry() is None
    assert core.run_phone_tool("mobile_alarm_create", {"time": "07:00"}) == {"error": core._PHONE_NOT_LOADED}
    assert "not loaded" in core._PHONE_NOT_LOADED
    registry_mod.registry = Registry({"mobile_alarm_create": object()})
    assert core._phone_registry() is registry_mod.registry
    assert loaded == []  # never loads other plugins itself


def test_phone_tool_calls_are_limited_and_honest(home, core, monkeypatch):
    phone = _FakePhone()
    monkeypatch.setattr(core, "_phone_registry", lambda: phone)
    out = core.run_server_tool("mobile_alarm_create", {"time": "07:15", "device_id": "other", "surprise": 1})
    name, sent = phone.calls[-1]
    assert name == "mobile_alarm_create" and sent["time"] == "07:15"
    assert "device_id" not in sent and "surprise" not in sent and sent["idempotency_key"]
    assert out["status"] == "succeeded" and out["request_id"] == "r1"
    assert "current_access" not in out and "device_id" not in out

    core.run_server_tool("mobile_alarm_create", {"time": "07:15"})
    assert phone.calls[-1][1]["idempotency_key"] == sent["idempotency_key"]

    phone.result = {"status": "pending"}
    assert "not done yet" in core.run_server_tool("mobile_timer_start", {"duration_seconds": 60})["note"]
    phone.result = {"status": "failed", "error": "no grant"}
    assert "did not happen" in core.run_server_tool("mobile_timer_start", {"duration_seconds": 61})["note"]

    assert "error" in core.run_server_tool("mobile_health_summary", {})
    assert "error" in core.run_server_tool("mobile_location", {})
    before = len(phone.calls)
    monkeypatch.setattr(core, "load_settings", lambda: {"phone_tools": False})
    assert "error" in core.run_server_tool("mobile_alarm_cancel", {"id": "a"})
    assert len(phone.calls) == before


def test_agent_is_named_after_the_profile(home, core):
    assert core.agent_name() == "Hermes"
    (core._home() / "profile.yaml").write_text("description: marketing\ndisplay_name: 'Reach'\n", encoding="utf-8")
    assert core.agent_name() == "Reach"
    (core._home() / "profile.yaml").write_text("ui_meta:\n  hermes-bots:\n    title: Soren\n", encoding="utf-8")
    assert core.agent_name() == "Soren"
    (core._home() / "profile.yaml").write_text("display_name: Reach\n", encoding="utf-8")
    settings = core.load_settings()
    text = core.build_system_instruction(settings, persona="hermes", context={})
    assert "You are Reach" in text and "Your name is Reach" in text and "speak of that work as your own" in text and "[Hermes update]" in text
    assert "HER-meez" not in text
    setup, _ = core.build_setup(settings, model="m", voice="Kore", persona="hermes", context={})
    ask = next(d for d in setup["tools"][0]["functionDeclarations"] if d["name"] == "ask_hermes")
    assert "Hand a request to Reach" in ask["description"]
