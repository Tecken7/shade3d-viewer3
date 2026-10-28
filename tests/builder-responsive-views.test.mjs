import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import {collectTrianglesInRoot,collectTrianglesInRootSteps} from '../app/model-builder/scene-input.mjs'
import {runStepsAsync} from '../app/model-builder/cooperative-work.mjs'
import {orientationViewCamera} from '../app/model-builder/orientation-view-camera.mjs'

test('base input collection yields without changing transformed triangle coordinates or the original scan',async()=>{
 const root=new THREE.Group(),source=new THREE.Group();root.position.set(14,8,3);root.rotation.set(.1,.2,.3);source.position.set(1,2,3);source.rotation.set(.4,.1,.5)
 const positions=Float32Array.from({length:90000},(_,i)=>Math.sin(i*.04)),geometry=new THREE.BufferGeometry().setAttribute('position',new THREE.BufferAttribute(positions,3));source.add(new THREE.Mesh(geometry));root.add(source)
 const before=positions.slice(),expected=collectTrianglesInRoot(source,root);let pauses=0
 const actual=await runStepsAsync(collectTrianglesInRootSteps(source,root),{budget:0,pause:async()=>{pauses++}})
 assert.ok(pauses>=3);assert.deepEqual(actual,expected);assert.deepEqual(positions,before)
 root.remove(source);const detached=await runStepsAsync(collectTrianglesInRootSteps(source,root));assert.equal(detached.length,expected.length);assert.ok(detached.every((value,i)=>Math.abs(value-expected[i])<1e-9))
})
test('shared orthographic view cameras fit all four directions without changing source bounds',()=>{
 const bounds=new THREE.Box3(new THREE.Vector3(-30,-5,-22),new THREE.Vector3(30,15,22)),before=bounds.clone()
 for(const view of ['top','side-left','front','side-right']){
  const camera=new THREE.OrthographicCamera();orientationViewCamera(camera,bounds,view,1.6,[0,0,0],80,-1);camera.updateMatrixWorld(true)
  assert.ok(camera.left<camera.right&&camera.bottom<camera.top);assert.ok(camera.near>0&&camera.far>camera.near)
  for(const x of [-30,30])for(const y of [-5,15])for(const z of [-22,22]){const p=new THREE.Vector3(x,y,z).project(camera);assert.ok(Math.abs(p.x)<1&&Math.abs(p.y)<1)}
 }
 assert.ok(bounds.equals(before))
})
