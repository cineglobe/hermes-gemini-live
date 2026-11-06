# Add gemini-live: Gemini Live for Hermes

Hackathon entry. Adds `plugin-catalog/gemini-live.yaml`, pinned to a full commit SHA.

## What it does

Full-duplex Gemini Live calls in Hermes Desktop and the web dashboard. The voice takes the name of the profile the call started from, delegates real work to that agent, and keeps talking while it runs.

## How it differs from the listed Gemini plugins

This is an independent project, not a fork. `gemini-live-bridge` has no agent tools, and `hermes-gemini-live` centres on a delegation task board. This plugin adds thread, bot-chat and subagent monitoring and steering, MCP tools, memory and conversation search, a three-layer read-only command path, a dashboard tab, and personas.

## Disclosure

- **Network:** the client streams microphone audio to `generativelanguage.googleapis.com` on a single-use ephemeral token. The backend calls Google's Gemini API with the key.
- **Sent to Gemini:** audio, the voice's instructions, tool results and, unless `share_chat_context` is off, the open chat's title and latest messages. On Gemini's free tier, Google may use content to improve its products.
- **Reads outside its own data:** `profile.yaml` for the display name, built-in memory notes, session history, thread and profile lists, and paired device grants when the phone plugin is installed.
- **iPhone tools:** with `hermes-mobile-device-access` and a paired iPhone, the voice can call that plugin's alarm, timer and reminder tools directly, without a Hermes turn. Only those eight tools are allowed, each is offered only when the device's grant covers it, and the bridge checks the grant again. Alarm and reminder details reach Gemini as tool results. `phone_tools` turns this off.
- **Shell commands:** only with `readonly_shell` or `system_checks` on, both off by default, and only under the layers in the README.
- **Credentials:** read through `agent.secret_scope`; the browser never receives the key.
- **Approvals:** Hermes decides what needs asking. The plugin shows the request and passes on the user's answer through `approval.respond`, one time only. The voice model has no way to answer. The opt-in `voice_approval` setting accepts the user's own spoken approve or deny, matched on the microphone transcript and ignored while the voice speaks.
- **Background processes and telemetry:** none.

## Checks

`hermes plugins validate` passes at the pinned commit: security scan safe, no core override, desktop surface inside the SDK.

## Companion change

An optional Desktop PR adds a `composer.voiceEngines` area so plugins can appear in the voice picker. The plugin works without it.

## Open offer

We'd love Gemini Live as an option in the mobile voice picker. If the maintainers prefer, we're happy to contribute it to Hermes as a built-in voice engine next to GPT Live.
