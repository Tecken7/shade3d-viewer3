import * as THREE from 'three'
import {reshapeOriginalBase} from './reshape-original-base.mjs'
import {indexed,stitch,meshTopology,fromManifold} from '../model-builder/engine.mjs'
import {prepareBevelRings} from '../model-builder/base-profile.mjs'
import {distalHolePositions,holeDirection} from '../model-builder/hole-placement.mjs'
import {contactArea} from '../model-builder/finished-model-tags.mjs'
import {separateFloat32Contacts} from './float32-contacts.mjs'
import {finishedModelEnds} from './distal-ends.mjs'
export async function convertFinishedBase(M,positions,settings={},progress=()=>{}){
 if(settings.extendBase!==true)return reshapeOriginalBase(M,positions,settings,progress)
 const allocated=[],own=o=>{allocated.push(o);return o}
 let replaceHeight=Number(settings.replaceHeight??2.5);const bevel=Number(settings.bevel??1),bevelHeight=Number(settings.bevelHeight??bevel),diameter=Number(settings.diameter??4.5)
 if(!Number.isFinite(replaceHeight)||replaceHeight<1||replaceHeight>6||!Number.isFinite(bevel)||bevel<0||bevel>Math.min(1.5,replaceHeight-.1)||!Number.isFinite(diameter)||diameter<2||diameter>6)throw Error('Zkontrolujte výšku úpravy, bevel a průměr otvorů.')
 if(!Number.isFinite(bevelHeight)||bevelHeight<0||bevelHeight>4||bevel>0&&(bevelHeight<.2||bevelHeight>replaceHeight-.1))throw Error('Výška bevelu musí být 0,2–4 mm a menší než výška prodloužení báze.')
 let baseZ=Infinity,maxZ=-Infinity
 for(let i=2;i<positions.length;i+=3){baseZ=Math.min(baseZ,positions[i]);maxZ=Math.max(maxZ,positions[i])}
 const p=positions.slice();for(let i=2;i<p.length;i+=3)p[i]-=baseZ
 if(maxZ-baseZ<replaceHeight+3)throw Error('Pás úpravy zasahuje příliš vysoko do modelu. Zmenšete výšku úpravy.')
 try{
 progress('Kontroluji síť a orientaci modelu…')
const input=indexed(p,{exact:true}),mesh=new M.Mesh({numProp:3,vertProperties:Float32Array.from(input.vertices),triVerts:Uint32Array.from(input.faces)});mesh.merge();const original=own(new M.Manifold(mesh))
if(original.status()!=='NoError')throw Error('Model nemá uzavřenou platnou síť.')
const area=r=>r.reduce((sum,a,i)=>{const b=r[(i+1)%r.length];return sum+a[0]*b[1]-b[0]*a[1]},0)/2
const preserve=settings.preserveOriginal!==false, extension=preserve?replaceHeight:0
let outers,inners,found=false
for(const height of (preserve?[.001]:[...new Set([replaceHeight,...[3,3.5,4,4.5,5,5.5].filter(h=>h>replaceHeight&&h<maxZ-baseZ-3)])])){
 const section=own(original.slice(height)),polys=section.toPolygons()
 outers=polys.filter(r=>area(r)>0).sort((a,b)=>area(b)-area(a));inners=polys.filter(r=>area(r)<0).sort((a,b)=>Math.abs(area(b))-Math.abs(area(a)))
 if(outers.length>=1&&inners.length&&Math.abs(area(inners[0]))>area(outers[0])*.2){if(!preserve)replaceHeight=height;found=true;break}
 if(settings.autoHeight===false)break
}
if(!found)throw Error('Spodní dutina je otevřená nebo členěná. Automatický převod báze není vhodný; můžete vypnout úpravu báze a přidat pouze podpis.')
progress(`Upravuji spodní pás ${replaceHeight.toFixed(1)} mm…`)
progress('Vytvářím bevel a dosedací lem…')
const contour=outers[0].map(([x,y])=>[x,-y]),vertices=[],faces=[]
function ring(points,y){return points.map(([x,z])=>{const id=vertices.length/3;vertices.push(x,y,z);return id})}
const top=ring(contour,replaceHeight);let previous=top
const shoulder=ring(contour,bevelHeight);stitch(vertices,faces,previous,shoulder);previous=shoulder
for(const profile of prepareBevelRings(M,contour,bevel,own,bevelHeight)){const next=ring(profile.points,-profile.y);stitch(vertices,faces,previous,next);previous=next}
function cap(ids,desired){const poly=ids.map(i=>new THREE.Vector2(vertices[i*3],vertices[i*3+2]));for(const t of THREE.ShapeUtils.triangulateShape(poly,[])){let [a,b,c]=t.map(i=>ids[i]);const va=new THREE.Vector3().fromArray(vertices,a*3),vb=new THREE.Vector3().fromArray(vertices,b*3),vc=new THREE.Vector3().fromArray(vertices,c*3);if(vb.sub(va).cross(vc.sub(va)).y*desired<0)[b,c]=[c,b];faces.push(a,b,c)}}
cap(top,1);cap(previous,-1)
// Return to the original 3Shape coordinate system without moving the teeth.
const world=vertices.map((v,i)=>i%3===0?v:i%3===1?-vertices[i+1]:vertices[i-1])
let v=0;for(let i=0;i<faces.length;i+=3){const a=new THREE.Vector3().fromArray(world,faces[i]*3),b=new THREE.Vector3().fromArray(world,faces[i+1]*3),c=new THREE.Vector3().fromArray(world,faces[i+2]*3);v+=a.dot(b.cross(c))/6}if(v<0)for(let i=0;i<faces.length;i+=3)[faces[i+1],faces[i+2]]=[faces[i+2],faces[i+1]]
const rimMesh=new M.Mesh({numProp:3,vertProperties:Float32Array.from(world),triVerts:Uint32Array.from(faces)});rimMesh.merge();const outerRim=own(new M.Manifold(rimMesh));if(outerRim.status()!=='NoError')throw Error('Invalid bevel loft '+outerRim.status())
// Preserve the contact band: the exterior bevel is compensated by an inward
// lip that fades into the original cavity at the untouched joint.
const cavitySection=own(new M.CrossSection([inners[0]],'EvenOdd')),cv=[],cf=[]
let supportInset=bevel
if(preserve&&(bevel>0||settings.holes!==false)){
 const bottom=previous.map(i=>[vertices[i*3],-vertices[i*3+2]]),loss=area(outers[0])-Math.abs(area(bottom)),target=Math.max(1,Math.abs(area(inners[0]))-loss-(settings.holes===false?1:diameter*10+1)-(settings._contactReserve??0)),baseSection=own(new M.CrossSection([inners[0]],'EvenOdd'));let lo=0,hi=4
 for(let i=0;i<18;i++){const mid=(lo+hi)/2,cs=own(baseSection.offset(-mid,'Round',2,48));if(cs.area()>target)lo=mid;else hi=mid}supportInset=hi
}
const profiles=[replaceHeight+.1,...Array.from({length:11},(_,i)=>replaceHeight*(1-i/10)),-.1]
let firstCavity=null,previousCavity=null,splitCavity=false
for(const height of profiles){
 const t=Math.max(0,Math.min(1,1-height/replaceHeight)),inset=supportInset*t*t*(3-2*t)
 const polygons=inset===0?[inners[0]]:own(cavitySection.offset(-inset,'Round',2,48)).toPolygons()
 if(polygons.length!==1){splitCavity=true;break}
 const polygon=area(polygons[0])<0?[...polygons[0]].reverse():polygons[0]
 const ids=polygon.map(([x,y])=>{const id=cv.length/3;cv.push(x,height,-y);return id})
 if(previousCavity)stitch(cv,cf,previousCavity,ids)
 else firstCavity=ids
 previousCavity=ids
}
function cavityCap(ids,desired){const shape=ids.map(i=>new THREE.Vector2(cv[i*3],cv[i*3+2]));for(const t of THREE.ShapeUtils.triangulateShape(shape,[])){let [a,b,c]=t.map(i=>ids[i]);const va=new THREE.Vector3().fromArray(cv,a*3),vb=new THREE.Vector3().fromArray(cv,b*3),vc=new THREE.Vector3().fromArray(cv,c*3);if(vb.sub(va).cross(vc.sub(va)).y*desired<0)[b,c]=[c,b];cf.push(a,b,c)}}
if(!splitCavity){cavityCap(firstCavity,1);cavityCap(previousCavity,-1)}
const cw=cv.map((v,i)=>i%3===0?v:i%3===1?-cv[i+1]:cv[i-1]);let cvol=0
for(let i=0;i<cf.length;i+=3){const a=new THREE.Vector3().fromArray(cw,cf[i]*3),b=new THREE.Vector3().fromArray(cw,cf[i+1]*3),c=new THREE.Vector3().fromArray(cw,cf[i+2]*3);cvol+=a.dot(b.cross(c))/6}
if(cvol<0)for(let i=0;i<cf.length;i+=3)[cf[i+1],cf[i+2]]=[cf[i+2],cf[i+1]]
let cavity
if(splitCavity){
 let joined=null;const slabs=[],steps=16,dy=replaceHeight/steps
 for(let i=0;i<steps;i++){const height=i*dy,t=1-height/replaceHeight,inset=supportInset*t*t*(3-2*t),section=own(cavitySection.offset(-inset,'Round',2,48)),slab=own(section.extrude(dy+.004).translate([0,0,height-.002]));slabs.push(slab)}
 joined=own(M.Manifold.union(slabs));const above=own(cavitySection.extrude(.2).translate([0,0,replaceHeight-.1])),below=own(own(cavitySection.offset(-supportInset,'Round',2,48)).extrude(.2).translate([0,0,-.1]));cavity=own(own(joined.add(above)).add(below))
}else{const cm=new M.Mesh({numProp:3,vertProperties:Float32Array.from(cw),triVerts:Uint32Array.from(cf)});cm.merge();cavity=own(new M.Manifold(cm))}
if(cavity.status()!=='NoError')throw Error('Invalid lip cavity: '+cavity.status())
let rim=own(outerRim.subtract(cavity))
for(const extra of inners.slice(1)){const section=own(new M.CrossSection([extra],'EvenOdd')),voidSolid=own(section.extrude(replaceHeight+.2).translate([0,0,-.1]));rim=own(rim.subtract(voidSolid))}
// Separate implant bosses retain their own annular footprint, without a support lip.
if(preserve)for(const boss of outers.slice(1)){
 const inside=(point,poly)=>{let c=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const a=poly[i],b=poly[j];if((a[1]>point[1])!==(b[1]>point[1])&&point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])c=!c}return c}
 const rings=[boss,...inners.filter(r=>inside(r[0],boss))],guard=own(new M.CrossSection([boss],'EvenOdd').offset(.15,'Round',2,48)),guardSolid=own(guard.extrude(extension+.02));rim=own(rim.subtract(guardSolid));const section=own(new M.CrossSection(rings,'EvenOdd')),solid=own(section.extrude(extension+.01));rim=own(rim.add(solid))
}
const upper=preserve?own(original.translate([0,0,extension-.001])):own(original.trimByPlane([0,0,1],replaceHeight))
let result=own(upper.add(rim));if(result.status()!=='NoError')throw Error('Failed joint '+result.status())
const contourBottom=previous.map(i=>vertices.slice(i*3,i*3+3)),ends=settings.holes===false?[]:finishedModelEnds(contourBottom),holes=[]
// Measure the drain from the new printing plane, independently of extension.
// Its crown must continue into the original base when the added band is short.
const drainHeight=1.5
progress('Umísťuji otvory na konce oblouku…')
for(const end of settings.holes===false?[]:ends){if(!end)throw Error('Missing arch end');const local=[end[0],drainHeight,end[2]],normal=holeDirection(contourBottom,end),point=new THREE.Vector3(local[0],-local[2],local[1]),axis=new THREE.Vector3(normal[0],-normal[2],normal[1]).normalize(),q=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,1),axis.clone().negate()),matrix=new THREE.Matrix4().compose(point.clone().addScaledVector(axis,3),q,new THREE.Vector3(1,1,1)),cutter=own(own(M.Manifold.cylinder(14,diameter/2,diameter/2,96,false)).transform(matrix.toArray()))
 const overlap=own(cutter.intersect(cavity)).volume();if(overlap<Math.min(5,diameter))throw Error('Odtok nedosahuje do hlavní dutiny. Upravte průměr otvoru nebo prodloužení báze.')
 const removed=own(result.intersect(cutter)).volume();if(removed<.1)throw Error('Odtok neprotíná koncovou stěnu modelu.')
 result=own(result.subtract(cutter));holes.push({position:point.toArray(),normal:axis.toArray(),diameter,openingHeight:drainHeight+diameter/2,through:true,cavityOverlapVolume:overlap,removedVolume:removed})}

