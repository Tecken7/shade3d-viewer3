import test from 'node:test'
import assert from 'node:assert/strict'
import {Worker} from 'node:worker_threads'
import * as THREE from 'three'

async function occlusion(payload) {
  const entry = new URL('../app/workers/analysis.worker.js', import.meta.url).href
  const worker = new Worker(`const {parentPort}=require('node:worker_threads');globalThis.self={postMessage:d=>parentPort.postMessage(d)};import(${JSON.stringify(entry)}).then(()=>parentPort.on('message',d=>self.onmessage({data:d})));`, {eval:true})
  try {
    return await new Promise((resolve,reject) => {
      worker.on('error',reject)
      worker.on('message',d => {
        if(d.type==='READY') worker.postMessage({type:'OCCLUSION',requestId:'test',payload})
        if(d.type==='ERROR') reject(Error(d.message))
        if(d.type==='RESULT') resolve(d.result)
      })
    })
  } finally { await worker.terminate() }
}

test('occlusion preserves signed distances for repeated vertices, inside/outside points and transformed surfaces', async () => {
  const target = new THREE.BoxGeometry(4,6,8).toNonIndexed()
  const targetMatrix = new THREE.Matrix4().compose(new THREE.Vector3(2,-1,3),new THREE.Quaternion().setFromEuler(new THREE.Euler(.21,.37,.13)),new THREE.Vector3(1.3,1.3,1.3))
  const sourceMatrix = new THREE.Matrix4().makeRotationZ(-.31).setPosition(-1,2,-3)
  const points=[]
  let seed=12345
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296}
  // Deliberately alternate distant points, then repeat them as non-indexed scans do.
  for(let i=0;i<120;i++) { const p=[(random()-.5)*18,(random()-.5)*18,(random()-.5)*18]; points.push(...p,...p,...p) }
  const positions=new Float32Array(points)
  const base={a:{positions,matrixWorld:sourceMatrix.toArray()},b:{positions:target.attributes.position.array,matrixWorld:targetMatrix.toArray()},maxDist:2}
  const normalMatrix=new THREE.Matrix3().getNormalMatrix(targetMatrix)
  const p=new THREE.Vector3(),q=new THREE.Vector3(),normal=new THREE.Vector3(),delta=new THREE.Vector3(),tri=new THREE.Triangle()
  const expected=[]
  for(let i=0;i<positions.length;i+=3) {
    p.fromArray(positions,i).applyMatrix4(sourceMatrix)
    let best=Infinity,signed=0
    for(let j=0;j<target.attributes.position.count;j+=3) {
      tri.a.fromBufferAttribute(target.attributes.position,j);tri.b.fromBufferAttribute(target.attributes.position,j+1);tri.c.fromBufferAttribute(target.attributes.position,j+2)
      tri.getNormal(normal).applyMatrix3(normalMatrix).normalize()
      tri.a.applyMatrix4(targetMatrix);tri.b.applyMatrix4(targetMatrix);tri.c.applyMatrix4(targetMatrix)
      tri.closestPointToPoint(p,q)
      delta.subVectors(p,q)
      const d=delta.length()
      if(d<best) {best=d;signed=d*(delta.dot(normal)<0?-1:1)}
    }
    expected.push(signed)
  }
  const normalResult=await occlusion(base), inverted=await occlusion({...base,invertSign:true})
  assert(expected.some(d=>d<0));assert(expected.some(d=>d>0))
  for(let i=0;i<expected.length;i++) {
    assert(Math.abs(normalResult.distances[i]-expected[i])<1e-5,`vertex ${i}`)
    assert.equal(inverted.distances[i],-normalResult.distances[i])
    if(i%3) {
      assert.equal(normalResult.distances[i],normalResult.distances[i-1])
      assert.deepEqual(normalResult.colors.slice(i*3,i*3+3),normalResult.colors.slice((i-1)*3,i*3))
    }
  }
  target.dispose()
})
