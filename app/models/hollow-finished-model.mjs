import * as THREE from 'three'
import {MeshBVH} from 'three-mesh-bvh'
import {indexed,fromManifold} from '../model-builder/engine.mjs'

// Distance from every retained surface also protects implant sockets. Only
// the flat printing face is omitted, so the cavity opens through the underside.
export function hollowFinishedModel(M,raw,settings={},progress=()=>{}){
 const allocated=[],own=o=>{allocated.push(o);return o},wall=Number(settings.wall??2.5)
 if(!Number.isFinite(wall)||wall<1.5||wall>5)throw Error('Tloušťka stěny musí být 1,5–5 mm.')
 let geometry
 try{
  const data=indexed(raw,{exact:true}),mesh=new M.Mesh({numProp:3,vertProperties:Float32Array.from(data.vertices),triVerts:Uint32Array.from(data.faces)});mesh.merge()
  const original=own(new M.Manifold(mesh));if(original.status()!=='NoError')throw Error('Model nemá uzavřenou platnou síť.')
  const box=original.boundingBox(),floor=box.min[2],section=own(original.slice(floor+.02)),polygons=section.toPolygons(),area=p=>p.reduce((s,a,i)=>{const b=p[(i+1)%p.length];return s+a[0]*b[1]-b[0]*a[1]},0)/2
  const outer=Math.max(...polygons.map(area)),largestVoid=Math.max(0,...polygons.map(p=>-area(p)))
  // Existing large cavities and thin/open arch bases are left untouched.
  const hull=own(section.hull()),solid=largestVoid<outer*.2&&section.area()/hull.area()>.38&&section.area()/outer>.75
  if(!solid||settings.autoHollow===false)return {raw,hollowed:false}
  progress(`Vydutím plný model · stěna ${wall.toFixed(1)} mm…`)
  const faces=[]
  for(let i=0;i<data.faces.length;i+=3){const ids=data.faces.slice(i,i+3);if(ids.every(id=>Math.abs(data.vertices[id*3+2]-floor)<.01))continue;faces.push(...ids)}
  geometry=new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(data.vertices,3)).setIndex(faces)
  const bvh=new MeshBVH(geometry),point=new THREE.Vector3(),hit={}
  const cutter=own(M.Manifold.levelSet(xyz=>{point.fromArray(xyz);bvh.closestPointToPoint(point,hit);return hit.distance-wall},{min:[box.min[0]-.5,box.min[1]-.5,floor-1],max:box.max.map(v=>v+.5)},.65,0,-1))
  const open=cutter.decompose().map(own).filter(part=>part.boundingBox().min[2]<floor-.1)
  if(!open.length)throw Error('Pro zvolenou stěnu nelze vytvořit otevřenou dutinu.')
  let output=original
  for(const part of open)output=own(output.subtract(part))
  const pieces=output.decompose().map(own)
  if(output.status()!=='NoError'||pieces.length!==1)throw Error('Vydutění by rozdělilo model. Zkuste silnější stěnu.')
  if(original.volume()-output.volume()<10)throw Error('Nevznikla použitelná dutina. Model nebyl změněn.')
  const result=fromManifold(output),expanded=new Float32Array(result.faces.length*3)
  for(let i=0;i<result.faces.length;i++)expanded.set(result.vertices.slice(result.faces[i]*3,result.faces[i]*3+3),i*3)
  return {raw:expanded,hollowed:true,functionalContours:polygons.filter(p=>area(p)<0&&-area(p)<=100).map(points=>({points,kind:'socket'})),wall,removedVolume:original.volume()-output.volume()}
 }finally{geometry?.dispose();allocated.reverse().forEach(o=>o.delete())}
}
