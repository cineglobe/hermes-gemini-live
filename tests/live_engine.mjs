// Live end-to-end check against the real Gemini Live API (costs a few cents of audio).
//
//   GLIVE_LIVE=1 GLIVE_HOME=/path/to/hermes_home [GLIVE_MODEL=id] node tests/engine.test.mjs
//
// The token is minted by the real Python backend (glive_core.create_session) under GLIVE_HOME,
// using that profile's key. Hermes itself is faked at the gateway boundary; no server is started.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { NativeWebSocket, installBrowserFakes, loadEngine } from './fakes.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function runtime() {
  const cmd = JSON.parse(execFileSync('hermes', ['--print-runtime-command'], { encoding: 'utf8' }))
  const agentRoot = /sys\.path\.insert\(0, '([^']+)'/.exec(cmd.at(-1))[1]

  return { python: cmd[0], agentRoot }
}

function backend(fn, payload) {
  const { python, agentRoot } = runtime()
  const code = `
import json, sys
sys.path.insert(0, ${JSON.stringify(agentRoot)}); import hermes_bootstrap
sys.path.insert(0, ${JSON.stringify(root)})
from pathlib import Path
from agent.secret_scope import build_profile_secret_scope, set_secret_scope
import os
home = Path(os.environ["HERMES_HOME"])
set_secret_scope(build_profile_secret_scope(home), profile_home=str(home))
import glive_core as c
p = json.loads(sys.stdin.read())
out = c.create_session(p) if ${JSON.stringify(fn)} == "session" else c.run_server_tool(p["name"], p.get("args") or {})
print(json.dumps(out))
`
  const env = { ...process.env, HERMES_HOME: process.env.GLIVE_HOME }
  delete env.GEMINI_LIVE_API_KEY
  delete env.GOOGLE_API_KEY
  delete env.GEMINI_API_KEY

  return JSON.parse(execFileSync(python, ['-I', '-c', code], { input: JSON.stringify(payload), env, encoding: 'utf8' }))
}

const wait = async (pred, ms, label) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`timed out waiting for ${label}`)
}

export async function runLive() {
  assert.ok(process.env.GLIVE_HOME, 'set GLIVE_HOME to a Hermes home with a Gemini key')
  const NodeWS = NativeWebSocket
  assert.ok(NodeWS, 'Node 22+ (global WebSocket) is required for the live test')
  const Ctx = installBrowserFakes()
  globalThis.WebSocket = class extends NodeWS {
    constructor(url) {
      super(url)
      if (process.env.GLIVE_DEBUG) {
        this.addEventListener('message', async e => {
          const text = typeof e.data === 'string' ? e.data : Buffer.from(await (e.data.arrayBuffer ? e.data.arrayBuffer() : e.data)).toString()
          console.log('  <<', text.replace(/"data":"[^"]{40,}"/g, '"data":"…"').slice(0, 300))
        })
        this.addEventListener('close', e => console.log('  close', e.code, e.reason))
      }
    }
    send(d) {
      if (process.env.GLIVE_DEBUG) console.log('  >>', String(d).replace(/"data":"[^"]{40,}"/g, '"data":"…"').slice(0, 200))
      super.send(d)
    }
  }
  const { createGeminiLiveEngine } = loadEngine()
  const rpcCalls = []
  const engine = createGeminiLiveEngine({
    rest: async (path, opts) => {
      if (path === '/session') return backend('session', opts.body)
      if (path === '/tool') return { ok: true, result: backend('tool', opts.body) }
      throw new Error(path)
    },
    rpc: async (method, params) => {
      rpcCalls.push(method)
      if (method === 'session.active_list') {
        return { sessions: [{ id: 'live-9', session_key: 's9', title: 'Quarterly report draft', status: 'working', preview: 'writing section 3', last_active: Date.now() / 1000 }] }
      }
      if (method === 'session.list') return { sessions: [] }
      if (method === 'profiles.list') return { profiles: [] }
      throw new Error(method)
    },
    onEvent: () => () => {},
    focus: () => ({ sessionId: '' }),
    chatContext: async () => ({})
  })

  let failed = 0
  const check = async (name, fn) => {
    try {
      await fn()
      console.log(`ok   live: ${name}`)
    } catch (error) {
      failed += 1
      console.log(`FAIL live: ${name}\n     ${error && error.message}`)
    }
  }

  await check('connects with a backend-minted ephemeral token', async () => {
    await engine.start(process.env.GLIVE_MODEL ? { model: process.env.GLIVE_MODEL } : {})
    await wait(() => engine.snapshot().phase !== 'connecting', 15000, 'connect')
    await new Promise(r => setTimeout(r, 1500)) // quota/policy rejections arrive just after setup
    assert.equal(engine.snapshot().phase, 'live', engine.snapshot().error)
  })

  await check('model speaks back (real audio frames played)', async () => {
    assert.ok(engine.sendText('Say hello in three words.'))
    await wait(() => Ctx.instances.some(c => c.played.length > 0), 25000, 'reply audio')
  })

  await check('voice-to-tool round-trip: list_threads routed and answered', async () => {
    await wait(() => !engine.snapshot().modelSpeaking, 20000, 'reply to finish')
    const before = engine.snapshot().transcript.length
    assert.ok(engine.sendText('Which of my threads are running right now? Use the list_threads tool.'))
    await wait(() => rpcCalls.includes('session.active_list'), 25000, 'list_threads tool call')
    await wait(
      () => engine.snapshot().transcript.slice(before).some(t => t.role === 'assistant' && /quarterly|report/i.test(t.text)),
      30000,
      'spoken answer naming the thread'
    )
  })

  await check('server tool through the real backend: recall_memory', async () => {
    await wait(() => !engine.snapshot().modelSpeaking, 30000, 'previous answer to finish')
    const before = engine.snapshot().activity.length
    assert.ok(engine.sendText('Use recall_memory to look up my project codename, then tell me it.'))
    await wait(() => engine.snapshot().activity.slice(before).some(a => /memory/i.test(a.label) && a.status === 'done'), 30000, 'recall_memory')
    await wait(() => engine.snapshot().transcript.some(t => t.role === 'assistant' && /bluebird/i.test(t.text)), 30000, 'codename in the answer')
  })

  await engine.stop()
  console.log(`     transcript: ${engine.snapshot().transcript.map(t => `${t.role}: ${t.text}`).join(' | ').slice(0, 600)}`)

  return failed
}
