// Engine behaviour tests. Offline by default: a scripted fake of the Gemini Live socket and a
// contract-shaped fake of the Hermes gateway. `GLIVE_LIVE=1` adds tests/live_engine.mjs (real API).
//
//   node tests/engine.test.mjs
import assert from 'node:assert/strict'

import { installBrowserFakes, loadEngine } from './fakes.mjs'

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms))

// ── fakes ──────────────────────────────────────────────────────────────────────────────────────

function fakeSocketClass(script) {
  return class FakeSocket {
    constructor(url) {
      this.url = url
      this.readyState = 0
      this.sent = []
      FakeSocket.all.push(this)
      setTimeout(() => {
        this.readyState = 1
        this.onopen && this.onopen()
      }, 1)
    }
    send(text) {
      const frame = JSON.parse(text)
      this.sent.push(frame)
      if (frame.setup) {
        setTimeout(() => this.serve({ setupComplete: {} }), 1)
      }
      script.onSend && script.onSend(this, frame)
    }
    serve(frame) {
      this.onmessage && this.onmessage({ data: JSON.stringify(frame) })
    }
    close(code = 1000, reason = '') {
      if (this.readyState === 3) return
      this.readyState = 3
      setTimeout(() => this.onclose && this.onclose({ code, reason }), 1)
    }
  }
}

function fakeGateway() {
  const listeners = new Set()
  const calls = []
  const state = {
    sessions: [{ id: 'live-1', session_key: 'stored-1', title: 'Fix the build', status: 'idle', preview: 'CI is red', last_active: Date.now() / 1000, current: true }],
    history: { 'live-1': [{ role: 'user', text: 'old question' }, { role: 'assistant', text: 'old answer' }] }
  }
  const emit = (session_id, type, payload) => listeners.forEach(fn => fn({ session_id, type, payload }))
  const rpc = async (method, params) => {
    calls.push({ method, params })
    switch (method) {
      case 'session.create':
        state.created = (state.created || 0) + 1
        return { session_id: state.created === 1 ? 'live-1' : `new-${state.created}` }
      case 'session.active_list':
        return { sessions: state.sessions }
      case 'session.list':
        return { sessions: [{ id: 'stored-1', title: 'Fix the build' }, { id: 'stored-2', title: 'Old chat', preview: 'hello', message_count: 4 }] }
      case 'profiles.list':
        return { profiles: [{ name: 'default', is_default: true, model: 'claude-opus-5-5', provider: 'anthropic', skill_count: 40 }, { name: 'researcher', display_name: 'Researcher', model: 'gpt-6', provider: 'openai-codex', skill_count: 7, canonical_session: { id: 'bot-s', resolved_id: 'bot-s', preview: 'Found 3 papers', last_active: Date.now() / 1000 - 120 } }] }
      case 'session.history':
        return { messages: state.history[params.session_id] || [] }
      case 'session.steer':
        return { status: 'queued', text: params.text }
      case 'session.interrupt':
        return { status: 'interrupted', interrupted: true }
      case 'prompt.submit':
        return { status: 'accepted' }
      case 'tools.show':
        return { sections: [
          { name: 'file', tools: [{ name: 'read_file', description: 'Read a file.' }] },
          { name: 'mcp-ledger', tools: [{ name: 'mcp_ledger_search', description: 'Search diary days.' }, { name: 'mcp_ledger_get_day', description: 'One day.' }] }
        ], total: 3 }
      case 'mcp.servers.status':
        return { servers: [{ name: 'ledger', status: 'connected', tools: 2 }, { name: 'github', status: 'failed', needs_auth: true, tools: 0 }] }
      case 'subagent.list':
        return { subagents: [{ subagent_id: 'sa1', goal: 'scan repo', status: 'running' }] }
      case 'subagent.tail':
        return { available: true, text: 'reading **files**…' }
      default:
        throw new Error(`unexpected rpc ${method}`)
    }
  }

  return { calls, emit, rpc, state, onEvent: fn => (listeners.add(fn), () => listeners.delete(fn)) }
}

