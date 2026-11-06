# Undo the whole install (instructions for a local coding agent)

This reverses everything `docs/MAC_SETUP.md` set up. Run the steps in
order, check each one as you go, and report what you changed. Never print or ask for keys; the
user runs the key step themselves.

## 1. Stop any call and quit Desktop

End any Gemini Live call, then quit Hermes Desktop with ⌘Q.

## 2. Remove the plugin from Hermes

```bash
hermes plugins disable gemini-live || true
ls -la ~/.hermes/plugins/gemini-live          # should be a symlink to the repo checkout
rm ~/.hermes/plugins/gemini-live              # removes only the LINK; the repo checkout stays
rm -rf ~/.hermes/desktop-plugins/gemini-live  # Desktop's app-level copy of the UI half
```

If `~/.hermes/plugins/gemini-live` is a real folder rather than a symlink (because it was installed
with `hermes plugins install`), use `hermes plugins remove gemini-live` instead of `rm`.

Do the same for every profile it was added to:

```bash
ls -d ~/.hermes/profiles/*/plugins/gemini-live 2>/dev/null
```

## 3. Remove its settings

```bash
hermes config unset plugins.entries.gemini-live
hermes config get plugins.enabled                 # if gemini-live is still listed, remove it:
# hermes config set plugins.enabled '[...the list without gemini-live...]'
```

Or restore the backup made during setup, if nothing else has changed since:

```bash
ls -t ~/.hermes/config.yaml.bak-* | head -1      # the newest backup
cp "$(ls -t ~/.hermes/config.yaml.bak-* | head -1)" ~/.hermes/config.yaml
```

## 4. The Gemini key (the user decides and runs this)

Keep the key if other things use it. Otherwise the user removes it:

```bash
hermes config unset GEMINI_LIVE_API_KEY
```

If the key was created only for this, delete it at https://aistudio.google.com/apikey as well.

## 5. Undo the voice-picker patch (only if step 6 of the setup was done)

```bash
cd ~/.hermes/hermes-agent
git status                       # only the patch's files should show; stop and ask otherwise
git apply -R <this repo>/upstream/desktop-voice-engines.patch   # the patch is uncommitted, so remove it first
git switch -                     # back to where you were, including a detached HEAD
git branch -D local/gemini-voice-picker
cd apps/desktop && npm run pack  # rebuilds the original Hermes.app
```

## 6. Restart and check

```bash
hermes gateway restart
hermes plugins list | grep -i gemini || echo "gemini-live is gone"
```

Open Desktop and confirm that:
- the **Gemini Live** sidebar entry, composer button and status chip are gone;
- the voice picker shows only the built-in engines;
- **Capabilities → Plugins** doesn't list gemini-live.

## 7. Demo leftovers (optional; ask the user about each)

- Every tool installed for the video. They're listed in `video/NOTES.md` and in the
  "Installed for the video" list below, which the video agent fills in as it installs things.
  Uninstall each one the way it was installed (e.g. `brew uninstall …`, `npm uninstall -g …`,
  removing an added skill).
- Audio devices or routing changed for the hands-free call: put the Mac's input and output back to
  the built-in devices first, then remove any virtual audio driver and reboot so it disappears.
- The demo workspace (generated voice lines, recordings, the video project, any mock app). **List
  what's in it and ask before deleting**; the recordings may be the only copy.
- Delete the demo Hermes sessions from the session list if the user wants them gone.

Installed for the video (the video agent appends one line per install: what, how, how to remove):

- *(none yet)*

## 8. Remove the repo checkout (last, and only if asked)

```bash
cd .. && rm -rf <the repo folder>
```
