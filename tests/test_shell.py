"""run_readonly: every layer can refuse, none can widen another; nothing runs without both checks."""

from __future__ import annotations

import json
from pathlib import Path

import pytest


@pytest.fixture
def shell():
    import importlib.util
    path = Path(__file__).resolve().parent.parent / "glive_shell.py"
    spec = importlib.util.spec_from_file_location("glive_shell_under_test", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ALLOWED = ["df -h /", "uptime", "free -h", "ps aux", "ls -la", "git log --oneline -n 5",
           "grep -n error notes.txt", "find . -maxdepth 2 -name '*.log'", "tail -n 20 app.log",
           "systemctl status ssh", "date", "cat /etc/os-release"]

REFUSED = {
    "rm -rf /": "allow-list",
    "sudo ls": "never allowed",
    "cat .env": "secret",
    "cat ~/.ssh/id_ed25519": "secret",
    "cat /etc/ssl/private/server.key": "secret",
    "ls /etc/ssh": "secret",
    "cat /etc/shadow": "secret",
    "ls /": "outside",
    "cat /usr/share/dict/words": "outside",
    "head -n 5 /proc/1/environ": "secret",
    "ls; rm -rf ~": "shell syntax",
    "df -h | sh": "shell syntax",
    "echo $(id)": "shell syntax",
    "cat `whoami`": "shell syntax",
    "find . -maxdepth 2 -delete": "-delete",
    "find . -maxdepth 2 -exec rm {} +": "shell syntax",
    "find / -name x": "-maxdepth",
    "grep -r password .": "recursive",
    "grep -rn key /etc": "recursive",
    "docker inspect web": "secrets",
    "docker exec web sh": "secrets",
    "docker compose down": "docker compose allows only",
    "docker rm web": "only these sub-commands",
    "systemctl restart nginx": "only these sub-commands",
    "systemctl show nginx": "only these sub-commands",
    "git push": "only these sub-commands",
    "env": "never allowed",
    "/bin/ls": "by name",
    "python3 -c 1": "never allowed",
    "tail -f app.log": "not allowed",
}


@pytest.mark.parametrize("command", ALLOWED)
def test_rules_allow_plain_read_only_commands(shell, command, tmp_path):
    argv, why = shell.check_command(command, tmp_path)
    if argv is None and "not installed" in why:
        pytest.skip(why)
    assert argv is not None, why


@pytest.mark.parametrize("command,reason", sorted(REFUSED.items()))
def test_rules_refuse_writes_secrets_and_shell_tricks(shell, command, reason, tmp_path):
    argv, why = shell.check_command(command, tmp_path)
    assert argv is None and reason in why, (command, why)


def test_symlink_to_a_secret_is_still_a_secret(shell, tmp_path):
    (tmp_path / ".env").write_text("K=v")
    (tmp_path / "innocent.txt").symlink_to(tmp_path / ".env")
    argv, why = shell.check_command("cat innocent.txt", tmp_path)
    assert argv is None and "secret" in why


@pytest.fixture
def fake_home(tmp_path, monkeypatch):
    """A home directory with the credential stores the review named, plus a workspace in it."""
    home = tmp_path / "home"
    files = {
        ".config/gh/hosts.yml": "github.com:\n  oauth_token: gho_x\n",
        ".config/gcloud/application_default_credentials.json": "{}",
        ".bash_history": "export KEY=1\n", ".zsh_history": "x", ".python_history": "x",
        ".hermes/config.yaml": "a: 1\n", ".hermes/state.db": "", ".hermes/webhook_subscriptions.json": "{}",
        ".hermes/profiles/work/config.yaml": "a: 1\n", ".hermes/logs/agent.log": "x",
        "projects/app/README.md": "hi", "projects/app/.env": "K=v",
    }
    for rel, text in files.items():
        (home / rel).parent.mkdir(parents=True, exist_ok=True)
        (home / rel).write_text(text)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv("HERMES_HOME", raising=False)
    return home


HOME_SECRETS = [".config/gh/hosts.yml", ".config/gcloud/application_default_credentials.json", ".bash_history",
                ".zsh_history", ".python_history", ".hermes/config.yaml", ".hermes/state.db",
                ".hermes/webhook_subscriptions.json", ".hermes/profiles/work/config.yaml", ".hermes/logs/agent.log"]


@pytest.mark.parametrize("rel", HOME_SECRETS)
@pytest.mark.parametrize("prog", ["cat", "head -n 5", "wc -l", "stat", "file"])
def test_credential_stores_and_hermes_state_are_refused(shell, fake_home, rel, prog):
    for workspace in (fake_home / "projects" / "app", fake_home, None):
        argv, why = shell.check_command(f"{prog} {fake_home / rel}", workspace)
        assert argv is None and "secret or private" in why, (prog, rel, workspace, why)


def test_dot_directories_cannot_be_listed_or_searched(shell, fake_home):
    for command in (f"ls {fake_home}/.config", f"ls -la {fake_home}/.hermes", f"du -s {fake_home}/.hermes",
                    f"find {fake_home}/.config -maxdepth 3 -name x", "ls ~/.config/gh", "cat ~/.bash_history"):
        argv, why = shell.check_command(command, fake_home)
        assert argv is None and "secret or private" in why, (command, why)


def test_hermes_home_is_refused_wherever_it_lives(shell, tmp_path):
    hermes_home = tmp_path / "srv" / "hermes-data"
    (hermes_home).mkdir(parents=True)
    (hermes_home / "config.yaml").write_text("a: 1\n")
    argv, why = shell.check_command(f"cat {hermes_home / 'config.yaml'}", tmp_path, hermes_home)
    assert argv is None and "secret or private" in why
    argv, why = shell.check_command("ls srv/hermes-data", tmp_path, hermes_home)
    assert argv is None and "secret or private" in why
    assert shell.check_command("ls srv", tmp_path, hermes_home)[0] is not None


def test_only_the_workspace_var_log_and_plain_system_files_are_readable(shell, fake_home):
    workspace = fake_home / "projects" / "app"
    assert shell.check_command("cat README.md", workspace)[0] is not None
    assert shell.check_command(f"cat {workspace}/README.md", workspace)[0] is not None
    assert shell.check_command("cat /etc/hostname", workspace)[0] is not None
    for command, reason in (("cat .env", "secret or private"), ("cat ../../.bash_history", "secret or private"),
                            (f"ls {fake_home}", "outside"), (f"cat {fake_home}/projects/other.txt", "outside"),
                            ("ls ..", "outside")):
        argv, why = shell.check_command(command, workspace)
        assert argv is None and reason in why, (command, why)
    if Path("/var/log").is_dir():
        assert shell.check_command("ls /var/log", workspace)[0] is not None


def test_without_a_workspace_nothing_under_home_is_readable(shell, fake_home):
    for command in ("ls", f"ls {fake_home}", f"cat {fake_home}/projects/app/README.md", "find . -maxdepth 1"):
        argv, why = shell.check_command(command, None)
        assert argv is None and "outside" in why, (command, why)
    for root in (Path("/"), Path("/home")):
        assert shell.workspace_root(root) is None


def test_symlink_out_of_the_workspace_is_refused(shell, fake_home):
    workspace = fake_home / "projects" / "app"
    (workspace / "gh.yml").symlink_to(fake_home / ".config" / "gh" / "hosts.yml")
    (workspace / "elsewhere").symlink_to(fake_home / "projects")
    assert "secret or private" in shell.check_command("cat gh.yml", workspace)[1]
    assert "outside" in shell.check_command("ls elsewhere", workspace)[1]


def test_unbounded_logs_get_bounded(shell, tmp_path):
    argv, _ = shell.check_command("journalctl -u ssh", tmp_path)
    if argv is None:
        pytest.skip("journalctl not installed")
    assert argv is not None and argv[-2:] == ["-n", "80"] and "--no-pager" in argv


def _reviewer(verdict: str, reason: str = "fine", calls: list | None = None):
    def request(url, key, body):
        if calls is not None:
            calls.append({"url": url, "key": key, "body": body})
        return {"candidates": [{"content": {"parts": [{"text": json.dumps({"verdict": verdict, "reason": reason})}]}}]}
    return request


def test_runs_only_after_rules_and_review_agree(shell, tmp_path):
    (tmp_path / "notes.txt").write_text("hello\nAPI_KEY=sk-live-abcdefghijklmnopqrstuvwxyz\n")
    calls: list = []
    out = shell.run_readonly("cat notes.txt", "User: what is in my notes file?", enabled=True, key="k",
                             model="gemini-3.5-flash-lite", cwd=str(tmp_path), request=_reviewer("allow", calls=calls))
    assert out["exit_code"] == 0 and "hello" in out["output"]
    assert "sk-live" not in out["output"] and "<redacted>" in out["output"]
    sent = calls[0]["body"]["contents"][0]["parts"][0]["text"]
    assert "what is in my notes file" in sent and "cat notes.txt" in sent
    assert "gemini-3.5-flash-lite:generateContent" in calls[0]["url"]


def test_reviewer_refusal_and_failure_both_stop_the_run(shell, tmp_path):
    marker = tmp_path / "ran"
    out = shell.run_readonly("ls", "", enabled=True, key="k", model="m", cwd=str(tmp_path),
                             request=_reviewer("deny", "not what the user asked"))
    assert out == {"refused": True, "layer": "review", "reason": "not what the user asked"}

    def broken(url, key, body):
        raise TimeoutError("quota")
    out = shell.run_readonly("ls", "", enabled=True, key="k", model="m", cwd=str(tmp_path), request=broken)
    assert out["refused"] and out["layer"] == "review" and "could not run" in out["reason"]
    assert not marker.exists()


def test_rules_refuse_before_the_reviewer_is_even_asked(shell, tmp_path):
    calls: list = []
    out = shell.run_readonly("rm -rf /", "User: delete everything", enabled=True, key="k", model="m",
                             cwd=str(tmp_path), request=_reviewer("allow", calls=calls))
    assert out["refused"] and out["layer"] == "rules" and calls == []


def test_off_by_default_and_no_secrets_inherited(shell, tmp_path, monkeypatch):
    assert "turned off" in shell.run_readonly("ls", "", enabled=False, key="k", model="m", cwd=None,
                                              request=_reviewer("allow"))["error"]
    monkeypatch.setenv("SUPER_SECRET_TOKEN", "do-not-leak")
    out = shell.execute(["ps", "-o", "pid", "-p", "1"], tmp_path)
    assert "do-not-leak" not in json.dumps(out)


def test_contained_run_cannot_write_files(shell, tmp_path):
    out = shell.execute(["python3", "-c", "open('x.txt','w').write('data')"], tmp_path)
    assert out.get("exit_code") != 0 or (tmp_path / "x.txt").read_text() == ""


def test_core_wires_settings_context_and_the_tool_declaration(home, core, monkeypatch):
    home.write(config="plugins:\n  entries:\n    gemini-live:\n      settings:\n        readonly_shell: true\n",
               env="GEMINI_LIVE_API_KEY=k-123\n")
    seen = {}

    def fake(url, key, body=None):
        seen.update(url=url, key=key, text=body["contents"][0]["parts"][0]["text"])
        return {"candidates": [{"content": {"parts": [{"text": '{"verdict":"allow","reason":"ok"}'}]}}]}

    monkeypatch.setattr(core, "_google_request", fake)
    assert {"run_readonly", "agents_overview"} <= {t["declaration"]["name"] for t in core.tool_catalog(core.load_settings())}
    out = core.run_server_tool("run_readonly", {"command": "uptime", "why": "is it up"},
                               {"transcript": [{"role": "user", "text": "how long has the box been up?"}]})
    assert out.get("exit_code") == 0, out
    assert seen["key"] == "k-123" and "how long has the box been up" in seen["text"] and "is it up" in seen["text"]
