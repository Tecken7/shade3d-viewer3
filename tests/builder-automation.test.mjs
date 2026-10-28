import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import {orientationLandmarks} from '../app/model-builder/auto-orientation.mjs'
import {DEFAULTS} from '../app/model-builder/defaults.mjs'
import {distalHolePositions} from '../app/model-builder/hole-placement.mjs'

test('automatic orientation proposes a proper reference frame for either arch and keeps samples unchanged',()=>{
 const rotation=new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(.6,.9,-.3))
 const up=new THREE.Vector3(0,1,0).transformDirection(rotation),front=new THREE.Vector3(0,0,1).transformDirection(rotation),before=[up.toArray(),front.toArray()]
 for(const arch of ['upper','lower']){
   const points=orientationLandmarks({up,front,confidence:.8},new THREE.Vector3(3,4,5),50,arch)
   const [left,right,anterior]=points.map(p=>new THREE.Vector3().fromArray(p))
   const x=right.clone().sub(left).normalize(),z=anterior.sub(left.clone().add(right).multiplyScalar(.5)).normalize(),base=x.clone().cross(z)
   assert.ok(Math.abs(x.dot(z))<1e-10)
   assert.ok(base.dot(up)*(arch==='upper'?1:-1)>.999)
   assert.ok(new THREE.Matrix4().makeBasis(x,z,base).determinant()>.999)
 }
 assert.deepEqual([up.toArray(),front.toArray()],before)
 assert.equal(orientationLandmarks({up,front,confidence:.1},new THREE.Vector3(),50,'upper'),null)
})
test('world orientation is converted into the viewer root coordinates',()=>{
 const frame=new THREE.Matrix4().makeRotationY(.8)
 const up=new THREE.Vector3(0,1,0).transformDirection(frame),front=new THREE.Vector3(0,0,1).transformDirection(frame)
 const points=orientationLandmarks({up,front,confidence:.8},new THREE.Vector3(),50,'lower',frame.clone().invert())
 assert.ok(points[2][2]>0);assert.ok(Math.abs(points[2][0])<1e-10)
})
test('default drain centres follow both distal ends rather than the anterior wall, for either winding and arch',()=>{
 const ring=[]
 for(let i=0;i<=50;i++){const a=Math.PI*i/50;ring.push([10*Math.cos(a),20,-10*Math.sin(a)])}
 for(let i=50;i>=0;i--){const a=Math.PI*i/50;ring.push([7*Math.cos(a),20,-7*Math.sin(a)])}
 for(const sign of [-1,1])for(const reverse of [false,true]){
   const contour=ring.map(p=>[p[0]+27,p[1],sign*p[2]+15]);if(reverse)contour.reverse()
   const before=structuredClone(contour),positions=distalHolePositions(contour,sign)
   assert.ok(positions[0][0]<21);assert.ok(positions[1][0]>33)
   for(const p of positions)assert.ok((p[2]-15)*sign>-.7)
   assert.deepEqual(contour,before)
 }
})

test('new model bases default to 20 mm',()=>assert.equal(DEFAULTS.totalHeight,20))
