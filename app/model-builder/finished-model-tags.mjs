import * as THREE from 'three'
import {FontLoader} from 'three/examples/jsm/loaders/FontLoader.js'
import {TextGeometry} from 'three/examples/jsm/geometries/TextGeometry.js'
import {toCreasedNormals} from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import {MeshBVH} from 'three-mesh-bvh'
import {DEFAULTS,applyModelText,meshTopology} from './engine.mjs'
import {findSurfaceLabelPlacement,isCavityWall} from './lab-logo-placement.mjs'
import {LAB_LOGO_TEXT} from './lab-logo.mjs'
import {textWeight} from './text-font.mjs'
import {projectSurfaceText} from './surface-text.mjs'

// Coordinates follow the builder: Y is vertical, baseDirection points toward
// the printing plane. The CLI preserves the original STL coordinate system.
export function contactArea(base){
 const p=base.positions,f=base.indices,level=base.placement.baseY,direction=base.placement.direction
 let area=0
 for(let i=0;i<f.length;i+=3){
  const a=f[i]*3,b=f[i+1]*3,c=f[i+2]*3
  if([a,b,c].some(o=>Math.abs(p[o+1]-level)>.001))continue
  const u=[p[b]-p[a],p[b+1]-p[a+1],p[b+2]-p[a+2]],v=[p[c]-p[a],p[c+1]-p[a+1],p[c+2]-p[a+2]],n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]]
  if(n[1]*direction>0)area+=Math.hypot(...n)/2
 }
 return area
}

export async function decorateFinishedModel(M,base,config,fonts,progress=()=>{}){
 const check=meshTopology(Array.from(base.positions),Array.from(base.indices))
 if(check.openEdges||check.nonManifold)throw Error('Vstupní model musí mít uzavřenou síť.')
 const tags=(config.tags||[]).filter(tag=>tag.text?.trim()).map(tag=>({...tag,text:tag.text.trim(),weight:textWeight(tag.weight),size:tag.size??4,depth:tag.depth??.4,mode:tag.mode??'emboss',side:tag.side??'outer',rotation:tag.rotation??0}))
 if(tags.some(tag=>tag.text.length>60||tag.size<1||tag.size>12||tag.depth<=0||tag.depth>3||!['emboss','engrave'].includes(tag.mode)||!['inner','outer'].includes(tag.side)))throw Error('Popisek musí mít nejvýše 60 znaků, velikost 1–12 mm a hloubku do 3 mm.')
 if(config.logo&&(!Number.isFinite(config.logoSize??1.8)||(config.logoSize??1.8)<1||(config.logoSize??1.8)>6))throw Error('Velikost podpisu musí být 1–6 mm.')
 if(config.logo)tags.push({text:LAB_LOGO_TEXT,name:'Designed by ARTHETIC',brand:true,size:config.logoSize??1.8,depth:.4,mode:'emboss',side:'cavity',rotation:0,...config.logoPlacement})
 if(!tags.length)return {status:'ready',output:base,items:[],contactAreaBefore:contactArea(base),contactAreaAfter:contactArea(base)}
 const raw=new THREE.BufferGeometry().setAttribute('position',new THREE.BufferAttribute(base.positions,3)).setIndex(new THREE.BufferAttribute(base.indices,1))
 const surface=toCreasedNormals(raw,Math.PI/6);surface.boundsTree=new MeshBVH(surface);surface.computeBoundingBox()
 const common={...DEFAULTS,totalHeight:surface.boundingBox.max.y-surface.boundingBox.min.y,baseDirection:base.placement.direction,cutHoles:true,holes:base.holes||[],text:''},planned=[],reserved=[]
 try{
  // Plan every label before changing geometry. A failed auto placement leaves
  // the complete source model untouched and requires review.
  for(const tag of tags){
   progress(`Hledám místo: ${tag.name||tag.text}`)
   const data=tag.brand?fonts.logo:fonts[tag.weight]
   if(!data)throw Error('Chybí požadovaný řez písma Inter.')
   if([...tag.text].some(char=>!data.glyphs[char]))throw Error('Písmo nepodporuje některý znak popisku.')
   const font=new FontLoader().parse(data),layout={...tag,blocked:reserved,sizes:tag.brand?[tag.size]:[tag.size,tag.size*.875,tag.size*.75].filter(size=>size>=1)}
   let candidate
   if(tag.position&&tag.normal){
    candidate={position:tag.position,normal:tag.normal,size:tag.size}
    const projection=projectSurfaceText(font,{...common,text:tag.text,textSize:tag.size,textDepth:tag.depth,textMode:tag.mode,textRotation:tag.rotation},candidate,surface,{preview:true})
    const valid=projection.valid&&(!tag.brand||isCavityWall(surface,new THREE.Vector3(...tag.position),new THREE.Vector3(...tag.normal),base.placement));projection.geometry?.dispose();if(!valid)candidate=null
   }else candidate=findSurfaceLabelPlacement(surface,font,common,base.placement,layout)
   if(!candidate)return {status:'needs-placement',output:config.allowManual?base:null,pending:tags,items:planned.map(item=>item.report),message:`Pro ${tag.name||tag.text} není dost vhodného místa. Je nutné ruční umístění.`}
   const measurement=new TextGeometry(tag.text,{font,size:candidate.size,depth:tag.depth,curveSegments:4,bevelEnabled:false});measurement.computeBoundingBox()
   const width=measurement.boundingBox.max.x-measurement.boundingBox.min.x;measurement.dispose()
   reserved.push({...candidate,width})
   planned.push({tag,data,candidate,report:{name:tag.name||tag.text,side:tag.side,...candidate,weight:tag.brand?'ART 800 / HETIC 400':tag.weight,depth:tag.depth,mode:tag.mode}})
  }
  let output=base
  for(const {tag,data,candidate} of planned){
   progress(`Spojuji s modelem: ${tag.name||tag.text}`)
   let point=candidate,lastError
   for(let attempt=0;attempt<4;attempt++){
    try{output=await applyModelText(M,output,{...common,text:tag.text,textSize:point.size,textDepth:tag.depth,textMode:tag.mode,textRotation:tag.rotation,textPosition:point.position,textNormal:point.normal,textLogoEnabled:false},data,progress);Object.assign(planned.find(p=>p.tag===tag).report,point);lastError=null;break}
    catch(error){lastError=error;if(tag.position||attempt===3)break;reserved.push({...point,width:6});point=findSurfaceLabelPlacement(surface,new FontLoader().parse(data),common,base.placement,{...tag,blocked:reserved,sizes:[tag.size]});if(!point)break}
   }
   if(lastError)throw lastError
  }
  const before=contactArea(base),after=contactArea(output)
  if(after+.01<before)throw Error('Popisek zmenšil dosedací plochu. Změňte jeho umístění.')
  return {status:'ready',output,items:planned.map(item=>item.report),contactAreaBefore:before,contactAreaAfter:after}
 }catch(error){if(config.allowManual)return {status:'needs-placement',output:base,pending:tags,items:planned.map(item=>item.report),message:error.message};throw error}finally{surface.dispose();raw.dispose()}
}
