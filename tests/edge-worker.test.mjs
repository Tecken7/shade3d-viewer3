import test from 'node:test'
import assert from 'node:assert/strict'
import {Worker} from 'node:worker_threads'
import * as THREE from 'three'

test('preview worker returns a refined patch with source face metadata',async()=>{
 const workerUrl=new URL('../app/workers/edge-edit.worker.js',import.meta.url).href
 const program=`import {parentPort} from 'node:worker_threads';globalThis.self={postMessage:value=>parentPort.postMessage(value)};await import(${JSON.stringify(workerUrl)});parentPort.on('message',data=>self.onmessage({data}));`
 const worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(program)),{type:'module'})
 try {
  const points=[[0,0],[2,0],[2,2],[4,2],[4,0],[6,0],[6,5],[0,5]],faces=THREE.ShapeUtils.triangulateShape(points.map(p=>new THREE.Vector2(...p)),[])
  const normals=points.flatMap(()=>[0,0,1]),colors=points.flatMap(()=>[.3,.5,.7])
  const response=new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)})
  worker.postMessage({type:'init',payload:{positions:new Float64Array(points.flatMap(p=>[...p,0])),indices:new Uint32Array(faces.flat()),faceIds:new Uint32Array(faces.map((_,i)=>i)),childIndices:new Uint16Array(faces.length),children:['scan'],nodeNormals:new Float32Array(normals),nodeColors:new Float32Array(colors),nodeUvs:null,loops:[{childUuid:'scan',materialIndex:0,boundary:points.map((p,nodeId)=>({nodeId,position:[...p,0],normal:[0,0,1],color:[.3,.5,.7],uv:null}))}]}})
  worker.postMessage({type:'preview',id:42,payload:{selection:[{loop:0,index:1},{loop:0,index:4}],bulge:.6}})
  const result=await response
  assert.equal(result.id,42);assert.equal(result.error,'');assert.equal(result.patch.childUuid,'scan');assert.ok(result.patch.triangles.length>20)
  assert.ok(result.patch.triangles.every(t=>t.every(c=>c.color.every((v,i)=>Math.abs(v-[.3,.5,.7][i])<1e-6))))
 }finally{await worker.terminate()}
})
