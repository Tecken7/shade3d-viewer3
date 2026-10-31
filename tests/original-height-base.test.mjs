import test from 'node:test'
import assert from 'node:assert/strict'
import Module from 'manifold-3d'
import {processFinishedModel,finalizeFinishedModel} from '../app/models/process.mjs'
import {encodeSTL,readSTL} from '../app/models/stl.mjs'
import {indexed,fromManifold} from '../app/model-builder/engine.mjs'
const M=await Module();M.setup()
const bytes=s=>{const m=s.getMesh();return encodeSTL(m.vertProperties,m.triVerts)}
function manifold(buffer){const d=indexed(readSTL(buffer),{exact:true}),mesh=new M.Mesh({numProp:3,vertProperties:Float32Array.from(d.vertices),triVerts:Uint32Array.from(d.faces)});mesh.merge();return new M.Manifold(mesh)}
test('native bevel keeps the printing plane, die seating and low existing relief unchanged',async()=>{
 const allocated=[],own=s=>{allocated.push(s);return s}
 try{
  const outer=own(M.Manifold.cube([60,35,18]).translate([-30,-17.5,0])),inner=own(M.Manifold.cube([54,29,15]).translate([-27,-14.5,0])),shell=own(outer.subtract(inner)),boss=own(M.Manifold.cylinder(16,4,4,64)),bore=own(M.Manifold.cylinder(25,1.4,1.4,64).translate([0,0,-1])),letter=own(M.Manifold.cube([1,.7,1.2]).translate([-8,-18,.25])),crossbar=own(M.Manifold.cube([4,.7,.35]).translate([-8,-18,.8])),original=own(own(own(own(shell.add(boss)).subtract(bore)).add(letter)).add(crossbar))
  const result=await processFinishedModel(M,bytes(original),{convertBase:true,bevel:1,holes:false,logo:false,autoHollow:false},{})
  assert.equal(result.report.extendedBy,0);assert.equal(result.report.baseMode,'original-height');assert.ok(result.report.protectedRegions>0)
  const output=own(manifold(result.stl));assert.equal(output.status(),'NoError');assert.ok(Math.abs(output.boundingBox().min[2])<.00001);assert.ok(Math.abs(output.boundingBox().max[2]-18)<.00001)
  const pinRegion=own(M.Manifold.cylinder(20,5,5,64).translate([0,0,-.1])),a=own(original.intersect(pinRegion)),b=own(output.intersect(pinRegion))
  assert.ok(own(a.subtract(b)).volume()<.01);assert.ok(own(b.subtract(a)).volume()<.01)
  const tagBox=own(M.Manifold.cube([4.4,1.2,2]).translate([-8.2,-18.3,0])),before=own(original.intersect(tagBox)),after=own(output.intersect(tagBox))
  assert.ok(own(before.subtract(after)).volume()<.01,'low existing tag and its root must survive the bevel')
  assert.ok(result.report.contactAfter>=result.report.contactBefore-.05)
  assert.ok(own(original.subtract(output)).volume()>5,'the unprotected perimeter still receives a bevel')
 }finally{allocated.reverse().forEach(s=>s.delete())}
})
test('a manually protected place is unchanged while the remaining perimeter is beveled',async()=>{
 const a=M.Manifold.cube([60,35,16]),b=M.Manifold.cube([54,29,13]).translate([3,3,0]),original=a.subtract(b)
 try{
  const result=await processFinishedModel(M,bytes(original),{convertBase:true,bevel:1,holes:false,logo:false,protectedZones:[{center:[15,0],radius:4}]},{})
  const out=manifold(result.stl),region=M.Manifold.cylinder(4,3.8,3.8,64).translate([15,0,0]),before=original.intersect(region),after=out.intersect(region),lost=before.subtract(after),added=after.subtract(before)
  assert.ok(lost.volume()<.01);assert.ok(added.volume()<.01);assert.equal(result.report.extendedBy,0)
  added.delete();lost.delete();before.delete();after.delete();region.delete();out.delete()
 }finally{original.delete();b.delete();a.delete()}
})
test('native drains retain their full diameter and connect to a main cavity above the original printing plane',async()=>{
 const contour=[];for(let i=0;i<=64;i++){const t=i*Math.PI/64;contour.push([33*Math.cos(t),28*Math.sin(t)])}for(let i=64;i>=0;i--){const t=i*Math.PI/64;contour.push([23*Math.cos(t),18*Math.sin(t)])}
 const section=new M.CrossSection([contour],'EvenOdd'),inside=section.offset(-2.5,'Round',2,32),a=section.extrude(18),b=inside.extrude(15),original=a.subtract(b)
 try{
  const result=await processFinishedModel(M,bytes(original),{convertBase:true,bevel:1,holes:true,diameter:6,logo:false},{})
  assert.equal(result.report.extendedBy,0);assert.equal(result.report.drains.length,2)
  for(const hole of result.report.drains){assert.equal(hole.through,true);assert.equal(hole.diameter,6);assert.ok(hole.openingHeight>4);assert.ok(hole.length>6)}
  assert.ok(result.report.contactAfter>=result.report.contactBefore-.05)
  const out=manifold(result.stl);assert.equal(out.status(),'NoError');assert.ok(Math.abs(out.boundingBox().min[2])<.00001);out.delete()
 }finally{original.delete();b.delete();a.delete();inside.delete();section.delete()}
})