progress('Kontroluji spojení a dosedací plochu…')
const protectedHeight=Math.max(replaceHeight,1.5+diameter/2)+.3
const beforeProtected=own((preserve?upper:original).trimByPlane([0,0,1],protectedHeight)),afterProtected=own(result.trimByPlane([0,0,1],protectedHeight))
if(Math.abs(own(beforeProtected.subtract(afterProtected)).volume())>.01||Math.abs(own(afterProtected.subtract(beforeProtected)).volume())>.01)throw Error('Úprava zasahuje nad povolený spodní pás. Export byl zastaven.')
progress('Ověřuji souvislost povrchu…')
const parts=result.decompose().map(own)
if(result.status()!=='NoError'||parts.length!==1)throw Error('Výsledek není jeden spojený model.')
progress('Připravuji výslednou geometrii…')
result=own(result.setTolerance(.0001))
const canonical=fromManifold(result)
// Preserve the kernel topology; only separate coincident, non-degenerate
// sheets before Float32 STL welding. Zero-area seam pairs are cancelled by export.
const groups=new Map(),normals=new Float64Array(canonical.vertices.length)
for(let i=0;i<canonical.faces.length;i+=3){const ids=canonical.faces.slice(i,i+3),a=new THREE.Vector3().fromArray(canonical.vertices,ids[0]*3),b=new THREE.Vector3().fromArray(canonical.vertices,ids[1]*3),c=new THREE.Vector3().fromArray(canonical.vertices,ids[2]*3),n=b.sub(a).cross(c.sub(a));for(const id of ids)for(let k=0;k<3;k++)normals[id*3+k]+=n.getComponent(k)}
for(let i=0;i<canonical.vertices.length;i+=3){const key=canonical.vertices.slice(i,i+3).map(Math.fround).join(',');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(i)}
for(const group of groups.values())if(group.length>1){const active=group.filter(o=>new THREE.Vector3().fromArray(normals,o).lengthSq()>1e-16);if(active.length<2)continue;if(preserve&&!settings.repairCoincident)continue;for(const o of active){const floor=Math.abs(canonical.vertices[o+2])<.001,n=new THREE.Vector3().fromArray(normals,o).normalize();for(let k=0;k<3;k++)canonical.vertices[o+k]+=n.getComponent(k)*.002;if(floor)canonical.vertices[o+2]=0}}
const outPositions=Float32Array.from(canonical.vertices)
for(let i=0;i<outPositions.length;i+=3){const y=outPositions[i+1];outPositions[i+1]=outPositions[i+2];outPositions[i+2]=-y}
const output={positions:settings.repairCoincident?separateFloat32Contacts(outPositions,Uint32Array.from(canonical.faces)):outPositions,indices:Uint32Array.from(canonical.faces),placement:{baseY:0,direction:-1},holes:holes.map(h=>({...h,position:[h.position[0],h.position[2],-h.position[1]],normal:[h.normal[0],h.normal[2],-h.normal[1]]})),stats:{volume:result.volume()},baseZ:baseZ-extension+.001*(preserve?1:0),replaceHeight,extendedBy:extension,protectedHeight}
// Use the actual cut footprint rather than assuming the same wall thickness
// at both arch ends. Widen only the internal support lip if drainage took more
// contact area than predicted, without enlarging implant bosses or the outside.
if(preserve&&(bevel>0||settings.holes!==false)&&(settings._contactAttempt??0)<3){
 const expected=own(original.slice(.001)).area(),actual=contactArea(output)
 if(actual+.05<expected){
  const reserve=(settings._contactReserve??0)+(expected+.75-actual)*1.15
  progress('Dolaďuji dosedací lem kolem otvorů…')
  allocated.reverse().forEach(o=>o.delete());allocated.length=0
  return await convertFinishedBase(M,positions,{...settings,_contactReserve:reserve,_contactAttempt:(settings._contactAttempt??0)+1},progress)
 }
}

return output

 }finally{allocated.reverse().forEach(o=>o.delete())}
}
