import test from "node:test"
import assert from "node:assert/strict"
import * as THREE from "three"
import { estimateArchOrientation, inferSceneOrientation, fitOrientedBounds } from "../app/viewer/scan-orientation.mjs"
import { cameraChanged } from "../app/viewer/camera-sync.mjs"

function arch() {
  const points = []
  for (let i = 0; i <= 160; i++) for (const radius of [0, 1, 2, 3]) {
    const angle = i / 160 * Math.PI
    points.push(new THREE.Vector3(Math.cos(angle)*(30+radius), Math.sin(i*2)*.6, Math.sin(angle)*(25+radius)))
  }
  return points
}
test("complete arches retain front and upright under arbitrary rotations", () => {
  for (let i = 0; i < 20; i++) {
    const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(i*.27, i*.43, i*.19))
    const translation = new THREE.Vector3(100,-45,200)
    const up = new THREE.Vector3(0,1,0).applyQuaternion(rotation), front = new THREE.Vector3(0,0,1).applyQuaternion(rotation)
    const result = estimateArchOrientation(arch().map(p => p.applyQuaternion(rotation).add(translation)), up)
    assert.ok(result, `orientation ${i}`)
    assert.ok(result.up.dot(up) > .98)
    assert.ok(result.front.dot(front) > .95)
  }
})
test("ambiguous symmetric rings and undersized fragments use fallback", () => {
  const points = Array.from({length:360},(_,i)=>new THREE.Vector3(Math.cos(i*Math.PI/180)*30,0,Math.sin(i*Math.PI/180)*30))
  assert.equal(estimateArchOrientation(points), null)
  assert.equal(estimateArchOrientation(points.slice(0,10)), null)
})
test("scene orientation preserves every model transform and bounds fitting stays finite", () => {
  const root = new THREE.Group()
  for (const [name,y] of [["Upper",5],["Lower",-5]]) {
    const geometry = new THREE.BufferGeometry().setFromPoints(arch())
    const mesh = new THREE.Points(geometry); mesh.name = name; mesh.position.y = y; root.add(mesh)
  }
  const before = root.children.map(o=>o.position.toArray())
  const result = inferSceneOrientation(root)
  assert.ok(result); assert.ok(result.up.y > .95)
  assert.deepEqual(root.children.map(o=>o.position.toArray()), before)
  const fit = fitOrientedBounds(new THREE.Box3().setFromObject(root), result.front, result.up)
  assert.ok(fit.width>0 && fit.height>0)
})
test("camera sync detects changes and ignores stationary views and tiny jitter", () => {
  const a={matrix:[1,2,3],up:[0,1,0],target:[0,0,0],canvasSize:[800,600],zoom:1}
  assert.equal(cameraChanged(null,a),true)
  assert.equal(cameraChanged(a,structuredClone(a)),false)
  assert.equal(cameraChanged(a,{...a,zoom:1+1e-8}),false)
  assert.equal(cameraChanged(a,{...a,target:[0,1,0]}),true)
  assert.equal(cameraChanged(a,{...a,canvasSize:[1000,600]}),true)
})