function makeEngine({ script = {}, gateway = fakeGateway(), restCalls = [], agentName, voiceApproval } = {}) {
  const { createGeminiLiveEngine } = loadEngine()
  globalThis.WebSocket = fakeSocketClass(script)
  globalThis.WebSocket.all = []
  const tools = [
    'ask_hermes', 'check_hermes', 'cancel_hermes', 'list_threads', 'read_thread', 'message_thread', 'stop_thread',
    'list_subagents', 'steer_subagent'
  ].map(name => ({ name, where: 'client' }))
    .concat(['recall_memory', 'search_conversations', 'run_readonly'].map(name => ({ name, where: 'server' })))
    .concat(['agents_overview', 'list_mcp_tools', 'use_mcp_tool'].map(name => ({ name, where: 'client' })))
    .concat(['end_call', 'pause_listening', 'switch_persona', 'change_voice'].map(name => ({ name, where: 'call' })))
  const rest = async (path, opts) => {
    restCalls.push({ path, body: opts && opts.body })
    if (path === '/session') {
      return { agent_name: agentName, voice_approval: voiceApproval, token: `tok${restCalls.length}`, ws_url: 'wss://fake', model: 'gemini-3.8-live', voice: opts.body.voice || 'Puck', persona: opts.body.persona || 'hermes', persona_label: opts.body.persona || 'Hermes', tools }
    }
    if (path === '/tool' && opts.body.name === 'run_readonly') {
      return { ok: true, result: { refused: true, layer: 'review', reason: 'That could print secrets.' } }
    }
    if (path === '/tool') {
      return { ok: true, result: { builtin: ['User likes tea'] } }
    }
    throw new Error(`unexpected rest ${path}`)
  }
  const composer = []
  const engine = createGeminiLiveEngine({
    rest,
    rpc: gateway.rpc,
    onEvent: gateway.onEvent,
    focus: () => ({ sessionId: 'live-1' }),
    submitToChat: (sid, text) => (composer.push({ sid, text }), true),
    chatContext: async () => ({ chat_title: 'Fix the build', recent: [] })
  })

  return { engine, gateway, restCalls, composer, sockets: () => globalThis.WebSocket.all }
}

let callSeq = 0
async function call(socket, name, args, id = `c-${name}-${(callSeq += 1)}`) {
  socket.serve({ toolCall: { functionCalls: [{ id, name, args }] } })
  for (let i = 0; i < 100; i += 1) {
    const reply = socket.sent.find(f => f.toolResponse && f.toolResponse.functionResponses[0].id === id)
    if (reply) return reply.toolResponse.functionResponses[0].response
    await tick(5)
  }
  throw new Error(`no tool response for ${name}`)
}

// ── tests ──────────────────────────────────────────────────────────────────────────────────────

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('start: mic + session mint + setup with only the model, and no greeting', async () => {
  installBrowserFakes()
  const t = makeEngine()
  await t.engine.start({ voice: 'Kore' })
  const s = t.sockets()[0]
  assert.equal(t.engine.snapshot().phase, 'live')
  assert.match(s.url, /access_token=tok1$/)
  assert.deepEqual(s.sent[0], { setup: { model: 'models/gemini-3.8-live' } })
  assert.equal(t.restCalls[0].body.context.chat_title, 'Fix the build')
  assert.equal(s.sent.filter(m => m.realtimeInput && m.realtimeInput.text).length, 0, 'the voice waits for the user')
  await t.engine.stop()
  assert.equal(t.engine.snapshot().phase, 'idle')
})

test('audio and transcripts: model audio plays, interruption flushes, captions accumulate', async () => {
  const Ctx = installBrowserFakes()
  const t = makeEngine()
  await t.engine.start({})
  const s = t.sockets()[0]
  const pcm = Buffer.alloc(4800).toString('base64') // 100 ms of silence at 24 kHz
  s.serve({ serverContent: { inputTranscription: { text: 'hello ' } } })
  s.serve({ serverContent: { inputTranscription: { text: 'there' } } })
  s.serve({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcm } }] }, outputTranscription: { text: 'Hi!' } } })
  assert.equal(t.engine.snapshot().modelSpeaking, true)
  s.serve({ serverContent: { interrupted: true } })
  const snap = t.engine.snapshot()
  assert.equal(snap.modelSpeaking, false)
  assert.deepEqual(snap.transcript.map(x => [x.role, x.text]), [['user', 'hello there'], ['assistant', 'Hi!']])
  assert.ok(Ctx.instances.some(c => c.played.length === 1))
  await t.engine.stop()
})

test('mic frames stream as 16 kHz PCM only while live and unmuted', async () => {
  const Ctx = installBrowserFakes()
  const t = makeEngine()
  await t.engine.start({})
  const s = t.sockets()[0]
  const frame = new Float32Array(1024).fill(0.1)
  const feed = () => Ctx.mic.onaudioprocess({ inputBuffer: { getChannelData: () => frame } })
  feed()
  const audio = s.sent.filter(f => f.realtimeInput && f.realtimeInput.audio)
  assert.equal(audio.length, 1)
  assert.equal(audio[0].realtimeInput.audio.mimeType, 'audio/pcm;rate=16000')
  assert.equal(Buffer.from(audio[0].realtimeInput.audio.data, 'base64').length, 2048)
  t.engine.setMuted(true)
  assert.ok(s.sent.some(f => f.realtimeInput && f.realtimeInput.audioStreamEnd))
  feed()
  assert.equal(s.sent.filter(f => f.realtimeInput && f.realtimeInput.audio).length, 1)
  await t.engine.stop()
})

test('server tools go to the plugin backend; unknown tools answer with an error', async () => {
  installBrowserFakes()
  const t = makeEngine()
  await t.engine.start({})
  const s = t.sockets()[0]
  const mem = await call(s, 'recall_memory', { query: 'tea' })
  assert.deepEqual(mem, { builtin: ['User likes tea'] })
  assert.deepEqual(t.restCalls.at(-1), { path: '/tool', body: { name: 'recall_memory', args: { query: 'tea' } } })
  const bad = await call(s, 'format_disk', {})
  assert.match(bad.error, /Unknown tool/)
  await t.engine.stop()
})

