import test from 'node:test'
import assert from 'node:assert/strict'
import {Worker} from 'node:worker_threads'
import * as THREE from 'three'
import {acceleratedRaycast} from 'three-mesh-bvh'
import {ensureAnalysisPickingTree} from '../app/viewer/analysis-picking.mjs'

export function workerFactory() {
  const entry = new URL('../app/workers/repair-preflight.worker.js',import.meta.url).href
  const worker = new Worker(`const {parentPort}=require('node:worker_threads');globalThis.self={postMessage:(data,transfer)=>parentPort.postMessage(data,transfer)};import(${JSON.stringify(entry)}).then(()=>{parentPort.on('message',data=>self.onmessage({data}));parentPort.postMessage({ready:true})});`,{eval:true})
  let ready=false,pending=[]
  const adapter={postMessage(data,transfer){if(ready)worker.postMessage(data,transfer);else pending.push([data,transfer])},terminate(){worker.terminate()}}
  worker.on('message',data=>{if(data.ready){ready=true;for(const args of pending)worker.postMessage(...args);pending=[]}else adapter.onmessage?.({data})})
  worker.on('error',error=>adapter.onerror?.(error));return adapter
}
test('background picking preserves exact surface hits, face IDs, colors and distances on indexed and non-indexed scans',async()=>{
  for(const indexed of [false,true]) {
    const original=new THREE.SphereGeometry(12,70,50), geometry=indexed?original:original.toNonIndexed()
    geometry.setAttribute('_analysisDist',new THREE.Float32BufferAttribute(Float32Array.from({length:geometry.attributes.position.count},(_,i)=>i*.001),1))
    const mesh=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({side:THREE.DoubleSide}))
    mesh.rotation.set(.3,.1,.2);mesh.position.set(1,2,3);mesh.updateMatrixWorld(true)
    const snapshots=Object.fromEntries(Object.entries(geometry.attributes).map(([name,a])=>[name,a.array.slice()]))
    const indexBefore=geometry.index?.array.slice(), rays=Array.from({length:12},(_,i)=>new THREE.Raycaster(new THREE.Vector3(-8+i*1.37,-4+i*.57,40),new THREE.Vector3(0,0,-1)))
    const before=rays.map(ray=>ray.intersectObject(mesh)[0])
    let created=0
    const factory=()=>{created++;return workerFactory()}
    const a=ensureAnalysisPickingTree(geometry,{workerFactory:factory}),b=ensureAnalysisPickingTree(geometry,{workerFactory:factory})
    assert.equal(a,b);await a;assert.equal(created,1)
    mesh.raycast=acceleratedRaycast
    rays.forEach((ray,i)=>{
      ray.firstHitOnly=true
      const hit=ray.intersectObject(mesh)[0],expected=before[i]
      assert.equal(!!hit,!!expected)
      if(hit){assert(Math.abs(hit.distance-expected.distance)<1e-10);assert.equal(hit.faceIndex,expected.faceIndex);assert.deepEqual([hit.face.a,hit.face.b,hit.face.c,hit.face.materialIndex],[expected.face.a,expected.face.b,expected.face.c,expected.face.materialIndex]);assert.deepEqual(hit.face.normal.toArray(),expected.face.normal.toArray())}
    })
    for(const [name,array] of Object.entries(snapshots))assert.deepEqual(geometry.attributes[name].array,array)
    assert.deepEqual(geometry.index?.array,indexBefore)
    await ensureAnalysisPickingTree(geometry,{workerFactory:factory});assert.equal(created,1)
  }
})
test('a worker error leaves the original geometry available and allows retry',async()=>{
  const geometry=new THREE.BoxGeometry(),positions=geometry.attributes.position.array.slice()
  const fail=()=>({postMessage(){queueMicrotask(()=>this.onmessage({data:{error:'failed'}}))},terminate(){}})
  await assert.rejects(ensureAnalysisPickingTree(geometry,{workerFactory:fail}),/failed/)
  assert.equal(geometry.boundsTree,undefined);assert.deepEqual(geometry.attributes.position.array,positions)
  await ensureAnalysisPickingTree(geometry,{workerFactory});assert(geometry.boundsTree)
})

test('a tree prepared for an older geometry revision is never installed',async()=>{
  const geometry=new THREE.BoxGeometry(), pending=ensureAnalysisPickingTree(geometry,{workerFactory})
  geometry.attributes.position.setX(0,2)
  geometry.attributes.position.needsUpdate=true
  assert.equal(await pending,null);assert.equal(geometry.boundsTree,undefined)
  await ensureAnalysisPickingTree(geometry,{workerFactory});assert(geometry.boundsTree)
})
