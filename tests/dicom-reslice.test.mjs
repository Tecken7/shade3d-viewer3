import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { Worker } from 'node:worker_threads'
import { resliceDicom } from '../app/viewer/dicom-reslice.mjs'
import { createDicomResliceEngine } from '../app/viewer/dicom-reslice-engine.js'
const identity = new THREE.Matrix4().toArray()
const settings = { visible:true, densityMin:-1024, densityMax:3071, cropMin:0, cropMax:1 }
function volume(){const data=new Uint8Array(8**3);for(let z=0;z<8;z++)for(let y=0;y<8;y++)for(let x=0;x<8;x++)data[(z*8+y)*8+x]=z*32;return{data,width:8,height:8,depth:8,size:[8,8,8]}}
test('reslice preserves original voxels, physical bounds and the current plane',()=>{
 const v=volume(),copy=v.data.slice(),a=resliceDicom(v,settings,identity,identity,48)
 assert.deepEqual(a.bounds,{minX:-4,minY:-4,width:8,height:8});assert.equal(a.width,48);assert.deepEqual(v.data,copy)
 const shifted=new THREE.Matrix4().setPosition(0,0,2).toArray(),b=resliceDicom(v,settings,shifted,identity,48)
 const center=(24*48+24)*4;assert(b.pixels[center]>a.pixels[center]);assert.equal(a.pixels[center+3],255)
 const outside=new THREE.Matrix4().setPosition(0,0,20).toArray();assert.equal(resliceDicom(v,settings,outside,identity,48),null)
 const cropped=resliceDicom(v,{...settings,cropMin:.8},identity,identity,48);assert.equal(cropped.pixels[center+3],0)
 const translated=new THREE.Matrix4().setPosition(12,0,0).toArray(),c=resliceDicom(v,settings,identity,translated,48)
 assert.equal(c.bounds.minX,8)
})
class ControlledWorker {
 messages=[]
 postMessage(data){this.messages.push(data)}
 terminate(){this.terminated=true}
 reply(result={blob:'test'}){const data=this.messages.at(-1);this.onmessage({data:{id:data.id,result}})}
}
test('only newest CT request is delivered; source transfers once and pending work is bounded',async()=>{
 const worker=new ControlledWorker(),engine=createDicomResliceEngine(volume(),{workerFactory:()=>worker})
 const first=engine.compute({planeMatrix:identity}),middle=engine.compute({planeMatrix:identity}),last=engine.compute({planeMatrix:identity})
 assert.equal(await middle,null);assert.equal(worker.messages.length,2);assert.equal(worker.messages[0].type,'init')
 worker.reply();assert.equal(await first,null);assert.equal(worker.messages.length,3);worker.reply();assert.deepEqual(await last,{blob:'test'})
 const cancelled=engine.compute({});engine.cancel();assert.equal(await cancelled,null);worker.reply()
 const disposed=engine.compute({});engine.dispose();assert.equal(await disposed,null);assert(worker.terminated)
})
test('worker failure rejects the CT image without a synchronous pixel fallback',async()=>{
 const engine=createDicomResliceEngine(volume(),{workerFactory:()=>{throw Error('unavailable')}})
 await assert.rejects(engine.compute({}),/unavailable/);engine.dispose()
})
test('actual worker resampling matches the pure sampler for a transformed plane',async()=>{
 const entry=new URL('../app/workers/dicom-reslice.worker.js',import.meta.url).href
 const script=`const {parentPort}=require('node:worker_threads');globalThis.self={postMessage:(data,transfer)=>parentPort.postMessage(data,transfer)};import(${JSON.stringify(entry)}).then(()=>parentPort.on('message',data=>self.onmessage({data})));`
 const worker=new Worker(script,{eval:true}),v=volume(),plane=new THREE.Matrix4().makeRotationY(.4).toArray()
 try{const result=await new Promise((resolve,reject)=>{worker.on('error',reject);worker.on('message',d=>d.error?reject(Error(d.error)):resolve(d.result));worker.postMessage({type:'init',volume:v});worker.postMessage({type:'build',id:1,settings,planeMatrix:plane,dicomMatrix:identity,resolution:48})});const expected=resliceDicom(v,settings,plane,identity,48);assert.deepEqual(result.bounds,expected.bounds);assert.deepEqual(result.pixels,expected.pixels)}finally{await worker.terminate()}
})

test('a cancelled active image cannot replace the newest queued position',async()=>{
 const worker=new ControlledWorker(),engine=createDicomResliceEngine(volume(),{workerFactory:()=>worker})
 const old=engine.compute({position:1});engine.cancel();assert.equal(await old,null)
 const newer=engine.compute({position:2}),newest=engine.compute({position:3});assert.equal(await newer,null)
 worker.reply({position:1});assert.equal(worker.messages.at(-1).position,3)
 worker.reply({position:3});assert.deepEqual(await newest,{position:3});engine.dispose()
})
