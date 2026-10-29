import * as THREE from 'three'
import {TextGeometry} from 'three/examples/jsm/geometries/TextGeometry.js'
import {createTextSurfaceChart,tessellateText} from './text-surface-chart.mjs'

const templates=new WeakMap()
function textTemplate(font,options){
 let cache=templates.get(font)
 if(!cache){cache=new Map();templates.set(font,cache)}
 const key=JSON.stringify([options.text.slice(0,60),options.textSize,options.textDepth,options.textMode])
 if(cache.has(key))return cache.get(key)
 const raw=new TextGeometry(options.text.slice(0,60),{font,size:options.textSize,depth:options.textDepth+.2,curveSegments:8,bevelEnabled:false})
 let refined,error=''
 try{
  raw.computeBoundingBox()
  const cx=(raw.boundingBox.min.x+raw.boundingBox.max.x)/2,cy=(raw.boundingBox.min.y+raw.boundingBox.max.y)/2,ranges=[]
  let cursor=0
  for(const char of options.text.slice(0,60)){
   const glyph=font.data.glyphs[char],advance=(glyph?.ha||0)/font.data.resolution*options.textSize
   if(char.trim()){
    const g=new TextGeometry(char,{font,size:options.textSize,depth:.1,curveSegments:8,bevelEnabled:false});g.computeBoundingBox()
    const box=g.boundingBox
    if(box&&!box.isEmpty())ranges.push({center:cursor+(box.min.x+box.max.x)/2-cx,min:cursor+box.min.x-cx,max:cursor+box.max.x-cx,minY:box.min.y-cy,maxY:box.max.y-cy})
    g.dispose()
   }
   cursor+=advance
  }
  raw.translate(-cx,-cy,options.textMode==='engrave'?-options.textDepth:-.2)
  try{refined=tessellateText(raw)}catch(reason){error=reason.message}
  const template={positions:(refined||raw).attributes.position.array.slice(),bounds:raw.boundingBox.clone(),ranges,error}
  if(cache.size>=6)cache.delete(cache.keys().next().value)
  cache.set(key,template);return template
 }finally{raw.dispose();refined?.dispose()}
}

// Both preview and boolean construction use this projection and its limits.
// A steep/missing surface is a rejected placement, never a partial inscription.
export function projectSurfaceText(font,options,placement,surface,{preview=false,perGlyph=false}={}){
 if(!font||!placement||!options.text?.trim())return {geometry:null,valid:false,error:''}
 const unsupported=[...options.text].find(char=>!font.data.glyphs[char])
 if(unsupported)return {geometry:null,valid:false,error:`Písmo nepodporuje znak „${unsupported}“.`}
 if(!(options.textSize>=1&&options.textSize<=12&&options.textDepth>0&&options.textDepth<=3))return {geometry:null,valid:false,error:'Velikost textu musí být 1–12 mm a hloubka nejvýše 3 mm.'}
 const template=textTemplate(font,options),bounds=template.bounds
 const text=new THREE.BufferGeometry().setAttribute('position',new THREE.BufferAttribute(template.positions.slice(),3)).setAttribute('textLocal',new THREE.BufferAttribute(template.positions.slice(),3))
 const attr=text.attributes.position,local=template.positions,n=new THREE.Vector3(...placement.normal).normalize(),up=new THREE.Vector3(0,-(options.baseDirection??options.holes?.[0]?.baseDirection??1),0)
 const right=new THREE.Vector3().crossVectors(up,n)
 if(right.lengthSq()<.04)right.set(1,0,0).addScaledVector(n,-n.x)
 right.normalize();up.crossVectors(n,right).normalize()
 const anchor=new THREE.Vector3(...placement.position),angle=(options.textRotation??0)*Math.PI/180,co=Math.cos(angle),si=Math.sin(angle)
 const plane=new THREE.Vector3(),cache=new Map()
 let chart
 const tangent=(x,y)=>plane.copy(anchor).addScaledVector(right,co*x-si*y).addScaledVector(up,si*x+co*y)
 const project=(x,y)=>{
  const key=`${x.toFixed(6)}:${y.toFixed(6)}`
  if(cache.has(key))return cache.get(key)
  const frame=chart(x,y);cache.set(key,frame);return frame
 }
 let error=''
 try{
  if(template.error)throw new Error(template.error)
  if(n.lengthSq()<.9)throw new Error('Vyberte povrch modelu pro umístění textu.')
  const chartRight=right.clone().multiplyScalar(co).addScaledVector(up,si),chartUp=up.clone().multiplyScalar(co).addScaledVector(right,-si),offset=options.textMode==='engrave'?0:options.textDepth
  if(!perGlyph)chart=createTextSurfaceChart(surface,anchor,n,chartRight,chartUp,bounds,offset)
  else{
   // Each glyph gets its own intrinsic patch. A long word can follow an arch
   // without accumulating shear across empty space between its letters.
   const lineBounds=bounds.clone();lineBounds.min.y=-.01;lineBounds.max.y=.01
   const baseline=createTextSurfaceChart(surface,anchor,n,chartRight,chartUp,lineBounds,offset),charts=new Map()
   chart=(x,y)=>{
    const distance=g=>x<g.min?g.min-x:x>g.max?x-g.max:0
    const glyph=template.ranges.reduce((best,g)=>distance(g)<distance(best)?g:best)
    if(!charts.has(glyph)){
     const frame=baseline(glyph.center,0),tangent=baseline(glyph.center+.025,0).point.clone().sub(baseline(glyph.center-.025,0).point).normalize(),vertical=new THREE.Vector3().crossVectors(frame.normal,tangent).normalize()
     if(vertical.dot(chartUp)<0)vertical.negate()
     const localBounds=new THREE.Box3(new THREE.Vector3(glyph.min-glyph.center,glyph.minY,0),new THREE.Vector3(glyph.max-glyph.center,glyph.maxY,0))
     charts.set(glyph,createTextSurfaceChart(surface,frame.point,frame.normal,tangent,vertical,localBounds,offset))
    }
    return charts.get(glyph)(x-glyph.center,y)
   }
  }
  for(let i=0;i<attr.count;i++){
   const frame=project(local[i*3],local[i*3+1]),z=preview?(options.textMode==='engrave' ? .02+(local[i*3+2]+options.textDepth)/(options.textDepth+.2)*.02 : local[i*3+2]+.015):local[i*3+2]
   attr.setXYZ(i,frame.point.x+frame.normal.x*z,frame.point.y+frame.normal.y*z,frame.point.z+frame.normal.z*z)
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
   const visible=(x,y)=>{const frame=project(x,y);return frame.point.clone().addScaledVector(frame.normal,options.textMode==='engrave'?0:options.textDepth)}
   let previous=visible(ax,ay)
   for(let k=1;k<=steps;k++){
    const point=visible(ax+(bx-ax)*k/steps,ay+(by-ay)*k/steps)
    if(point.distanceTo(previous)>step*1.16+.005)throw new Error('Text přemosťuje mezeru nebo příliš prudkou změnu povrchu. Posuňte jej nebo zmenšete písmo.')
    previous=point
   }
  }
 }catch(reason){
  if(!perGlyph&&template.ranges.length>1&&reason.message.includes('proporce')){
   text.dispose();return projectSurfaceText(font,options,placement,surface,{preview,perGlyph:true})
  }
  error=reason.message
 }
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
