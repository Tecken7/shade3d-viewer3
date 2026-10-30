import test from 'node:test'
import assert from 'node:assert/strict'
import Module from 'manifold-3d'
import {processFinishedModel} from '../app/models/process.mjs'
import {encodeSTL,readSTL} from '../app/models/stl.mjs'
import {indexed} from '../app/model-builder/engine.mjs'
import {finishedModelEnds} from '../app/models/distal-ends.mjs'
const M=await Module();M.setup()
const outer=M.Manifold.cube([60,35,16],true).translate([0,0,8]),inner=M.Manifold.cube([55,30,20],true).translate([0,0,5]),shape=outer.subtract(inner),mesh=shape.getMesh()
const buffer=encodeSTL(mesh.vertProperties,mesh.triVerts);shape.delete();inner.delete();outer.delete()
test('browser pipeline modifies a hollow base, preserves contact and exports a closed STL',async()=>{
 const before=new Uint8Array(buffer).slice(),result=await processFinishedModel(M,buffer,{convertBase:true,extendBase:true,replaceHeight:2.5,bevel:0,holes:false,logo:false},{})
 assert.deepEqual(new Uint8Array(buffer),before);assert.ok(result.report.contactAfter>=result.report.contactBefore-.05)
 const beveled=await processFinishedModel(M,buffer,{convertBase:true,extendBase:true,replaceHeight:2.5,bevel:1,holes:false,logo:false},{})
 assert.ok(beveled.report.contactAfter>=beveled.report.contactBefore-.05);assert.equal(beveled.report.extendedBy,2.5)
 assert.equal(result.report.openEdges,0);assert.equal(result.report.components,1)
 const raw=readSTL(result.stl);assert.ok(raw.length>0);assert.ok(indexed(raw,{exact:true}).faces.length)
})
test('text-only pass-through keeps a model unchanged and invalid base settings are rejected',async()=>{
 const result=await processFinishedModel(M,buffer,{convertBase:false,logo:false},{})
 assert.ok(Math.abs(result.report.contactBefore-result.report.contactAfter)<.001)
 await assert.rejects(()=>processFinishedModel(M,buffer,{convertBase:true,extendBase:true,replaceHeight:20,bevel:1},{ }),/Zkontrolujte/)
})
test('corrupt or non-finite STL is never processed as a printable result',()=>{
 assert.throws(()=>readSTL(new ArrayBuffer(4)))
 const bad=buffer.slice(0);new DataView(bad).setFloat32(96,NaN,true);assert.throws(()=>readSTL(bad),/platné/)
})
test('distal holes follow the arch when a finished model is rotated for export',()=>{
 const contour=[]
 for(let i=0;i<=160;i++){const t=i*Math.PI/160;contour.push([33*Math.cos(t),0,28*Math.sin(t)])}
 for(let i=160;i>=0;i--){const t=i*Math.PI/160;contour.push([27*Math.cos(t),0,22*Math.sin(t)])}
 const ends=finishedModelEnds(contour);assert.ok(ends.every(p=>p[2]<5))
 for(const angle of [Math.PI/2,Math.PI,Math.PI/4]){
  const rotate=p=>[p[0]*Math.cos(angle)-p[2]*Math.sin(angle)+100,p[1],p[0]*Math.sin(angle)+p[2]*Math.cos(angle)-40]
  const actual=finishedModelEnds(contour.map(rotate)),expected=ends.map(rotate)
  assert.ok(actual.every(p=>Math.min(...expected.map(q=>Math.hypot(p[0]-q[0],p[2]-q[2])))<2))
 }
})
