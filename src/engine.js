// ── Gemini Live engine ─────────────────────────────────────────────────────────────────────────
// Shared by the Desktop half (desktop/plugin.js) and the web dashboard tab (dashboard/dist/index.js);
// scripts/build.py inlines this file into both, so it must stay import-free and framework-free.
//
// One call = one engine. It owns the Gemini Live WebSocket (opened with a single-use ephemeral
// token the plugin backend minted; the user's key never reaches this code), the microphone
// (16 kHz PCM up) and the speaker (24 kHz PCM down), the tool router and the Hermes delegation
// tracker. The host supplies the doors through `env`:
//
//   env.rest(path, { method, body })      → plugin backend (/api/plugins/gemini-live/…)
//   env.rpc(method, params, timeoutMs)    → Hermes gateway JSON-RPC (sessions, threads, steering)
//   env.onEvent(listener) → unsubscribe   → Hermes gateway event stream ({ type, session_id, payload })
//   env.focus() → { sessionId, storedId }  → the chat the user is looking at (may be empty)
//   env.submitToChat(sessionId, text)     → optional: send through the app's own composer
//   env.ensureSession() → sessionId       → optional: create a session when none is focused
//   env.chatContext() → Promise<{ chat_title, recent }>
//   env.log(level, message)               → optional diagnostics
//
// The engine never stores anything; the UI reads `engine.snapshot()` and subscribes to changes.

/* eslint-disable no-restricted-syntax */

const GL_INPUT_RATE = 16000
const GL_OUTPUT_RATE = 24000
const GL_CHUNK = 1024 // 64 ms of mic audio per frame
const GL_MAX_TRANSCRIPT = 240
const GL_MAX_ACTIVITY = 80
const GL_RESULT_CLIP = 1800
const GL_RECONNECT_ATTEMPTS = 4
const GL_TERMINAL_STATUSES = { complete: 1, completed: 1, error: 1, failed: 1, interrupted: 1, cancelled: 1, canceled: 1 }
const GL_BUSY_STATUSES = { starting: 1, waiting: 1, working: 1, streaming: 1, resuming: 1 }

function glNow() {
  return Date.now()
}

// Gemini puts the human reason in the close frame. Quota and policy closes are final: retrying
// only burns the next token, so they end the call with a next step instead of reconnecting.
// Requests that would surface secrets. Hermes can read files, so this gate covers every route the
// voice has to it (ask_hermes, message_thread, steer_subagent), not only run_readonly.
const GL_SECRET_FILE =
  /(?:^|[\s"'`(/~])\.env(?!\.(?:example|sample|template))(?:\.[\w-]+)?\b|\bdot[\s-]?env\b|\benv(?:ironment)?\s+file\b|\bauth\.json\b|\bid_(?:rsa|ed25519|ecdsa|dsa)\b|\.ssh\b|\.aws\/credentials\b|\.netrc\b|\.npmrc\b|\.pypirc\b|\/etc\/(?:shadow|sudoers|master\.passwd)\b|\bkeychain\b/i
const GL_SECRET_VALUE =
  /\b(?:api[\s_-]?keys?|(?:access|auth|bearer|session)[\s_-]?tokens?|secret[\s_-]?keys?|passwords?|private[\s_-]?keys?|credentials?)\b/i
const GL_REVEAL =
  /\b(?:read|show|open|print|cat|display|dump|list|summari[sz]e|tell me|what(?:'s| is| are)|contents?|copy|send|e-?mail|upload|post|share|paste|reveal|look (?:at|in|inside|through)|check|inspect|give me|extract|fetch|grep|search|review)\b/i
const GL_HOW_TO = /\bhow (?:do|to|can|should)\b/i

function glSecretRequest(text) {
  const value = String(text || '')
  if (!GL_REVEAL.test(value) || GL_HOW_TO.test(value)) {
    return false
  }

  return GL_SECRET_FILE.test(value) || GL_SECRET_VALUE.test(value)
}

// The whole utterance must be the decision, so "approve... no, wait" is not a yes.
const GL_APPROVE = /^\W*(?:yes,?\s+)?approved?(?:\s+(?:it|that))?\W*$/i
const GL_DENY = /^\W*(?:no,?\s+)?(?:deny|denied|reject)(?:\s+(?:it|that))?\W*$/i

// What the user sees of a notice: the news, without the instructions meant for the voice.
function glNoticeShown(text) {
  return text
    .replace(/\[Hermes update\]\s*/g, '')
    .replace(/\s*(?:Tell the user what that says, and only that\. Say something was done only if it says so\. If it asks a question, ask the user, then send their reply with ask_hermes, where last_task\.|Acknowledge it in a few words\.|Say so briefly if the user is still deciding\.|Say in one plain sentence what it wants to do[^\n]*)/g, '')
}

const GL_APPROVAL_WORDS = /\b(?:approv\w*|den(?:y|ies|ied)|reject\w*|allow\w*|go ahead|yes|confirm\w*)\b/i

const GL_SECRET_REFUSAL = {
  refused: true,
  layer: 'secrets',
  reason: 'that would expose secrets',
  note: 'Not sent to Hermes. Secret files and credentials stay private on every route. Say so in a sentence and do not offer another way.'
}

// Tried in order when a fresh call hits a quota close before Gemini has said anything.
const GL_FALLBACK_MODEL = 'gemini-2.5-flash-native-audio-latest'

// Speech-to-text often mishears the name of the agent the whole call is about.
function glFixName(text) {
  return String(text || '').replace(/\b(?:her ?m[ie]+s|h?armies|hermies|hermees|hermez|air ?mees)\b/gi, 'Hermes')
}

function glCloseInfo(event) {
  const reason = String((event && event.reason) || '').trim()
  const quota = /quota|rate limit|resource.?exhausted|billing/i.test(reason)
  const code = event && event.code
  let message = reason ? `Gemini closed the call: ${reason}` : 'Gemini closed the call.'

  if (quota) {
    message = 'This Gemini key is out of quota for this model. Pick another Live model, or check billing at aistudio.google.com.'
  } else if (code === 1008 && /api key|permission|auth|token/i.test(reason)) {
    message = `Gemini rejected the key or token: ${reason}`
  }

  return { final: quota || code === 1008 || code === 1007, message, quota }
}

// "I'll ask Hermes", "let me check that", "I'm going to look it up": a spoken promise to act.
const GL_PROMISE = /\b(?:i'?ll|i will|let me|i'?m going to|i am going to|i'?m gonna)\s+(?!know\b)(?:\w+\s+){0,4}?(?:ask|check|look|find|get|have|send|pass|hand|start|run|search|fetch|pull|see)\b/i

function glPromisedAction(text) {
  return GL_PROMISE.test(String(text || ''))
}

function glClip(text, limit) {
  const s = String(text == null ? '' : text)
  return s.length <= limit ? s : `${s.slice(0, limit)} …`
}

function glSquash(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
}

// Strip markdown so a Hermes reply reads as plain facts to the voice model.
function glPlain(text) {
  return glSquash(
    String(text || '')
      .replace(/```[\s\S]*?```/g, ' [code omitted] ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
      .replace(/^\s*[-*+]\s+/gm, '• ')
  )
}

function glBase64FromBytes(bytes) {
  let binary = ''
  const step = 0x8000

  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step))
  }

  return btoa(binary)
}

function glBytesFromBase64(b64) {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)

  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i)
  }

  return out
}

