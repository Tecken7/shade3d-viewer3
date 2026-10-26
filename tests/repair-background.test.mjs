import test from 'node:test'
import assert from 'node:assert/strict'
import {Worker} from 'node:worker_threads'
import * as THREE from 'three'
import {runStepsAsync} from '../app/model-builder/cooperative-work.mjs'
import {buildCGALRepairPayloadSteps, buildCGALRepairWorkerPayload, buildCGALRepairPatchData, applyRepairPatchesToObject} from '../app/model-builder/repair-geometry.mjs'
import {finishRepairPatchAsync, applyRepairPatchesToObjectAsync} from '../app/model-builder/repair-background.mjs'

function workerFactory() {
  const entry = new URL('../app/workers/repair-geometry.worker.js', import.meta.url).href
  const worker = new Worker(`const {parentPort}=require('node:worker_threads');globalThis.self={postMessage:(data,transfer)=>parentPort.postMessage(data,transfer)};import(${JSON.stringify(entry)}).then(()=>{parentPort.on('message',data=>self.onmessage({data}));parentPort.postMessage({ready:true})});`, {eval: true})
  let ready = false, pending = []
  const adapter = {postMessage(data, transfer) {if (ready) worker.postMessage(data, transfer); else pending.push([data, transfer])}, terminate() {worker.terminate()}}
  worker.on('message', data => {if (data.ready) {ready = true; for (const args of pending) worker.postMessage(...args); pending = []} else adapter.onmessage?.({data})})
  worker.on('error', error => adapter.onerror?.(error))
  return adapter
}
function fixture() {
  const nodes = [[-2,-2,0],[2,-2,0],[2,2,0],[-2,2,0],[-1,-1,0],[1,-1,0],[1,1,0],[-1,1,0]].map(p => new THREE.Vector3(...p))
  const faces = [[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]]
  const geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(nodes.flatMap(p => p.toArray()), 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(nodes.flatMap(p => [(p.x+2)/4,(p.y+2)/4]), 2))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(nodes.flatMap(p => [.4+(p.x+2)/10,.5,.6]), 3))
  geometry.setIndex(faces.flat()); geometry.computeVertexNormals(); geometry.addGroup(0, 12, 0); geometry.addGroup(12, 12, 1)
  const mesh = new THREE.Mesh(geometry), root = new THREE.Group(); root.add(mesh)
  const context = {nodes, triangles: faces.map(nodeIds => ({childUuid: mesh.uuid, nodeIds})), sourceObject: root,
    childMeta: new Map([[mesh.uuid, {mesh, sourceToChild: new THREE.Matrix4().makeRotationX(.2)}]])}
  const hole = {id: 'hole', childUuid: mesh.uuid, nodeIds: [4,5,6,7], materialIndex: 1, points: nodes.slice(4),
    boundary: [4,5,6,7].map(nodeId => ({nodeId, normal: new THREE.Vector3(0,0,1), color: [.6,.5,.6], uv: [.2,.8]}))}
  return {context, hole, mesh}
}
function responseFor(context, hole) {
  const prepared = buildCGALRepairWorkerPayload(context, hole)
  return {sourceNodeIds: prepared.sourceNodeIds, sourceFaces: new Uint32Array(prepared.payload.faces),
    result: {positions: Float64Array.from(hole.points.flatMap(p => p.toArray())), triangles: Uint32Array.from([0,1,2,0,2,3]), origins: Int32Array.from([4,5,6,7]), fairSuccess: true, errorCode: 0}, timings: null}
}
test('CGAL input preparation yields without changing any source vertices or face IDs', async () => {
  const {context, hole} = fixture(), expected = buildCGALRepairWorkerPayload(context, hole)
  let pauses = 0
  const actual = await runStepsAsync(buildCGALRepairPayloadSteps(context, hole), {budget: 0, pause: async () => {pauses++}})
  assert.deepEqual(actual.payload, expected.payload); assert.deepEqual(actual.sourceNodeIds, expected.sourceNodeIds)
  assert(pauses > 0)
})
test('worker patch preparation preserves winding, UVs, colors and normals exactly', async () => {
  const {context, hole} = fixture(), response = responseFor(context, hole)
  const expected = buildCGALRepairPatchData(context, hole, response.result, response.sourceNodeIds)
  const actual = await finishRepairPatchAsync(hole, response, {workerFactory})
  assert.deepEqual(actual, expected)
})
test('worker geometry assembly keeps the scene responsive and produces the exact repaired scan and BVH', async () => {
  const a = fixture(), b = fixture(), response = responseFor(a.context, a.hole)
  const patch = buildCGALRepairPatchData(a.context, a.hole, response.result, response.sourceNodeIds)
  const expectedBackup = applyRepairPatchesToObject(a.context, [patch])
  const original = b.mesh.geometry, workerPatch = {...patch, childUuid: b.mesh.uuid}
  let ticks = 0
  const timer = setInterval(() => ticks++, 1)
  try {
    const pending = applyRepairPatchesToObjectAsync(b.context, [workerPatch], {workerFactory})
    assert.equal(b.mesh.geometry, original, 'visible geometry stays intact until the replacement is ready')
    const backup = await pending
    assert(ticks > 0, 'main event loop runs during normals and BVH work')
    assert.equal(backup[0].geometry, original); assert.equal(expectedBackup.length, backup.length)
    for (const name of ['position','normal','uv','color']) assert.deepEqual(b.mesh.geometry.attributes[name].array, a.mesh.geometry.attributes[name].array)
    assert.deepEqual(b.mesh.geometry.index?.array, a.mesh.geometry.index?.array)
    assert.deepEqual(b.mesh.geometry.groups, a.mesh.geometry.groups)
    assert.deepEqual(b.mesh.geometry.boundingBox, a.mesh.geometry.boundingBox)
    assert.deepEqual(b.mesh.geometry.boundingSphere, a.mesh.geometry.boundingSphere)
    const point = new THREE.Vector3(0,0,4), hitA = {}, hitB = {}
    a.mesh.geometry.boundsTree.closestPointToPoint(point, hitA); b.mesh.geometry.boundsTree.closestPointToPoint(point, hitB)
    assert.equal(hitA.distance, hitB.distance); assert.equal(hitA.faceIndex, hitB.faceIndex)
  } finally {clearInterval(timer)}
})
test('a worker failure does not change any visible geometry or discard the original colors', async () => {
  const {context, hole, mesh} = fixture(), original = mesh.geometry
  mesh.userData._originalColors = original.attributes.color.clone()
  const colors = mesh.userData._originalColors
  const fail = () => ({postMessage() {queueMicrotask(() => this.onmessage({data: {error: 'failed'}}))}, terminate() {}})
  await assert.rejects(applyRepairPatchesToObjectAsync(context, [{childUuid: hole.childUuid, triangles: [[{sourcePos: [0,0,0]}]]}], {workerFactory: fail}), /failed/)
  assert.equal(mesh.geometry, original); assert.equal(mesh.userData._originalColors, colors)
  assert(original.attributes.position.array.byteLength > 0)
})

test('failure on a later mesh does not commit an already prepared replacement', async () => {
  const a = fixture(), b = fixture(), originalA = a.mesh.geometry, originalB = b.mesh.geometry
  const patches = [a,b].map(item => {
    const response = responseFor(item.context, item.hole)
    return buildCGALRepairPatchData(item.context, item.hole, response.result, response.sourceNodeIds)
  })
  a.context.sourceObject.add(b.mesh)
  a.context.childMeta.set(b.mesh.uuid, b.context.childMeta.get(b.mesh.uuid))
  let count = 0
  const failSecond = () => ++count === 1 ? workerFactory() : {
    postMessage() {queueMicrotask(() => this.onmessage({data: {error: 'second mesh failed'}}))}, terminate() {},
  }
  await assert.rejects(applyRepairPatchesToObjectAsync(a.context, patches, {workerFactory: failSecond}), /second mesh failed/)
  assert.equal(a.mesh.geometry, originalA); assert.equal(b.mesh.geometry, originalB)
  assert(originalA.attributes.position.array.byteLength > 0); assert(originalB.attributes.position.array.byteLength > 0)
})
