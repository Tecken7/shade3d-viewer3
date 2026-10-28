import test from 'node:test'
import assert from 'node:assert/strict'
import {Worker} from 'node:worker_threads'
import * as THREE from 'three'
import {MeshBVH} from 'three-mesh-bvh'
import {prepareRepairVertices,prepareRepairVerticesAsync,weldByDistance} from '../app/model-builder/mesh-preflight.mjs'

function workerFactory() {
  const entry = new URL('../app/workers/repair-preflight.worker.js',import.meta.url).href
  const worker = new Worker(`const {parentPort}=require('node:worker_threads');globalThis.self={postMessage:(data,transfer)=>parentPort.postMessage(data,transfer)};import(${JSON.stringify(entry)}).then(()=>{parentPort.on('message',data=>self.onmessage({data}));parentPort.postMessage({ready:true})});`,{eval:true})
  let ready=false, pending=[]
  const adapter={postMessage(data,transfer){if(ready)worker.postMessage(data,transfer);else pending.push([data,transfer])},terminate(){worker.terminate()}}
  worker.on('message',data=>{if(data.ready){ready=true;for(const args of pending)worker.postMessage(...args);pending=[]}else adapter.onmessage?.({data})})
  worker.on('error',error=>adapter.onerror?.(error))
  return adapter
}
function splitBox() {
  const geometry=new THREE.BoxGeometry(10,10,10).toNonIndexed(),p=geometry.attributes.position
  for(let i=0;i<p.count;i++)p.setX(i,p.getX(i)+(Math.floor(i/6)%3)*.001)
  const root=new THREE.Group(),mesh=new THREE.Mesh(geometry)
  mesh.position.set(1,2,3);mesh.rotation.y=.2;root.add(mesh)
  return {root,mesh}
}
test('background repair preparation preserves exact welding, attributes, triangle order and BVH queries',async()=>{
  const before=THREE.BufferGeometry.prototype.computeBoundsTree
  THREE.BufferGeometry.prototype.computeBoundsTree=function(options){this.boundsTree=new MeshBVH(this,options)}
  try {
    const sync=splitBox(),async=splitBox()
    const expected=prepareRepairVertices(sync.root)
    let yields=0
    const actual=await prepareRepairVerticesAsync(async.root,.005,{workerFactory,pause:async()=>{yields++}})
    assert.deepEqual(actual.stats,expected.stats)
    assert.equal(actual.backup.length,expected.backup.length)
    for(const attr of ['position','normal','uv'])assert.deepEqual(async.mesh.geometry.attributes[attr].array,sync.mesh.geometry.attributes[attr].array)
    assert.deepEqual(async.mesh.geometry.index.array,sync.mesh.geometry.index.array)
    assert.deepEqual(async.mesh.geometry.groups,sync.mesh.geometry.groups)
    for(const point of [new THREE.Vector3(20,5,3),new THREE.Vector3(0,0,0)]) {
      const a={},b={}
      sync.mesh.geometry.boundsTree.closestPointToPoint(point,a)
      async.mesh.geometry.boundsTree.closestPointToPoint(point,b)
      assert.equal(a.distance,b.distance);assert.equal(a.faceIndex,b.faceIndex)
    }
    assert(yields>0)
  } finally {if(before)THREE.BufferGeometry.prototype.computeBoundsTree=before;else delete THREE.BufferGeometry.prototype.computeBoundsTree}
})
test('worker failure keeps the original scene geometry intact',async()=>{
  const {root,mesh}=splitBox(),original=mesh.geometry
  const failed=()=>({postMessage(){queueMicrotask(()=>this.onmessage({data:{error:'test failure'}}))},terminate(){}})
  await assert.rejects(prepareRepairVerticesAsync(root,.005,{workerFactory:failed}),/test failure/)
  assert.equal(mesh.geometry,original)
})

