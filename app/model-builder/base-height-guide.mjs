import * as THREE from 'three'
import {indexed,meshTopology,stitch} from './engine.mjs'
import {prepareSurface} from './prepare-surface.mjs'
import {repairBaseBoundary} from './boundary-repair.mjs'
import {baseDirection} from './base-direction.mjs'
import {smoothMargin,prepareBaseContour,prepareBevelRings} from './base-profile.mjs'
import {DEFAULTS} from './defaults.mjs'

// Only the boundary/profile is prepared, never the expensive hollow solid.
// The profile uses the exact same cleanup, sampling and kernel offsets as export.
export function prepareBaseHeightGuide(M,positions,arch,options={}) {
  const p={...DEFAULTS,...options},source=indexed(positions,{exact:true})
  const prepared=prepareSurface(source.vertices,source.faces)
  const {vertices,faces}=repairBaseBoundary(prepared.vertices,prepared.faces)
  const boundary=meshTopology(vertices,faces).loops[0]
  if(!boundary?.length)throw Error('Scan nemá otevřený obvod pro náhled výšky báze.')
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity]
  for(let i=0;i<vertices.length;i+=3)for(let k=0;k<3;k++){
    min[k]=Math.min(min[k],vertices[i+k]);max[k]=Math.max(max[k],vertices[i+k])
  }
  const direction=baseDirection(vertices,boundary,arch)
  smoothMargin(vertices,boundary,p.smoothing)
  const allocated=[],own=value=>{allocated.push(value);return value}
  try{
    const contour=prepareBaseContour(M,vertices,boundary,p.smoothing,own)
    const bevel=prepareBevelRings(M,contour,p.bevel,own),depth=Math.max(.8,p.bevel)
    const rings=[{points:contour,y:-depth}]
    if(depth>p.bevel&&p.bevel>0)rings.push({points:contour,y:-p.bevel})
    rings.push(...(bevel.length?bevel:[{points:contour,y:0}]))
    const v=[],f=[],ids=[]
    for(const ring of rings){
      const current=ring.points.map(pt=>{const id=v.length/3;v.push(pt[0],ring.y,pt[1]);return id})
      if(ids.length)stitch(v,f,ids[ids.length-1],current)
      ids.push(current)
    }
    // At the underside, the opening follows an inward wall offset of the
    // terminal bevel contour. Extrude that opening through this thin guide;
    // the full anatomical cavity remains the job of the final solid generator.
    const foot=rings[rings.length-1].points
    const openings=p.hollow?own(own(new M.CrossSection([foot],'EvenOdd')).offset(-p.wall,'Round',2,48)).toPolygons():[]
    const inner=[]
    for(const polygon of openings){
      const ends=[-depth,0].map(y=>polygon.map(pt=>{const id=v.length/3;v.push(pt[0],y,pt[1]);return id}))
      stitch(v,f,ends[1],ends[0]);inner.push(ends)
    }
    for(const index of [0,ids.length-1]){
      const ring=ids[index],side=index===0?0:1,holes=inner.map(ends=>ends[side]),all=[...ring,...holes.flat()]
      const shape=ring.map(id=>new THREE.Vector2(v[id*3],v[id*3+2]))
      const holeShapes=holes.map(hole=>hole.map(id=>new THREE.Vector2(v[id*3],v[id*3+2])))
      for(const triangle of THREE.ShapeUtils.triangulateShape(shape,holeShapes)){
        const face=triangle.map(i=>all[i]);if(index===0)face.reverse();f.push(...face)
      }
    }
    // Connector origins follow the smooth contour, using the nearest scan rim height.
    const step=Math.max(1,Math.ceil(contour.length/240))
    const points=contour.filter((_,i)=>i%step===0).map(([x,z])=>{
      let nearest=boundary[0],distance=Infinity
      for(const id of boundary){const d=(vertices[id*3]-x)**2+(vertices[id*3+2]-z)**2;if(d<distance){distance=d;nearest=id}}
      return [x,vertices[nearest*3+1],z]
    })
    return {min,max,points,direction,profile:{positions:new Float32Array(v),indices:new Uint32Array(f)}}
  }finally{for(const value of allocated.reverse())value.delete()}
}
