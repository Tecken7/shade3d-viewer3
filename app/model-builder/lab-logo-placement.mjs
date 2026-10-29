import * as THREE from 'three'
import {TextGeometry} from 'three/examples/jsm/geometries/TextGeometry.js'
import {projectSurfaceText} from './surface-text.mjs'
import {LAB_LOGO_TEXT} from './lab-logo.mjs'

export function findLabLogoPlacement(surface,font,options,placement){
 return findSurfaceLabelPlacement(surface,font,options,placement,{side:'cavity',sizes:[options.textLogoSize??1.8],rotation:options.textLogoRotation??0})
}

// A lingual exterior also faces the arch centre. A true cavity must instead
// have a roof, an open route to the printing plane and walls across its airspace.
export function isCavityWall(surface,point,normal,placement){
 const p=point.clone().addScaledVector(normal,1.3),direction=placement.direction??1
 const cast=axis=>{
  const geometry=surface.boundsTree.geometry,normals=geometry.attributes.normal
  geometry.deleteAttribute('normal')
  try{return surface.boundsTree.raycastFirst(new THREE.Ray(p,axis),THREE.DoubleSide)}finally{if(normals)geometry.setAttribute('normal',normals)}
 }
 const roof=cast(new THREE.Vector3(0,-direction,0))
 if(!roof||roof.face.normal.y*direction<.15)return false
 const floorDistance=(placement.baseY-p.y)*direction,floor=cast(new THREE.Vector3(0,direction,0))
 if(floorDistance<=0||floor&&floor.distance<floorDistance-.15)return false
 const across=new THREE.Vector3(normal.x,0,normal.z).normalize(),tangent=new THREE.Vector3(-across.z,0,across.x)
 if(!surface.boundingBox)surface.computeBoundingBox()
 const span=surface.boundingBox.getSize(new THREE.Vector3()).length()
 return [across,tangent,tangent.clone().negate()].every(axis=>{const hit=cast(axis);return hit&&hit.distance<span&&hit.face.normal.dot(axis)<-.15})
}

