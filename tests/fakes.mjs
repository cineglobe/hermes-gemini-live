// Browser stand-ins for the engine tests: timers, a fake audio graph and mic, and the engine loader.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// Captured at import, before any test swaps in a fake socket.
export const NativeWebSocket = globalThis.WebSocket

export function installBrowserFakes() {
  globalThis.window = globalThis
  let clock = 0
  const start = Date.now()
  class FakeParam { constructor() { this.value = 1 } }
  class FakeNode {
    connect() {}
    disconnect() {}
  }
  class FakeCtx {
    constructor(opts = {}) {
      this.sampleRate = opts.sampleRate || 48000
      this.destination = new FakeNode()
      this.played = []
      FakeCtx.instances.push(this)
    }
    get currentTime() { return (Date.now() - start) / 1000 + clock }
    resume() { return Promise.resolve() }
    close() { return Promise.resolve() }
    createGain() { const n = new FakeNode(); n.gain = new FakeParam(); return n }
    createAnalyser() { const n = new FakeNode(); n.fftSize = 512; n.getByteTimeDomainData = d => d.fill(128); return n }
    createBuffer(_ch, length, rate) {
      const data = new Float32Array(length)
      return { duration: length / rate, getChannelData: () => data, length }
    }
    createBufferSource() {
      const ctx = this
      const node = new FakeNode()
      node.start = when => {
        ctx.played.push(node.buffer.length)
        setTimeout(() => node.onended && node.onended(), Math.max(0, (when - ctx.currentTime + node.buffer.duration) * 1000))
      }
      node.stop = () => { node.onended && node.onended() }
      return node
    }
    createMediaStreamSource() { return new FakeNode() }
    createScriptProcessor() { const n = new FakeNode(); FakeCtx.mic = n; return n }
  }
  FakeCtx.instances = []
  globalThis.AudioContext = FakeCtx
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } }
  })

  return FakeCtx
}

export function loadEngine() {
  const source = readFileSync(join(here, '..', 'src', 'engine.js'), 'utf8')

  return new Function(`${source}\nreturn { createGeminiLiveEngine, glCreateOrb, glNoticeShown, glSample, glSymbolFor, glCondense, glPlain, glPromisedAction }`)()
}

