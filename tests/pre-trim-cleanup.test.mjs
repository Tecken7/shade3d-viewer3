import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import {Worker} from 'node:worker_threads'
import {prepareTrimCleanup} from '../app/model-builder/pre-trim-cleanup.mjs'
import {prepareTrimCleanupAsync} from '../app/model-builder/pre-trim-cleanup-async.mjs'
import {indexed,meshTopology} from '../app/model-builder/engine.mjs'

function perforated(size=.1){
 const outer=[[-4,-4],[4,-4],[4,4],[-4,4]].map(p=>new THREE.Vector2(...p)),hole=[[-size,-size],[-size,size],[size,size],[size,-size]].map(p=>new THREE.Vector2(...p))
 return {positions:new Float32Array([...outer,...hole].flatMap(p=>[p.x,0,p.y])),index:new Uint32Array(THREE.ShapeUtils.triangulateShape(outer,[hole]).flat())}
}
function topology(positions,index){const expanded=Float32Array.from([...index].flatMap(id=>[...positions.slice(id*3,id*3+3)])),mesh=indexed(expanded,{exact:true});return meshTopology(mesh.vertices,mesh.faces)}
test('pre-trim cleanup closes only a microhole, retaining the main rim and input coordinates',()=>{
 for(const size of [.05,.5]){
  const {positions,index}=perforated(size),before=positions.slice(),result=prepareTrimCleanup(positions,index)
  assert.equal(topology(positions,result.index).loops.length,size<.1?1:2)
  assert.equal(result.stats.closedMicroHoles,size<.1?1:0);assert.deepEqual(positions,before)
 }
})
test('tiny pinched fan is removed and UV seam corners retain their original vertex indices',()=>{
 const positions=new Float32Array([0,0,0,10,0,0,10,0,10,0,0,10,0,0,0,-.1,0,0,0,0,-.1]),index=new Uint32Array([0,1,2,4,2,3,0,5,6])
 const result=prepareTrimCleanup(positions,index)
 assert.equal(result.stats.removedFans,1);assert.deepEqual([...result.index],[0,1,2,4,2,3])
 assert.equal(topology(positions,result.index).loops.length,1)
})
function workerFactory(){
 const entry=new URL('../app/workers/pre-trim-cleanup.worker.js',import.meta.url).href
 const worker=new Worker(`const {parentPort}=require('node:worker_threads');globalThis.self={postMessage:(data,transfer)=>parentPort.postMessage(data,transfer)};import(${JSON.stringify(entry)}).then(()=>{parentPort.on('message',data=>self.onmessage({data}));parentPort.postMessage({ready:true})});`,{eval:true})
 let ready=false,pending=[]
 const adapter={postMessage(data,transfer){if(ready)worker.postMessage(data,transfer);else pending.push([data,transfer])},terminate(){worker.terminate()}}
 worker.on('message',data=>{if(data.ready){ready=true;for(const args of pending)worker.postMessage(...args);pending=[]}else adapter.onmessage?.({data})});worker.on('error',error=>adapter.onerror?.(error));return adapter
}
test('background cleanup preserves colors/UVs and installs a working BVH atomically',async()=>{
 const {positions,index}=perforated(.05),geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));geometry.setIndex(new THREE.BufferAttribute(index,1))
 geometry.setAttribute('uv',new THREE.Float32BufferAttribute(Array.from({length:positions.length/3*2},(_,i)=>i/100),2));geometry.setAttribute('color',new THREE.Float32BufferAttribute(Array.from({length:positions.length},(_,i)=>i/100),3))
 const mesh=new THREE.Mesh(geometry),result=await prepareTrimCleanupAsync(mesh,{workerFactory,pause:async()=>{}})
 assert.equal(result.backup.length,1);assert.equal(result.backup[0].geometry,geometry)
 for(const attr of ['position','uv','color'])assert.deepEqual(mesh.geometry.attributes[attr].array,geometry.attributes[attr].array)
 assert.ok(mesh.geometry.boundsTree);assert.equal(topology(positions,mesh.geometry.index.array).loops.length,1)
 const hit={};mesh.geometry.boundsTree.closestPointToPoint(new THREE.Vector3(0,2,0),hit);assert.ok(Math.abs(hit.distance-2)<1e-6)
})
