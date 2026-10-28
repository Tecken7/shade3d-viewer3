import test from 'node:test'
import assert from 'node:assert/strict'
import {Worker} from 'node:worker_threads'
import * as THREE from 'three'
import Module from 'manifold-3d'
import {prepareBaseHeightGuide} from '../app/model-builder/base-height-guide.mjs'
import {baseHeightGuideLayout,draggedBaseHeight} from '../app/model-builder/base-height-layout.mjs'
import {buildModel} from '../app/model-builder/engine.mjs'

const contour=[[-20,-15],[-8,-15],[-8,4],[-5,9],[5,9],[8,4],[8,-15],[20,-15],[20,6],[13,18],[-13,18],[-20,6]].map(p=>new THREE.Vector2(...p))
const input=[]
for(const triangle of THREE.ShapeUtils.triangulateShape(contour,[])){
  const points=triangle.map(i=>[contour[i].x,3,contour[i].y])
  const [a,b,c]=points.map(p=>new THREE.Vector3(...p))
  if(b.sub(a).cross(c.sub(a)).y>0)points.reverse()
  input.push(...points.flat())
}
const positions=new Float32Array(input)

test('guide target plane matches generated bases for both jaws and reversed direction',async()=>{
  const M=await Module();M.setup()
  const original=positions.slice()
  for(const arch of ['upper','lower'])for(const flip of [false,true]){
    const data=prepareBaseHeightGuide(positions,arch)
    const layout=baseHeightGuideLayout(data,20,flip)
    const result=await buildModel(M,positions,{arch,flipBaseDirection:flip,totalHeight:20,smoothing:0,rounding:0,holes:[{enabled:false},{enabled:false}]},null)
    assert.equal(result.placement.direction,layout.direction)
    for(const p of result.placement.bottomContour)assert.ok(Math.abs(p[1]-layout.y)<.001)
    assert.ok(data.points.length>=3&&data.points.length<=240)
    assert.deepEqual(positions,original,'preparing a guide never modifies the scan')
  }
})

test('height drag uses the generator direction and preserves slider limits and precision',()=>{
  assert.equal(draggedBaseHeight(20,5,8,1,15,50),23)
  assert.equal(draggedBaseHeight(20,5,8,-1,15,50),17)
  assert.equal(draggedBaseHeight(20,5,500,1,15,50),50)
  assert.equal(draggedBaseHeight(20,5,500,-1,15,50),15)
  assert.equal(draggedBaseHeight(20,5,5.123,1,15,50),20.12)
})

test('the real background worker prepares the same footprint without transferring the original scan',async()=>{
  const entry=new URL('../app/workers/base-height-guide.worker.js',import.meta.url).href
  const worker=new Worker(`const {parentPort}=require('node:worker_threads');globalThis.self={postMessage:data=>parentPort.postMessage(data)};import(${JSON.stringify(entry)}).then(()=>parentPort.on('message',data=>self.onmessage({data})));`,{eval:true})
  try{
    const result=await new Promise((resolve,reject)=>{worker.on('message',resolve);worker.on('error',reject);worker.postMessage({positions:positions.slice(),arch:'upper'})})
    assert.equal(result.error,undefined)
    assert.deepEqual(result.result,prepareBaseHeightGuide(positions,'upper'))
    assert.ok(positions.byteLength>0)
  }finally{await worker.terminate()}
})
