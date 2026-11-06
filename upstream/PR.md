# Desktop: let plugins add engines to the voice-engine picker (`composer.voiceEngines`)

Companion change for the **Gemini Live** plugin
([cineglobe/hermes-gemini-live](https://github.com/cineglobe/hermes-gemini-live)), submitted to the
Hermes plugin hackathon. The patch is `desktop-voice-engines.patch` in this folder. It applies cleanly to
`NousResearch/hermes-agent` `main` at the commit below.

## Why

The composer's voice-engine picker offers *Speech-to-text + Hermes voice* and *GPT-Live*. A plugin
that ships its own realtime engine has nowhere to appear there, so it has to add a second call
button and users have two different "talk" buttons. The plugin SDK has no seam for this, and a
catalog plugin may not edit core files.

## What

- A new data area, `COMPOSER_AREAS.voiceEngines` (`composer.voiceEngines`), with payload
  `ComposerVoiceEngine { label, shortLabel, detail?, start() }`. It is exported from
  `@hermes/plugin-sdk` like the other composer areas.
- `VoiceEngineRows` lists the registered plugin engines after the core rows. Picking one is a
  **renderer-side** choice (`store/plugin-voice-engine.ts`), persisted per (connection, profile)
  with the same scope key as `$voiceLiveStatus`. Picking a core row clears it and writes
  `voice.voice_chat_mode` exactly as before. The backend keeps refusing unknown modes (4002) and is
  untouched.
- The start-voice button and the folded voice menu call the chosen plugin's `start()`. If that
  plugin is no longer registered, the button falls back to the core engine. If `start()` throws,
  the error shows and the core engine starts, so a broken plugin can't swallow the click.
- Malformed payloads (no `start`, blank labels, duplicate ids) are dropped, so a broken plugin
  can't blank the picker or add a row that does nothing.

There are no new strings, because labels come from the plugin. There is no backend change, and
nothing changes for users without such a plugin.

## Tests

`src/app/chat/composer/voice-engines.test.ts` covers payload validation and ordering, per-scope
persistence, fallback when the plugin is gone, and clearing back to the core engine.

## Mobile

The mobile app's voice picker currently offers only GPT Live, and its source isn't public, so this
patch can't cover it. **We'd love an installed Gemini Live plugin to appear as an option in the mobile
picker too, so people can choose it as their voice engine on any device.** The
plugin's backend already serves everything a client needs:

- `POST /api/plugins/gemini-live/session` returns a single-use ephemeral token with the model,
  voice, instructions and tools locked server-side. The key never leaves the backend.
- `POST /api/plugins/gemini-live/tool` runs the server-side tools.
- `src/engine.js` is the framework-free call engine (audio, socket, tool router, delegation) that a
  mobile client can port directly.

## Open offer

If the maintainers would like it, we're happy to contribute Gemini Live to Hermes as a **built-in**
voice engine everywhere, next to GPT Live: the backend, Desktop, the dashboard, and help with
mobile. That would include the multi-layer `run_readonly` safety design and the thread/bot
monitoring tools. Tell us which shape you'd prefer.

Base: NousResearch/hermes-agent@5ec43faa12c0abd0b3a01a7b299324c207319d05
