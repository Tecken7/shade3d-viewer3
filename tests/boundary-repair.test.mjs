import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import {repairBaseBoundary} from '../app/model-builder/boundary-repair.mjs'
import {meshTopology,indexed} from '../app/model-builder/engine.mjs'

const vertices=[0,0,0,4,0,0,4,0,4,0,0,4,-.1,0,0,0,0,-.1]
const faces=[0,1,2,0,2,3,0,4,5]

test('tiny fan pinching the rim is removed without changing the source or retained surface',()=>{
 const source=structuredClone({vertices,faces})
 assert.throws(()=>meshTopology(vertices,faces),/větví/)
 const repaired=repairBaseBoundary(vertices,faces),topology=meshTopology(repaired.vertices,repaired.faces)
 assert.equal(repaired.removedFans,1);assert.equal(topology.loops.length,1);assert.equal(topology.nonManifold,0)
 assert.deepEqual(repaired.vertices,vertices.slice(0,12));assert.deepEqual(repaired.faces,faces.slice(0,6))
 assert.deepEqual({vertices,faces},source)
 // Disabling the repair uses the unchanged scan, including its original error.
 assert.throws(()=>meshTopology(vertices,faces),/větví/)
})

test('large branches are refused atomically rather than cutting meaningful surface',()=>{
 const large=vertices.slice();large.splice(12,6,-2,0,0,0,0,-2)
 const snapshot=large.slice()
 assert.throws(()=>repairBaseBoundary(large,faces),/větší úpravu/)
 assert.deepEqual(large,snapshot)
})

test('degenerate rim triangles and unused coordinates are excluded from repaired model bounds',()=>{
 const result=repairBaseBoundary([...vertices,100,0,0],[0,1,2,0,2,3,0,1,6])
 assert.equal(result.removedDegenerate,1);assert.equal(result.removedFans,0)
 assert.deepEqual(result.vertices,vertices.slice(0,12))
})

test('repair retains real holes and rejects non-manifold edges',()=>{
 const outer=[[-4,-4],[4,-4],[4,4],[-4,4]].map(p=>new THREE.Vector2(...p)),hole=[[-1,-1],[-1,1],[1,1],[1,-1]].map(p=>new THREE.Vector2(...p)),points=[...outer,...hole]
 const positions=THREE.ShapeUtils.triangulateShape(outer,[hole]).flatMap(t=>t.flatMap(i=>[points[i].x,0,points[i].y])),source=indexed(positions)
 const result=repairBaseBoundary(source.vertices,source.faces)
 assert.equal(meshTopology(result.vertices,result.faces).loops.length,2)
 assert.equal(result.faces.length,source.faces.length)
 assert.throws(()=>repairBaseBoundary(vertices,[0,1,2,1,0,3,0,1,5]),/větší úpravu/)
})