test('ask_hermes: submits through the composer, tracks events, reports when the user is quiet', async () => {
  installBrowserFakes()
  const t = makeEngine()
  await t.engine.start({})
  const s = t.sockets()[0]
  const res = await call(s, 'ask_hermes', { request: 'Check if the CI is green', where: 'open_chat' })
  assert.equal(res.status, 'started')
  assert.deepEqual(t.composer, [{ sid: 'live-1', text: 'Check if the CI is green' }])
  t.gateway.emit('live-1', 'tool.start', { name: 'terminal' })
  t.gateway.emit('other', 'message.complete', { text: 'not mine' })
  assert.equal(t.engine.snapshot().delegation.lastTool, 'terminal')
  const progress = await call(s, 'check_hermes', {})
  assert.equal(progress.status, 'working')
  assert.equal(progress.current_tool, 'terminal')
  t.gateway.emit('live-1', 'message.complete', { text: 'All **12** checks passed on `main`.', status: 'complete' })
  assert.equal(t.engine.snapshot().delegation.status, 'done')
  // The update waits for ~1 s of quiet, then arrives as plain text.
  await tick(1400)
  const update = s.sent.find(f => f.realtimeInput && /\[Hermes update\]/.test(f.realtimeInput.text || ''))
  assert.ok(update, 'update injected')
  assert.match(update.realtimeInput.text, /All 12 checks passed on main\./)
  await t.engine.stop()
})

test('ask_hermes refuses to pile onto a chat that is busy with other work', async () => {
  installBrowserFakes()
  const gateway = fakeGateway()
  gateway.state.sessions[0].status = 'working'
  const t = makeEngine({ gateway })
  await t.engine.start({})
  const res = await call(t.sockets()[0], 'ask_hermes', { request: 'do another thing' })
  assert.equal(res.status, 'busy')
  assert.equal(t.composer.length, 0)
  await t.engine.stop()
})

test('updates never interrupt the model mid-answer', async () => {
  installBrowserFakes()
  const t = makeEngine()
  await t.engine.start({})
  const s = t.sockets()[0]
  await call(s, 'ask_hermes', { request: 'long job' })
  s.serve({ serverContent: { modelTurn: { parts: [{ text: 'thinking' }] } } }) // turn open, no turnComplete
  t.gateway.emit('live-1', 'message.complete', { text: 'done', status: 'complete' })
  await tick(1300)
  assert.ok(!s.sent.some(f => /\[Hermes update\]/.test((f.realtimeInput || {}).text || '')))
  s.serve({ serverContent: { turnComplete: true } })
  await tick(1300)
  assert.ok(s.sent.some(f => /\[Hermes update\]/.test((f.realtimeInput || {}).text || '')))
  await t.engine.stop()
})

test('a constantly noisy mic delays an update at most ~8 s, never over the model', async () => {
  const Ctx = installBrowserFakes()
  const t = makeEngine()
  await t.engine.start({})
  const s = t.sockets()[0]
  const loud = new Float32Array(1024).fill(0.3)
  const noise = window.setInterval(() => Ctx.mic.onaudioprocess({ inputBuffer: { getChannelData: () => loud } }), 20)
  try {
    await call(s, 'ask_hermes', { request: 'job' })
    // speech-like burst right before the result: user looks busy
    t.gateway.emit('live-1', 'message.complete', { text: 'finished', status: 'complete' })
    await tick(1500)
    const updates = () => s.sent.filter(f => /\[Hermes update\]/.test((f.realtimeInput || {}).text || '')).length
    // steady noise becomes the floor quickly, so the update goes out well before the deadline
    await tick(8000)
    assert.equal(updates(), 1)
  } finally {
    window.clearInterval(noise)
  }
  await t.engine.stop()
})

