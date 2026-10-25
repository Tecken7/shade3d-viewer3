import test from 'node:test'
import assert from 'node:assert/strict'
import {Worker} from 'node:worker_threads'
import * as THREE from 'three'

test('optimized comparison preserves exact distances for repeated vertices and transformed surfaces',async()=>{
 const a=new THREE.BoxGeometry(4,6,8).toNonIndexed(),b=new THREE.BoxGeometry(8,10,4).toNonIndexed()
 const ma=new THREE.Matrix4().makeRotationY(.3).setPosition(1,2,3),mb=new THREE.Matrix4().makeRotationZ(-.2).setPosition(-2,1,0)
 const payload={a:{positions:a.attributes.position.array,matrixWorld:ma.toArray()},b:{positions:b.attributes.position.array,matrixWorld:mb.toArray()},tolerance:.3}
 const entry=new URL('../app/workers/analysis.worker.js',import.meta.url).href
 const worker=new Worker(`const {parentPort}=require('node:worker_threads');globalThis.self={postMessage:d=>parentPort.postMessage(d)};import(${JSON.stringify(entry)}).then(()=>parentPort.on('message',d=>self.onmessage({data:d})));`,{eval:true})
 try {
  const result=await new Promise((resolve,reject)=>{worker.on('error',reject);worker.on('message',d=>{if(d.type==='READY')worker.postMessage({type:'COMPARISON',requestId:'test',payload});if(d.type==='ERROR')reject(Error(d.message));if(d.type==='RESULT')resolve(d.result)})})
  for(const [source,target,sm,tm,key] of [[a,b,ma,mb,'a'],[b,a,mb,ma,'b']]){
   const p=new THREE.Vector3(),q=new THREE.Vector3(),tri=new THREE.Triangle()
   for(let i=0;i<source.attributes.position.count;i++){
    p.fromBufferAttribute(source.attributes.position,i).applyMatrix4(sm);let best=Infinity
    for(let j=0;j<target.attributes.position.count;j+=3){tri.a.fromBufferAttribute(target.attributes.position,j).applyMatrix4(tm);tri.b.fromBufferAttribute(target.attributes.position,j+1).applyMatrix4(tm);tri.c.fromBufferAttribute(target.attributes.position,j+2).applyMatrix4(tm);tri.closestPointToPoint(p,q);best=Math.min(best,p.distanceTo(q))}
    assert(Math.abs(result[key].distances[i]-best)<1e-5)
   }
  }
  assert.equal(result.stats.samples,a.attributes.position.count+b.attributes.position.count)
 } finally {await worker.terminate();a.dispose();b.dispose()}
})