function glFloatToPcm16(float32) {
  const out = new Int16Array(float32.length)

  for (let i = 0; i < float32.length; i += 1) {
    const s = Math.max(-1, Math.min(1, float32[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }

  return out
}

function glRms(float32) {
  let sum = 0

  for (let i = 0; i < float32.length; i += 1) {
    sum += float32[i] * float32[i]
  }

  return Math.sqrt(sum / Math.max(1, float32.length))
}

// Linear resampler for mic input when the browser refuses a 16 kHz AudioContext.
function glResample(input, fromRate, toRate) {
  if (fromRate === toRate) {
    return input
  }

  const ratio = fromRate / toRate
  const length = Math.floor(input.length / ratio)
  const out = new Float32Array(length)

  for (let i = 0; i < length; i += 1) {
    const pos = i * ratio
    const idx = Math.floor(pos)
    const frac = pos - idx
    const a = input[idx] || 0
    const b = input[idx + 1] === undefined ? a : input[idx + 1]
    out[i] = a + (b - a) * frac
  }

  return out
}

/** Condense a gateway transcript (session.history rows) into speakable lines. */
function glCondense(messages, limit) {
  const out = []

  for (const m of messages || []) {
    const role = m && m.role

    if (role === 'tool') {
      out.push({ role: 'tool', text: `[${m.name || 'tool'} finished]` })
      continue
    }

    if (role !== 'user' && role !== 'assistant') {
      continue
    }

    let text = m.text
    if (text == null) {
      text = Array.isArray(m.content)
        ? m.content.map(p => (p && typeof p.text === 'string' ? p.text : '')).join(' ')
        : typeof m.content === 'string'
          ? m.content
          : ''
    }

    text = glSquash(text)

    if (text) {
      out.push({ role, text: glClip(text, 900) })
    }
  }

  return out.slice(-Math.max(1, Math.min(limit || 8, 30)))
}

// Tool symbols as line art in a -1..1 box. They are sampled into dots, so every symbol can be drawn
// by the same dots.
const GL_TAU = Math.PI * 2

function glArc(x, y, rx, ry, from, to) {
  const points = []
  for (let i = 0; i <= 40; i += 1) {
    const a = from + ((to - from) * i) / 40
    points.push([x + Math.cos(a) * rx, y + Math.sin(a) * ry])
  }

  return points
}

function glBox(l, t, r, b, c) {
  const q = Math.PI / 2

  return [...glArc(r - c, t + c, c, c, -q, 0), ...glArc(r - c, b - c, c, c, 0, q), ...glArc(l + c, b - c, c, c, q, q * 2), ...glArc(l + c, t + c, c, c, q * 2, q * 3), [r - c, t]]
}

function glGear() {
  const points = []
  for (let i = 0; i <= 160; i += 1) {
    const a = (i / 160) * GL_TAU
    points.push([Math.cos(a), Math.sin(a)].map(v => v * (0.72 + 0.22 * Math.max(-1, Math.min(1, Math.sin(a * 8) * 3)))))
  }

  return points
}

const GL_SYMBOLS = {
  ring: [glArc(0, 0, 0.8, 0.8, 0, GL_TAU)],
  idle: [glArc(0, 0, 0.26, 0.26, 0, GL_TAU)],
  terminal: [glBox(-0.92, -0.74, 0.92, 0.74, 0.16), [[-0.52, -0.32], [-0.12, 0], [-0.52, 0.32]], [[0.04, 0.34], [0.52, 0.34]]],
  web: [glArc(0, 0, 0.94, 0.94, 0, GL_TAU), glArc(0, 0, 0.4, 0.94, 0, GL_TAU), [[-0.94, 0], [0.94, 0]]],
  file: [[[0.2, -0.94], [-0.68, -0.94], [-0.68, 0.94], [0.68, 0.94], [0.68, -0.46], [0.2, -0.94], [0.2, -0.46], [0.68, -0.46]], [[-0.36, 0.06], [0.36, 0.06]], [[-0.36, 0.48], [0.36, 0.48]]],
  search: [glArc(-0.16, -0.16, 0.66, 0.66, 0, GL_TAU), [[0.31, 0.31], [0.92, 0.92]]],
  memory: [glArc(0, -0.62, 0.78, 0.3, 0, GL_TAU), [[-0.78, -0.62], [-0.78, 0.62]], [[0.78, -0.62], [0.78, 0.62]], glArc(0, 0.62, 0.78, 0.3, 0, Math.PI), glArc(0, 0, 0.78, 0.3, 0, Math.PI)],
  mcp: [[[-0.3, -0.96], [-0.3, -0.42]], [[0.3, -0.96], [0.3, -0.42]], [[-0.64, -0.42], [0.64, -0.42]], glArc(0, -0.42, 0.64, 0.98, 0, Math.PI), [[0, 0.56], [0, 0.96]]],
  phone: [glBox(-0.52, -0.96, 0.52, 0.96, 0.18), [[-0.16, -0.72], [0.16, -0.72]], [[-0.2, 0.72], [0.2, 0.72]]],
  agent: [glArc(0, -0.46, 0.44, 0.44, 0, GL_TAU), glArc(0, 0.94, 0.84, 0.92, Math.PI, GL_TAU), [[-0.84, 0.94], [0.84, 0.94]]],
  code: [[[-0.36, -0.62], [-0.94, 0], [-0.36, 0.62]], [[0.36, -0.62], [0.94, 0], [0.36, 0.62]], [[0.18, -0.8], [-0.18, 0.8]]],
  edit: [[[-0.8, 0.8], [-0.62, 0.2], [0.38, -0.8], [0.8, -0.38], [-0.2, 0.62], [-0.8, 0.8]], [[0.16, -0.58], [0.58, -0.16]]],
  browser: [glBox(-0.94, -0.76, 0.94, 0.76, 0.14), [[-0.94, -0.34], [0.94, -0.34]], [[-0.5, 0.06], [0.5, 0.06]], [[-0.5, 0.38], [0.18, 0.38]]],
  screen: [glBox(-0.94, -0.76, 0.94, 0.4, 0.1), [[0, 0.4], [0, 0.82]], [[-0.42, 0.82], [0.42, 0.82]]],
  pointer: [[[-0.5, -0.92], [-0.5, 0.6], [-0.12, 0.24], [0.14, 0.88], [0.42, 0.76], [0.14, 0.14], [0.62, 0.14], [-0.5, -0.92]]],
  image: [glBox(-0.94, -0.76, 0.94, 0.76, 0.12), [[-0.94, 0.52], [-0.3, -0.1], [0.1, 0.3], [0.4, 0], [0.94, 0.52]], glArc(0.42, -0.36, 0.16, 0.16, 0, GL_TAU)],
  eye: [glArc(0, 0, 0.96, 0.54, 0, GL_TAU), glArc(0, 0, 0.26, 0.26, 0, GL_TAU)],
  video: [glBox(-0.94, -0.76, 0.94, 0.76, 0.14), [[-0.26, -0.38], [0.42, 0], [-0.26, 0.38], [-0.26, -0.38]]],
  audio: [[-0.8, 0.26], [-0.48, 0.6], [-0.16, 0.92], [0.16, 0.5], [0.48, 0.76], [0.8, 0.3]].map(([x, h]) => [[x, -h], [x, h]]),
  skill: [[[0, -0.6], [-0.4, -0.82], [-0.94, -0.72], [-0.94, 0.7], [-0.4, 0.6], [0, 0.82], [0.4, 0.6], [0.94, 0.7], [0.94, -0.72], [0.4, -0.82], [0, -0.6], [0, 0.82]]],
  todo: [-0.62, 0, 0.62].flatMap(y => [[[-0.88, y], [-0.7, y + 0.18], [-0.42, y - 0.2]], [[-0.16, y], [0.92, y]]]),
  clock: [glArc(0, 0, 0.94, 0.94, 0, GL_TAU), [[0, -0.58], [0, 0], [0.4, 0.26]]],
  calendar: [glBox(-0.84, -0.74, 0.84, 0.9, 0.12), [[-0.84, -0.3], [0.84, -0.3]], [[-0.42, -0.96], [-0.42, -0.54]], [[0.42, -0.96], [0.42, -0.54]], [[-0.42, 0.14], [0.42, 0.14]], [[-0.42, 0.5], [0.1, 0.5]]],
  board: [glBox(-0.94, -0.84, -0.38, 0.84, 0.1), glBox(-0.28, -0.84, 0.28, 0.3, 0.1), glBox(0.38, -0.84, 0.94, 0.56, 0.1)],
  message: [glBox(-0.94, -0.78, 0.94, 0.44, 0.24), [[-0.42, 0.44], [-0.52, 0.92], [0.04, 0.44]]],
  question: [glArc(0, -0.42, 0.48, 0.48, Math.PI, Math.PI * 2.5), [[0, 0.06], [0, 0.34]], glArc(0, 0.72, 0.1, 0.1, 0, GL_TAU)],
  folder: [[[-0.94, -0.64], [-0.34, -0.64], [-0.14, -0.38], [0.94, -0.38], [0.94, 0.76], [-0.94, 0.76], [-0.94, -0.64]]],
  home: [[[-0.94, -0.04], [0, -0.9], [0.94, -0.04]], [[-0.66, -0.24], [-0.66, 0.86], [0.66, 0.86], [0.66, -0.24]], [[-0.2, 0.86], [-0.2, 0.28], [0.2, 0.28], [0.2, 0.86]]],
  tool: [glGear(), glArc(0, 0, 0.3, 0.3, 0, GL_TAU)]
}

// First match wins, so the more specific names come first.
const GL_TOOL_SYMBOLS = [
  ['mcp', /mcp|connection/],
  ['calendar', /calendar|reminder/],
  ['clock', /alarm|cron|schedule|timer/],
  ['phone', /mobile|phone/],
  ['home', /^ha_|home/],
  ['board', /kanban/],
  ['todo', /todo|task_list/],
  ['agent', /delegate|subagent|agent/],
  ['skill', /skill|catalog/],
  ['memory', /memory|recall|session_search/],
  ['question', /clarify/],
  ['message', /message|discord|^yb_|slack|telegram|whatsapp|email|comment|send_/],
  ['folder', /drive|feishu_doc|folder/],
  ['video', /video/],
  ['eye', /vision/],
  ['image', /image/],
  ['audio', /speech|tts|audio|transcri/],
  ['pointer', /computer_use|gui_tour/],
  ['browser', /browser/],
  ['web', /web|fetch|http/],
  ['search', /search|grep|find/],
  ['terminal', /terminal|shell|bash|process/],
  ['code', /execute_code|python|code/],
  ['screen', /desktop|window|pane|preview|theme|tip/],
  ['edit', /patch|edit|write/],
  ['file', /file|(^|_)read/]
]

function glSymbolFor(name) {
  const n = String(name || '').toLowerCase()
  const match = GL_TOOL_SYMBOLS.find(([, pattern]) => pattern.test(n))

  return match ? match[0] : 'tool'
}

// Easing for the messenger's hop. All take 0..1 and clamp outside it.
const glSmooth = x => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x))
const glSpring = x => (x <= 0 ? 0 : x >= 1 ? 1 : 1 - Math.exp(-6 * x) * Math.cos(7 * x))


function glBack(x) {
  if (x <= 0 || x >= 1) {
    return x <= 0 ? 0 : 1
  }
  const c = 1.2
  const y = x * 2

  return y < 1 ? (y * y * ((c + 1) * y - c)) / 2 : ((y - 2) * (y - 2) * ((c + 1) * (y - 2) + c) + 2) / 2
}

// `n` points spaced evenly along a symbol's lines.
function glSample(kind, n) {
  const segments = []
  let total = 0
  for (const path of GL_SYMBOLS[kind]) {
    for (let i = 1; i < path.length; i += 1) {
      const length = Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1])
      if (length > 0) {
        segments.push({ a: path[i - 1], b: path[i], length, start: total })
        total += length
      }
    }
  }
  const points = []
  let k = 0
  for (let i = 0; i < n; i += 1) {
    const at = ((i + 0.5) * total) / n
    while (k < segments.length - 1 && segments[k].start + segments[k].length < at) {
      k += 1
    }
    const { a, b, length, start } = segments[k]
    const f = (at - start) / length
    points.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f])
  }

  return points
}

