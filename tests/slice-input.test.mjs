import test from "node:test"
import assert from "node:assert/strict"
import * as THREE from "three"
import { bindSliceDrawing } from "../app/viewer/slice-input.mjs"

class Element extends EventTarget {
  style = {}; attributes = new Map(); children = []; captured = null
  setAttribute(key, value) { this.attributes.set(key, String(value)) }
  getAttribute(key) { return this.attributes.get(key) ?? null }
  removeAttribute(key) { this.attributes.delete(key) }
  appendChild(child) { this.children.push(child) }
  remove() { this.removed = true }
  getBoundingClientRect() { return { left: 20, top: 30, width: 800, height: 600 } }
  setPointerCapture(id) { this.captured = id }
  hasPointerCapture(id) { return this.captured === id }
  releasePointerCapture() { this.captured = null }
  focus() {}
}
function setup(t) {
  const previous = { window: globalThis.window, document: globalThis.document }
  const window = new EventTarget()
  globalThis.window = window
  globalThis.document = { createElementNS: () => new Element() }
  const canvas = new Element(); canvas.parentElement = new Element()
  const camera = new THREE.OrthographicCamera(-40,40,30,-30,.1,1000)
  camera.position.set(0,0,100); camera.lookAt(0,0,0); camera.updateProjectionMatrix()
  const results = [], states = []
  const cleanup = bindSliceDrawing({ canvas, camera, getAnchor: () => new THREE.Vector3(), onComplete: r => results.push(r), onDrawingChange: a => states.push(a) })
  t.after(() => { cleanup(); Object.assign(globalThis, previous) })
  const send = (target, type, extra = {}) => {
    const event = new Event(type, { cancelable: true })
    Object.assign(event, { button: 0, pointerId: 7, clientX: 120, clientY: 330, ...extra })
    target.dispatchEvent(event); return event
  }
  return { canvas, window, results, states, send }
}
test("mouse drag completes on window even when released outside canvas", t => {
  const {canvas, window, results, states, send} = setup(t)
  send(canvas, "pointerdown")
  send(window, "pointermove", {clientX: 620})
  send(window, "pointerup", {clientX: 720})
  assert.equal(results.length, 1); assert.deepEqual(states, [true, false])
  assert(Math.abs(results[0].normal.y) > .999)
})
test("Shift drag is left available to camera controls", t => {
  const {canvas, window, results, states, send} = setup(t)
  const event = send(canvas, "pointerdown", {shiftKey: true})
  send(window, "pointerup", {clientX: 720})
  assert.equal(event.defaultPrevented, false); assert.deepEqual(states, []); assert.equal(results.length, 0)
})
test("click does not cut and cancelled drag permits retry", t => {
  const {canvas, window, results, send} = setup(t)
  send(canvas, "pointerdown"); send(window, "pointerup")
  send(canvas, "pointerdown"); send(window, "pointercancel")
  assert.equal(results.length, 0)
  send(canvas, "pointerdown"); send(window, "pointerup", {clientY: 500})
  assert.equal(results.length, 1)
})
test("other pointers cannot finish the current stroke", t => {
  const {canvas, window, results, send} = setup(t)
  send(canvas, "pointerdown")
  send(window, "pointerup", {pointerId: 8, clientX: 720})
  assert.equal(results.length, 0)
  send(window, "pointerup", {clientX: 720}); assert.equal(results.length, 1)
})
