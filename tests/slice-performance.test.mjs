import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { Worker } from 'node:worker_threads'
import { prepareSliceGeometry, intersectSlice, unpackSliceResult } from '../app/viewer/slice-intersection.mjs'
import { createSliceEngine } from '../app/viewer/slice-engine.js'
const identity = new THREE.Matrix4().toArray()
const packed = geometry => ({positions:geometry.attributes.position.array.slice(), index:geometry.index?.array.slice() || null})
const canonical = groups => groups.flatMap(group => {const lines=[];for(let i=0;i<group.points.length;i+=4){const p=[...group.points.slice(i,i+2)].map(x=>x.toFixed(6)).join(',');const q=[...group.points.slice(i+2,i+4)].map(x=>x.toFixed(6)).join(',');lines.push([p,q].sort().join('|'))}return lines}).sort()
function referenceWorld(geometry,matrix,planeMatrix){
 const world=new THREE.Matrix4().fromArray(matrix),frame=new THREE.Matrix4().fromArray(planeMatrix),inverse=frame.clone().invert()
 const plane=new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(0,0,1).transformDirection(frame),new THREE.Vector3().setFromMatrixPosition(frame))
 const position=geometry.attributes.position,index=geometry.index,points=[]
 for(let i=0;i<(index?.count||position.count);i+=3){
  const vertices=[0,1,2].map(j=>new THREE.Vector3().fromBufferAttribute(position,index?index.getX(i+j):i+j).applyMatrix4(world))
  const hits=[]
  for(let j=0;j<3;j++){const a=vertices[j],b=vertices[(j+1)%3],da=plane.distanceToPoint(a),db=plane.distanceToPoint(b);if(da*db<0){const p=a.clone().lerp(b,da/(da-db)).applyMatrix4(inverse);if(!hits.some(q=>q.distanceToSquared(p)<1e-16))hits.push(p)}}
  if(hits.length===2)points.push(hits[0].x,hits[0].y,hits[1].x,hits[1].y)
 }
 return [{points}]
}
test('BVH section matches independent world-space reference for transformed indexed and non-indexed scans',()=>{
 for(const indexed of [true,false]){
  const original=new THREE.TorusGeometry(8,2,32,100),g=indexed?original:original.toNonIndexed()
  const prepared=prepareSliceGeometry(packed(g)),cache=new Map([['scan',prepared]])
  const world=new THREE.Matrix4().compose(new THREE.Vector3(3,-2,7),new THREE.Quaternion().setFromEuler(new THREE.Euler(.3,.8,.2)),new THREE.Vector3(1.5,.8,1.2)).toArray()
  for(const angle of [.1,.7,1.4]){
   const frame=new THREE.Matrix4().compose(new THREE.Vector3(3.1,-1.8,7.2),new THREE.Quaternion().setFromEuler(new THREE.Euler(angle,.4,.9)),new THREE.Vector3(1,1,1)).toArray()
   const result=intersectSlice([{key:'scan',matrix:world,color:'#123456',modelIndex:2}],frame,cache)
   assert.deepEqual(canonical(result.groups),canonical(referenceWorld(g,world,frame)))
   const unpacked=unpackSliceResult(result);assert(unpacked.segments.every(s=>s.color==='#123456'&&s.modelIndex===2))
  }
 }
})
test('dense geometry rejects most triangles without losing section segments',t=>{
 const geometry=new THREE.TorusGeometry(20,3,180,360),prepared=prepareSliceGeometry(packed(geometry)),cache=new Map([['scan',prepared]])
 const meshes=[{key:'scan',matrix:identity,color:'#aaa',modelIndex:0}]
 const frame=new THREE.Matrix4().makeRotationY(.6).setPosition(.2,.4,.6).toArray()
 let start=performance.now();const baseline=intersectSlice(meshes,frame,cache,{bruteForce:true});const baselineMs=performance.now()-start
 start=performance.now();const fast=intersectSlice(meshes,frame,cache);const fastMs=performance.now()-start
 assert.deepEqual(canonical(fast.groups),canonical(baseline.groups));assert(fast.testedTriangles<baseline.testedTriangles*.2)
 t.diagnostic(JSON.stringify({triangles:baseline.testedTriangles,tested:fast.testedTriangles,baselineMs,fastMs}))
 const outside=new THREE.Matrix4().setPosition(0,0,200).toArray();assert.equal(intersectSlice(meshes,outside,cache).testedTriangles,0)
})
test('planes through vertices and coplanar faces produce finite bounds',()=>{
 const g=new THREE.BoxGeometry(2,2,2),cache=new Map([['box',prepareSliceGeometry(packed(g))]])
 for(const z of [0,1,2]){const result=intersectSlice([{key:'box',matrix:identity}],new THREE.Matrix4().setPosition(0,0,z).toArray(),cache);assert(result.groups.every(g=>g.points.every(Number.isFinite)));if(z===2)assert.equal(result.boundingBox,null)}
})
class ControlledWorker {
 messages=[]
 postMessage(data){this.messages.push(data)}
 terminate(){this.terminated=true}
 reply(){const message=this.messages.at(-1);this.onmessage({data:{id:message.id,result:{groups:[],boundingBox:null}}})}
}
function scene(){const root=new THREE.Group();const mesh=new THREE.Mesh(new THREE.BoxGeometry());root.add(mesh);return{root,mesh}}
test('worker queue keeps only newest pending plane, reuses geometry and invalidates edits',async()=>{
 const worker=new ControlledWorker(),engine=createSliceEngine({workerFactory:()=>worker}),{root,mesh}=scene()
 const first=engine.compute(root,identity),superseded=engine.compute(root,identity),last=engine.compute(root,identity)
 assert.equal(await superseded,null);assert.equal(worker.messages.length,1);assert.equal(worker.messages[0].updates.length,1)
 worker.reply();assert(await first);assert.equal(worker.messages.length,2);assert.equal(worker.messages[1].updates.length,0)
 worker.reply();await last
 mesh.geometry.attributes.position.needsUpdate=true
 const edited=engine.compute(root,identity);assert.equal(worker.messages.at(-1).updates.length,1);worker.reply();await edited
 const cancelled=engine.compute(root,identity);engine.cancel();worker.reply();assert.equal(await cancelled,null)
 const disposed=engine.compute(root,identity);engine.dispose();assert.equal(await disposed,null);assert(worker.terminated)
})
test('worker failure retains functional exact slicing fallback',async()=>{
 const engine=createSliceEngine({workerFactory:()=>{throw Error('unavailable')}}),{root}=scene()
 const result=await engine.compute(root,identity);assert(result.segments.length>0);engine.dispose()
})
test('actual worker caches geometry for subsequent plane-only requests',async()=>{
 const entry=new URL('../app/workers/slice.worker.js',import.meta.url).href
 const script=`const {parentPort}=require('node:worker_threads');globalThis.self={postMessage:(data,transfer)=>parentPort.postMessage(data,transfer)};import(${JSON.stringify(entry)}).then(()=>parentPort.on('message',data=>self.onmessage({data})));`
 const worker=new Worker(script,{eval:true})
 const request=data=>new Promise((resolve,reject)=>{worker.once('error',reject);worker.once('message',msg=>msg.error?reject(Error(msg.error)):resolve(msg.result));worker.postMessage(data)})
 try {
  const geometry=new THREE.TorusGeometry(8,2,24,100),update={key:'scan',...packed(geometry)},meshes=[{key:'scan',matrix:identity,color:'#abcdef',modelIndex:3}]
  const first=await request({id:1,planeMatrix:identity,meshes,updates:[update]});assert(first.groups.length>0)
  const frame=new THREE.Matrix4().makeRotationY(.4).toArray()
  const second=await request({id:2,planeMatrix:frame,meshes,updates:[]})
  const expected=intersectSlice(meshes,frame,new Map([['scan',prepareSliceGeometry(packed(geometry))]]))
  assert.deepEqual(canonical(second.groups),canonical(expected.groups))
 } finally {await worker.terminate()}
})

test('external CT surface participates in the cached slice and respects its local crop',async()=>{
 const engine=createSliceEngine({workerFactory:()=>{throw Error('fallback')}})
 const root=new THREE.Group(),ct=new THREE.Mesh(new THREE.BoxGeometry(4,4,4))
 ct.matrixAutoUpdate=false;ct.matrix.makeTranslation(5,0,0);ct.matrixWorld.copy(ct.matrix)
 ct.userData._viewerColor='#A29C90';ct.userData.sliceCrop=[0,1]
 const frame=new THREE.Matrix4().makeRotationX(Math.PI/2).toArray()
 const result=await engine.compute(root,frame,'vertical',[ct])
 assert(result.segments.length>0)
 assert(result.segments.every(s=>s.color==='#A29C90'))
 for(const segment of result.segments)for(const p of [segment.a,segment.b]){
  assert(p.x>=3-1e-6&&p.x<=7+1e-6)
  assert(p.y>=-1e-6&&p.y<=1+1e-6)
 }
 const absent=await engine.compute(root,frame);assert.equal(absent.segments.length,0)
 engine.dispose()
})
