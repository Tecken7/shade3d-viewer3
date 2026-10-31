import test from 'node:test'
import assert from 'node:assert/strict'
import Module from 'manifold-3d'
import {resolveModelSettings} from '../app/models/model-settings.mjs'
import {processFinishedModel} from '../app/models/process.mjs'
import {encodeSTL} from '../app/models/stl.mjs'
const global={convertBase:true,extendBase:false,replaceHeight:2.5,bevel:1,bevelHeight:1.7,holes:false,logo:false,wall:2.5}
test('only enabled per-model base settings override the batch and cannot leak into another model',()=>{
 const original={...global},own={enabled:true,extendBase:true,replaceHeight:3,bevelHeight:2,bevel:.1,wall:5,logo:true}
 assert.deepEqual(resolveModelSettings(global),global);assert.deepEqual(resolveModelSettings(global,{...own,enabled:false}),global)
 const a=resolveModelSettings(global,own),b=resolveModelSettings(global)
 assert.equal(a.extendBase,true);assert.equal(a.replaceHeight,3);assert.equal(a.bevelHeight,2);assert.equal(a.bevel,1);assert.equal(a.wall,2.5);assert.equal(a.logo,false)
 assert.deepEqual(b,original);assert.deepEqual(global,original)
 assert.equal(resolveModelSettings({...global,extendBase:true},{...own,extendBase:false}).extendBase,false)
 assert.equal(resolveModelSettings({...global,convertBase:false},own).convertBase,true)
 for(const patch of [{replaceHeight:0},{replaceHeight:7},{bevelHeight:NaN},{bevelHeight:3}])assert.throws(()=>resolveModelSettings(global,{...own,...patch}),/vlastní/)
})
test('a mixed batch extends only the individually enabled model and leaves its neighbour at the original height',async()=>{
 const M=await Module();M.setup();const a=M.Manifold.cube([60,35,18]),b=M.Manifold.cube([54,29,15]).translate([3,3,0]),s=a.subtract(b),mesh=s.getMesh(),buffer=encodeSTL(mesh.vertProperties,mesh.triVerts);s.delete();b.delete();a.delete()
 const input=new Uint8Array(buffer).slice(),local=await processFinishedModel(M,buffer,resolveModelSettings(global,{enabled:true,extendBase:true,replaceHeight:3,bevelHeight:2}),{}),normal=await processFinishedModel(M,buffer,resolveModelSettings(global),{})
 assert.equal(local.status,'ready');assert.equal(normal.status,'ready');assert.equal(local.report.extendedBy,3);assert.equal(normal.report.extendedBy,0)
 const short=await processFinishedModel(M,buffer,resolveModelSettings(global,{enabled:true,extendBase:true,replaceHeight:1,bevelHeight:.9}),{});assert.equal(short.status,'ready');assert.equal(short.report.extendedBy,1)
 assert.ok(local.report.contactAfter>=local.report.contactBefore-.05);assert.ok(normal.report.contactAfter>=normal.report.contactBefore-.05);assert.deepEqual(new Uint8Array(buffer),input)
})