test('STL verification cleans only numerical micro-fragments and still rejects substantial detached parts',async()=>{
 const main=M.Manifold.cube([20,20,10]),tiny=M.Manifold.cube([.001,.001,.001]).translate([25,0,0]),separate=M.Manifold.cube([1,1,1]).translate([25,0,0])
 async function finish(part){const combined=main.add(part);try{const d=fromManifold(combined),p=Float32Array.from(d.vertices);for(let i=0;i<p.length;i+=3){const y=p[i+1];p[i+1]=p[i+2];p[i+2]=-y}return await finalizeFinishedModel(M,{positions:p,indices:Uint32Array.from(d.faces),placement:{baseY:0,direction:-1}},{baseZ:0,before:400,settings:{convertBase:false},labels:[]})}finally{combined.delete()}}
 try{const result=await finish(tiny),out=manifold(result.stl),parts=out.decompose();try{assert.equal(parts.length,1);assert.equal(out.status(),'NoError')}finally{parts.forEach(p=>p.delete());out.delete()}await assert.rejects(finish(separate),/jeden uzavřený celek/)}finally{main.delete();tiny.delete();separate.delete()}
})

test('contact compensation never adds a ring around an implant boss attached to the inner wall',async()=>{
 const allocated=[],own=s=>{allocated.push(s);return s}
 try{
  const outer=own(M.Manifold.cube([60,35,18]).translate([-30,-17.5,0])),inner=own(M.Manifold.cube([54,29,15]).translate([-27,-14.5,0])),shell=own(outer.subtract(inner)),boss=own(M.Manifold.cylinder(16,4.5,4.5,64).translate([0,-12,0])),bore=own(M.Manifold.cylinder(25,1.5,1.5,64).translate([0,-12,-1])),original=own(own(shell.add(boss)).subtract(bore))
  const result=await processFinishedModel(M,bytes(original),{convertBase:true,bevel:1.5,holes:false,logo:false,autoHollow:false},{})
  const output=own(manifold(result.stl)),region=own(M.Manifold.cylinder(2,7.5,7.5,96).translate([0,-12,0])),before=own(original.intersect(region)),after=own(output.intersect(region))
  assert.ok(own(after.subtract(before)).volume()<.01,'a new contact ring must not enlarge the original implant shoulder')
  assert.ok(result.report.contactAfter>=result.report.contactBefore-.05)
 }finally{allocated.reverse().forEach(p=>p.delete())}
})


test('bevel height changes the vertical profile independently of width without moving the printing plane or losing contact',async()=>{
 const outer=M.Manifold.cube([60,35,18]),inner=M.Manifold.cube([54,29,15]).translate([3,3,0]),original=outer.subtract(inner),allocated=[],own=s=>{allocated.push(s);return s}
 const convert=async settings=>{const result=await processFinishedModel(M,bytes(original),{convertBase:true,bevel:1,holes:false,logo:false,...settings},{});assert.equal(result.status,'ready');assert.ok(result.report.contactAfter>=result.report.contactBefore-.05);const solid=own(manifold(result.stl));assert.equal(solid.status(),'NoError');assert.deepEqual(solid.boundingBox(),original.boundingBox());return solid}
 const minX=(s,z)=>{const section=s.slice(z);try{return Math.min(...section.toPolygons().flat().map(p=>p[0]))}finally{section.delete()}}
 try{
  const legacy=await convert({}),same=await convert({bevelHeight:1}),tall=await convert({bevelHeight:2.5}),narrow=await convert({bevelHeight:2.5,bevel:.5})
  const difference=own(legacy.subtract(same));assert.ok(difference.volume()<.001,'omitting height must preserve the old 45 degree profile')
  assert.ok(Math.abs(minX(legacy,.001)-minX(tall,.001))<.002,'height must not increase bottom inset')
  assert.ok(Math.abs(minX(tall,1)-.6)<.015,'1 mm wide / 2.5 mm tall bevel must still be sloped at z=1')
  assert.ok(Math.abs(minX(legacy,1.1))<.001,'old 1 mm high bevel has already ended')
  assert.ok(Math.abs(minX(narrow,1)-.3)<.015,'width must remain independently adjustable')
  const protectedRegion=own(M.Manifold.cube([65,40,15]).translate([-2,-2,3])),before=own(original.intersect(protectedRegion)),after=own(tall.intersect(protectedRegion));assert.ok(own(before.subtract(after)).volume()<.001);assert.ok(own(after.subtract(before)).volume()<.001)
  for(const bevelHeight of [NaN,-1,0,5])await assert.rejects(convert({bevelHeight}),/Výška/)
 }finally{allocated.reverse().forEach(s=>s.delete());original.delete();inner.delete();outer.delete()}
})