// Reuse the same physical footprint and exact wrap checks for ordinary tags.
export function findSurfaceLabelPlacement(surface,font,options,placement,layout={}){
 if(!surface?.boundsTree||!placement||!Number.isFinite(placement.baseY))return null
 surface.computeBoundingBox()
 const center=surface.boundingBox.getCenter(new THREE.Vector3()),direction=placement.direction??options.baseDirection??1,baseY=placement.baseY,position=surface.attributes.position,index=surface.index,triangle=new THREE.Triangle(),normal=new THREE.Vector3(),point=new THREE.Vector3(),ray=new THREE.Ray(),cells=new Map()
 const project=(p,n,limit=1.6)=>{
  ray.origin.copy(p).addScaledVector(n,2.5);ray.direction.copy(n).negate()
  // Placement needs the geometric face normal only. Avoid interpolating
  // vertex normals across needle-thin Boolean seams in imported STL files.
  const geometry=surface.boundsTree.geometry,normals=geometry.attributes.normal
  let hit
  geometry.deleteAttribute('normal')
  try{hit=surface.boundsTree.raycastFirst(ray,THREE.DoubleSide)}finally{if(normals)geometry.setAttribute('normal',normals)}
  return hit&&Math.abs(hit.distance-2.5)<=limit&&hit.face.normal.dot(n)>.6?hit:null
 }
 const count=index?index.count:position.count
 for(let i=0;i<count;i+=3){
  for(const [corner,key]of [[0,'a'],[1,'b'],[2,'c']])triangle[key].fromBufferAttribute(position,index?index.getX(i+corner):i+corner)
  triangle.getNormal(normal);if(Math.abs(normal.y)>(layout.side==='cavity'?.35:.12))continue
  triangle.getMidpoint(point)
  const depth=direction*(baseY-point.y)
  if(depth<1||depth>Math.min(9,options.totalHeight*.7))continue
  const inward=new THREE.Vector3(center.x-point.x,0,center.z-point.z).normalize().dot(normal)*(layout.side==='outer'?-1:1)
  if(layout.side==='cavity'){if(!isCavityWall(surface,point,normal,placement))continue}else if(inward<.35)continue
  const key=`${Math.round(point.x)}:${Math.round(point.z)}`
  if(!cells.has(key))cells.set(key,{point:point.clone(),normal:normal.clone(),inward})
 }
 for(const size of layout.sizes||[2.6,2.2,1.8]){
  const text=new TextGeometry(layout.text??LAB_LOGO_TEXT,{font,size,depth:layout.depth??.4,curveSegments:4,bevelEnabled:false});text.computeBoundingBox()
  const width=text.boundingBox.max.x-text.boundingBox.min.x,height=text.boundingBox.max.y-text.boundingBox.min.y;text.dispose()
  const candidates=[]
  for(const cell of cells.values())for(const depth of layout.side==='cavity'?[4.6,6,3.2,2.5]:[3.2,4.6,2.5]){
   const proposal=cell.point.clone();proposal.y=baseY-direction*depth
   const hit=project(proposal,cell.normal,.7);if(!hit||Math.abs(hit.face.normal.y)>(layout.side==='cavity'?.35:.2))continue
   const n=hit.face.normal.clone().normalize(),right=new THREE.Vector3().crossVectors(new THREE.Vector3(0,-direction,0),n).normalize()
   if(options.textPosition&&options.textNormal&&n.dot(new THREE.Vector3(...options.textNormal))>.65){
    const offset=hit.point.clone().sub(new THREE.Vector3(...options.textPosition)),userWidth=(options.text?.length||0)*(options.textSize||4)*.6
    if(Math.abs(offset.y)<(height+(options.textSize||4))*.6&&Math.abs(offset.dot(right))<(width+userWidth)/2+1)continue
   }
   if((layout.blocked||[]).some(label=>{if(n.dot(new THREE.Vector3(...label.normal))<.65)return false;const offset=hit.point.clone().sub(new THREE.Vector3(...label.position));return Math.abs(offset.y)<(height+label.size)*.6+.4&&Math.abs(offset.dot(right))<(width+label.width)/2+1}))continue
   if(options.cutHoles&&(options.holes||[]).some(hole=>hole.enabled!==false&&hole.position&&hit.point.distanceTo(new THREE.Vector3(...hole.position))<width*.35+(hole.diameter||3)/2+1))continue
   let quality=0,valid=true
   for(const x of [-width/2-.4,0,width/2+.4])for(const y of [-height/2-.4,0,height/2+.4]){
    const sample=hit.point.clone().addScaledVector(right,x);sample.y+=y
    const check=project(sample,n)
    if(!check||Math.abs(check.face.normal.y)>.45||layout.side==='cavity'&&!isCavityWall(surface,check.point,check.face.normal,placement)){valid=false;break}
    quality+=check.face.normal.dot(n)
   }
   if(valid)candidates.push({position:hit.point.toArray(),normal:n.toArray(),size,score:quality+cell.inward*3-Math.abs(depth-3.2)*.15})
  }
  candidates.sort((a,b)=>b.score-a.score)
  const tested=[]
  for(const candidate of candidates){
   if(tested.some(point=>new THREE.Vector3(...point).distanceTo(new THREE.Vector3(...candidate.position))<2))continue
   tested.push(candidate.position);if(tested.length>8)break
   const config={...options,text:layout.text??LAB_LOGO_TEXT,textSize:size,textDepth:layout.depth??.4,textMode:layout.mode??'emboss',textRotation:layout.rotation??0},result=projectSurfaceText(font,config,candidate,surface,{preview:true})
   const valid=result.valid;result.geometry?.dispose()
   if(valid)return {position:candidate.position,normal:candidate.normal,size}
  }
 }
 return null
}
