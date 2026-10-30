import * as THREE from 'three'
import {MeshBVH} from 'three-mesh-bvh'
import {indexed,stitch,fromManifold} from '../model-builder/engine.mjs'
import {prepareBevelRings} from '../model-builder/base-profile.mjs'
import {sampleContour} from '../model-builder/transition.mjs'
import {holeDirection,nearestContourPosition,contourPosition} from '../model-builder/hole-placement.mjs'
import {finishedModelEnds} from './distal-ends.mjs'
import {polygonArea,pointInPolygon,detectBaseRelief,socketSupportRegion} from './base-protection.mjs'
import {inspectDrainPassage} from './drain-placement.mjs'
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
  const relief=detectBaseRelief(surface,outers[0],bevel),guards=[],supportRegions=[]
  for(const p of functional??voids.filter(p=>Math.abs(polygonArea(p))<=100)){const guard=own(own(new M.CrossSection([p],'EvenOdd')).offset(3,'Round',2,48));guards.push(guard);supportRegions.push(socketSupportRegion(p,flowVoids))}
  for(const p of outers.slice(1)){const guard=own(own(new M.CrossSection([p],'EvenOdd')).offset(.8,'Round',2,48));guards.push(guard)}
  for(const zone of [...relief,...zones]){const guard=own(own(M.CrossSection.circle(zone.radius,32)).translate(zone.center));guards.push(guard)}
  const seed=own(M.CrossSection.circle(1,12));let guard=own(seed.subtract(seed))
  for(const part of guards)guard=own(guard.add(part))
  let supportGuard=guard
  for(const region of supportRegions){const area=own(own(M.CrossSection.circle(region.radius,64)).translate(region.center));supportGuard=own(supportGuard.add(area))}
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
  const proposalOnly=!Array.isArray(settings.manualHoles)&&Array.isArray(settings.reviewHoles),manual=Array.isArray(settings.manualHoles)||proposalOnly,manualHoles=settings.manualHoles??settings.reviewHoles,depth=1.5,flowSection=own(original.slice(depth)),cavityPolys=flowSection.toPolygons().filter(p=>polygonArea(p)<0&&isResinVoid(p))
  let cutHeight=depth+diameter/2,uncertain=false
  const cylinder=(point,outward,outer,length,radius)=>{
   const rayOrigin=point.clone().addScaledVector(outward,outer),q=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,1),outward.clone().negate()),matrix=new THREE.Matrix4().compose(rayOrigin,q,new THREE.Vector3(1,1,1))
   return own(own(M.Manifold.cylinder(length,radius,radius,96,false)).transform(matrix.toArray()))
  }
  const add=(candidate,cut)=>{
   cutters.push(cut);holes.push({enabled:true,position:[candidate.point.x,candidate.point.z,-candidate.point.y],normal:[candidate.outward.x,0,-candidate.outward.y],baseDirection:-1,heightOffset:candidate.point.z,yaw:candidate.yaw??0,diameter:candidate.diameter??diameter,openingHeight:candidate.point.z+(candidate.diameter??diameter)/2,through:true,length:candidate.length,outerLength:candidate.outer??4,quality:candidate.quality})
  }
  if(settings.holes!==false&&manual){
   if(manualHoles.length>2)throw Error('Lze umístit nejvýše dva odtoky.')
   for(const hole of manualHoles.filter(h=>h.enabled!==false)){
    if(!Array.isArray(hole.position)||hole.position.length!==3||hole.position.some(v=>!Number.isFinite(v))||![hole.length,hole.outerLength,hole.diameter,hole.yaw??0].every(Number.isFinite)||hole.diameter<2||hole.diameter>8||hole.length<.5||hole.length>30||hole.outerLength<.5||hole.outerLength>20||hole.position[1]<0||hole.position[1]>4)throw Error('Zkontrolujte polohu a rozměry odtokového válce. Výška středu může být 0–4 mm.')
    const normal=holeDirection(contour,hole.position,hole.yaw??0),outward=new THREE.Vector3(normal[0],-normal[2],0),point=new THREE.Vector3(hole.position[0],-hole.position[2],hole.position[1]),candidate={point,outward,yaw:hole.yaw??0,diameter:hole.diameter,outer:hole.outerLength,length:hole.length+hole.outerLength},cut=cylinder(point,outward,candidate.outer,candidate.length,hole.diameter/2)
    if(!proposalOnly&&own(cut.intersect(guardSolid)).volume()>.005)throw Error('Válec zasahuje do chráněného tagu nebo uložení pinu. Posuňte jej nebo zkraťte.')
    if(!proposalOnly&&own(original.intersect(cut)).volume()<5)throw Error('Válec neprotíná dostatečně stěnu modelu. Posuňte jej na okraj.')
    add(candidate,cut);cutHeight=Math.max(cutHeight,point.z+hole.diameter/2)
   }
  }else if(settings.holes!==false){
   progress('Hledám krátký průchod koncovou stěnou…')
   for(const end of finishedModelEnds(contour)){
    const start=nearestContourPosition(contour,end).fraction,candidates=[]
    for(const offset of [0,1,-1,2,-2,3,-3,4,-4,6,-6,8,-8,10,-10,14,-14])for(const yaw of [0,10,-10,20,-20,30,-30,40,-40,50,-50]){
     const position=contourPosition(contour,(start+offset/perimeter+1)%1);if(holes.some(h=>Math.hypot(h.position[0]-position[0],h.position[2]-position[2])<diameter*1.5))continue
     const normal=holeDirection(contour,position,yaw),outward=new THREE.Vector3(normal[0],-normal[2],0),point=new THREE.Vector3(position[0],-position[2],depth),ray=new THREE.Ray(point.clone().addScaledVector(outward,4),outward.clone().negate())
     const hits=surface.boundsTree.raycast(ray,THREE.DoubleSide,0,30).sort((a,b)=>a.distance-b.distance),entry=hits.find(h=>h.face.normal.dot(ray.direction)<-.2),exit=entry&&hits.find(h=>h.distance>entry.distance+.1&&h.face.normal.dot(ray.direction)>.2&&cavityPolys.some(p=>pointInPolygon([h.point.x-outward.x*.1,h.point.y-outward.y*.1],p)))
     if(!exit)continue
     const quality=inspectDrainPassage(surface,point,outward,diameter/2,4)
     candidates.push({point,outward,yaw,outer:4,length:Math.min(34,quality.length),quality,score:quality.score+Math.abs(offset)*.3+Math.abs(yaw)*.015})
    }
    candidates.sort((a,b)=>Number(b.quality.confident)-Number(a.quality.confident)||a.score-b.score)
    let chosen=null
    for(const candidate of candidates.slice(0,16)){
     const cut=cylinder(candidate.point,candidate.outward,4,candidate.length,diameter/2)
     if(own(cut.intersect(guardSolid)).volume()>.005||own(original.intersect(cut)).volume()<5)continue
     chosen={candidate,cut};break
    }
    if(!chosen){
     const position=contourPosition(contour,start),normal=holeDirection(contour,position),point=new THREE.Vector3(position[0],-position[2],depth),outward=new THREE.Vector3(normal[0],-normal[2],0),candidate=candidates[0]||{point,outward,yaw:0,outer:4,length:10,quality:{confident:false}}
     chosen={candidate,cut:cylinder(candidate.point,candidate.outward,4,candidate.length,diameter/2)};uncertain=true
    }
    add(chosen.candidate,chosen.cut);uncertain||=!chosen.candidate.quality.confident
   }
  }
  const warnings=[]
  const review=()=>nativeBaseOutput(result,{baseZ,holes,replaceHeight:bevel,extendedBy:0,baseMode:'original-height',protectedRegions:guards.length,protectedZones:[...relief,...zones],drainReview:{bottomContour:contour,holes:proposalOnly?manualHoles:holes.map(h=>({...h,length:Math.max(.5,h.length-h.outerLength),autoPosition:false,autoDepth:false})),message:'Zkontrolujte navržené odtoky. Válce můžete posunout, otočit nebo zkrátit; otvor vznikne až po potvrzení.'}})
  if(settings.holes!==false&&(proposalOnly||!manual&&(uncertain||settings.reviewDrains)))return review()
  // Compensate contact only inside the large resin cavities. Pin/sleeve seating
  // and every protected region are excluded from both addition and subtraction.
  const mainVoid=own(new M.CrossSection(flowVoids,'EvenOdd')),cutSections=cutters.map(c=>own(c.slice(.001))),beveledFloor=own(result.slice(.001)),target=floor.area()+1
  const footprint=inset=>{
   const inner=own(mainVoid.offset(-inset,'Round',2,48)),band=own(own(mainVoid.subtract(inner)).subtract(supportGuard));let shape=own(beveledFloor.add(band))
   for(const cut of cutSections)shape=own(shape.subtract(cut))
   return shape.area()
  }
  let inset=0
  if(footprint(0)<target){let lo=0,hi=4;if(footprint(hi)<target){if(!manual&&settings.holes!==false)return review();const error=Error('Nelze zachovat dosedací plochu bez zásahu do chráněných míst. Zmenšete bevel nebo otvory.');error.details={floor:floor.area(),beveled:beveledFloor.area(),max:footprint(hi),void:mainVoid.area(),guard:guard.area()};throw error}
   for(let i=0;i<16;i++){const mid=(lo+hi)/2;if(footprint(mid)<target)lo=mid;else hi=mid}inset=hi
  }
  if(inset>.001){
   progress('Doplňuji vnitřní dosedací lem mimo funkční detaily…')
   const layers=[],height=Math.max(1.2,bevel+.2),steps=32,dy=height/steps,bond=own(own(mainVoid.offset(.3,'Round',2,48)).intersect(outline))
   for(let i=0;i<steps;i++){const t=1-i/steps,amount=inset*t*t*(3-2*t),inner=own(mainVoid.offset(-amount,'Round',2,48)),band=own(own(bond.subtract(inner)).subtract(supportGuard));if(band.area()>.001)layers.push(own(own(band.extrude(dy+.001)).translate([0,0,i*dy])))}
   if(layers.length)result=own(result.add(own(M.Manifold.union(layers))))
  }
  const resinCore=mainVoid
  // A round drain may enter a curved cavity off its centre line. Test the
  // complete cutter against actual free space after the support lip has been added.
  for(let i=0;i<cutters.length;i++){
   const volume=drainCavityVolume(M,cutters[i],result,resinCore,holes[i].openingHeight)
   if(volume<Math.min(5,holes[i].diameter)){if(!manual)return review();throw Error('Válec nedosahuje do volné dutiny za dosedacím lemem. Posuňte jej nebo prodlužte vnitřní konec.')}
   holes[i].cavityOverlapVolume=volume
  }
  for(const cutter of cutters)result=own(result.subtract(cutter))
  progress('Ověřuji původní dosednutí, chráněná místa a průchodnost…')
  const protectedBefore=own(original.intersect(guardSolid)),protectedAfter=own(result.intersect(guardSolid))
  if(own(protectedBefore.subtract(protectedAfter)).volume()>.02||own(protectedAfter.subtract(protectedBefore)).volume()>.02)throw Error('Úprava zasáhla do chráněného detailu. Model nebyl exportován.')
  const upper=Math.max(bevel+.3,cutHeight+.3),beforeUpper=own(original.trimByPlane([0,0,1],upper)),afterUpper=own(result.trimByPlane([0,0,1],upper))
  if(own(beforeUpper.subtract(afterUpper)).volume()>.01||own(afterUpper.subtract(beforeUpper)).volume()>.01)throw Error('Úprava zasahuje nad spodní pás modelu.')
  // Discard only sub-microscopic Boolean slivers (under 0.00001 mm³).
  const parts=result.decompose().map(own).filter(p=>Math.abs(p.volume())>1e-5);if(result.status()!=='NoError'||parts.length!==1){const error=Error('Úprava by rozdělila model.');error.details=parts.map(p=>({volume:p.volume(),bounds:p.boundingBox()}));throw error}
  return nativeBaseOutput(parts[0],{holes,warnings,drainDrafts:manual?manualHoles:holes.map(h=>({...h,length:Math.max(.5,h.length-h.outerLength),autoPosition:false,autoDepth:false})),baseZ,replaceHeight:bevel,extendedBy:0,baseMode:'original-height',protectedRegions:guards.length,protectedZones:[...relief,...zones],supportInset:inset,protectedHeight:upper})
 }finally{surface?.dispose();allocated.reverse().forEach(o=>o.delete())}
}

export function drainCavityVolume(M,cutter,original,resinCore,height){
 const column=resinCore.extrude(height),free=column.subtract(original),overlap=cutter.intersect(free)
 try{return Math.max(0,overlap.volume())}finally{overlap.delete();free.delete();column.delete()}
}

function nativeBaseOutput(solid,metadata){
 const canonical=fromManifold(solid),output=Float32Array.from(canonical.vertices)
 for(let i=0;i<output.length;i+=3){const y=output[i+1];output[i+1]=output[i+2];output[i+2]=-y}
 const indices=Uint32Array.from(canonical.faces)
 return {positions:separateFloat32Contacts(output,indices),indices,placement:{baseY:0,direction:-1},stats:{volume:solid.volume()},...metadata}
}
