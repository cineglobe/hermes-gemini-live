# Mac setup and end-to-end test (instructions for a local coding agent)

These steps install Gemini Live into the Hermes on **this Mac**: the Desktop app at
`~/.hermes/hermes-agent/apps/desktop/release/mac-arm64/Hermes.app`, built from the
`~/.hermes/hermes-agent` checkout, and its local backend. Work through them in order and stop at the
first failure.

**Ground rules**
- Never print, paste or ask for API keys. When a step needs the Gemini key, tell the user to run
  that one command themselves.
- `~/.hermes/hermes-agent` is the user's live Hermes. Change it only in step 6, on a branch, after
  asking. Back up `~/.hermes/config.yaml` before step 2.
- Don't start extra `hermes serve` or `hermes dashboard` processes. Use the backend Desktop
  already runs.

## 1. Check prerequisites

```bash
hermes --version                        # needs >= 0.22.5
node -v                                 # 22+ (only for the tests and the video)
cd <this repo> && python3 scripts/build.py --check   # bundles match src/
```

## 2. Link the plugin (a live link, so Desktop hot-reloads it)

```bash
cp ~/.hermes/config.yaml ~/.hermes/config.yaml.bak-$(date +%Y%m%d%H%M%S)
mkdir -p ~/.hermes/plugins
ln -s "$PWD" ~/.hermes/plugins/gemini-live      # run from this repo's root
hermes plugins enable gemini-live
hermes plugins doctor gemini-live
```

## 3. Gemini key (the user runs this, not the agent)

```bash
hermes config set GEMINI_LIVE_API_KEY <key from https://aistudio.google.com/apikey>
hermes gemini-live doctor          # should say the key works and list Live models
```

If `gemini-3.8-live` reports a quota error, pick `gemini-2.5-flash-native-audio-latest` on the
call screen. Quotas are per model.

## 4. Load it in Desktop

1. Quit Hermes Desktop completely (⌘Q) and reopen it, so the backend loads the plugin's routes.
2. In **Capabilities → Plugins**, turn on **gemini-live** (Desktop has its own enable switch,
   which is off by default), then click **Rescan**.
3. Check that **Gemini Live** appears in the sidebar and that its page shows the model, voice and
   persona pickers without a key warning.
4. In macOS **System Settings → Privacy & Security → Microphone**, allow Hermes.

If the page says the backend isn't reachable, run `hermes gateway restart` once, then reopen
Desktop.

## 5. Optional settings for the demo

Turn on the opt-in server tools, after backing up config first:

```bash
hermes config set plugins.entries.gemini-live.settings.readonly_shell true
hermes config set plugins.entries.gemini-live.settings.system_checks true
```

MCP tools are on by default. Every MCP server already connected to this profile is visible to the
voice.

## 6. Optional: "Gemini Live" inside the built-in voice picker

This needs the companion Desktop patch (`upstream/desktop-voice-engines.patch`) and a rebuild.
**Ask the user first.** It modifies their Hermes checkout, and `hermes update` will need the change
stashed or committed on a branch.

```bash
cd ~/.hermes/hermes-agent
git status                                  # must be clean, otherwise stop and ask
git switch -c local/gemini-voice-picker
git apply --check <this repo>/upstream/desktop-voice-engines.patch && git apply <this repo>/upstream/desktop-voice-engines.patch
cd apps/desktop && npm run pack             # rebuilds release/mac-arm64/Hermes.app
```

Reopen the app. The composer's voice-engine menu (the chevron next to the mic) should now list
**Gemini Live**. Choosing it makes the mic button start a Gemini Live call, and the plugin's own
composer button disappears. To undo, follow `docs/UNINSTALL.md` §5.

## 7. End-to-end test (speak each step and watch the Activity tab)

| # | Say | Expect |
|---|---|---|
| 1 | "Hi, what can you do?" | Greeting, then a short spoken answer. The transcript fills in. |
| 2 | "Which agents do I have and what models do they use?" | `agents_overview` → names, models, providers. |
| 3 | "What MCP tools can you use?" | Names the connected MCP servers (from its instructions or `list_mcp_tools`). |
| 4 | "Use <an MCP tool> to …" | `use_mcp_tool` → a Hermes turn starts in the chat → the result is spoken. |
| 5 | "How much disk space is left?" | `run_readonly` with `df -h /` → the spoken number. |
| 6 | "Read me my .env file." | Refused, with the reason spoken. Nothing runs. |
| 7 | "Ask Hermes to draft a three-line launch tweet for this plugin in a new note." | `ask_hermes` → the chat shows the turn working → the update is spoken when done. |
| 8 | While 7 runs: "How's that going?" then "Tell it to make it funnier." | `check_hermes`, then `message_thread` (delivered as a steer). |
| 9 | "What's running in my other threads?" | `list_threads` / `read_thread` summary. |
| 10 | "Switch to the concise persona", then "Change your voice to Kore." | Reconnects, keeps context, new style and voice. |
| 11 | "Goodbye." | Says goodbye and hangs up. |

Report each row as pass or fail with what you saw. For failures, include the Desktop devtools
console lines tagged `gemini-live` and `hermes logs --since 10m | grep -i gemini`.
