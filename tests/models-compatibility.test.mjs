import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import Module from 'manifold-3d'
import {hollowFinishedModel} from '../app/models/hollow-finished-model.mjs'
import {processFinishedModel,finishManualLabels} from '../app/models/process.mjs'
import {encodeSTL,readSTL} from '../app/models/stl.mjs'
import {indexed} from '../app/model-builder/engine.mjs'
import {fromManifold} from '../app/model-builder/engine.mjs'
import {separateFloat32Contacts} from '../app/models/float32-contacts.mjs'
import {convertFinishedBase} from '../app/models/convert-finished-base.mjs'
import {contactArea} from '../app/model-builder/finished-model-tags.mjs'
const M=await Module();M.setup()
function bytes(solid){const m=solid.getMesh();return encodeSTL(m.vertProperties,m.triVerts)}
function solid(buffer){const raw=readSTL(buffer),d=indexed(raw,{exact:true}),mesh=new M.Mesh({numProp:3,vertProperties:Float32Array.from(d.vertices),triVerts:Uint32Array.from(d.faces)});mesh.merge();return new M.Manifold(mesh)}
test('extension preserves low embossed names and an isolated annular implant footprint',async()=>{
 const allocated=[],own=s=>{allocated.push(s);return s}
 try{
  const outer=own(M.Manifold.cube([60,35,18]).translate([-30,-17.5,0])),inner=own(M.Manifold.cube([54,29,18]).translate([-27,-14.5,-3])),shell=own(outer.subtract(inner))
  const boss=own(M.Manifold.cylinder(16,4,4,64).translate([0,0,0])),bore=own(M.Manifold.cylinder(25,1,1,64).translate([0,0,-1])),name=own(M.Manifold.cube([10,1,1]).translate([-5,17,1]))
  const original=own(own(own(shell.add(boss)).add(name)).subtract(bore)),result=await processFinishedModel(M,bytes(original),{convertBase:true,extendBase:true,holes:false,bevel:1,logo:false},{})
  const output=own(solid(result.stl)),protectedBefore=own(original.trimByPlane([0,0,1],.02)),protectedAfter=own(output.trimByPlane([0,0,1],.02))
  assert.ok(Math.abs(own(protectedBefore.subtract(protectedAfter)).volume())<.01)
  const excess=Math.abs(own(protectedAfter.subtract(protectedBefore)).volume());assert.ok(excess<.01,`added ${excess} ${JSON.stringify(own(protectedAfter.subtract(protectedBefore)).boundingBox())}`)
  const floor=own(output.slice(-2.49)),probe=own(M.CrossSection.circle(4.1,64)),bossFoot=own(floor.intersect(probe))
  assert.ok(Math.abs(bossFoot.area()-Math.PI*(16-1))<.5)
 }finally{allocated.reverse().forEach(s=>s.delete())}
})
test('a solid model is hollowed through its printing face while retaining the outer skin',()=>{
 const shape=M.Manifold.cube([24,20,16]),data=readSTL(bytes(shape)),result=hollowFinishedModel(M,data,{wall:2.5})
 assert.equal(result.hollowed,true);assert.ok(result.removedVolume>100)
 const d=indexed(result.raw,{exact:true}),mesh=new M.Mesh({numProp:3,vertProperties:Float32Array.from(d.vertices),triVerts:Uint32Array.from(d.faces)});mesh.merge();const out=new M.Manifold(mesh),floor=out.slice(.02),parts=out.decompose()
 try{assert.equal(out.status(),'NoError');assert.equal(parts.length,1);assert.ok(floor.toPolygons().length>=2);assert.ok(out.volume()<shape.volume());assert.deepEqual(out.boundingBox(),shape.boundingBox())}finally{floor.delete();parts.forEach(p=>p.delete());out.delete();shape.delete()}
})
test('unplaceable text retains a clean preview and can be manually completed without regenerating the base',async()=>{
 const outer=M.Manifold.cube([60,35,16]),inner=M.Manifold.cube([54,29,16]).translate([3,3,-3]),shape=outer.subtract(inner)
 const fonts={500:JSON.parse(fs.readFileSync(new URL('../public/wasm/model-builder/inter-500-font.json',import.meta.url)))}
 try{
  const result=await processFinishedModel(M,bytes(shape),{convertBase:false,logo:false,tag:'W'.repeat(60),tagSize:12},fonts)
  assert.equal(result.status,'needs-placement');assert.ok(result.manual.base.positions.length);assert.equal(result.stl,undefined)
  const pending=[{...result.manual.pending[0],text:'TEST',size:3,position:[30,5,-35],normal:[0,0,-1]}]
  const finished=await finishManualLabels(M,result.manual,pending,fonts)
  assert.equal(finished.status,'ready',finished.message);assert.ok(finished.stl);assert.equal(finished.report.extendedBy,0)
 }finally{shape.delete();inner.delete();outer.delete()}
})
test('touching cavity sheets remain printable after Float32 welding and the printing face stays flat',()=>{
 const a=M.Manifold.cube([2,5,2]),b=M.Manifold.cube([2,5,2]).translate([2,0,2]),roof=M.Manifold.cube([4,1,4]).translate([0,4,0]),shape=M.Manifold.union([a,b,roof]),d=fromManifold(shape),p=Float32Array.from(d.vertices),f=Uint32Array.from(d.faces)
 try{
  assert.throws(()=>encodeSTL(p,f),/uzavřenosti/)
  const repaired=separateFloat32Contacts(p,f),stl=encodeSTL(repaired,f),roundtrip=solid(stl),parts=roundtrip.decompose()
  assert.equal(roundtrip.status(),'NoError');assert.equal(parts.length,1)
  for(let i=1;i<p.length;i+=3)if(p[i]===0)assert.equal(repaired[i],0)
  for(let i=0;i<p.length;i+=3)assert.ok(Math.hypot(...[0,1,2].map(k=>p[i+k]-repaired[i+k]))<.00301)
  parts.forEach(p=>p.delete());roundtrip.delete()
 }finally{shape.delete();roof.delete();b.delete();a.delete()}
})
test('drains retain their full crown above short extensions and open into the main cavity',async()=>{
 const contour=[]
 for(let i=0;i<=64;i++){const t=i*Math.PI/64;contour.push([33*Math.cos(t),28*Math.sin(t)])}
 for(let i=64;i>=0;i--){const t=i*Math.PI/64;contour.push([23*Math.cos(t),18*Math.sin(t)])}
 const section=new M.CrossSection([contour],'EvenOdd'),inside=section.offset(-2.5,'Round',2,32),outer=section.extrude(18),cavity=inside.extrude(15),shape=outer.subtract(cavity)
 try{
  for(const [height,bevel] of [[1.5,1],[2,1],[2.5,1],[5,1],[2.5,0]]){
   const result=await convertFinishedBase(M,readSTL(bytes(shape)),{extendBase:true,replaceHeight:height,bevel,holes:true,diameter:6})
   assert.equal(result.holes.length,2)
   assert.ok(contactArea(result)>=section.area()-inside.area()-.05)
   for(const hole of result.holes){assert.ok(hole.removedVolume>0);assert.equal(hole.position[1],1.5);assert.equal(hole.openingHeight,4.5);assert.equal(hole.through,true);assert.ok(hole.cavityOverlapVolume>=5);assert.ok(hole.position[1]-hole.diameter/2<0)}
   const local=result.positions.slice();for(let i=0;i<local.length;i+=3){const y=local[i+1];local[i+1]=-local[i+2];local[i+2]=y}
   const m=new M.Mesh({numProp:3,vertProperties:local,triVerts:result.indices});m.merge();const out=new M.Manifold(m),shifted=shape.translate([0,0,height-.001]),probeZ=4.2,a=shifted.slice(probeZ),b=out.slice(probeZ),missing=a.subtract(b),aboveBefore=shifted.trimByPlane([0,0,1],5.1),aboveAfter=out.trimByPlane([0,0,1],5.1),lostAbove=aboveBefore.subtract(aboveAfter),addedAbove=aboveAfter.subtract(aboveBefore)
   try{assert.equal(out.status(),'NoError');if(height<probeZ)assert.ok(missing.area()>.1,'the crown must actually cut original material above the extension');assert.ok(lostAbove.volume()<.01);assert.ok(addedAbove.volume()<.01)}finally{addedAbove.delete();lostAbove.delete();aboveAfter.delete();aboveBefore.delete();missing.delete();b.delete();a.delete();shifted.delete();out.delete()}
   const p=result.positions.slice();for(let i=0;i<p.length;i+=3){const y=p[i+1];p[i+1]=-p[i+2];p[i+2]=y+result.baseZ}assert.ok(encodeSTL(p,result.indices).byteLength>84)
  }
 }finally{shape.delete();cavity.delete();outer.delete();inside.delete();section.delete()}
})
