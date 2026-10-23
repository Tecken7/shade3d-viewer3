import test from "node:test"
import assert from "node:assert/strict"
import { createViewerBridge, createViewerReceiver } from "../public/integrations/viewer-bridge-v1.mjs"

function fixture({ dropAck = 0, receiver = true } = {}) {
  let now = 0, next = 1, applied = [], messages = [], files = []
  const jobs = new Map()
  const setTimeout = (fn, delay = 0) => { const id = next++; jobs.set(id, { fn, at: now + delay }); return id }
  const clearTimeout = id => jobs.delete(id)
  const makeHost = origin => {
    const listeners = new Set()
    return { location: { href: origin }, crypto: { randomUUID: () => "session-1" }, setTimeout, clearTimeout,
      addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn),
      emit: event => [...listeners].forEach(fn => fn(event)) }
  }
  const parent = makeHost("https://lab.example"), child = makeHost("https://viewer.example")
  child.parent = parent
  child.postMessage = message => { messages.push(message); setTimeout(() => child.emit({ data: message, origin: "https://lab.example", source: parent })) }
  parent.postMessage = message => {
    if (message.type === "ARTHETIC_VIEWER_ACK" && dropAck-- > 0) return
    setTimeout(() => parent.emit({ data: message, origin: "https://viewer.example", source: child }))
  }
  const errors = []
  const stop = receiver ? createViewerReceiver({ host: child, apply: payload => { applied.push(payload); if (payload.files) files = payload.files }, getFiles: () => files }) : () => {}
  const bridge = createViewerBridge({ frame: { src: "https://viewer.example/?mode=live", contentWindow: child }, host: parent, onError: error => errors.push(error), delay: 10, retryMs: 100 })
  return { bridge, applied, messages, errors, stop, parent, child,
    tick(ms) { const end = now + ms; for (let count = 0; count < 10000; count++) { const job = [...jobs].filter(([,v]) => v.at <= end).sort((a,b) => a[1].at-b[1].at)[0]; if (!job) break; now = job[1].at; jobs.delete(job[0]); job[1].fn() }; now = end },
  }
}
const payload = opacity => ({ files: [{ u: "scan.ply", n: "Upper.ply", o: opacity }], keepCamera: true })

test("handshake accepts once, lost ACK retries without reapplying the scene", () => {
  const f = fixture({ dropAck: 1 }); f.bridge.update(payload(1)); f.tick(250)
  assert.equal(f.applied.length, 1)
  assert.equal(f.messages.filter(m => m.type === "SHADE3D_LIVE").length, 2)
  assert.equal(f.errors.length, 0); f.bridge.dispose(); f.stop()
})
test("slider edits coalesce; acknowledged files use patches with no lost metadata", () => {
  const f = fixture(); f.bridge.update(payload(1)); f.tick(30)
  f.bridge.update(payload(.9)); f.bridge.update(payload(.4)); f.tick(30)
  assert.equal(f.applied.length, 2)
  assert.equal(f.applied[1].files[0].o, .4)
  assert.equal(f.applied[1].files[0].n, "Upper.ply")
  assert.equal(f.messages.filter(m => m.type === "SHADE3D_LIVE").at(-1).payload.files, undefined)
  f.bridge.update(payload(.4)); f.tick(500); assert.equal(f.applied.length, 2)
  f.bridge.dispose(); f.stop()
})
test("coalescing and superseding preserve unacknowledged initial state", () => {
  const f = fixture({ dropAck: 2 })
  f.bridge.update({ ...payload(1), keepCamera: false, viewer_state: { alignment: { transforms: [1] } } })
  f.bridge.update(payload(.8)); f.tick(20)
  f.bridge.update(payload(.3)); f.tick(350)
  assert.deepEqual(f.applied.at(-1).viewer_state, { alignment: { transforms: [1] } })
  assert.equal(f.applied.at(-1).keepCamera, false)
  assert.equal(f.applied.at(-1).files[0].o, .3)
  f.bridge.dispose(); f.stop()
})
test("old viewer fallback sends once; disposal cancels pending sends", () => {
  const f = fixture({ receiver: false }); f.bridge.update(payload(1)); f.tick(500)
  assert.equal(f.messages.filter(m => m.type === "SHADE3D_LIVE").length, 1)
  f.bridge.update(payload(.4)); f.bridge.dispose(); f.tick(1000)
  assert.equal(f.messages.filter(m => m.type === "SHADE3D_LIVE").length, 1)
})
test("receiver ignores messages from other windows and origins", () => {
  const f = fixture(); f.tick(5)
  for (const overrides of [{ source: {} }, { origin: "https://other.example" }]) f.child.emit({ source: f.parent, origin: "https://lab.example", data: { type: "SHADE3D_LIVE", protocolVersion: 1, session: "session-1", sequence: 1, payload: payload(1) }, ...overrides })
  assert.equal(f.applied.length, 0); f.bridge.dispose(); f.stop()
})
test("missing acknowledgements stop after bounded retries and report failure", () => {
  const f = fixture({ dropAck: 100 }); f.bridge.update(payload(1)); f.tick(5000)
  assert.equal(f.applied.length, 1)
  assert.equal(f.messages.filter(m=>m.type === "SHADE3D_LIVE").length, 5)
  assert.equal(f.errors.length, 1)
  f.bridge.dispose(); f.stop()
})