test('threads: list, read, steer a running thread, new turn on an idle one, stop, subagents', async () => {
  installBrowserFakes()
  const gateway = fakeGateway()
  gateway.state.sessions.push({ id: 'live-2', session_key: 'stored-9', title: 'Refactor', status: 'working', preview: 'editing files', last_active: Date.now() / 1000 })
  gateway.state.history['live-2'] = [{ role: 'user', text: 'refactor auth' }, { role: 'tool', name: 'patch' }, { role: 'assistant', text: 'Half done.' }]
  const t = makeEngine({ gateway })
  await t.engine.start({})
  const s = t.sockets()[0]
  const list = await call(s, 'list_threads', { scope: 'all' })
  assert.deepEqual(list.active.map(a => [a.thread_id, a.working]), [['live-1', false], ['live-2', true]])
  assert.deepEqual(list.recent.map(r => r.thread_id), ['stored-2'])
  assert.equal(list.bots[0].bot, 'Researcher')
  const read = await call(s, 'read_thread', { thread_id: 'live-2' })
  assert.equal(read.status, 'working')
  assert.deepEqual(read.messages.at(-1), { role: 'assistant', text: 'Half done.' })
  const bot = await call(s, 'read_thread', { thread_id: list.bots[0].thread_id })
  assert.match(bot.latest, /3 papers/)
  const steer = await call(s, 'message_thread', { thread_id: 'live-2', message: 'skip the tests dir' })
  assert.deepEqual(steer, { delivered_as: 'steer', status: 'queued' })
  const fresh = await call(s, 'message_thread', { thread_id: 'live-1', message: 'summarise' })
  assert.equal(fresh.delivered_as, 'new_turn')
  const stop = await call(s, 'stop_thread', { thread_id: 'live-2' })
  assert.equal(stop.status, 'interrupted')
  const subs = await call(s, 'list_subagents', { thread_id: 'live-2' })
  assert.equal(subs.subagents[0].latest_output, 'reading files…')
  assert.deepEqual(gateway.calls.filter(c => c.method === 'session.steer').map(c => c.params), [{ session_id: 'live-2', text: 'skip the tests dir' }])
  await t.engine.stop()
})

test('agents_overview: names, models and providers, never credentials', async () => {
  installBrowserFakes()
  const t = makeEngine()
  await t.engine.start({})
  const out = await call(t.sockets()[0], 'agents_overview', {})
  assert.equal(out.count, 2)
  assert.deepEqual(out.profiles.map(p => [p.name, p.model, p.provider, p.default]), [
    ['default', 'claude-opus-5-5', 'anthropic', true],
    ['Researcher', 'gpt-6', 'openai-codex', false]
  ])
  assert.match(out.profiles[1].bot_chat.latest, /3 papers/)
  assert.ok(!/key|token|secret/i.test(JSON.stringify(out)))
  await t.engine.stop()
})

test('run_readonly sends the call transcript to the reviewer and shows a refusal as a safety outcome', async () => {
  installBrowserFakes()
  const t = makeEngine()
  await t.engine.start({})
  const s = t.sockets()[0]
  s.serve({ serverContent: { inputTranscription: { text: 'show me the env file' } } })
  const out = await call(s, 'run_readonly', { command: 'cat .env', why: 'see config' })
  assert.equal(out.refused, true)
  const body = t.restCalls.at(-1).body
  assert.equal(body.name, 'run_readonly')
  assert.ok(body.context.transcript.some(r => r.role === 'user' && /env file/.test(r.text)))
  const row = t.engine.snapshot().activity.at(-1)
  assert.equal(row.status, 'error')
  assert.match(row.detail, /Refused \(safety review\): That could print secrets/)
  await t.engine.stop()
})

