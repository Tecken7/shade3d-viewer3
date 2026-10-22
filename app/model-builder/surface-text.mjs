import * as THREE from 'three'
import {TextGeometry} from 'three/examples/jsm/geometries/TextGeometry.js'

// Both preview and boolean construction use this projection and its limits.
// A steep/missing surface is a rejected placement, never a partial inscription.
export function projectSurfaceText(font,options,placement,surface,{preview=false}={}){
 if(!font||!placement||!options.text?.trim())return {geometry:null,valid:false,error:''}
 const unsupported=[...options.text].find(char=>!font.data.glyphs[char])
 if(unsupported)return {geometry:null,valid:false,error:`Písmo nepodporuje znak „${unsupported}“.`}
 if(!(options.textSize>=1&&options.textSize<=12&&options.textDepth>0&&options.textDepth<=3))return {geometry:null,valid:false,error:'Velikost textu musí být 1–12 mm a hloubka nejvýše 3 mm.'}
 const text=new TextGeometry(options.text.slice(0,60),{font,size:options.textSize,depth:options.textDepth+.2,curveSegments:5,bevelEnabled:false})
 text.computeBoundingBox()
 text.translate(-(text.boundingBox.min.x+text.boundingBox.max.x)/2,-(text.boundingBox.min.y+text.boundingBox.max.y)/2,options.textMode==='engrave'?-options.textDepth:-.2)
 const attr=text.attributes.position,local=attr.array.slice(),n=new THREE.Vector3(...placement.normal).normalize(),up=new THREE.Vector3(0,-(options.baseDirection??options.holes?.[0]?.baseDirection??1),0)
 const right=new THREE.Vector3().crossVectors(up,n)
 if(right.lengthSq()<.04)right.set(1,0,0).addScaledVector(n,-n.x)
 right.normalize();up.crossVectors(n,right).normalize()
 const anchor=new THREE.Vector3(...placement.position),angle=(options.textRotation??0)*Math.PI/180,co=Math.cos(angle),si=Math.sin(angle)
 const plane=new THREE.Vector3(),ray=new THREE.Ray(),cache=new Map()
 const tangent=(x,y)=>plane.copy(anchor).addScaledVector(right,co*x-si*y).addScaledVector(up,si*x+co*y)
 const project=(x,y)=>{
  const key=`${x.toFixed(6)}:${y.toFixed(6)}`
  if(cache.has(key))return cache.get(key)
  tangent(x,y);ray.origin.copy(plane).addScaledVector(n,15);ray.direction.copy(n).negate()
  const hits=surface?.boundsTree?.raycast(ray,THREE.DoubleSide).filter(hit=>hit.face.normal.dot(n)>.15)||[]
  hits.sort((a,b)=>a.point.distanceToSquared(plane)-b.point.distanceToSquared(plane))
  if(!hits[0]||hits[0].point.distanceTo(plane)>8)throw new Error('Část textu nemá pod sebou vhodný povrch. Posuňte text nebo zmenšete písmo.')
  const point=hits[0].point;cache.set(key,point);return point
 }
 let error=''
 try{
  if(n.lengthSq()<.9)throw new Error('Vyberte povrch modelu pro umístění textu.')
  for(let i=0;i<attr.count;i++){
   const point=project(local[i*3],local[i*3+1]),z=local[i*3+2]+(preview?(options.textMode==='engrave'?options.textDepth+.04:.24):0)
   attr.setXYZ(i,point.x+n.x*z,point.y+n.y*z,point.z+n.z*z)
  }
  // Check between glyph vertices too: sparse, straight letter edges must not
  // silently bridge a tooth gap or jump onto a much deeper/back-facing surface.
  const edges=new Set()
  for(let i=0;i<attr.count;i+=3)for(const [a,b]of [[i,i+1],[i+1,i+2],[i+2,i]]){
   const ax=local[a*3],ay=local[a*3+1],bx=local[b*3],by=local[b*3+1],distance=Math.hypot(bx-ax,by-ay)
   if(distance<1e-6)continue
   const ka=`${ax}:${ay}`,kb=`${bx}:${by}`,key=ka<kb?`${ka}/${kb}`:`${kb}/${ka}`
   if(edges.has(key))continue;edges.add(key)
   const steps=Math.max(1,Math.ceil(distance/.2)),step=distance/steps
   let previous=project(ax,ay)
   for(let k=1;k<=steps;k++){
    const point=project(ax+(bx-ax)*k/steps,ay+(by-ay)*k/steps)
    if(point.distanceTo(previous)>step*4+.35)throw new Error('Text přemosťuje mezeru nebo příliš prudkou změnu povrchu. Posuňte jej nebo zmenšete písmo.')
    previous=point
   }
  }
 }catch(reason){error=reason.message}
 if(error){
  // Keep an explicit red, flat proposal visible instead of deleting the text.
  for(let i=0;i<attr.count;i++){
   const point=tangent(local[i*3],local[i*3+1]),z=local[i*3+2]+(options.textMode==='engrave'?options.textDepth+.08:.28)
   attr.setXYZ(i,point.x+n.x*z,point.y+n.y*z,point.z+n.z*z)
  }
 }
 text.computeVertexNormals();text.computeBoundingBox();text.computeBoundingSphere()
 return {geometry:text,valid:!error,error}
}