// The call's visual, drawn with one fixed set of dots that are never added or removed. They form a
// sphere that follows both voices. While Hermes works the sphere opens into a ring of six circles
// around a still disc of dots. Six shapes spin through that disc, swelling the dots they pass over,
// and every few seconds swap places through the middle. One group of dots, the messenger, draws
// each tool's symbol: on the next tool it breathes in and flies to the centre as a ball, where it
// sinks into one of the six shapes. That shape swells and swings round, widening like a rider on a
// roundabout, and flings the ball out to the next circle, where it opens and leaves a sparse echo
// behind. The circles turn slowly, each rim bounces when the messenger lands, and a tool the safety
// layers refused turns red where it lands.
function glCreateOrb() {
  const NODES = 6
  const BLOBS = 6
  const NODE_AT = 0.345
  const NODE_SIZE = 0.118
  const CORE_AT = 0.122
  const CORE_SPAN = 0.195
  const TURN = GL_TAU / 5.4 // radians a second
  const SPINNING = 6
  const SWAPPING = 3.2
  const HOP = 2.7 // seconds for the messenger's whole trip, from leaving one circle to opening in the next
  const SCATTER = 0.1 // seconds of difference between its dots, so it moves as a loose group
  const LANDS = 2.4 // seconds until a symbol has opened
  let dots = []
  let plan = { carry: 0, echo: 0, rim: 0, core: 0 }
  let clock = 0
  let t = 0
  let sphereTurn = 0
  let ringTurn = 0
  let morph = 0
  let mic = 0
  let voice = 0
  let seen = 0
  let slots = []
  let active = 0
  let carryCells = []
  let order = [0, 1, 2, 3, 4, 5]
  let cycle = 0
  let tails = []
  let relayTurn = 0
  let sent = -9
  let rider = 0 // the shape that takes the messenger round
  let sweep = 0
  let seat = 0 // the rider's place on the ring when the trip began; swaps mustn't move the ball

  function layout(small) {
    plan = small ? { carry: 30, echo: 12, rim: 6, core: 60 } : { carry: 132, echo: 44, rim: 22, core: 520 }
    const count = plan.carry + (plan.echo + plan.rim) * NODES + plan.core
    carryCells = glSample('ring', plan.carry)
    dots = []
    for (let i = 0; i < count; i += 1) {
      const y = 1 - (2 * (i + 0.5)) / count
      const r = Math.sqrt(1 - y * y)
      const a = i * 2.39996
      const d = { x: Math.cos(a) * r, y, z: Math.sin(a) * r, delay: ((i * 7) % 23) / 23, rx: null, ry: 0, qx: 0, qy: 0, swell: 0, k: 0, strength: 0.16, flight: null }
      // Roles are spread evenly over the sphere so it looks the same whichever dots end up where.
      const role = (i * 223) % count
      if (role < plan.carry) {
        d.role = 'carry'
        d.k = role
      } else if (role < plan.carry + plan.echo * NODES) {
        d.role = 'echo'
        d.node = (role - plan.carry) % NODES
        d.k = Math.floor((role - plan.carry) / NODES)
      } else if (role < plan.carry + (plan.echo + plan.rim) * NODES) {
        const n = role - plan.carry - plan.echo * NODES
        d.role = 'rim'
        d.node = n % NODES
        d.around = (Math.floor(n / NODES) / plan.rim) * GL_TAU
      } else {
        const n = role - plan.carry - (plan.echo + plan.rim) * NODES
        const pack = Math.sqrt((n + 0.5) / plan.core) * CORE_SPAN
        d.role = 'core'
        d.rx = Math.cos(n * 2.39996) * pack
        d.ry = Math.sin(n * 2.39996) * pack
        // Most of these sit on an inner shell of the sphere, so it keeps its airy look.
        d.x *= 0.6
        d.y *= 0.6
        d.z *= 0.6
      }
      dots.push(d)
    }
  }

  const nodeAt = n => {
    const a = (n / NODES) * GL_TAU - Math.PI / 2 + relayTurn

    return [Math.cos(a) * NODE_AT, Math.sin(a) * NODE_AT]
  }

  // Calls the messenger back through the orb from wherever each dot is, so nothing jumps. (hx, hy)
  // is the middle of the shape it is leaving.
  function send(hx, hy) {
    sent = t
    // The shape about two thirds of a lap behind the next circle takes it, so every ride is similar.
    const [nx, ny] = nodeAt(active)
    const start = Math.atan2(ny, nx) - 4
    rider = order.reduce((best, _, b) => (Math.abs(wrap(ringAngle(b) - start)) < Math.abs(wrap(ringAngle(best) - start)) ? b : best), 0)
    seat = (order[rider] / BLOBS) * GL_TAU
    sweep = (((Math.atan2(ny, nx) - ringAngle(rider)) % GL_TAU) + GL_TAU) % GL_TAU
    for (const d of dots) {
      if (d.role === 'carry' && d.rx !== null) {
        d.flight = { hx, hy, ox: d.rx, oy: d.ry, start: t + (((d.k * 37) % 41) / 41) * SCATTER }
      }
    }
  }

  const ringAngle = b => ringTurn + (order[b] / BLOBS) * GL_TAU
  const wrap = a => Math.atan2(Math.sin(a), Math.cos(a))
  // How far the messenger has sunk into its shape, `raw` 0..1 through the trip.
  const carried = raw => glSmooth((raw - 0.24) / 0.09) * (1 - glSmooth((raw - 0.66) / 0.07))

  // The ball's path to the circle at (nx, ny): it meets its shape on the ring, swings round with it,
  // widening, and leaves on the curve at that circle's angle.
  function ballAt(raw, nx, ny) {
    const exit = Math.atan2(ny, nx)
    const from = ringTurn + seat
    const x = Math.min(1, Math.max(0, (raw - 0.3) / 0.46))
    const a = from + (sweep + wrap(exit - from - sweep)) * glSmooth(x ** 1.25)
    const ride = CORE_AT * (1 + 0.28 * glSmooth((raw - 0.42) / 0.3))
    const r = ride + (NODE_AT - ride) * glSpring((raw - 0.71) / 0.2)

    return [Math.cos(a) * r, Math.sin(a) * r, a, Math.sin(x * Math.PI)]
  }

  // Where a messenger dot is, `raw` 0..1 through its trip out to (tx, ty) in the circle at (nx, ny).
  function journey(f, raw, tx, ty, nx, ny, cx, cy) {
    const breath = 1 - 0.13 * Math.sin(Math.min(1, Math.max(0, raw / 0.12)) * Math.PI)
    const leftX = f.hx + (f.ox - f.hx) * breath
    const leftY = f.hy + (f.oy - f.hy) * breath
    const gather = glSmooth((raw - 0.07) / 0.25)
    const [bx, by, a, speed] = ballAt(raw, nx, ny)
    // The ball tightens just before it is flung, and stretches along its path as it rides.
    const ball = 0.026 * (1 - 0.35 * Math.sin(Math.min(1, Math.max(0, (raw - 0.6) / 0.08)) * Math.PI))
    const pull = (cy * Math.cos(a) - cx * Math.sin(a)) * ball * 1.8 * speed
    const ix = bx + cx * ball - Math.sin(a) * pull
    const iy = by + cy * ball + Math.cos(a) * pull
    const heldX = leftX + (ix - leftX) * gather
    const heldY = leftY + (iy - leftY) * gather
    const open = glSpring((raw - 0.83) / 0.17)

    return [heldX + (tx - bx - cx * ball) * open, heldY + (ty - by - cy * ball) * open]
  }

  function record(s) {
    if (s.tools < seen) {
      const [hx, hy] = nodeAt(active)
      seen = 0
      slots = []
      active = 0
      carryCells = glSample('ring', plan.carry)
      send(hx, hy)
    }
    // Tools can fire faster than the messenger travels: it finishes its trip, then takes the latest.
    if (s.tools === seen || t - sent < HOP * 0.92) {
      return
    }
    const names = s.names || []
    for (let n = seen; n < s.tools; n += 1) {
      const name = String(names[names.length - (s.tools - n)] || '')
      const old = slots[n % NODES]
      slots[n % NODES] = { kind: glSymbolFor(name.replace('!', '')), blocked: name.startsWith('!'), was: old ? old.kind : 'ring', order: n, ready: t + LANDS }
    }
    const last = (s.tools - 1) % NODES
    const [hx, hy] = seen ? nodeAt(active) : [0, 0]
    active = last
    carryCells = glSample(slots[last].kind, plan.carry)
    seen = s.tools
    send(hx, hy)
  }

  const crossing = n => [[n % BLOBS, (n + 3) % BLOBS, 0], [(n + 1) % BLOBS, (n + 4) % BLOBS, 0.3]]
  const partner = (pairs, place) => pairs.find(p => p[0] === place || p[1] === place)

  // Where the six blobs are now: { x, y, r } in fractions of the canvas.
  function blobs(swapping, u) {
    const size = a => 0.02 + 0.026 * Math.pow(0.5 + 0.5 * Math.cos(a - ringTurn * 1.3), 1.5)
    const radius = CORE_AT * (1 + voice * 0.1 - mic * 0.07 - (swapping ? 0.16 * Math.sin(u * Math.PI) : 0))
    const spot = n => {
      const a = ringTurn + (n / BLOBS) * GL_TAU

      return { x: Math.cos(a) * radius, y: Math.sin(a) * radius, r: size(a) }
    }
    // Two opposite pairs cross per swap, the second a beat behind; the pairs move round each time.
    const pairs = crossing(cycle)

    return order.map(place => {
      const here = spot(place)
      const pair = swapping && partner(pairs, place)
      if (!pair) {
        return here
      }
      const there = spot(pair[0] === place ? pair[1] : pair[0])
      const k = Math.min(1, Math.max(0, (u - pair[2]) / 0.7))
      const e = k * k * k * (k * (6 * k - 15) + 10)
      const bow = Math.sin(e * Math.PI) * 0.17 // pairs pass side by side, not through each other

      return {
        x: here.x + (there.x - here.x) * e - (there.y - here.y) * bow,
        y: here.y + (there.y - here.y) * e + (there.x - here.x) * bow,
        r: (here.r + (there.r - here.r) * e) * (1 + 0.3 * Math.sin(e * Math.PI))
      }
    })
  }

  // The shapes as a field: each has a lagging tail, which stretches it along its path, and shapes
  // that come close neck together.
  // Returns [strength, pullX, pullY] at a point on the disc.
  function fieldOf(at, grow, follow) {
    const sources = []
    at.forEach((b, i) => {
      const tail = tails[i] || (tails[i] = { x: b.x, y: b.y })
      tail.x += (b.x - tail.x) * follow
      tail.y += (b.y - tail.y) * follow
      const stretch = Math.hypot(tail.x - b.x, tail.y - b.y)
      if (stretch > b.r * 1.3) {
        tail.x = b.x + ((tail.x - b.x) * b.r * 1.3) / stretch
        tail.y = b.y + ((tail.y - b.y) * b.r * 1.3) / stretch
      }
      const reach = (b.r * grow * 1.6) ** 2
      sources.push([b.x, b.y, reach], [tail.x, tail.y, reach])
    })

    return (x, y) => {
      let v = 0
      let px = 0
      let py = 0
      for (const [sx, sy, reach] of sources) {
        const q = 1 - ((x - sx) ** 2 + (y - sy) ** 2) / (reach || 1e-6)
        if (q > 0) {
          v += q * q
          px += (sx - x) * q * q
          py += (sy - y) * q * q
        }
      }

      return [v, px, py]
    }
  }

  // `s` is { input, output, phase, working, tools, names, color, reduced, now }; `now` is the
  // animation frame's timestamp in ms, so the motion keeps the same pace on 60 and 120 Hz screens.
  function draw(g, w, s) {
    const small = w < 140
    if (!dots.length || small !== (plan.blob === 6)) {
      layout(small)
    }
    const now = Number.isFinite(s.now) ? s.now / 1000 : clock + 1 / 60
    const dt = Math.min(0.05, Math.max(0, now - clock))
    clock = now
    t += dt
    const step = k => 1 - Math.pow(1 - k, dt * 60)
    const pace = s.reduced ? 0.25 : 1
    const live = s.phase === 'live'
    const waiting = s.phase === 'connecting' || s.phase === 'reconnecting'
    mic += ((live ? s.input : 0) - mic) * step(0.1)
    voice += ((live ? s.output : 0) - voice) * step(0.07)
    morph += ((s.working ? 1 : 0) - morph) * step(0.028)
    sphereTurn += dt * pace * (waiting ? 0.5 : 0.22)
    record(s)

    // Spin, then swap. The ring eases almost to a stop for the swap, as the iPhone's does.
    const period = SPINNING + SWAPPING
    const nextCycle = s.reduced ? cycle : Math.floor(t / period)
    if (nextCycle !== cycle) {
      const pairs = crossing(cycle)
      order = order.map(place => {
        const pair = partner(pairs, place)

        return pair ? (pair[0] === place ? pair[1] : pair[0]) : place
      })
      cycle = nextCycle
    }
    const into = t % period
    const swapping = !s.reduced && into > SPINNING
    const u = swapping ? (into - SPINNING) / SWAPPING : 0
    ringTurn += dt * TURN * pace * (swapping ? 1 - 0.75 * Math.sin(u * Math.PI) : 1)
    const grown = Math.min(1, Math.max(0, (morph - 0.5) / 0.45))
    const trip = (t - sent) / HOP
    const [targetX, targetY] = nodeAt(active)
    // The carrying shape swells as the ball sinks in, then slides back to its place once it's gone.
    const shapes = blobs(swapping, u)
    const [ballX, ballY] = ballAt(Math.min(trip, 0.7), targetX, targetY)
    const holding = glSmooth((trip - 0.24) / 0.09) * (1 - glSmooth((trip - 0.7) / 0.28))
    const full = carried(trip)
    const shape = shapes[rider]
    shapes[rider] = { x: shape.x + (ballX - shape.x) * holding, y: shape.y + (ballY - shape.y) * holding, r: shape.r + (0.045 - shape.r) * Math.max(full, holding * 0.4) }
    const field = fieldOf(shapes, grown * grown * (3 - 2 * grown), step(0.1))

    const c = w / 2
    const unit = w / 280
    const radius = w * 0.31 * (1 - mic * 0.1 + voice * 0.07 + (waiting ? 0.02 * Math.sin(t * 2.5) : 0))
    const cos = Math.cos(sphereTurn)
    const sin = Math.sin(sphereTurn)
    relayTurn += dt * pace * 0.07
    // Before the first tool the messenger waits inside the orb.
    const [ax, ay] = seen ? nodeAt(active) : [0, 0]
    const carrySize = seen ? NODE_SIZE : 0.024
    const cells = {}
    const echoCells = kind => cells[kind] || (cells[kind] = glSample(kind, plan.echo))
    g.clearRect(0, 0, w, w)
    g.fillStyle = s.color

    for (const d of dots) {
      const px = d.x * cos + d.z * sin
      const pz = -d.x * sin + d.z * cos
      const wave = s.reduced ? 1 : 1 + voice * 0.07 * Math.sin(d.y * 5 - t * 3) - mic * 0.07 * Math.sin(d.y * 4 + t * 2.4)
      const depth = (pz + 1) / 2
      const sx = c + px * radius * wave
      const sy = c + d.y * radius * wave
      const k = Math.min(1, Math.max(0, morph * 1.5 - d.delay * 0.5))
      const m = k * k * (3 - 2 * k)
      let size
      let alpha
      let wobble = 0
      // A refused tool lands blue, then turns red with a short shiver.
      const owner = d.role === 'carry' ? slots[active] : d.role === 'core' ? null : slots[d.node]
      const refused = owner && owner.blocked ? glSmooth((t - owner.ready) / 0.4) : 0
      const shiver = refused > 0 && refused < 1 ? 0.004 * Math.sin(t * 46) : 0

      if (d.role === 'core') {
        // Dots lean towards a passing shape and swell and fade gradually, so the shape flows through
        // the disc instead of stepping from dot to dot.
        const [v, pullX, pullY] = field(d.rx, d.ry)
        d.swell += (glSmooth((v - 0.12) / 0.6) - d.swell) * step(0.14)
        d.qx += (pullX * 0.26 - d.qx) * step(0.14)
        d.qy += (pullY * 0.26 - d.qy) * step(0.14)
        size = 0.5 + d.swell * 1.85
        alpha = 0.13 + d.swell * 0.82
      } else if (d.role === 'echo') {
        const slot = slots[d.node]
        const kind = !slot ? 'idle' : t >= slot.ready ? slot.kind : slot.was === 'ring' ? 'idle' : slot.was
        const [nx, ny] = nodeAt(d.node)
        const [cx, cy] = echoCells(kind)[d.k]
        wobble = 1
        const tx = nx + cx * NODE_SIZE
        const ty = ny + cy * NODE_SIZE
        if (d.rx === null) {
          d.rx = tx
          d.ry = ty
        }
        d.rx += (tx - d.rx) * step(0.05)
        d.ry += (ty - d.ry) * step(0.05)
        const fresh = slot && t >= slot.ready ? Math.max(0.24, 0.8 - (seen - 1 - slot.order) * 0.12) : 0.2
        d.strength += (fresh - d.strength) * step(0.03)
        size = 0.86
        alpha = d.strength
      } else if (d.role === 'rim') {
        // A small wave always runs round the rim; the landing adds a bounce that dies away.
        const slot = slots[d.node]
        const since = slot ? t - slot.ready : -1
        const kick = since > 0 ? 0.2 * Math.exp(-2.4 * since) * Math.cos(8 * since) : 0
        const live = d.node === active && s.working
        const a = d.around + t * (d.node % 2 ? -0.16 : 0.16)
        const bounce = (live ? 0.05 : 0.025) * Math.sin(d.around * 3 - t * 2.6) + kick
        const [nx, ny] = nodeAt(d.node)
        d.rx = nx + Math.cos(a) * NODE_SIZE * (1.12 + bounce)
        d.ry = ny + Math.sin(a) * NODE_SIZE * (1.12 + bounce)
        d.strength += ((live ? 0.8 : slot ? 0.42 : 0.24) - d.strength) * step(0.04)
        size = 0.95
        alpha = d.strength
      } else {
        const [cx, cy] = carryCells[d.k]
        const tx = ax + cx * carrySize
        const ty = ay + cy * carrySize
        const f = d.flight
        const raw = f ? (t - f.start) / HOP : 1
        if (raw >= 1) {
          d.flight = null
        }
        if (!d.flight || d.rx === null) {
          d.rx = tx
          d.ry = ty
        } else if (raw > 0) {
          [d.rx, d.ry] = journey(f, raw, tx, ty, ax, ay, cx, cy)
        }
        const sunk = f ? carried(raw) : 0
        size = 0.92 * (1 - 0.6 * sunk)
        alpha = 0.95 * (1 - 0.96 * sunk)
        wobble = 1
      }

      // Symbols are never quite still: each one floats gently as a whole.
      const home = d.role === 'echo' ? d.node : active
      const driftX = d.qx + wobble * 0.0065 * Math.sin(t * 0.9 + home * 1.7)
      const driftY = d.qy + wobble * 0.0065 * Math.cos(t * 0.75 + home * 2.3)
      const inner = d.role === 'core' ? 0.22 : 1
      const r = (0.7 + depth * 1.9) * inner * (1 - m) + size * m
      g.globalAlpha = Math.max(0.04, Math.min(1, (0.14 + depth * 0.8) * inner * (1 - m) + alpha * m))
      g.beginPath()
      g.arc(sx + (c + (d.rx + driftX + shiver) * w - sx) * m, sy + (c + (d.ry + driftY) * w - sy) * m, Math.max(0.3, r) * unit, 0, GL_TAU)
      g.fill()
      if (refused > 0) {
        g.fillStyle = s.danger || '#d23a44'
        g.globalAlpha *= refused * m
        g.fill()
        g.fillStyle = s.color
      }
    }
    g.globalAlpha = 1
  }

  return { draw }
}

