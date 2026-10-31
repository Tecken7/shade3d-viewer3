import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import Module from 'manifold-3d'
import {processFinishedModel,reviewManualDrains,finishManualDrains,finishManualLabels} from '../app/models/process.mjs'
import {encodeSTL} from '../app/models/stl.mjs'
const M=await Module();M.setup()
const bytes=s=>{const m=s.getMesh();return encodeSTL(m.vertProperties,m.triVerts)}
function arch(){const p=[];for(let i=0;i<=40;i++){const t=i*Math.PI/40;p.push([33*Math.cos(t),28*Math.sin(t)])}for(let i=40;i>=0;i--){const t=i*Math.PI/40;p.push([23*Math.cos(t),18*Math.sin(t)])}const a=new M.CrossSection([p],'EvenOdd'),b=a.offset(-2.5,'Round',2,32),outer=a.extrude(18),inner=b.extrude(15),s=outer.subtract(inner);inner.delete();outer.delete();b.delete();a.delete();return s}
for(const extended of [false,true])test(`finished ${extended?'extended':'native'} models reopen their own cutters and retain a downloadable result until editing is requested`,async()=>{
 const s=arch(),input=bytes(s);s.delete()
 const ready=await processFinishedModel(M,input,{convertBase:true,extendBase:extended,replaceHeight:2,bevel:1,bevelHeight:1,holes:true,diameter:6,logo:false},{})
 assert.equal(ready.status,'ready',ready.message);assert.ok(ready.stl);assert.ok(ready.drainEdit);assert.equal(ready.drainDrafts.length,2)
 const originalBytes=new Uint8Array(ready.stl).slice(),review=await reviewManualDrains(M,ready.drainEdit,ready.drainDrafts)
 assert.equal(review.status,'needs-drains');assert.equal(review.stl,undefined);assert.deepEqual(review.drainReview.holes,ready.drainDrafts)
 const moved=review.drainReview.holes.map((h,i)=>({...h,enabled:i===0,yaw:5,position:[h.position[0],2,h.position[2]],heightOffset:2}))
 const updated=await finishManualDrains(M,review.drainManual,moved,{})
 assert.equal(updated.status,'ready',updated.message);assert.equal(updated.report.drains.length,1);assert.equal(updated.report.drains[0].position[1],2);assert.equal(updated.drainDrafts[1].enabled,false);assert.ok(updated.drainEdit)
 assert.deepEqual(new Uint8Array(ready.stl),originalBytes,'editing must not mutate the previous printable result')
 const reopened=await reviewManualDrains(M,updated.drainEdit,updated.drainDrafts);assert.deepEqual(reopened.drainReview.holes,updated.drainDrafts)
})

test('automatically merged logo and tag reopen on a clean base, and repeated application never stacks text',async()=>{
 const outer=M.Manifold.cube([60,35,16]).translate([-30,-17.5,0]),inner=M.Manifold.cube([55,30,20]).translate([-27.5,-15,-5]),shape=outer.subtract(inner),input=bytes(shape);shape.delete();inner.delete();outer.delete()
 const data=name=>JSON.parse(fs.readFileSync(new URL('../public/wasm/model-builder/'+name,import.meta.url))),fonts={500:data('inter-500-font.json'),logo:data('arthetic-logo-font.json')}
 const ready=await processFinishedModel(M,input,{convertBase:false,logo:true,logoSize:1.8,tag:'MODEL 04',tagSize:4},fonts)
 assert.equal(ready.status,'ready',ready.message);assert.ok(ready.stl);assert.equal(ready.labelEdit.pending.length,2);assert.ok(ready.labelEdit.pending.some(t=>t.brand));assert.ok(ready.labelEdit.pending.every(t=>t.position&&t.normal))
 const clean=ready.labelEdit.base.positions.slice(),moved=ready.labelEdit.pending.map(t=>t.brand?t:{...t,text:'NEW 05',position:[t.position[0]+t.normal[2]*3,t.position[1],t.position[2]-t.normal[0]*3]})
 const changed=await finishManualLabels(M,ready.labelEdit,moved,fonts)
 assert.equal(changed.status,'ready',changed.message);assert.equal(changed.labelEdit.pending.find(t=>!t.brand).text,'NEW 05');assert.deepEqual(changed.labelEdit.base.positions,clean)
 const again=await finishManualLabels(M,changed.labelEdit,changed.labelEdit.pending,fonts)
 assert.equal(again.status,'ready',again.message);assert.deepEqual(new Uint8Array(again.stl),new Uint8Array(changed.stl));assert.deepEqual(ready.labelEdit.base.positions,clean)
})


test('individual base awaiting manual text placement retains editable drains and the unfinished label',async()=>{
 const shape=arch(),input=bytes(shape);shape.delete()
 const fonts={logo:JSON.parse(fs.readFileSync(new URL('../public/wasm/model-builder/arthetic-logo-font.json',import.meta.url)))}
 const result=await processFinishedModel(M,input,{convertBase:true,extendBase:true,replaceHeight:1.8,bevel:1,bevelHeight:1.7,holes:true,diameter:6,logo:true,logoSize:6},fonts)
 assert.equal(result.status,'needs-placement');assert.ok(result.manual);assert.ok(result.drainEdit);assert.equal(result.drainDrafts.length,2)
 assert.equal(result.drainEdit.settings.replaceHeight,1.8);assert.equal(result.drainEdit.settings.bevelHeight,1.7)
 const review=await reviewManualDrains(M,result.drainEdit,result.drainDrafts)
 assert.equal(review.status,'needs-drains');assert.deepEqual(review.drainManual.labelDrafts,result.manual.pending)
 const updated=await finishManualDrains(M,review.drainManual,review.drainReview.holes,fonts)
 assert.equal(updated.status,'needs-placement');assert.ok(updated.drainEdit);assert.ok(updated.manual.pending.some(t=>t.brand));assert.equal(updated.manual.settings.replaceHeight,1.8)
})