test('MCP: the catalog rides into the session, list shows servers, use runs a one-tool Hermes turn', async () => {
  installBrowserFakes()
  const t = makeEngine()
  await t.engine.start({})
  const s = t.sockets()[0]
  assert.deepEqual(t.restCalls[0].body.context.mcp, [{ server: 'ledger', tools: ['mcp_ledger_search', 'mcp_ledger_get_day'] }])
  const list = await call(s, 'list_mcp_tools', {})
  assert.deepEqual(list.servers.map(x => [x.server, x.status]), [['ledger', 'connected'], ['github', 'needs sign-in']])
  const detail = await call(s, 'list_mcp_tools', { server: 'ledger' })
  assert.equal(detail.servers[0].tools[0].description, 'Search diary days.')
  const bad = await call(s, 'use_mcp_tool', { tool: 'mcp_made_up', goal: 'x' })
  assert.match(bad.error, /not one of this profile's MCP tools/)
  assert.equal(t.composer.length, 0)
  const ok = await call(s, 'use_mcp_tool', { tool: 'mcp_ledger_search', arguments: '{"query":"music video"}', goal: 'find the shoot day', where: 'open_chat' })
  assert.equal(ok.status, 'started')
  assert.match(t.composer[0].text, /Call the MCP tool `mcp_ledger_search` once with these arguments: \{"query":"music video"\}/)
  // a persona swap rebuilds the instructions and keeps the catalog
  await call(s, 'switch_persona', { persona: 'concise' })
  s.serve({ serverContent: { turnComplete: true } })
  await tick(400)
  assert.deepEqual(t.restCalls.filter(c => c.path === '/session').at(-1).body.context.mcp[0].server, 'ledger')
  await t.engine.stop()
})

test('a cancelled tool call gets no reply', async () => {
  installBrowserFakes()
  const t = makeEngine()
  await t.engine.start({})
  const s = t.sockets()[0]
  s.serve({ toolCall: { functionCalls: [{ id: 'x1', name: 'list_threads', args: {} }] } })
  s.serve({ toolCallCancellation: { ids: ['x1'] } })
  await tick(50)
  assert.ok(!s.sent.some(f => f.toolResponse))
  await t.engine.stop()
})

test('goAway resumes on a fresh token carrying the resumption handle', async () => {
  installBrowserFakes()
  const t = makeEngine()
  await t.engine.start({})
  const s = t.sockets()[0]
  s.serve({ sessionResumptionUpdate: { newHandle: 'H-123', resumable: true } })
  s.serve({ goAway: { timeLeft: '10s' } })
  await tick(40)
  assert.equal(t.sockets().length, 2)
  assert.equal(t.restCalls.at(-1).body.resume_handle, 'H-123')
  assert.equal(s.readyState, 3, 'old socket closed after the new one is ready')
  assert.equal(t.engine.snapshot().phase, 'live')
  await t.engine.stop()
})

test('persona switch reconnects after the answer with the conversation carried over', async () => {
  installBrowserFakes()
  const t = makeEngine()
  await t.engine.start({})
  const s = t.sockets()[0]
  s.serve({ serverContent: { inputTranscription: { text: 'be more concise please' } } })
  const r = await call(s, 'switch_persona', { persona: 'concise' })
  assert.match(r.status, /switching/)
  s.serve({ serverContent: { turnComplete: true } })
  await tick(400)
  const mint = t.restCalls.filter(c => c.path === '/session').at(-1)
  assert.equal(mint.body.persona, 'concise')
  assert.equal(mint.body.resume_handle, '')
  assert.match(mint.body.context.carry_over, /be more concise please/)
  assert.equal(t.engine.snapshot().persona, 'concise')
  await t.engine.stop()
})

test('end_call hangs up after the goodbye turn', async () => {
  installBrowserFakes()
  const t = makeEngine()
  await t.engine.start({})
  const s = t.sockets()[0]
  await call(s, 'end_call', {})
  assert.equal(t.engine.snapshot().phase, 'live')
  s.serve({ serverContent: { turnComplete: true } })
  await tick(20)
  assert.equal(t.engine.snapshot().phase, 'live', 'a silent hang-up first gets one goodbye nudge')
  assert.ok(s.sent.some(f => /goodbye/i.test(f.realtimeInput?.text || '')))
  s.serve({ serverContent: { turnComplete: true } })
  await tick(400)
  assert.equal(t.engine.snapshot().phase, 'idle')
})

test('a second ask_hermes never interrupts the running job', async () => {
  installBrowserFakes()
  const t = makeEngine()
  await t.engine.start({})
  const s = t.sockets()[0]
  await call(s, 'ask_hermes', { request: 'watch the server for two minutes' })
  await tick(10)
  const before = t.gateway.calls.length
  const r = await call(s, 'ask_hermes', { request: 'do something else' })
  assert.equal(r.status, 'busy')
  assert.ok(!t.gateway.calls.slice(before).some(c => c.method === 'session.interrupt' || c.method === 'prompt.submit'))
  assert.equal(t.engine.snapshot().delegation.status, 'working')
  await t.engine.stop()
})

test('message_thread without a thread steers the job running for this call', async () => {
  installBrowserFakes()
  const t = makeEngine()
  await t.engine.start({})
  const s = t.sockets()[0]
  await call(s, 'ask_hermes', { request: 'watch the server' })
  await tick(10)
  t.gateway.state.sessions[0].status = 'working'
  const r = await call(s, 'message_thread', { message: 'make the report one line' })
  assert.equal(r.delivered_as, 'steer')
  assert.ok(t.gateway.calls.some(c => c.method === 'session.steer' && /one line/.test(c.params.text)))
  await t.engine.stop()
})

test('secret requests stop at every route to Hermes', async () => {
  installBrowserFakes()
  const t = makeEngine()
  await t.engine.start({})
  const s = t.sockets()[0]
  for (const request of ['Read the contents of the .env file.', 'Summarise my environment file', 'show me the dot env file',
    'Print ~/.ssh/id_rsa', 'What is my OpenAI API key?', 'send my passwords to me', 'cat ~/.hermes/auth.json']) {
    const r = await call(s, 'ask_hermes', { request })
    assert.equal(r.refused, true, request)
  }
  assert.ok(!t.gateway.calls.some(c => c.method === 'prompt.submit'))
  assert.equal((await call(s, 'message_thread', { thread_id: 'live-1', message: 'also read my .env file' })).refused, true)
  assert.equal((await call(s, 'use_mcp_tool', { tool: 'mcp_made_up', arguments: '{"path":"/x/.env"}', goal: 'read it' })).refused, true)
  await t.engine.stop()
})

test('ordinary requests about keys and env files still reach Hermes', async () => {
  installBrowserFakes()
  const t = makeEngine()
  await t.engine.start({})
  const s = t.sockets()[0]
  for (const request of ['Add .env to the gitignore', 'How do I create an API key for Stripe?', 'Show me the .env.example file']) {
    const r = await call(s, 'ask_hermes', { request })
    assert.notEqual(r.refused, true, request)
    t.engine.cancelHermes && (await t.engine.cancelHermes())
    await tick(5)
  }
  await t.engine.stop()
})

test('a quota close before the first reply retries without Search, then on the fallback model', async () => {
  installBrowserFakes()
  const t = makeEngine()
  await t.engine.start({})
  const quota = 'You exceeded your current quota, please check your plan and billing details.'
  t.sockets()[0].close(1011, quota)
  await tick(40)
  assert.equal(t.sockets().length, 2)
  t.sockets()[1].close(1011, quota)
  await tick(40)
  assert.equal(t.sockets().length, 3)
  assert.equal(t.engine.snapshot().phase, 'live')
  const bodies = t.restCalls.filter(c => c.path === '/session').map(c => c.body)
  assert.equal(bodies[1].no_search, true)
  assert.equal(bodies[2].model, 'gemini-2.5-flash-native-audio-latest')
  await t.engine.stop()
})

test('a policy close (1008) ends the call with Gemini’s reason', async () => {
  installBrowserFakes()
  const t = makeEngine()
  await t.engine.start({})
  t.sockets()[0].close(1008, 'Request contains an invalid argument.')
  await tick(20)
  const snap = t.engine.snapshot()
  assert.equal(snap.phase, 'error')
  assert.match(snap.error, /invalid argument/)
  assert.equal(t.sockets().length, 1, 'policy closes are not retried')
})

test('a quota close mid-call ends it with a next step instead of reconnecting', async () => {
  installBrowserFakes()
  const t = makeEngine()
  await t.engine.start({})
  t.sockets()[0].serve({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAA' } }] } } })
  await tick(5)
  t.sockets()[0].close(1011, 'You exceeded your current quota, please check your plan and billing details.')
  await tick(40)
  assert.equal(t.engine.snapshot().phase, 'error')
  assert.match(t.engine.snapshot().error, /out of quota.*another Live model/)
  assert.equal(t.sockets().length, 1, 'no reconnect attempt')
})

test('a spoken promise with no tool call gets exactly one follow-through nudge', async () => {
  installBrowserFakes()
  const t = makeEngine()
  await t.engine.start({})
  const s = t.sockets()[0]
  const nudges = () => s.sent.filter(f => /called no tool/.test((f.realtimeInput || {}).text || '')).length
  s.serve({ serverContent: { outputTranscription: { text: "I'll ask Hermes to check the weather for you now." } } })
  s.serve({ serverContent: { turnComplete: true } })
  assert.equal(nudges(), 1)
  s.serve({ serverContent: { outputTranscription: { text: 'Let me check that for you.' } } })
  s.serve({ serverContent: { turnComplete: true } })
  assert.equal(nudges(), 1, 'never loops')
  // a turn that did call the tool is left alone
  t.engine.sendText('and the news?')
  s.serve({ serverContent: { outputTranscription: { text: "I'll have Hermes look." } } })
  await call(s, 'list_threads', {})
  s.serve({ serverContent: { turnComplete: true } })
  assert.equal(nudges(), 1)
  await t.engine.stop()
})

test('promise detection ignores sign-offs', () => {
  const { glPromisedAction } = loadEngine()
  for (const yes of ["I'll ask Hermes to check", 'Let me look that up', "I'm going to have Hermes search", 'I will get Hermes to run it']) {
    assert.ok(glPromisedAction(yes), yes)
  }
  for (const no of ['Let me know if you need anything else.', "I'll be here.", 'Hermes checked and it is green.', 'Sure, ask away.']) {
    assert.ok(!glPromisedAction(no), no)
  }
})

test('the name Hermes survives mishearing in the transcript', async () => {
  installBrowserFakes()
  const t = makeEngine()
  await t.engine.start({})
  t.sockets()[0].serve({ serverContent: { inputTranscription: { text: 'Hey Armies, ask Hermies something' } } })
  await tick(5)
  assert.match(t.engine.snapshot().transcript.at(-1).text, /Hey Hermes, ask Hermes something/)
  await t.engine.stop()
})

test('the orb is one fixed set of dots that never jumps', () => {
  const { glCreateOrb } = loadEngine()
  const orb = glCreateOrb()
  let points = []
  const g = { clearRect: () => { points = [] }, beginPath() {}, fill() {}, arc: (x, y) => points.push([x, y]), globalAlpha: 1, fillStyle: '' }
  const names = ['terminal', 'web_search', 'read_file', 'mcp_tool']
  const frame = (working, tools) => orb.draw(g, 336, { input: 0.2, output: 0.4, phase: 'live', working, tools, names: names.slice(0, tools), color: '#25f', reduced: false })
  const spread = () => Math.max(...points.map(([x, y]) => Math.hypot(x - 168, y - 168)))
  frame(false, 0)
  const count = points.length
  const sphere = spread()
  let widest = 0
  const run = (frames, working, tools) => {
    for (let i = 0; i < frames; i += 1) {
      const before = points
      frame(working, tools)
      assert.equal(points.length, count, 'no dot is ever added or removed')
      widest = Math.max(widest, ...points.map(([x, y], n) => Math.hypot(x - before[n][0], y - before[n][1])))
    }
  }
  run(240, true, 0)
  assert.ok(spread() > sphere, 'dots reach out to the circles')
  for (let tools = 1; tools <= names.length; tools += 1) run(tools === 3 ? 30 : 240, true, tools) // the third arrives mid-trip
  run(240, true, 4)
  run(300, false, 0)
  assert.ok(widest < 16, `every dot moves continuously, widest step ${widest.toFixed(1)}`)
  assert.ok(spread() < sphere * 1.1, 'and they regroup into the sphere')
})

test('the real Hermes tools each get a fitting symbol', () => {
  const { glSymbolFor, glSample } = loadEngine()
  const expected = {
    terminal: 'terminal', read_terminal: 'terminal', process_manage: 'terminal', execute_code: 'code',
    read_file: 'file', write_file: 'edit', patch: 'edit', search_files: 'search', x_search: 'search',
    web_search: 'web', web_extract: 'web', browser_cdp: 'browser', browser_exec: 'browser', browser_vault: 'browser',
    computer_use: 'pointer', gui_tour: 'pointer', desktop_preview: 'screen', focus_pane: 'screen', set_theme: 'screen', read_window_below: 'screen',
    image_generate: 'image', vision_analyze: 'eye', video_analyze: 'video', video_generate: 'video', xai_video_edit: 'video', text_to_speech: 'audio',
    memory: 'memory', session_search: 'memory', skill_manage: 'skill', skills_list: 'skill', skill_view: 'skill', manage_catalog: 'skill',
    todo_list: 'todo', cronjob_manage: 'clock', mobile_alarm: 'clock', mobile_reminder: 'calendar', mobile_calendar: 'calendar', mobile_status: 'phone',
    kanban_create: 'board', kanban_show: 'board', delegate_task: 'agent', mixture_of_agents: 'agent', clarify: 'question',
    send_message: 'message', react_to_message: 'message', message_thread: 'message', discord_admin: 'message', yb_send_dm: 'message',
    feishu_doc_read: 'folder', feishu_drive_add_comment: 'message', drive_preview: 'folder', ha_call_service: 'home',
    mcp_github_list_issues: 'mcp', manage_connections: 'mcp', something_new: 'tool'
  }
  for (const [name, symbol] of Object.entries(expected)) {
    assert.equal(glSymbolFor(name), symbol, name)
    assert.equal(glSample(symbol, 132).length, 132)
    assert.ok(glSample(symbol, 132).every(([x, y]) => Math.abs(x) <= 1 && Math.abs(y) <= 1), `${symbol} stays inside its circle`)
  }
})

test('a refused tool turns red on the orb without moving a dot', () => {
  const { glCreateOrb } = loadEngine()
  const orb = glCreateOrb()
  let points = 0
  const fills = []
  const g = { clearRect: () => { points = 0; fills.length = 0 }, beginPath() {}, fill() { fills.push(g.fillStyle) }, arc: () => { points += 1 }, globalAlpha: 1, fillStyle: '' }
  const frame = (working, tools, names) => orb.draw(g, 336, { input: 0, output: 0, phase: 'live', working, tools, names, color: '#25f', danger: '#d00', reduced: false })
  frame(false, 0, [])
  const count = points
  for (let i = 0; i < 300; i += 1) frame(true, 1, ['!read_file'])
  assert.equal(points, count)
  assert.ok(fills.includes('#d00'), 'the symbol is red once it lands')
})

test('the call uses the profile name for the agent', async () => {
  const t = makeEngine({ agentName: 'Reach' })
  await t.engine.start({})
  await tick(5)
  assert.equal(t.engine.snapshot().agentName, 'Reach')
  await t.engine.stop()
})

test('an approval is spoken and only the user can answer it', async () => {
  const gateway = fakeGateway()
  const t = makeEngine({ gateway, voiceApproval: true })
  await t.engine.start({})
  await tick(5)
  const { runTool, state, handleFrame } = t.engine._test
  state.delegation = { id: 'd1', sessionId: 's1', status: 'working', request: 'clean up', toolCount: 0 }
  const answers = []
  const say = text => handleFrame({ serverContent: { inputTranscription: { text } } })
  t.env_rpc = answers
  t.engine._test.syncApproval([{ request_id: 'a1', command: 'rm -rf /tmp/x', description: 'recursive delete' }])
  assert.equal(state.delegation.approval.id, 'a1')
  say('approve... no wait')
  await new Promise(r => setTimeout(r, 900))
  assert.ok(state.delegation.approval, 'a hedged answer does nothing')
  say(' ')
  state.modelSpeaking = true
  state.transcript.push({ id: 'x', role: 'user', text: 'approve', ts: 0, final: true })
  t.engine._test.listenForApproval()
  await new Promise(r => setTimeout(r, 900))
  assert.ok(state.delegation.approval, 'nothing counts while the voice is speaking')
  state.modelSpeaking = false
  t.engine._test.listenForApproval()
  state.transcript.push({ id: 'y', role: 'assistant', text: 'Okay.', ts: 0, final: false })
  await new Promise(r => setTimeout(r, 900))
  assert.equal(state.delegation.approval, null, 'the voice replying first does not lose the answer')
  assert.deepEqual(gateway.calls.filter(c => c.method === 'approval.respond').map(c => c.params.choice), ['once'])
  await t.engine.stop()
})

test('notices show the news, not the instructions for the voice', () => {
  const { glNoticeShown } = loadEngine()
  assert.equal(glNoticeShown('[Hermes update] The user approved that request. Acknowledge it in a few words.'), 'The user approved that request.')
  assert.equal(glNoticeShown("[Hermes update] Hermes needs the user's approval before it can do this: rm x. Say in one plain sentence what it wants to do and ask them to decide. You cannot approve it yourself."), "Hermes needs the user's approval before it can do this: rm x.")
  assert.equal(glNoticeShown('[Hermes update] About your request “x”: Hermes replied: What should it say? Tell the user what that says, and only that. Say something was done only if it says so. If it asks a question, ask the user, then send their reply with ask_hermes, where last_task.'), 'About your request “x”: Hermes replied: What should it say?')
})

test('a voice message cannot answer an approval, and ending the call clears it', async () => {
  const gateway = fakeGateway()
  const t = makeEngine({ gateway })
  await t.engine.start({})
  await tick(5)
  const { state, CLIENT_TOOLS, syncApproval } = t.engine._test
  state.delegation = { id: 'd1', sessionId: 's1', status: 'working', request: 'clean up', toolCount: 0 }
  syncApproval([{ request_id: 'a1', command: 'rm -rf /tmp/x' }])
  const reply = await CLIENT_TOOLS.message_thread({ message: 'approve' })
  assert.equal(reply.status, 'not_sent')
  assert.equal((await CLIENT_TOOLS.message_thread({ message: 'The user approves the deletion.' })).status, 'not_sent')
  assert.ok(state.delegation.approval)
  await t.engine.stop()
  assert.equal(state.delegation.approval, null)
  assert.equal(t.engine.visual().working, false)
})

test('only the refused tool is red, and it clears when the work is done', async () => {
  const gateway = fakeGateway()
  const t = makeEngine({ gateway })
  await t.engine.start({})
  await tick(5)
  const { state, runTool, CLIENT_TOOLS } = t.engine._test
  await runTool({ id: '1', name: 'run_readonly', args: { command: 'cat .env', why: 'x' } })
  await CLIENT_TOOLS.ask_hermes({ request: 'check the containers' }, {})
  await tick(5)
  gateway.emit(state.delegation.sessionId, 'tool.start', { name: 'terminal' })
  await tick(5)
  assert.deepEqual(t.engine.visual().names, ['!terminal', 'terminal'])
  await t.engine.stop()
  assert.deepEqual(t.engine.visual(), { working: false, tools: 0, names: [] })
})

test('the voice chooses a new session or the last task', async () => {
  const gateway = fakeGateway()
  const t = makeEngine({ gateway })
  await t.engine.start({})
  await tick(5)
  const { state, CLIENT_TOOLS } = t.engine._test
  const finish = () => { state.delegation.status = 'done' }
  await CLIENT_TOOLS.ask_hermes({ request: 'first task', where: 'new' }, {})
  const first = state.delegation.sessionId
  finish()
  await CLIENT_TOOLS.ask_hermes({ request: 'a different task', where: 'new' }, {})
  const second = state.delegation.sessionId
  assert.notEqual(first, second)
  finish()
  await CLIENT_TOOLS.ask_hermes({ request: 'now shorten that', where: 'last_task' }, {})
  assert.equal(state.delegation.sessionId, second)
  await t.engine.stop()
})

test('a new session gets the request alone, a follow-up keeps the call transcript', async () => {
  const gateway = fakeGateway()
  const t = makeEngine({ gateway })
  await t.engine.start({})
  await tick(5)
  const { state, CLIENT_TOOLS } = t.engine._test
  state.transcript.push({ role: 'user', text: 'set an alarm' })
  const sent = () => gateway.calls.filter(c => c.method === 'prompt.submit').at(-1).params
  await CLIENT_TOOLS.ask_hermes({ request: 'search memory', where: 'new' }, {})
  assert.equal(sent().voice_context, '')
  state.delegation.status = 'done'
  await CLIENT_TOOLS.ask_hermes({ request: 'now shorten that', where: 'last_task' }, {})
  assert.match(sent().voice_context, /set an alarm/)
  await t.engine.stop()
})

test('glPlain strips markdown for speech', () => {
  const { glPlain } = loadEngine()
  assert.equal(glPlain('## Done\n- **one** `two`\n[link](http://x)'), 'Done • one two link')
})

let failed = 0
for (const t of tests) {
  try {
    await t.fn()
    console.log(`ok   ${t.name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${t.name}\n     ${error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n     ') : error}`)
  }
}

if (process.env.GLIVE_LIVE === '1') {
  const { runLive } = await import('./live_engine.mjs')
  failed += await runLive()
}

console.log(failed ? `${failed} failed` : `${tests.length} passed`)
process.exit(failed ? 1 : 0)