import fs from 'node:fs'
import {runStepsAsync} from '../app/model-builder/cooperative-work.mjs'
const source=fs.readFileSync(new URL('../app/ClientPage.jsx',import.meta.url),'utf8')
const section=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)))
const helpers=new Function('THREE',section('const trimEdgeKey =','const repairWaitForBusyPaint')+section('function buildTrimMeshContext(','function resolveTrimHit(')+section('function repairAverage(','function findRepairHoleNearPoint(')+';return {buildTrimMeshContext,buildTrimMeshContextSteps,findRepairBoundaryLoops,findRepairBoundaryLoopSteps}')(THREE)
test('chunked topology and boundary analysis keeps exact closed-loop geometry',async()=>{
  const grid=new THREE.PlaneGeometry(8,8,4,4).toNonIndexed(),geometry=new THREE.BufferGeometry()
  for(const name of ['position','normal','uv']){
    const attr=grid.attributes[name],values=[]
    for(let face=0;face<grid.attributes.position.count/3;face++){
      if(face===10||face===11)continue
      for(let k=0;k<3;k++)for(let axis=0;axis<attr.itemSize;axis++)values.push(attr.array[(face*3+k)*attr.itemSize+axis])
    }
    geometry.setAttribute(name,new THREE.Float32BufferAttribute(values,attr.itemSize))
  }
  const mesh=new THREE.Mesh(geometry)
  const sync=helpers.buildTrimMeshContext(mesh)
  let pauses=0
  const async=await runStepsAsync(helpers.buildTrimMeshContextSteps(mesh),{budget:0,pause:async()=>{pauses++}})
  assert.deepEqual(async.nodes,sync.nodes);assert.deepEqual(async.edgeTriangles,sync.edgeTriangles);assert.deepEqual(async.triangleNeighbors,sync.triangleNeighbors)
  const expected=helpers.findRepairBoundaryLoops(sync),actual=await runStepsAsync(helpers.findRepairBoundaryLoopSteps(async),{budget:0,pause:async()=>{pauses++}})
  assert.deepEqual(actual,expected)
  assert.equal(actual.length,2)
  assert.deepEqual(actual.map(loop=>loop.area),[4,64])
  assert(pauses>0)
})

test('failure while preparing the search tree does not commit partial mesh changes',async()=>{
  const {root,mesh}=splitBox(),original=mesh.geometry
  const failed=()=>({postMessage(data){queueMicrotask(()=>this.onmessage({data:data.type==='weld'?{result:weldByDistance(data.points,data.triangles,data.tolerance,data.vertexGroups)}:{error:'tree failure'}}))},terminate(){}})
  await assert.rejects(prepareRepairVerticesAsync(root,.005,{workerFactory:failed}),/tree failure/)
  assert.equal(mesh.geometry,original)
  assert.equal(mesh.userData._baseGeom,undefined)
})


test('builder continues hole analysis on the unchanged trim when welding would damage topology',async()=>{
  const geometry=new THREE.BufferGeometry()
  geometry.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0,.001,0,0,0,1,0,0,0,1],3))
  geometry.setIndex([0,2,1,0,1,3,0,3,2,1,2,3])
  const root=new THREE.Group(),mesh=new THREE.Mesh(geometry);root.add(mesh)
  const positions=geometry.attributes.position.array.slice(),indices=geometry.index.array.slice()
  await assert.rejects(prepareRepairVerticesAsync(root,.005,{workerFactory}),{code:'UNSAFE_WELD_TOPOLOGY'})
  const result=await prepareRepairVerticesAsync(root,.005,{workerFactory,preserveUnsafeBoundary:true})
  assert.equal(result.stats.unsafeWeldSkipped,true)
  assert.deepEqual(result.backup,[])
  assert.equal(mesh.geometry,geometry)
  assert.deepEqual(geometry.attributes.position.array,positions)
  assert.deepEqual(geometry.index.array,indices)
  const context=await runStepsAsync(helpers.buildTrimMeshContextSteps(root))
  const holes=await runStepsAsync(helpers.findRepairBoundaryLoopSteps(context))
  assert.equal(holes.length,0,'completed analysis can advance instead of leaving an empty repair panel')
})

test('builder fallback never swallows unrelated worker failures',async()=>{
 const {root}=splitBox()
 const failed=()=>({postMessage(){queueMicrotask(()=>this.onmessage({data:{error:'unexpected worker failure'}}))},terminate(){}})
 await assert.rejects(prepareRepairVerticesAsync(root,.005,{workerFactory:failed,preserveUnsafeBoundary:true}),/unexpected worker failure/)
})