function createGeminiLiveEngine(env) {
  const listeners = new Set()
  const state = {
    phase: 'idle', // idle | connecting | live | reconnecting | ending | error
    error: '',
    muted: false,
    pausedUntil: 0,
    modelSpeaking: false,
    userSpeaking: false,
    model: '',
    voice: '',
    persona: '',
    personaLabel: '',
    agentName: 'Hermes', // this profile's display name, from the backend
    startedAt: 0,
    transcript: [], // { id, role: 'user'|'assistant'|'system', text, ts, final }
    activity: [], // { id, name, label, status: 'running'|'done'|'error', detail, ts }
    delegation: null // { id, request, sessionId, status, lastTool, partial, result, startedAt, finishedAt }
  }

  let ws = null
  let wsGen = 0
  let session = null // last /session response
  let resumeHandle = ''
  let reconnecting = false
  let reconnectAttempts = 0
  let ending = false
  let micStream = null
  let micCtx = null
  let micNode = null
  let micSource = null
  let micSink = null
  let outCtx = null
  let outGain = null
  let outAnalyser = null
  let playHead = 0
  const playing = new Set()
  let inLevel = 0
  let lastUserVoiceAt = 0
  // Background level the mic settles to (fans, music, a fake test device). "The user is talking"
  // means clearly above it, so steady noise cannot hold updates back.
  let noiseFloor = 0.01
  let noticesSince = 0
  let lastModelAudioAt = 0
  let turnOpen = false
  // The profile's MCP tools as Hermes sees them (tools.show + mcp.servers.status), refreshed at
  // call start and on list_mcp_tools; also baked into the call's instructions so it knows them.
  let mcpCache = null
  let mcpBrief = []
  // Follow-through guard: what the model said this turn, whether it called a tool, and whether
  // it was already nudged since the user last spoke (one nudge per user turn, never a loop).
  let turnSpeech = ''
  let turnTools = 0
  let nudged = false
  const pendingNotices = []
  let noticeTimer = 0
  let pauseTimer = 0
  let unsubscribeEvents = null
  let pollTimer = 0
  let seq = 0
  let pendingSwap = null // { persona, voice } — reconnect after the current answer
  let endAfterTurn = false
  let endRequestedAt = 0
  let goodbyeNudged = false
  let quotaStep = 0
  let noSearch = false
  let freshContext = {}
  const threadIndex = new Map() // thread id → { liveId, storedId, profile, title, kind }

  // ── state plumbing ───────────────────────────────────────────────────────────────────────────

  let emitQueued = false

  function emit() {
    if (emitQueued) {
      return
    }

    emitQueued = true
    Promise.resolve().then(() => {
      emitQueued = false
      const snap = snapshot()
      listeners.forEach(fn => {
        try {
          fn(snap)
        } catch (error) {
          log('warn', `listener failed: ${error}`)
        }
      })
    })
  }

  function snapshot() {
    return {
      ...state,
      transcript: state.transcript.slice(),
      activity: state.activity.slice(),
      delegation: state.delegation ? { ...state.delegation } : null
    }
  }

  function set(patch) {
    Object.assign(state, patch)
    emit()
  }

  function log(level, message) {
    if (env.log) {
      env.log(level, message)
    }
  }

  function addTranscript(role, text, final) {
    const clean = String(text || '')
    const last = state.transcript[state.transcript.length - 1]

    if (last && last.role === role && !last.final) {
      last.text += clean
      last.final = Boolean(final)
      last.ts = glNow()
    } else if (clean.trim()) {
      state.transcript.push({ id: `t${(seq += 1)}`, role, text: clean, ts: glNow(), final: Boolean(final) })

      if (state.transcript.length > GL_MAX_TRANSCRIPT) {
        state.transcript.splice(0, state.transcript.length - GL_MAX_TRANSCRIPT)
      }
    }

    emit()
  }

  function sealTranscript(role) {
    const last = state.transcript[state.transcript.length - 1]

    if (last && (!role || last.role === role)) {
      last.final = true
    }
  }

  function addActivity(name, label, status, detail) {
    const item = { id: `a${(seq += 1)}`, name, label, status, detail: detail || '', ts: glNow() }
    state.activity.push(item)

    if (state.activity.length > GL_MAX_ACTIVITY) {
      state.activity.splice(0, state.activity.length - GL_MAX_ACTIVITY)
    }

    emit()

    return item
  }

  function finishActivity(item, status, detail) {
    item.status = status
    if (detail !== undefined) {
      item.detail = detail
    }
    emit()
  }

  // ── audio out ────────────────────────────────────────────────────────────────────────────────

  function ensureOutput() {
    if (outCtx) {
      return
    }

    const Ctx = window.AudioContext || window.webkitAudioContext
    outCtx = new Ctx({ sampleRate: GL_OUTPUT_RATE })
    outGain = outCtx.createGain()
    outAnalyser = outCtx.createAnalyser()
    outAnalyser.fftSize = 512
    outGain.connect(outAnalyser)
    outAnalyser.connect(outCtx.destination)
    playHead = 0
  }

  function playPcm(b64) {
    ensureOutput()
    const bytes = glBytesFromBase64(b64)
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2))
    const buffer = outCtx.createBuffer(1, samples.length, GL_OUTPUT_RATE)
    const channel = buffer.getChannelData(0)

    for (let i = 0; i < samples.length; i += 1) {
      channel[i] = samples[i] / 0x8000
    }

    const node = outCtx.createBufferSource()
    node.buffer = buffer
    node.connect(outGain)
    const start = Math.max(outCtx.currentTime + 0.04, playHead)
    node.start(start)
    playHead = start + buffer.duration
    playing.add(node)
    node.onended = () => {
      playing.delete(node)

      if (!playing.size) {
        set({ modelSpeaking: false })
        scheduleNotices(450)
      }
    }
    lastModelAudioAt = glNow()

    if (!state.modelSpeaking) {
      set({ modelSpeaking: true })
    }
  }

  function flushPlayback() {
    playing.forEach(node => {
      try {
        node.stop()
      } catch {
        // already stopped
      }
    })
    playing.clear()
    playHead = 0

    if (state.modelSpeaking) {
      set({ modelSpeaking: false })
    }
  }

  // ── audio in ─────────────────────────────────────────────────────────────────────────────────

  async function startMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('This window has no microphone access.')
    }

    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    })
    const Ctx = window.AudioContext || window.webkitAudioContext

    try {
      micCtx = new Ctx({ sampleRate: GL_INPUT_RATE })
    } catch {
      micCtx = new Ctx()
    }

    micSource = micCtx.createMediaStreamSource(micStream)
    // ScriptProcessor keeps this file free of worklet modules (catalog rule: no blob/module loads).
    micNode = micCtx.createScriptProcessor(GL_CHUNK, 1, 1)
    micSink = micCtx.createGain()
    micSink.gain.value = 0
    micNode.onaudioprocess = event => {
      const input = event.inputBuffer.getChannelData(0)
      const level = glRms(input)
      inLevel = inLevel * 0.6 + level * 0.4

      noiseFloor = level < noiseFloor ? noiseFloor * 0.9 + level * 0.1 : noiseFloor * 0.998 + level * 0.002

      if (level > Math.max(0.02, noiseFloor * 3)) {
        lastUserVoiceAt = glNow()
      }

      if (state.muted || !ws || ws.readyState !== 1 || state.phase !== 'live') {
        return
      }

      const pcm = glFloatToPcm16(glResample(input, micCtx.sampleRate, GL_INPUT_RATE))
      send({
        realtimeInput: {
          audio: { data: glBase64FromBytes(new Uint8Array(pcm.buffer)), mimeType: `audio/pcm;rate=${GL_INPUT_RATE}` }
        }
      })
    }
    micSource.connect(micNode)
    micNode.connect(micSink)
    micSink.connect(micCtx.destination)
  }

  function stopMic() {
    try {
      if (micNode) {
        micNode.onaudioprocess = null
        micNode.disconnect()
      }
      if (micSource) {
        micSource.disconnect()
      }
      if (micSink) {
        micSink.disconnect()
      }
    } catch {
      // nodes already torn down
    }

    if (micStream) {
      micStream.getTracks().forEach(track => track.stop())
    }

    if (micCtx) {
      micCtx.close().catch(() => undefined)
    }

    micStream = micCtx = micNode = micSource = micSink = null
    inLevel = 0
  }

  // Tools for the orb, in the order they happened. A leading ! marks one the safety layers refused.
  const orbTools = []
  let voiceApproval = false
  let approvalPoll = 0
  let approvalWait = 0
  let refusedAt = 0

  function visual() {
    const d = state.delegation
    const working = Boolean(d && d.status === 'working')
    const active = state.phase === 'live' && (working || Date.now() - refusedAt < 5500)
    if (!active) {
      orbTools.length = 0 // the orb is a clean sphere again, ready for the next job
    }

    return { working: active, tools: orbTools.length, names: orbTools.slice(-6) }
  }

  function levels() {
    let out = 0

    if (outAnalyser && playing.size) {
      const data = new Uint8Array(outAnalyser.fftSize)
      outAnalyser.getByteTimeDomainData(data)
      let sum = 0

      for (let i = 0; i < data.length; i += 1) {
        const v = (data[i] - 128) / 128
        sum += v * v
      }

      out = Math.sqrt(sum / data.length)
    }

    return { input: state.muted ? 0 : Math.min(1, inLevel * 4), output: Math.min(1, out * 3) }
  }

  // ── socket ───────────────────────────────────────────────────────────────────────────────────

  function send(frame) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(frame))

      return true
    }

    return false
  }

  async function loadMcpCatalog(force) {
    if (!force && mcpCache && glNow() - mcpCache.at < 60000) {
      return mcpCache.servers
    }

    const sid = (env.focus && env.focus().sessionId) || ''
    const [shown, status] = await Promise.all([
      env.rpc('tools.show', sid ? { session_id: sid } : {}, 15000),
      env.rpc('mcp.servers.status', {}, 10000).catch(() => null)
    ])
    const states = new Map(((status && status.servers) || []).map(row => [row.name, row]))
    const servers = ((shown && shown.sections) || [])
      .filter(section => String(section.name || '').startsWith('mcp-'))
      .map(section => {
        const name = section.name.slice(4)
        const row = states.get(name)

        return {
          server: name,
          status: row ? row.status : 'connected',
          tools: (section.tools || []).map(t => ({ name: t.name, description: glClip(t.description || '', 160) }))
        }
      })

    // Configured servers that are not exposed right now (failed, needs sign-in, disabled).
    for (const [name, row] of states) {
      if (!servers.some(s => s.server === name)) {
        servers.push({ server: name, status: row.needs_auth ? 'needs sign-in' : row.status, tools: [] })
      }
    }

    mcpCache = { at: glNow(), servers }

    return servers
  }

  function mcpToolKnown(name) {
    return Boolean(mcpCache && mcpCache.servers.some(s => s.tools.some(t => t.name === name)))
  }

  async function mintSession(overrides) {
    const context = {
      ...(overrides.context || {}),
      ...(mcpBrief.length ? { mcp: mcpBrief } : {}),
      time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone
    }
    const response = await env.rest('/session', {
      method: 'POST',
      body: {
        model: overrides.model || state.model || undefined,
        voice: overrides.voice || state.voice || undefined,
        persona: overrides.persona || state.persona || undefined,
        resume_handle: overrides.resumeHandle || '',
        no_search: noSearch || undefined,
        context
      }
    })

    if (!response || !response.token) {
      throw new Error((response && (response.detail || response.error)) || 'The plugin backend did not return a session.')
    }

    return response
  }

  function openSocket(minted, { fresh }) {
    return new Promise((resolve, reject) => {
      const gen = (wsGen += 1)
      const socket = new WebSocket(`${minted.ws_url}?access_token=${encodeURIComponent(minted.token)}`)
      socket.binaryType = 'arraybuffer'
      let ready = false
      const timeout = window.setTimeout(() => {
        if (!ready) {
          try {
            socket.close()
          } catch {
            // ignore
          }
          reject(new Error('Gemini did not answer the call setup in time.'))
        }
      }, 15000)

      socket.onopen = () => {
        socket.send(JSON.stringify({ setup: { model: `models/${minted.model}` } }))
      }

      socket.onmessage = event => {
        let frame
        try {
          const text = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data)
          frame = JSON.parse(text)
        } catch {
          return
        }

        if (!ready && frame.setupComplete) {
          ready = true
          window.clearTimeout(timeout)
          const old = ws
          ws = socket
          if (old && old !== socket) {
            try {
              old.close(1000, 'replaced')
            } catch {
              // ignore
            }
          }
          resolve({ fresh })

          return
        }

        if (gen === wsGen || socket === ws) {
          handleFrame(frame)
        }
      }

      socket.onerror = () => {
        if (!ready) {
          window.clearTimeout(timeout)
          reject(new Error('Could not connect to Gemini Live.'))
        }
      }

      socket.onclose = event => {
        window.clearTimeout(timeout)

        if (!ready) {
          reject(new Error(event.reason ? glCloseInfo(event).message : 'Gemini closed the call during setup.'))

          return
        }

        if (socket !== ws || ending) {
          return
        }

        ws = null
        log('warn', `socket closed ${event.code} ${event.reason || ''}`)

        // 1000 with a reason after goAway is routine; anything else is retried while resumable.
        const info = glCloseInfo(event)
        if (info.quota && recoverFromQuota()) {
          return
        }
        if (info.final) {
          fail(info.message)

          return
        }

        void reconnect('dropped')
      }
    })
  }

  // The default setup can be over a free key's quota when a lighter one is not: drop Search, then
  // fall back to the 2.5 model. Only before Gemini has spoken, so a live call never changes silently.
  function recoverFromQuota() {
    if (lastModelAudioAt >= state.startedAt || quotaStep >= 2 || ending) {
      return false
    }
    quotaStep += 1
    noSearch = true
    const model = quotaStep === 2 && state.model !== GL_FALLBACK_MODEL ? GL_FALLBACK_MODEL : undefined
    if (model) {
      addTranscript('system', `Out of quota on ${state.model}, so this call uses ${model}.`, true)
    }
    log('warn', `quota close before the first reply: retrying (step ${quotaStep})`)
    connect({ model, context: freshContext })
      .then(() => set({ phase: 'live' }))
      .catch(error => {
        if (!(/quota/i.test(String(error && error.message)) && recoverFromQuota())) {
          fail((error && error.message) || String(error))
        }
      })

    return true
  }

  async function connect(overrides) {
    const minted = await mintSession(overrides)
    session = minted
    voiceApproval = Boolean(minted.voice_approval)
    set({ agentName: minted.agent_name || state.agentName, model: minted.model, voice: minted.voice, persona: minted.persona, personaLabel: minted.persona_label || minted.persona })
    await openSocket(minted, { fresh: !overrides.resumeHandle })

    return minted
  }

  function carryOver() {
    return state.transcript
      .filter(t => t.role === 'user' || t.role === 'assistant')
      .slice(-24)
      .map(t => `${t.role === 'user' ? 'User' : 'You'}: ${glSquash(t.text)}`)
      .join('\n')
  }

  async function reconnect(reason, swap) {
    if (reconnecting || ending) {
      return
    }

    reconnecting = true
    set({ phase: 'reconnecting' })
    flushPlayback()

    try {
      while (reconnectAttempts < GL_RECONNECT_ATTEMPTS && !ending) {
        reconnectAttempts += 1

        try {
          if (swap) {
            // A persona/voice change needs a new system instruction, so it is a new session
            // that carries the conversation over as context instead of a resumed one.
            await connect({ persona: swap.persona, voice: swap.voice, context: { carry_over: carryOver() } })
          } else {
            await connect({ resumeHandle: resumeHandle, context: resumeHandle ? {} : { carry_over: carryOver() } })
          }

          reconnectAttempts = 0
          set({ phase: 'live', error: '' })
          addTranscript('system', swap ? `Switched to ${state.personaLabel} · ${state.voice}` : 'Reconnected', true)
          if (swap) {
            send({ realtimeInput: { text: '[System] The voice settings just changed. Say one short sentence in the new style to confirm.' } })
          }

          return
        } catch (error) {
          log('warn', `reconnect (${reason}) failed: ${error && error.message}`)
          await new Promise(r => window.setTimeout(r, 600 * reconnectAttempts))
        }
      }

      fail('Lost the connection to Gemini Live.')
    } finally {
      reconnecting = false
    }
  }

  function handleFrame(frame) {
    if (frame.sessionResumptionUpdate) {
      const update = frame.sessionResumptionUpdate
      if (update.resumable && update.newHandle) {
        resumeHandle = update.newHandle
      }
    }

    if (frame.goAway) {
      // The socket is about to rotate (~10 min lifetime). Resume on a fresh token now.
      void reconnect('goAway')
    }

    if (frame.toolCall && Array.isArray(frame.toolCall.functionCalls)) {
      for (const call of frame.toolCall.functionCalls) {
        turnTools += 1
        void runTool(call)
      }
    }

    if (frame.toolCallCancellation && Array.isArray(frame.toolCallCancellation.ids)) {
      for (const id of frame.toolCallCancellation.ids) {
        cancelledCalls.add(id)
      }
    }

    const content = frame.serverContent

    if (!content) {
      return
    }

    if (content.interrupted) {
      flushPlayback()
      sealTranscript('assistant')
    }

    if (content.inputTranscription && content.inputTranscription.text) {
      sealTranscript('assistant')
      addTranscript('user', glFixName(content.inputTranscription.text), false)
      nudged = false
      set({ userSpeaking: true })
      listenForApproval()
    }

    if (content.modelTurn && Array.isArray(content.modelTurn.parts)) {
      turnOpen = true
      sealTranscript('user')
      if (state.userSpeaking) {
        set({ userSpeaking: false })
      }

      for (const part of content.modelTurn.parts) {
        if (part.inlineData && part.inlineData.data && String(part.inlineData.mimeType || '').startsWith('audio/pcm')) {
          playPcm(part.inlineData.data)
        }
      }
    }

    if (content.outputTranscription && content.outputTranscription.text) {
      sealTranscript('user')
      const spoken = content.outputTranscription.text.replace(/<no speech>(\{[^}]*\})?/gi, '')
      addTranscript('assistant', spoken, false)
      turnSpeech += spoken
    }

    if (content.turnComplete) {
      turnOpen = false
      sealTranscript('assistant')
      if (state.userSpeaking) {
        set({ userSpeaking: false })
      }
      scheduleNotices(playing.size ? 0 : 350)
      checkFollowThrough()

      if (endAfterTurn && !goodbyeNudged && lastModelAudioAt < endRequestedAt - 4000) {
        // The model hung up without speaking: give it one turn to say goodbye (the timer still ends it).
        goodbyeNudged = true
        send({ realtimeInput: { text: '[System] Say a short goodbye out loud now.' } })
      } else if (endAfterTurn) {
        endAfterTurn = false
        afterPlayback(() => void stop('goodbye'))
      } else if (pendingSwap) {
        const swap = pendingSwap
        pendingSwap = null
        afterPlayback(() => void reconnect('swap', swap))
      }
    }
  }

  // Native-audio models sometimes announce an action ("I'll ask Hermes to check") and end the
  // turn without calling the tool, so nothing happens. Catch that once and make it act or own up.
  function checkFollowThrough() {
    const spoke = turnSpeech
    const tools = turnTools
    turnSpeech = ''
    turnTools = 0

    const working = state.delegation && state.delegation.status === 'working'

    // While Hermes is already on it, "I'll check on that" is about the running work, not a new job.
    if (nudged || tools > 0 || working || endAfterTurn || pendingSwap || !glPromisedAction(spoke)) {
      return
    }

    nudged = true
    log('info', 'model promised an action without a tool call; nudging')
    send({
      realtimeInput: {
        text:
          '[System] You just said you would do something, but you called no tool, so nothing is happening. ' +
          'If it needs Hermes, call ask_hermes now and do not repeat what you already said. ' +
          'If you can answer it yourself, just answer.'
      }
    })
  }

  function afterPlayback(fn) {
    const wait = () => {
      if (!playing.size || !outCtx || outCtx.currentTime >= playHead) {
        fn()
      } else {
        window.setTimeout(wait, 150)
      }
    }

    window.setTimeout(wait, 150)
  }

  // ── system updates into the conversation ─────────────────────────────────────────────────────
  // Injected text interrupts a model that is mid-answer, so updates wait for a quiet moment:
  // the model finished its turn and its audio, and the user is not talking.

  function queueNotice(text) {
    if (!pendingNotices.length) {
      noticesSince = glNow()
    }
    pendingNotices.push(text)
    scheduleNotices(0)
  }

  function scheduleNotices(delay) {
    if (noticeTimer) {
      window.clearTimeout(noticeTimer)
    }

    noticeTimer = window.setTimeout(flushNotices, delay)
  }

  function flushNotices() {
    noticeTimer = 0

    if (!pendingNotices.length || state.phase !== 'live') {
      return
    }

    const now = glNow()
    const modelBusy = turnOpen || playing.size > 0 || now - lastModelAudioAt < 600
    // After 8 s an update stops waiting for the user to go quiet (a noisy room never does); it
    // still never talks over the model.
    const userBusy = now - noticesSince < 8000 && (state.userSpeaking || now - lastUserVoiceAt < 900)

    if (modelBusy || userBusy) {
      scheduleNotices(500)

      return
    }

    const text = pendingNotices.splice(0, pendingNotices.length).join('\n\n')
    send({ realtimeInput: { text } })
    addTranscript('system', glClip(glNoticeShown(text), 400), true)
  }

  // ── tools ────────────────────────────────────────────────────────────────────────────────────

  const cancelledCalls = new Set()

  function routeOf(name) {
    const tools = (session && session.tools) || []
    const hit = tools.find(t => t.name === name)

    return hit ? hit.where : ''
  }

  async function runTool(call) {
    const name = call.name
    const args = call.args || {}
    const label = (TOOL_LABELS[name] || name).replace('Hermes', state.agentName)
    const item = addActivity(name, label, 'running', summariseArgs(name, args))
    let result

    try {
      const where = routeOf(name)

      if (where === 'server') {
        const body = { name, args }
        if (name === 'run_readonly') {
          // The reviewer judges the command against what was actually said on this call.
          body.context = {
            transcript: state.transcript.slice(-16).map(t => ({ role: t.role, text: glClip(t.text, 400) }))
          }
        }
        const response = await env.rest('/tool', { method: 'POST', body })
        result = (response && response.result) || { error: 'no result' }
      } else if (where === 'client' || where === 'call') {
        const handler = CLIENT_TOOLS[name]
        result = handler ? await handler(args, item) : { error: `${name} is not available here` }
      } else {
        result = { error: `Unknown tool ${name}` }
      }
    } catch (error) {
      result = { error: glClip((error && error.message) || String(error), 300) }
    }

    if (result && result.refused) {
      orbTools.push(name === 'run_readonly' ? '!terminal' : '!read_file')
      refusedAt = Date.now()
      // A refused command is a safety outcome, not a crash: show which layer said no and why.
      finishActivity(item, 'error', `Refused (${result.layer === 'review' ? 'safety review' : 'rules'}): ${glClip(result.reason || '', 160)}`)
    } else {
      finishActivity(item, result && result.error ? 'error' : 'done', result && result.error ? String(result.error) : item.detail)
    }

    if (cancelledCalls.has(call.id)) {
      cancelledCalls.delete(call.id)

      return
    }

    send({ toolResponse: { functionResponses: [{ id: call.id, name, response: limitResult(result) }] } })
  }

  function limitResult(result) {
    const json = JSON.stringify(result == null ? {} : result)

    if (json.length <= 7000) {
      return typeof result === 'object' && result !== null ? result : { result }
    }

    return { result: `${json.slice(0, 7000)} …[truncated]` }
  }

  function summariseArgs(name, args) {
    if (args.command) {
      return glClip(args.command, 120)
    }
    if (args.tool) {
      return glClip(`${args.tool}${args.goal ? ` · ${args.goal}` : ''}`, 120)
    }
    if (name === 'ask_hermes') {
      return glClip(args.request || '', 140)
    }
    if (args.query) {
      return glClip(args.query, 120)
    }
    if (args.message) {
      return glClip(args.message, 120)
    }
    if (args.persona) {
      return String(args.persona)
    }
    if (args.voice) {
      return String(args.voice)
    }
    if (args.check) {
      return String(args.check)
    }
    return args.thread_id ? `thread ${String(args.thread_id).slice(0, 12)}` : ''
  }

  const TOOL_LABELS = {
    ask_hermes: 'Asked Hermes',
    check_hermes: 'Checked progress',
    cancel_hermes: 'Stopped Hermes',
    list_threads: 'Listed threads',
    read_thread: 'Read a thread',
    message_thread: 'Messaged a thread',
    stop_thread: 'Stopped a thread',
    list_subagents: 'Listed subagents',
    steer_subagent: 'Steered a subagent',
    recall_memory: 'Searched memory',
    search_conversations: 'Searched past chats',
    system_check: 'System check',
    run_readonly: 'Ran a read-only command',
    mobile_alarm_create: 'Set an alarm',
    mobile_timer_start: 'Started a timer',
    mobile_alarms_list: 'Listed alarms',
    mobile_alarm_cancel: 'Cancelled an alarm',
    mobile_reminder_create: 'Created a reminder',
    mobile_reminders_list: 'Read reminders',
    mobile_reminder_complete: 'Completed a reminder',
    mobile_request_result: 'Checked with the phone',
    list_mcp_tools: 'Listed MCP tools',
    use_mcp_tool: 'Used an MCP tool',
    agents_overview: 'Looked at your agents',
    end_call: 'Ending call',
    pause_listening: 'Paused listening',
    switch_persona: 'Switching persona',
    change_voice: 'Changing voice'
  }

  // ── Hermes delegation ────────────────────────────────────────────────────────────────────────

  async function resolveTarget(threadId) {
    if (threadId) {
      const known = threadIndex.get(String(threadId))
      if (known && known.liveId) {
        return { sessionId: known.liveId, viaComposer: false }
      }
      if (known && known.storedId && !known.profile) {
        const resumed = await env.rpc('session.resume', { session_id: known.storedId, omit_messages: true, inline_images: false }, 60000)
        const liveId = resumed && resumed.session_id
        if (liveId) {
          known.liveId = liveId

          return { sessionId: liveId, viaComposer: false }
        }
      }

      return { sessionId: String(threadId), viaComposer: false }
    }

    const focus = (env.focus && env.focus()) || {}

    if (focus.sessionId) {
      return { sessionId: focus.sessionId, viaComposer: Boolean(env.submitToChat) }
    }

    if (env.ensureSession) {
      const created = await env.ensureSession()

      if (created) {
        return { sessionId: created, viaComposer: false }
      }
    }

    return { sessionId: '', viaComposer: Boolean(env.submitToChat) }
  }

  async function voiceContext() {
    return state.transcript
      .filter(t => t.role !== 'system')
      .slice(-10)
      .map(t => `${t.role === 'user' ? 'User' : 'Voice'}: ${glSquash(t.text)}`)
      .join('\n')
  }

  // The voice chooses: the chat the call started from, a new session, or the last task's session.
  async function taskTarget(args, previous) {
    if (args.thread_id) {
      return resolveTarget(args.thread_id)
    }
    if (args.where === 'last_task' && previous && previous.sessionId) {
      return { sessionId: previous.sessionId, viaComposer: false }
    }
    const focus = (env.focus && env.focus()) || {}
    if (args.where !== 'new' && focus.sessionId) {
      return resolveTarget()
    }
    const created = await env.rpc('session.create', {}, 30000).catch(() => null)

    return created && created.session_id ? { sessionId: created.session_id, viaComposer: false, fresh: true } : resolveTarget()
  }

  async function submitToHermes(sessionId, text, viaComposer, fresh) {
    if (viaComposer && env.submitToChat && env.submitToChat(sessionId || null, text)) {
      return sessionId || (await waitForFocusedSession())
    }

    if (!sessionId) {
      throw new Error('Open a chat first, then ask again.')
    }

    // A new session stands on its own request; the call's transcript would also become its title.
    const context = fresh ? '' : await voiceContext()
    await env.rpc('prompt.submit', { session_id: sessionId, text, surface: 'voice-live', voice_context: context }, 30000)

    return sessionId
  }

  async function waitForFocusedSession() {
    for (let i = 0; i < 40; i += 1) {
      const focus = (env.focus && env.focus()) || {}
      if (focus.sessionId) {
        return focus.sessionId
      }
      await new Promise(r => window.setTimeout(r, 150))
    }

    return ''
  }

  // Approvals stay Hermes': this only surfaces a waiting request and passes on the user's answer.
  // The voice model has no tool for it. A button or, if voice_approval is on, the user's own words
  // answer it, matched here on the microphone transcript and never while the voice is speaking.
  function syncApproval(pending) {
    const d = state.delegation
    if (!d || d.status !== 'working' || state.phase !== 'live') {
      return
    }
    const next = pending[0]
    if (!next) {
      if (d.approval) {
        d.approval = null
        emit()
        queueNotice('[Hermes update] That approval request was answered elsewhere or timed out. Say so briefly if the user is still deciding.')
      }
      return
    }
    if (d.approval && d.approval.id === next.request_id) {
      return
    }
    const action = glClip(next.command || next.description || 'a protected action', 200)
    d.approval = { id: next.request_id, action, reason: glClip(next.description || '', 200), after: state.transcript.length }
    emit()
    const how = voiceApproval ? 'They can say approve or deny, or use the buttons on screen.' : 'They must press Approve or Deny on screen.'
    queueNotice(`[Hermes update] ${state.agentName} needs the user's approval before it can do this: ${action}. Say in one plain sentence what it wants to do and ask them to decide. ${how} You cannot approve it yourself.`)
  }

  async function answerApproval(choice) {
    const d = state.delegation
    const asked = d && d.approval
    if (!asked) {
      return
    }
    const approved = choice === 'once'
    d.approval = null
    emit()
    finishActivity(addActivity('approval', approved ? 'Approved' : 'Denied', 'running', asked.action), 'done', asked.action)
    try {
      await env.rpc('approval.respond', { session_id: d.sessionId, request_id: asked.id, choice: approved ? 'once' : 'deny' }, 300000)
      queueNotice(`[Hermes update] The user ${approved ? 'approved' : 'denied'} that request. Acknowledge it in a few words.`)
    } catch (error) {
      addTranscript('system', `Could not send that approval: ${glClip((error && error.message) || String(error), 160)}`, true)
    }
  }

  // Judges the user's line as heard: by the time the timer fires the voice may have replied, and
  // anything heard while it was speaking could be its own words coming back through the speakers.
  function listenForApproval() {
    clearTimeout(approvalWait)
    const d = state.delegation
    const asked = d && d.approval
    const index = state.transcript.length - 1
    const line = state.transcript[index]
    if (!voiceApproval || !asked || state.modelSpeaking || index < asked.after || !line || line.role !== 'user') {
      return
    }
    approvalWait = setTimeout(() => {
      if (d.approval !== asked) {
        return
      }
      if (GL_APPROVE.test(line.text)) {
        void answerApproval('once')
      } else if (GL_DENY.test(line.text)) {
        void answerApproval('deny')
      }
    }, 600)
  }

  function startTracking(delegation) {
    stopTracking()
    const seen = { working: false }
    approvalPoll = setInterval(() => {
      env.rpc('approval.pending', { session_id: delegation.sessionId }, 5000)
        .then(reply => syncApproval((reply && reply.approvals) || []))
        .catch(() => {})
    }, 2000)

    unsubscribeEvents = env.onEvent(event => {
      const d = state.delegation
      if (!d || d.id !== delegation.id || !event || event.session_id !== d.sessionId) {
        return
      }

      const payload = event.payload || {}

      switch (event.type) {
        case 'message.start':
          seen.working = true
          d.status = 'working'
          break
        case 'message.delta':
          seen.working = true
          if (typeof payload.text === 'string') {
            d.partial = glClip((d.partial || '') + payload.text, 6000)
          }
          break
        case 'tool.start':
          seen.working = true
          d.lastTool = payload.name || d.lastTool
          d.toolCount = (d.toolCount || 0) + 1
          orbTools.push(d.lastTool)
          break
        case 'message.complete':
          finishDelegation(d, payload)
          return
        default:
          return
      }

      emit()
    })

    // Poll as the fallback: events can be missed across reconnects, and some transports
    // deliver only the focused session's stream.
    pollTimer = window.setInterval(async () => {
      const d = state.delegation
      if (!d || d.id !== delegation.id || d.status === 'done' || d.status === 'failed') {
        return
      }

      try {
        const live = await env.rpc('session.active_list', {}, 10000)
        const row = ((live && live.sessions) || []).find(s => s.id === d.sessionId)

        if (row && GL_BUSY_STATUSES[row.status]) {
          seen.working = true
          d.status = 'working'

          return
        }

        if ((row && row.status === 'idle' && seen.working) || glNow() - d.startedAt > 20000) {
          const history = await env.rpc('session.history', { session_id: d.sessionId }, 15000)
          const msgs = (history && history.messages) || []
          const probe = glSquash(d.request).slice(0, 40)
          let anchor = -1

          msgs.forEach((m, i) => {
            if (m.role === 'user' && glSquash(m.text).includes(probe)) {
              anchor = i
            }
          })

          const reply = anchor < 0 ? null : msgs.slice(anchor + 1).filter(m => m.role === 'assistant' && glSquash(m.text)).pop()

          if (reply && (!row || row.status === 'idle')) {
            finishDelegation(d, { text: reply.text, status: 'complete' })
          }
        }
      } catch (error) {
        log('debug', `delegation poll: ${error && error.message}`)
      }
    }, 3000)
  }

  function dropApproval() {
    if (state.delegation && state.delegation.approval) {
      state.delegation.approval = null
      emit()
    }
  }

  function stopTracking() {
    clearInterval(approvalPoll)
    clearTimeout(approvalWait)
    if (unsubscribeEvents) {
      unsubscribeEvents()
      unsubscribeEvents = null
    }

    if (pollTimer) {
      window.clearInterval(pollTimer)
      pollTimer = 0
    }
  }

  function finishDelegation(d, payload) {
    if (d.status === 'done' || d.status === 'failed') {
      return
    }

    const status = String(payload.status || 'complete')
    const failed = status === 'error' || status === 'failed' || Boolean(payload.error)
    const interrupted = status === 'interrupted' || status === 'cancelled'
    const text = glPlain(typeof payload.text === 'string' ? payload.text : d.partial || '')
    d.status = failed ? 'failed' : 'done'
    d.result = glClip(text, GL_RESULT_CLIP)
    d.finishedAt = glNow()
    stopTracking()
    emit()

    const what = glClip(d.request, 160)
    const outcome = interrupted
      ? `${state.agentName} stopped before finishing.`
      : failed
        ? `${state.agentName} hit a problem: ${glClip(payload.error || payload.failure_reason || text || 'unknown error', 400)}`
        : text
          ? `${state.agentName} replied: ${d.result}`
          : `${state.agentName} finished without a written answer.`
    queueNotice(`[Hermes update] About your request “${what}”: ${outcome} Tell the user what that says, and only that. Say something was done only if it says so. If it asks a question, ask the user, then send their reply with ask_hermes, where last_task.`)
  }

  // ── client tools ─────────────────────────────────────────────────────────────────────────────

  async function listThreads(args) {
    const scope = args.scope || 'all'
    const focus = (env.focus && env.focus()) || {}
    const out = {}

    if (scope === 'active' || scope === 'all') {
      const live = await env.rpc('session.active_list', { current_session_id: focus.sessionId || null }, 10000)
      out.active = ((live && live.sessions) || []).slice(0, 15).map(s => {
        threadIndex.set(s.id, { liveId: s.id, storedId: s.session_key, title: s.title, kind: 'live' })

        return {
          thread_id: s.id,
          title: glClip(s.title || 'Untitled', 80),
          status: s.status,
          on_screen: Boolean(s.current),
          working: Boolean(GL_BUSY_STATUSES[s.status]),
          last_active_min_ago: Math.max(0, Math.round((glNow() / 1000 - (s.last_active || 0)) / 60)),
          latest: glClip(s.preview || '', 160)
        }
      })
    }

    if (scope === 'recent' || scope === 'all') {
      const stored = await env.rpc('session.list', { limit: 10 }, 10000)
      const liveKeys = new Set([...threadIndex.values()].map(v => v.storedId).filter(Boolean))
      out.recent = ((stored && stored.sessions) || [])
        .filter(s => !liveKeys.has(s.id))
        .slice(0, 10)
        .map(s => {
          threadIndex.set(s.id, { storedId: s.id, title: s.title, kind: 'stored' })

          return { thread_id: s.id, title: glClip(s.title || s.preview || 'Untitled', 80), messages: s.message_count, latest: glClip(s.preview || '', 140) }
        })
    }

    if (scope === 'bots' || scope === 'all') {
      try {
        const roster = await env.rpc('profiles.list', { include_sessions: true }, 15000)
        const liveByKey = new Map([...threadIndex.values()].filter(v => v.liveId && v.storedId).map(v => [v.storedId, v.liveId]))
        out.bots = ((roster && roster.profiles) || [])
          .filter(p => !p.is_default && p.canonical_session)
          .slice(0, 12)
          .map(p => {
            const chat = p.canonical_session
            const storedId = chat.resolved_id || chat.id
            const liveId = liveByKey.get(storedId) || ''
            const id = liveId || `bot:${p.name}`
            threadIndex.set(id, { liveId, storedId, profile: p.name, title: p.display_name || p.name, kind: 'bot', preview: chat.preview })

            return {
              thread_id: id,
              bot: p.display_name || p.name,
              live: Boolean(liveId),
              last_active_min_ago: chat.last_active ? Math.max(0, Math.round((glNow() / 1000 - chat.last_active) / 60)) : null,
              latest: glClip(chat.preview || '', 180)
            }
          })
      } catch (error) {
        out.bots_error = glClip(error && error.message, 160)
      }
    }

    return out
  }

  async function readThread(args) {
    const id = String(args.thread_id || '')
    const limit = Math.max(1, Math.min(Number(args.messages) || 8, 20))
    const known = threadIndex.get(id) || {}

    if (known.kind === 'bot' && !known.liveId) {
      return {
        thread_id: id,
        bot: known.title,
        note: 'This bot chat is not running right now; this is its latest message.',
        latest: glClip(known.preview || '', 1200)
      }
    }

    const liveId = known.liveId || (known.kind ? '' : id)

    if (liveId) {
      try {
        const [history, live] = await Promise.all([
          env.rpc('session.history', { session_id: liveId }, 15000),
          env.rpc('session.active_list', {}, 10000).catch(() => null)
        ])
        const row = ((live && live.sessions) || []).find(s => s.id === liveId)

        return {
          thread_id: id,
          title: (row && row.title) || known.title || '',
          status: row ? row.status : 'unknown',
          messages: glCondense((history && history.messages) || [], limit)
        }
      } catch (error) {
        log('debug', `live history for ${liveId} failed (${error && error.message}); trying the stored transcript`)
      }
    }

    const storedId = known.storedId || id
    const stored = await env.rest(`/thread/${encodeURIComponent(storedId)}?limit=${limit}`)

    return { thread_id: id, title: stored.title, status: 'not running', messages: stored.messages }
  }

  async function liveIdFor(threadId) {
    const id = String(threadId || '')
    if (!id) {
      const focus = (env.focus && env.focus()) || {}

      return focus.sessionId || ''
    }

    const known = threadIndex.get(id)
    if (known && known.liveId) {
      return known.liveId
    }

    if (known && known.storedId && !known.profile) {
      const target = await resolveTarget(id)

      return target.sessionId
    }

    return known ? '' : id
  }

  const CLIENT_TOOLS = {
    async list_mcp_tools(args) {
      const servers = await loadMcpCatalog(true)
      const want = String(args.server || '').trim().toLowerCase()
      const picked = want ? servers.filter(s => s.server.toLowerCase() === want) : servers

      if (want && !picked.length) {
        return { error: `No MCP server named ${args.server}.`, servers: servers.map(s => s.server) }
      }

      return {
        servers: picked.map(s => ({
          server: s.server,
          status: s.status,
          tools: want ? s.tools : s.tools.slice(0, 40).map(t => t.name),
          more: want ? undefined : Math.max(0, s.tools.length - 40) || undefined
        }))
      }
    },

    async use_mcp_tool(args, item) {
      if (glSecretRequest(`read ${args.arguments || ''} ${args.goal || ''}`)) {
        return GL_SECRET_REFUSAL
      }
      const tool = String(args.tool || '').trim()
      if (!mcpToolKnown(tool)) {
        await loadMcpCatalog(true).catch(() => undefined)
      }
      if (!mcpToolKnown(tool)) {
        return { error: `${tool || 'That tool'} is not one of this profile's MCP tools. Call list_mcp_tools first.` }
      }

      const goal = glSquash(args.goal || '')
      const input = typeof args.arguments === 'string' ? args.arguments.trim() : ''
      // A one-tool Hermes turn: Hermes' MCP trust gate, credentials and approvals stay in charge.
      const request =
        `Call the MCP tool \`${tool}\` once${input ? ` with these arguments: ${glClip(input, 1500)}` : ''}.` +
        (goal ? ` Purpose: ${glClip(goal, 300)}.` : '') +
        ' Use no other tools unless that call needs a required value you can look up. Reply with a short plain summary of its result.'

      return CLIENT_TOOLS.ask_hermes({ request, thread_id: args.thread_id, where: args.where }, item)
    },

    async agents_overview() {
      const roster = await env.rpc('profiles.list', { include_sessions: true }, 15000)
      const nowS = glNow() / 1000
      const ago = ts => (ts ? Math.max(0, Math.round((nowS - ts) / 60)) : null)
      const profiles = ((roster && roster.profiles) || []).slice(0, 24).map(p => {
        const bot = p.canonical_session
        const worker = p.worker_session

        return {
          profile: p.name,
          name: p.display_name || p.name,
          default: Boolean(p.is_default),
          description: glClip(p.description || '', 200) || undefined,
          model: p.model || 'not set',
          provider: p.provider || 'not set',
          skills: p.skill_count || 0,
          bot_chat: bot ? { latest: glClip(bot.preview || '', 160), last_active_min_ago: ago(bot.last_active) } : undefined,
          last_chat: !bot && p.last_session ? { title: glClip(p.last_session.title || '', 80), last_active_min_ago: ago(p.last_session.last_active) } : undefined,
          working_on: worker ? glClip(worker.title || worker.source || 'a background job', 100) : undefined
        }
      })

      return { count: profiles.length, profiles }
    },

    async ask_hermes(args, item) {
      const request = glSquash(args.request)

      if (!request) {
        return { error: 'request is empty' }
      }

      if (glSecretRequest(request)) {
        return GL_SECRET_REFUSAL
      }

      const previous = state.delegation
      if (previous && previous.status === 'working' && !args.thread_id) {
        // Never interrupt or pile on: a running job is only changed by a steer the user asked for.
        return {
          status: 'busy',
          working_on: glClip(previous.request, 160),
          note: routeOf('message_thread')
            ? `Nothing was sent and the running job continues. If this changes that job, call message_thread with no thread_id. If it is separate, tell the user ${state.agentName} is busy and offer to do it next.`
            : `Nothing was sent and the running job continues. Tell the user ${state.agentName} is busy and offer to do it next.`
        }
      }

      const target = await taskTarget(args, previous)

      if (target.sessionId) {
        const live = await env.rpc('session.active_list', {}, 10000).catch(() => null)
        const row = ((live && live.sessions) || []).find(s => s.id === target.sessionId)

        if (row && GL_BUSY_STATUSES[row.status]) {
          return {
            status: 'busy',
            note: 'That chat is in the middle of other work. Ask the user whether to steer it with this request (message_thread mode steer), stop it first, or wait.'
          }
        }
      }

      const sessionId = await submitToHermes(target.sessionId, request, target.viaComposer, target.fresh)
      const delegation = { id: `d${(seq += 1)}`, request, sessionId, status: 'working', lastTool: '', partial: '', result: '', startedAt: glNow(), toolCount: 0 }
      set({ delegation })

      if (sessionId) {
        startTracking(delegation)
      }

      item.detail = glClip(request, 140)

      return { status: 'started', note: `${state.agentName} is working on it in the background. Its result will arrive as a [Hermes update] message; keep talking with the user meanwhile.` }
    },

    async check_hermes() {
      const d = state.delegation
      if (!d) {
        return { status: 'idle', note: 'Nothing has been delegated in this call.' }
      }

      return {
        status: d.status,
        request: glClip(d.request, 200),
        seconds_running: Math.round(((d.finishedAt || glNow()) - d.startedAt) / 1000),
        current_tool: d.lastTool || null,
        tools_used: d.toolCount || 0,
        partial_answer: d.status === 'working' ? glClip(glPlain(d.partial), 600) : undefined,
        result: d.status !== 'working' ? d.result : undefined
      }
    },

    async cancel_hermes() {
      const d = state.delegation
      if (!d || d.status !== 'working') {
        return { status: 'nothing to cancel' }
      }

      const response = await env.rpc('session.interrupt', { session_id: d.sessionId }, 10000)
      d.status = 'failed'
      d.result = 'Stopped by the user.'
      stopTracking()
      emit()

      return { status: response && response.interrupted === false ? 'was not running' : 'stopped' }
    },

    list_threads: listThreads,
    read_thread: readThread,

    async message_thread(args) {
      const message = glSquash(args.message)

      if (glSecretRequest(message)) {
        return GL_SECRET_REFUSAL
      }

      if (state.delegation && state.delegation.approval && GL_APPROVAL_WORDS.test(message)) {
        return { status: 'not_sent', note: 'Messages cannot answer an approval. Nothing was sent. Tell the user to answer it themselves.' }
      }

      const job = state.delegation && state.delegation.status === 'working' ? state.delegation : null
      const sessionId = args.thread_id ? await liveIdFor(args.thread_id) : job && job.sessionId

      if (!sessionId) {
        return { error: args.thread_id ? 'That thread is not running in this app, so it cannot be messaged from here.' : 'Nothing was sent, because Hermes is not working on anything for this call. For a follow-up to its last answer, call ask_hermes with where last_task.' }
      }
      if (!message) {
        return { error: 'message is empty' }
      }

      const live = await env.rpc('session.active_list', {}, 10000).catch(() => null)
      const row = ((live && live.sessions) || []).find(s => s.id === sessionId)
      const running = row ? Boolean(GL_BUSY_STATUSES[row.status]) : false
      const mode = args.mode || 'auto'

      if ((mode === 'steer' || mode === 'auto') && running) {
        const response = await env.rpc('session.steer', { session_id: sessionId, text: message }, 15000)

        return { delivered_as: 'steer', status: response && response.status }
      }

      if (mode === 'steer') {
        return { error: 'That thread is idle, so there is no running turn to steer. Use new_turn instead.' }
      }

      await env.rpc('prompt.submit', { session_id: sessionId, text: message }, 30000)

      return { delivered_as: 'new_turn', status: 'started' }
    },

    async stop_thread(args) {
      const sessionId = await liveIdFor(args.thread_id)
      if (!sessionId) {
        return { error: 'That thread is not running in this app.' }
      }

      const response = await env.rpc('session.interrupt', { session_id: sessionId }, 10000)

      return { status: response && response.status }
    },

    async list_subagents(args) {
      const sessionId = await liveIdFor(args.thread_id)
      if (!sessionId) {
        return { error: 'That thread is not running in this app.' }
      }

      const roster = await env.rpc('subagent.list', { session_id: sessionId }, 10000)
      const subagents = ((roster && roster.subagents) || []).slice(0, 8)
      const detailed = []

      for (const child of subagents) {
        const row = {
          subagent_id: child.subagent_id || child.id,
          goal: glClip(child.goal || child.title || '', 200),
          status: child.status,
          last_tool: child.last_tool || null
        }

        if (detailed.length < 3 && row.subagent_id && !GL_TERMINAL_STATUSES[String(child.status || '')]) {
          try {
            const tail = await env.rpc('subagent.tail', { session_id: sessionId, subagent_id: row.subagent_id }, 10000)
            if (tail && tail.available) {
              row.latest_output = glClip(glPlain(String(tail.text || '').slice(-1200)), 600)
            }
          } catch {
            // tail is best-effort
          }
        }

        detailed.push(row)
      }

      return { thread_id: args.thread_id || sessionId, subagents: detailed, count: subagents.length }
    },

    async steer_subagent(args) {
      if (glSecretRequest(args.message || args.guidance || args.text)) {
        return GL_SECRET_REFUSAL
      }
      const sessionId = await liveIdFor(args.thread_id)
      const response = await env.rpc('subagent.steer', { session_id: sessionId, subagent_id: String(args.subagent_id || ''), text: glSquash(args.message) }, 15000)

      return { status: response && response.status }
    },

    async end_call() {
      endAfterTurn = true
      endRequestedAt = glNow()
      window.setTimeout(() => {
        if (endAfterTurn) {
          void stop('goodbye')
        }
      }, 9000)

      return { status: 'ending after your goodbye' }
    },

    async pause_listening(args) {
      const seconds = Math.max(5, Math.min(Number(args.seconds) || 60, 600))
      setMuted(true)
      state.pausedUntil = glNow() + seconds * 1000
      if (pauseTimer) {
        window.clearTimeout(pauseTimer)
      }
      pauseTimer = window.setTimeout(() => {
        state.pausedUntil = 0
        setMuted(false)
      }, seconds * 1000)

      return { status: `microphone paused for ${seconds} seconds` }
    },

    async switch_persona(args) {
      pendingSwap = { persona: String(args.persona || ''), voice: state.voice }

      return { status: 'switching after this reply' }
    },

    async change_voice(args) {
      pendingSwap = { persona: state.persona, voice: String(args.voice || '') }

      return { status: 'switching after this reply' }
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────────────────────

  function fail(message) {
    ending = true
    stopTracking()
    teardown()
    dropApproval()
    set({ phase: 'error', error: message, modelSpeaking: false, userSpeaking: false })
  }

  function teardown() {
    stopMic()
    flushPlayback()

    if (ws) {
      try {
        ws.close(1000, 'call ended')
      } catch {
        // ignore
      }
      ws = null
    }

    if (outCtx) {
      outCtx.close().catch(() => undefined)
      outCtx = outGain = outAnalyser = null
    }

    if (noticeTimer) {
      window.clearTimeout(noticeTimer)
      noticeTimer = 0
    }

    if (pauseTimer) {
      window.clearTimeout(pauseTimer)
      pauseTimer = 0
    }
  }

  async function start(options) {
    if (state.phase === 'connecting' || state.phase === 'live' || state.phase === 'reconnecting') {
      return
    }

    ending = false
    reconnectAttempts = 0
    resumeHandle = ''
    pendingSwap = null
    endAfterTurn = false
    endRequestedAt = 0
    goodbyeNudged = false
    quotaStep = 0
    noSearch = false
    pendingNotices.length = 0
    set({
      phase: 'connecting',
      error: '',
      muted: false,
      pausedUntil: 0,
      startedAt: glNow(),
      transcript: [],
      activity: [],
      delegation: null,
      model: (options && options.model) || '',
      voice: (options && options.voice) || '',
      persona: (options && options.persona) || ''
    })

    try {
      // The mic prompt and the AudioContexts need the click's user activation: start them first.
      ensureOutput()
      await outCtx.resume()
      await startMic()
      const [context] = await Promise.all([
        env.chatContext ? env.chatContext().catch(() => ({})) : {},
        loadMcpCatalog(true)
          .then(servers => {
            mcpBrief = servers
              .filter(s => s.tools.length)
              .slice(0, 12)
              .map(s => ({ server: s.server, tools: s.tools.slice(0, 30).map(t => t.name) }))
          })
          .catch(error => log('warn', `MCP catalog unavailable: ${(error && error.message) || error}`))
      ])
      freshContext = context
      await connect({ ...(options || {}), context })
      set({ phase: 'live' })
    } catch (error) {
      if (/quota/i.test(String(error && error.message)) && recoverFromQuota()) {
        return
      }
      const message =
        error && error.name === 'NotAllowedError'
          ? 'Microphone access was denied. Allow it in your system settings and try again.'
          : (error && error.message) || String(error)
      fail(message)
    }
  }

  async function stop() {
    if (state.phase === 'idle') {
      return
    }

    ending = true
    set({ phase: 'ending' })
    stopTracking()
    teardown()
    dropApproval()
    set({ phase: 'idle', modelSpeaking: false, userSpeaking: false })
  }

  function setMuted(muted) {
    const next = Boolean(muted)

    if (next && !state.muted) {
      send({ realtimeInput: { audioStreamEnd: true } })
    }

    if (!next) {
      state.pausedUntil = 0
    }

    set({ muted: next })
  }

  function switchPersona(persona) {
    if (state.phase !== 'live') {
      set({ persona })

      return
    }

    void reconnect('swap', { persona, voice: state.voice })
  }

  function switchVoice(voice) {
    if (state.phase !== 'live') {
      set({ voice })

      return
    }

    void reconnect('swap', { persona: state.persona, voice })
  }

  function sendText(text) {
    const clean = glSquash(text)

    if (!clean || state.phase !== 'live') {
      return false
    }

    addTranscript('user', clean, true)

    nudged = false

    return send({ realtimeInput: { text: clean } })
  }

  function subscribe(fn) {
    listeners.add(fn)
    fn(snapshot())

    return () => listeners.delete(fn)
  }

  return {
    start,
    stop,
    setMuted,
    toggleMute: () => setMuted(!state.muted),
    switchPersona,
    switchVoice,
    sendText,
    subscribe,
    snapshot,
    levels,
    visual,
    cancelHermes: () => CLIENT_TOOLS.cancel_hermes(),
    answerApproval,
    _test: { syncApproval, listenForApproval, handleFrame, runTool, CLIENT_TOOLS, threadIndex, state, queueNotice, flushNotices, finishDelegation }
  }
}
