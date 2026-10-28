import {indexed,meshTopology} from './engine.mjs'
import {prepareSurface} from './prepare-surface.mjs'
import {repairBaseBoundary} from './boundary-repair.mjs'
import {baseDirection} from './base-direction.mjs'

// This is a display guide only. Work on copies, using the same source frame,
// boundary preparation and height convention as the actual base generator.
export function prepareBaseHeightGuide(positions,arch) {
  const source=indexed(positions,{exact:true})
  const prepared=prepareSurface(source.vertices,source.faces)
  const surface=repairBaseBoundary(prepared.vertices,prepared.faces)
  const {vertices,faces}=surface,topology=meshTopology(vertices,faces)
  const boundary=topology.loops[0]
  if(!boundary?.length)throw Error('Scan nemá otevřený obvod pro náhled výšky báze.')
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity]
  for(let i=0;i<vertices.length;i+=3)for(let k=0;k<3;k++){
    min[k]=Math.min(min[k],vertices[i+k]);max[k]=Math.max(max[k],vertices[i+k])
  }
  // Bound display geometry independently of the resolution of the scan.
  const step=Math.max(1,Math.ceil(boundary.length/240))
  const points=boundary.filter((_,i)=>i%step===0).map(id=>vertices.slice(id*3,id*3+3))
  return {min,max,points,direction:baseDirection(vertices,boundary,arch)}
}

