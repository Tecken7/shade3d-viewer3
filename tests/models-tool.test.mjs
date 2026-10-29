import test from 'node:test'
import assert from 'node:assert/strict'
import Module from 'manifold-3d'
import {processFinishedModel} from '../app/models/process.mjs'
import {encodeSTL,readSTL} from '../app/models/stl.mjs'
import {indexed} from '../app/model-builder/engine.mjs'
const M=await Module();M.setup()
const outer=M.Manifold.cube([60,35,16],true).translate([0,0,8]),inner=M.Manifold.cube([55,30,20],true).translate([0,0,5]),shape=outer.subtract(inner),mesh=shape.getMesh()
const buffer=encodeSTL(mesh.vertProperties,mesh.triVerts);shape.delete();inner.delete();outer.delete()
test('browser pipeline modifies a hollow base, preserves contact and exports a closed STL',async()=>{
 const before=new Uint8Array(buffer).slice(),result=await processFinishedModel(M,buffer,{convertBase:true,replaceHeight:2.5,bevel:0,holes:false,logo:false},{})
 assert.deepEqual(new Uint8Array(buffer),before);assert.ok(result.report.contactAfter>=result.report.contactBefore-.05)
 await assert.rejects(()=>processFinishedModel(M,buffer,{convertBase:true,replaceHeight:2.5,bevel:1,holes:false,logo:false},{}),/dosedací plochu/)
 assert.equal(result.report.openEdges,0);assert.equal(result.report.components,1)
 const raw=readSTL(result.stl);assert.ok(raw.length>0);assert.ok(indexed(raw,{exact:true}).faces.length)
})
test('text-only pass-through keeps a model unchanged and invalid base settings are rejected',async()=>{
 const result=await processFinishedModel(M,buffer,{convertBase:false,logo:false},{})
 assert.ok(Math.abs(result.report.contactBefore-result.report.contactAfter)<.001)
 await assert.rejects(()=>processFinishedModel(M,buffer,{convertBase:true,replaceHeight:20,bevel:1},{ }),/Zkontrolujte/)
})
test('corrupt or non-finite STL is never processed as a printable result',()=>{
 assert.throws(()=>readSTL(new ArrayBuffer(4)))
 const bad=buffer.slice(0);new DataView(bad).setFloat32(96,NaN,true);assert.throws(()=>readSTL(bad),/platné/)
})
