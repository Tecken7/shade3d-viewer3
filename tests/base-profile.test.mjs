import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import Module from 'manifold-3d'
import {prepareBaseHeightGuide} from '../app/model-builder/base-height-guide.mjs'
import {makeBaseGuideGeometry} from '../app/model-builder/base-guide-geometry.mjs'
import {buildModel} from '../app/model-builder/engine.mjs'

// A narrow projecting sliver, like the reported scan rim. Its raw inset would
// create long miters; the shared morphological opening should remove it.
const polygon=[[-20,-15],[-8,-15],[-8,4],[-5,9],[5,9],[8,4],[8,-15],[20,-15],[20,6],[13,18],[.15,18],[0,22],[-.15,18],[-13,18],[-20,6]].map(p=>new THREE.Vector2(...p))
const input=[]
for(const tri of THREE.ShapeUtils.triangulateShape(polygon,[])){
 const points=tri.map(i=>[polygon[i].x,3,polygon[i].y]),[a,b,c]=points.map(p=>new THREE.Vector3(...p))
 if(b.sub(a).cross(c.sub(a)).y>0)points.reverse()
 input.push(...points.flat())
}
const positions=new Float32Array(input)
test('smoothed preview foot matches generated base, including bevel, without rim spikes',async()=>{
 const M=await Module();M.setup();const original=positions.slice()
 for(const bevel of [0,.7,1.5]){
  const options={smoothing:.8,bevel,rounding:0,totalHeight:20,repairBoundary:true,hollow:false,holes:[{enabled:false},{enabled:false}]}
  const guide=prepareBaseHeightGuide(M,positions,'lower',options),geometry=makeBaseGuideGeometry(guide.profile)
  const result=await buildModel(M,positions,{arch:'lower',...options},null)
  const foot=[];for(let i=0;i<guide.profile.positions.length;i+=3)if(Math.abs(guide.profile.positions[i+1])<1e-6)foot.push([guide.profile.positions[i],guide.profile.positions[i+2]])
  for(const point of result.placement.bottomContour)assert.ok(foot.some(q=>Math.hypot(point[0]-q[0],point[2]-q[1])<1e-4),'same terminal contour as printable model')
  assert.ok(geometry.boundingBox.max.z<19,'narrow scan spur is not reproduced in blue guide')
  assert.ok(Math.abs(geometry.boundingBox.min.y+Math.max(.8,bevel))<1e-6)
  const normal=geometry.attributes.normal;for(const value of normal.array)assert.ok(Number.isFinite(value))
  geometry.dispose()
 }
 assert.deepEqual(positions,original)
})
test('changing smoothing or bevel changes preview profile, but not its target height',async()=>{
 const M=await Module();M.setup()
 const a=prepareBaseHeightGuide(M,positions,'upper',{smoothing:.8,bevel:0})
 const b=prepareBaseHeightGuide(M,positions,'upper',{smoothing:1.2,bevel:1})
 assert.deepEqual(a.min,b.min);assert.deepEqual(a.max,b.max);assert.equal(a.direction,b.direction)
 assert.notDeepEqual(a.profile.positions,b.profile.positions)
})

test('hollow guide leaves the underside open and follows wall thickness; solid guide stays capped',async()=>{
 const M=await Module();M.setup()
 const hit=(hollow,wall,x)=>{
  const data=prepareBaseHeightGuide(M,positions,'lower',{smoothing:.8,bevel:1,hollow,wall})
  const geometry=makeBaseGuideGeometry(data.profile),material=new THREE.MeshBasicMaterial({side:THREE.DoubleSide}),mesh=new THREE.Mesh(geometry,material)
  mesh.updateMatrixWorld(true)
  const hits=new THREE.Raycaster(new THREE.Vector3(x,10,0),new THREE.Vector3(0,-1,0)).intersectObject(mesh)
  geometry.dispose();material.dispose();return hits.length
 }
 assert.ok(hit(false,2.5,14)>0,'solid cap covers the middle of the arch arm')
 assert.equal(hit(true,2.5,14),0,'hollow guide is open through the middle')
 assert.equal(hit(true,1,10.5),0,'thin wall keeps a wider opening')
 assert.ok(hit(true,2.5,10.5)>0,'increasing the wall visibly reduces the opening')
})
