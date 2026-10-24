import test from 'node:test'
import assert from 'node:assert/strict'
import {Worker} from 'node:worker_threads'
import {prepareCtField,removeTinyCtIslands,extractCtSurface,ctIsoLevel} from '../app/viewer/ct-surface.mjs'
import {createCtSurfaceEngine} from '../app/viewer/ct-surface-engine.js'
function sphere(n=32){const data=new Uint8Array(n**3);for(let z=0;z<n;z++)for(let y=0;y<n;y++)for(let x=0;x<n;x++)if(Math.hypot(x+.5-n/2,y+.5-n/2,z+.5-n/2)<n*.28)data[(z*n+y)*n+x]=240;return{data,width:n,height:n,depth:n,size:[32,48,64]}}
test('rendering preparation and extraction never change original voxel data',()=>{
 const volume=sphere(),original=volume.data.slice(),field=prepareCtField(volume,24),copy=field.data.slice();const cleaned=removeTinyCtIslands(field,100),mesh=extractCtSurface(cleaned,100)
 assert.deepEqual(volume.data,original);assert.deepEqual(field.data,copy);assert(mesh.triangles>0);assert(mesh.vertices<mesh.triangles*3)
 assert.deepEqual(mesh.dims,[24,24,24]);assert(mesh.normals.every(Number.isFinite));assert(mesh.positions.every(Number.isFinite))
 for(let axis=0;axis<3;axis++){assert(Math.abs(mesh.bounds.min[axis]+mesh.bounds.max[axis])<1e-5);assert(mesh.bounds.max[axis]>volume.size[axis]*.24)}
})
test('threshold plane retains physical coordinates and outward winding',()=>{
 const data=new Float32Array(16**3);for(let i=0;i<data.length;i++)if(i%16>=8)data[i]=255
 const mesh=extractCtSurface({data,dims:[16,16,16],size:[16,32,48],voxelSize:[1,2,3]},127.5)
 for(let i=0;i<mesh.positions.length;i+=3){assert(Math.abs(mesh.positions[i])<1e-7);assert(mesh.normals[i]<-.99)}
 for(let i=0;i<mesh.index.length;i+=3){const a=mesh.index[i]*3,b=mesh.index[i+1]*3,c=mesh.index[i+2]*3;const uy=mesh.positions[b+1]-mesh.positions[a+1],uz=mesh.positions[b+2]-mesh.positions[a+2],vy=mesh.positions[c+1]-mesh.positions[a+1],vz=mesh.positions[c+2]-mesh.positions[a+2];assert((uy*vz-uz*vy)*mesh.normals[a]>0)}
})
test('tiny noise is removed without dropping either of two disconnected larger regions',()=>{
 const data=new Float32Array(12**3),at=(x,y,z)=>(z*12+y)*12+x
 data[at(1,1,1)]=255
 for(const start of [3,8])for(let z=3;z<5;z++)for(let y=3;y<5;y++)for(let x=start;x<start+2;x++)data[at(x,y,z)]=255
 const prepared={data,dims:[12,12,12],size:[12,12,12],voxelSize:[1,1,1]},clean=removeTinyCtIslands(prepared,100,2)
 assert.equal(clean.removed,1);assert.equal(clean.components,3);assert.equal(clean.data[at(1,1,1)],0);assert.equal(clean.data[at(3,3,3)],255);assert.equal(clean.data[at(8,3,3)],255);assert.equal(data[at(1,1,1)],255)
})
test('surface extraction is atomic when the triangle budget is exceeded',()=>{
 assert.throws(()=>extractCtSurface(prepareCtField(sphere(),32),100,{maxTriangles:10}),/CT_SURFACE_BUDGET/)
 const empty=extractCtSurface(prepareCtField(sphere(),16),256);assert.equal(empty.triangles,0);assert.equal(empty.bounds,null)
 assert(ctIsoLevel(350,2200)>ctIsoLevel(0,1000))
})
class FakeWorker{messages=[];postMessage(data){this.messages.push(data)}terminate(){this.terminated=true}reply(final=true){const job=this.messages.at(-1);this.onmessage({data:{id:job.id,type:'surface',final,surface:{positions:new Float32Array(),normals:new Float32Array(),index:new Uint32Array(),triangles:0}}})}}
test('engine transfers the source once, coalesces thresholds, and caches the final shell',()=>{
 const worker=new FakeWorker(),engine=createCtSurfaceEngine(sphere(),{workerFactory:()=>worker}),received=[]
 const request=iso=>engine.request({iso,detail:128,onSurface:(_,final)=>received.push([iso,final])})
 request(100);request(110);request(120);assert.equal(worker.messages.length,2);worker.reply();assert.equal(worker.messages.at(-1).iso,120);assert.equal(received.length,0);worker.reply();assert.deepEqual(received,[[120,true]])
 const count=worker.messages.length;request(120);assert.equal(worker.messages.length,count);assert.equal(received.length,2);engine.dispose();assert(worker.terminated)
})
test('actual worker returns progressive meshes with conserved dimensions',async()=>{
 const entry=new URL('../app/workers/ct-surface.worker.js',import.meta.url).href,script=`const {parentPort}=require('node:worker_threads');globalThis.self={postMessage:(data,transfer)=>parentPort.postMessage(data,transfer)};import(${JSON.stringify(entry)}).then(()=>parentPort.on('message',data=>self.onmessage({data})));`
 const worker=new Worker(script,{eval:true}),surfaces=[]
 try{const result=await new Promise((resolve,reject)=>{worker.on('error',reject);worker.on('message',data=>{if(data.type==='error')reject(Error(data.error));if(data.type==='surface'){surfaces.push(data);if(data.final)resolve(data.surface)}});worker.postMessage({type:'init',volume:sphere(40)});worker.postMessage({type:'build',id:1,iso:100,detail:160})});assert(result.triangles>0);assert.equal(surfaces.length,2);assert.equal(surfaces[0].final,false);assert.equal(surfaces[1].final,true);assert(result.positions.buffer.byteLength>0)}finally{await worker.terminate()}
})
