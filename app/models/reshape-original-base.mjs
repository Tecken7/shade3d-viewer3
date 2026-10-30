import * as THREE from 'three'
import {MeshBVH} from 'three-mesh-bvh'
import {indexed,stitch,fromManifold} from '../model-builder/engine.mjs'
import {prepareBevelRings} from '../model-builder/base-profile.mjs'
import {sampleContour} from '../model-builder/transition.mjs'
import {holeDirection,nearestContourPosition,contourPosition} from '../model-builder/hole-placement.mjs'
import {finishedModelEnds} from './distal-ends.mjs'
import {polygonArea,pointInPolygon,detectBaseRelief} from './base-protection.mjs'
import {separateFloat32Contacts} from './float32-contacts.mjs'

// Work in the original STL Z-up coordinates. Neither the printing plane nor
// the die/pin seating depth moves. Only a protected outside wedge is removed.
export async function reshapeOriginalBase(M,positions,settings={},progress=()=>{}){
 const allocated=[],own=o=>{allocated.push(o);return o},bevel=Number(settings.bevel??1),diameter=Number(settings.diameter??6)
 if(!Number.isFinite(bevel)||bevel<0||bevel>1.5||!Number.isFinite(diameter)||diameter<2||diameter>8)throw Error('Bevel musí být 0–1,5 mm a průměr otvorů 2–8 mm.')
 const zones=settings.protectedZones||[]
 if(zones.length>50||zones.some(z=>!Array.isArray(z.center)||z.center.length!==2||z.center.some(v=>!Number.isFinite(v))||!Number.isFinite(z.radius)||z.radius<.5||z.radius>10))throw Error('Neplatná ochranná oblast.')
 let surface,baseZ=Infinity
 for(let i=2;i<positions.length;i+=3)baseZ=Math.min(baseZ,positions[i])
 const raw=positions.slice();for(let i=2;i<raw.length;i+=3)raw[i]-=baseZ
 try{
  progress('Kontroluji původní bázi a dosednutí pinů…')
  const d=indexed(raw,{exact:true}),mesh=new M.Mesh({numProp:3,vertProperties:Float32Array.from(d.vertices),triVerts:Uint32Array.from(d.faces)});mesh.merge()
  const original=own(new M.Manifold(mesh));if(original.status()!=='NoError')throw Error('Model nemá uzavřenou platnou síť.')
  const floor=own(original.slice(.001)),polygons=floor.toPolygons(),outers=polygons.filter(p=>polygonArea(p)>0).sort((a,b)=>polygonArea(b)-polygonArea(a)),voids=polygons.filter(p=>polygonArea(p)<0)
  if(!outers.length)throw Error('Chybí rovná dosedací plocha modelu.')
  const functional=settings.sourceFunctionalContours?.map(c=>c.points),isResinVoid=p=>{if(!functional)return Math.abs(polygonArea(p))>100;const center=p.reduce((a,v)=>[a[0]+v[0]/p.length,a[1]+v[1]/p.length],[0,0]);return Math.abs(polygonArea(p))>.1&&!functional.some(hole=>pointInPolygon(center,hole))},outline=own(new M.CrossSection([outers[0]],'EvenOdd')),flowVoids=voids.filter(isResinVoid)
  if(!flowVoids.length)throw Error('Nenašel jsem hlavní otevřenou dutinu. Zkontrolujte vydutění modelu.')
  surface=new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(d.vertices,3)).setIndex(d.faces);surface.boundsTree=new MeshBVH(surface)
  progress('Vyhledávám reliéf původních tagů…')
  const relief=detectBaseRelief(surface,outers[0],bevel),guards=[]
  for(const p of settings.sourceFunctionalContours?settings.sourceFunctionalContours.map(c=>c.points):voids.filter(p=>Math.abs(polygonArea(p))<=100)){const guard=own(own(new M.CrossSection([p],'EvenOdd')).offset(3,'Round',2,48));guards.push(guard)}
  for(const p of outers.slice(1)){const guard=own(own(new M.CrossSection([p],'EvenOdd')).offset(.8,'Round',2,48));guards.push(guard)}
  for(const zone of [...relief,...zones]){const guard=own(own(M.CrossSection.circle(zone.radius,32)).translate(zone.center));guards.push(guard)}
  const seed=own(M.CrossSection.circle(1,12));let guard=own(seed.subtract(seed))
  for(const part of guards)guard=own(guard.add(part))
  const emptySolid=own(M.Manifold.cube([1,1,1]));const guardSolid=guard.area()>1e-8?own(own(guard.extrude(Math.max(bevel+2,diameter+3))).translate([0,0,-.1])):own(emptySolid.subtract(emptySolid))
  let result=original,wedge=null
  if(bevel>0){
   progress('Vytvářím lokální bevel v původní výšce…')
   const vertices=[],faces=[],ring=(p,z)=>p.map(([x,y])=>{const id=vertices.length/3;vertices.push(x,y,z);return id}),top=ring(outers[0],bevel);let previous=top
   for(const profile of prepareBevelRings(M,outers[0],bevel,own)){const next=ring(profile.points,-profile.y);const vertical=vertices.map((v,i)=>i%3===0?v:i%3===1?vertices[i+1]:-vertices[i-1]);stitch(vertical,faces,previous,next);previous=next}
   const cap=(ids,up)=>{const poly=ids.map(id=>new THREE.Vector2(vertices[id*3],vertices[id*3+1]));for(const tri of THREE.ShapeUtils.triangulateShape(poly,[])){let [a,b,c]=tri.map(i=>ids[i]);const va=new THREE.Vector3().fromArray(vertices,a*3),vb=new THREE.Vector3().fromArray(vertices,b*3),vc=new THREE.Vector3().fromArray(vertices,c*3);if(vb.sub(va).cross(vc.sub(va)).z*up<0)[b,c]=[c,b];faces.push(a,b,c)}}
   cap(top,1);cap(previous,-1)
   let volume=0;for(let i=0;i<faces.length;i+=3){const [a,b,c]=faces.slice(i,i+3).map(id=>new THREE.Vector3().fromArray(vertices,id*3));volume+=a.dot(b.cross(c))/6}if(volume<0)for(let i=0;i<faces.length;i+=3)[faces[i+1],faces[i+2]]=[faces[i+2],faces[i+1]]
   const keep=own(new M.Manifold(new M.Mesh({numProp:3,vertProperties:Float32Array.from(vertices),triVerts:Uint32Array.from(faces)})))
   if(keep.status()!=='NoError')throw Error('Obrys není vhodný pro automatický bevel. Zmenšete bevel.')
   wedge=own(own(own(outline.extrude(bevel)).subtract(keep)).subtract(guardSolid));result=own(original.subtract(wedge))
  }
  const contour=sampleContour(outers[0],.4).map(([x,y])=>[x,0,-y]),perimeter=contour.reduce((n,p,i)=>n+Math.hypot(p[0]-contour[(i+1)%contour.length][0],p[2]-contour[(i+1)%contour.length][2]),0),holes=[],cutters=[]
  const depth=1.5,cutHeight=depth+diameter/2,flowSection=own(original.slice(depth)),cavityPolys=flowSection.toPolygons().filter(p=>polygonArea(p)<0&&isResinVoid(p))
  if(settings.holes!==false){
   progress('Hledám průchozí odtoky mimo tagy a uložení pahýlů…')
   for(const end of finishedModelEnds(contour)){
    const start=nearestContourPosition(contour,end).fraction;let chosen=null
    for(const offset of [0,2,-2,4,-4,6,-6,9,-9,12,-12,16,-16,20,-20]){
     for(const yaw of [0,20,-20,40,-40]){
     const candidate=contourPosition(contour,(start+offset/perimeter+1)%1);if(holes.some(h=>Math.hypot(h.position[0]-candidate[0],h.position[2]-candidate[2])<diameter*1.5))continue
     const normal=holeDirection(contour,candidate,yaw),outward=new THREE.Vector3(normal[0],-normal[2],0),point=new THREE.Vector3(candidate[0],-candidate[2],depth),ray=new THREE.Ray(point.clone().addScaledVector(outward,3),outward.clone().negate())
     const hits=surface.boundsTree.raycast(ray,THREE.DoubleSide,0,30).sort((a,b)=>a.distance-b.distance),entry=hits.find(h=>h.face.normal.dot(ray.direction)<-.2),exit=entry&&hits.find(h=>h.distance>entry.distance+.1&&h.face.normal.dot(ray.direction)>.2&&cavityPolys.some(p=>pointInPolygon([h.point.x-outward.x*.1,h.point.y-outward.y*.1],p)))
     if(!exit)continue
     const next=hits.find(h=>h.distance>exit.distance+.1&&h.face.normal.dot(ray.direction)<-.2),length=Math.min(exit.distance+4,next?next.distance-.3:30)
     if(length-exit.distance<1)continue
     const q=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,1),ray.direction),matrix=new THREE.Matrix4().compose(ray.origin,q,new THREE.Vector3(1,1,1)),cutter=own(own(M.Manifold.cylinder(length,diameter/2,diameter/2,96,false)).transform(matrix.toArray()))
     if(own(cutter.intersect(guardSolid)).volume()>.005)continue
     if(own(original.intersect(cutter)).volume()<5)continue
     chosen={cutter,point,outward,length,exit:exit.distance};break
     }if(chosen)break
    }
    if(!chosen)continue
    cutters.push(chosen.cutter);holes.push({position:[chosen.point.x,depth,-chosen.point.y],normal:[chosen.outward.x,0,-chosen.outward.y],diameter,openingHeight:cutHeight,through:true,length:chosen.length})
   }
  }
  if(settings.holes!==false&&!holes.length)throw Error('Pro odtok není bezpečné průchozí místo mimo tag nebo uložení pinu. Zmenšete průměr otvorů nebo upravte ochranné oblasti.')
  const warnings=settings.holes!==false&&holes.length<2?['Druhý odtok byl vynechán: zasahoval by do funkčního detailu nebo neměl průchod do dutiny.']:[]
  // Compensate contact only inside the large resin cavities. Pin/sleeve seating
  // and every protected region are excluded from both addition and subtraction.
  const mainVoid=own(new M.CrossSection(flowVoids,'EvenOdd')),cutSections=cutters.map(c=>own(c.slice(.001))),beveledFloor=own(result.slice(.001)),target=floor.area()+1
  const footprint=inset=>{
   const inner=own(mainVoid.offset(-inset,'Round',2,48)),band=own(own(mainVoid.subtract(inner)).subtract(guard));let shape=own(beveledFloor.add(band))
   for(const cut of cutSections)shape=own(shape.subtract(cut))
   return shape.area()
  }
  let inset=0
  if(footprint(0)<target){let lo=0,hi=4;if(footprint(hi)<target){const error=Error('Nelze zachovat dosedací plochu bez zásahu do chráněných míst. Zmenšete bevel nebo otvory.');error.details={floor:floor.area(),beveled:beveledFloor.area(),max:footprint(hi),void:mainVoid.area(),guard:guard.area()};throw error}
   for(let i=0;i<16;i++){const mid=(lo+hi)/2;if(footprint(mid)<target)lo=mid;else hi=mid}inset=hi
  }
  const resinCore=own(mainVoid.offset(-inset,'Round',2,48)).toPolygons()
  for(let i=0;i<cutters.length;i++){
   const hole=holes[i],x=hole.position[0],y=-hole.position[2],nx=hole.normal[0],ny=-hole.normal[2];let connected=false
   for(let distance=3.2;distance<hole.length-.1;distance+=.15){const p=[x+nx*(3-distance),y+ny*(3-distance)];if(resinCore.some(poly=>pointInPolygon(p,poly))){connected=true;break}}
   if(!connected)throw Error('Odtok by nedosáhl do hlavní dutiny po doplnění lemu. Zmenšete bevel nebo upravte umístění ochrany.')
  }
  if(inset>.001){
   progress('Doplňuji vnitřní dosedací lem mimo funkční detaily…')
   const layers=[],height=Math.max(1.2,bevel+.2),steps=32,dy=height/steps,bond=own(own(mainVoid.offset(.3,'Round',2,48)).intersect(outline))
   for(let i=0;i<steps;i++){const t=1-i/steps,amount=inset*t*t*(3-2*t),inner=own(mainVoid.offset(-amount,'Round',2,48)),band=own(own(bond.subtract(inner)).subtract(guard));if(band.area()>.001)layers.push(own(own(band.extrude(dy+.001)).translate([0,0,i*dy])))}
   if(layers.length)result=own(result.add(own(M.Manifold.union(layers))))
  }
  for(const cutter of cutters)result=own(result.subtract(cutter))
  progress('Ověřuji původní dosednutí, chráněná místa a průchodnost…')
  const protectedBefore=own(original.intersect(guardSolid)),protectedAfter=own(result.intersect(guardSolid))
  if(own(protectedBefore.subtract(protectedAfter)).volume()>.02||own(protectedAfter.subtract(protectedBefore)).volume()>.02)throw Error('Úprava zasáhla do chráněného detailu. Model nebyl exportován.')
  const upper=Math.max(bevel+.3,cutHeight+.3),beforeUpper=own(original.trimByPlane([0,0,1],upper)),afterUpper=own(result.trimByPlane([0,0,1],upper))
  if(own(beforeUpper.subtract(afterUpper)).volume()>.01||own(afterUpper.subtract(beforeUpper)).volume()>.01)throw Error('Úprava zasahuje nad spodní pás modelu.')
  // Discard only sub-microscopic Boolean slivers (under 0.00001 mm³).
  const parts=result.decompose().map(own).filter(p=>Math.abs(p.volume())>1e-5);if(result.status()!=='NoError'||parts.length!==1){const error=Error('Úprava by rozdělila model.');error.details=parts.map(p=>({volume:p.volume(),bounds:p.boundingBox()}));throw error}
  result=parts[0];const canonical=fromManifold(result),output=Float32Array.from(canonical.vertices);for(let i=0;i<output.length;i+=3){const y=output[i+1];output[i+1]=output[i+2];output[i+2]=-y}
  return {positions:separateFloat32Contacts(output,Uint32Array.from(canonical.faces)),indices:Uint32Array.from(canonical.faces),placement:{baseY:0,direction:-1},holes,warnings,stats:{volume:result.volume()},baseZ,replaceHeight:bevel,extendedBy:0,baseMode:'original-height',protectedRegions:guards.length,protectedZones:[...relief,...zones],supportInset:inset,protectedHeight:upper}
 }finally{surface?.dispose();allocated.reverse().forEach(o=>o.delete())}
}
