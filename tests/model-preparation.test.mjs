import test from 'node:test'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import * as THREE from 'three'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { autoSmoothGeometry,packGeometry,unpackGeometry,packObject,unpackObject,modelTransferables } from '../app/viewer/model-preparation.mjs'
const triangle='v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'
test('geometry transfer preserves indexed colors, groups and bounds',()=>{
 const g=new THREE.BoxGeometry(2,3,4);g.setAttribute('color',new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count*3).fill(.5),3));g.computeBoundingBox();g.computeBoundingSphere()
 const packed=packGeometry(g),copy=unpackGeometry(packed)
 assert.deepEqual(copy.index.array,g.index.array);assert.deepEqual(copy.attributes.color.array,g.attributes.color.array)
 assert.deepEqual(copy.groups,g.groups);assert.equal(copy.boundingSphere.radius,g.boundingSphere.radius)
 assert.equal(new Set(modelTransferables(packed)).size,modelTransferables(packed).length)
 const smooth=autoSmoothGeometry(g,30);assert.equal(smooth.index,null);assert.equal(smooth.attributes.normal.count,smooth.attributes.position.count)
})
test('OBJ hierarchy and material survive worker handoff',()=>{
 const object=new OBJLoader().parse(triangle);object.position.set(4,5,6)
 const result=unpackObject(packObject(object));assert.deepEqual(result.position.toArray(),[4,5,6]);assert.deepEqual(result.children[0].geometry.attributes.position.array,object.children[0].geometry.attributes.position.array)
 assert.equal(result.children[0].material.type,object.children[0].material.type)
})
test('actual preparation worker parses STL, PLY and OBJ and reports progress',async()=>{
 const entry=new URL('../app/workers/scene-loading.worker.js',import.meta.url).href
 const script=`const {parentPort}=require('node:worker_threads');globalThis.self={postMessage:(data,transfer)=>parentPort.postMessage(data,transfer)};import(${JSON.stringify(entry)}).then(()=>parentPort.on('message',data=>self.onmessage({data})));`
 const fixtures={obj:triangle,stl:'solid scan\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid scan',ply:'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n'}
 for(const [ext,text]of Object.entries(fixtures)){
  const worker=new Worker(script,{eval:true});const progress=[],stages=[]
  try{const result=await new Promise((resolve,reject)=>{worker.on('error',reject);worker.on('message',data=>{if(data.type==='progress'){progress.push(data.progress);stages.push(data.stage);}if(data.type==='error')reject(new Error(data.error));if(data.type==='result')resolve(data.result)});worker.postMessage({url:'data:application/octet-stream;base64,'+Buffer.from(text).toString('base64'),ext,autoSmooth:true,smoothAngle:30})})
   const geometry=ext==='obj'?unpackObject(result.object).children[0].geometry:unpackGeometry(result.base||result.geometry)
   assert.equal(geometry.attributes.position.count,3);assert(geometry.attributes.normal);assert(progress.includes(.9));assert.deepEqual([...new Set(stages)],['downloading','parsing','optimizing','finalizing'])
  }finally{await worker.terminate()}
 }
})
