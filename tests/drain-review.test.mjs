import test from 'node:test'
import assert from 'node:assert/strict'
import Module from 'manifold-3d'
import * as THREE from 'three'
import {MeshBVH} from 'three-mesh-bvh'
import {inspectDrainPassage} from '../app/models/drain-placement.mjs'
import {processFinishedModel,finishManualDrains} from '../app/models/process.mjs'
import {encodeSTL} from '../app/models/stl.mjs'
const M=await Module();M.setup()
function arch(width=10){const p=[];for(let i=0;i<=40;i++){const t=i*Math.PI/40;p.push([33*Math.cos(t),28*Math.sin(t)])}for(let i=40;i>=0;i--){const t=i*Math.PI/40;p.push([(33-width)*Math.cos(t),(28-width)*Math.sin(t)])}const a=new M.CrossSection([p],'EvenOdd'),b=a.offset(-2.5,'Round',2,32),outer=a.extrude(18),inner=b.extrude(15),solid=outer.subtract(inner);inner.delete();outer.delete();b.delete();a.delete();return solid}
function bytes(s){const m=s.getMesh();return encodeSTL(m.vertProperties,m.triVerts)}
test('full circular clearance rejects a narrow cavity even when the centre ray has a short open path',()=>{
 const outer=M.Manifold.cube([20,10,10]),wide=M.Manifold.cube([12,6,10]).translate([4,2,0]),narrow=M.Manifold.cube([2,6,10]).translate([9,2,0]),clear=outer.subtract(wide),bad=outer.subtract(narrow)
 function inspect(s){const m=s.getMesh(),g=new THREE.BufferGeometry().setAttribute('position',new THREE.BufferAttribute(m.vertProperties,3)).setIndex(new THREE.BufferAttribute(m.triVerts,1));g.boundsTree=new MeshBVH(g);try{return inspectDrainPassage(g,new THREE.Vector3(10,0,1.5),new THREE.Vector3(0,-1,0),3)}finally{g.dispose()}}
 try{const good=inspect(clear),risk=inspect(bad);assert.equal(good.confident,true);assert.ok(good.length<7);assert.equal(risk.confident,false);assert.ok(risk.score>good.score)}finally{bad.delete();clear.delete();narrow.delete();wide.delete();outer.delete()}
})
test('a drain review cannot export or cut until explicit approval; edited drafts can be confirmed and reopened',async()=>{
 const solid=arch(),source=bytes(solid),before=new Uint8Array(source).slice()
 try{
  const draft=await processFinishedModel(M,source,{convertBase:true,bevel:1,diameter:6,holes:true,logo:false,reviewDrains:true},{})
  assert.equal(draft.status,'needs-drains');assert.equal(draft.stl,undefined);assert.equal(draft.drainReview.holes.length,2);assert.deepEqual(new Uint8Array(source),before)
  const holes=draft.drainReview.holes.map((h,i)=>({...h,enabled:i===0,length:h.length+.5}))
  const finished=await finishManualDrains(M,draft.drainManual,holes,{})
  assert.equal(finished.status,'ready',finished.message);assert.equal(finished.report.drains.length,1);assert.ok(finished.stl);assert.equal(finished.report.openEdges,0);assert.equal(finished.drainDrafts[1].enabled,false)
  const reopened=await processFinishedModel(M,source,{convertBase:true,bevel:1,diameter:6,holes:true,logo:false,reviewDrains:true,reviewHoles:finished.drainDrafts},{})
  assert.equal(reopened.status,'needs-drains');assert.deepEqual(reopened.drainReview.holes.map(h=>h.enabled),[true,false]);assert.ok(Math.abs(reopened.drainReview.holes[0].length-holes[0].length)<1e-8)
  await assert.rejects(finishManualDrains(M,draft.drainManual,[{...holes[0],position:[500,1.5,500]}],{}),/stěnu modelu/)
  assert.deepEqual(new Uint8Array(source),before)
 }finally{solid.delete()}
})
test('an oversized proposed drain asks for review instead of automatically cutting into side walls',async()=>{
 const solid=arch(7);try{const result=await processFinishedModel(M,bytes(solid),{convertBase:true,bevel:1,diameter:8,holes:true,logo:false},{});assert.equal(result.status,'needs-drains');assert.equal(result.stl,undefined);assert.ok(result.drainReview.holes.length)}finally{solid.delete()}
})
