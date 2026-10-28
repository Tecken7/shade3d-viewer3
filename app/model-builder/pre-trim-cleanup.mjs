import {indexed,meshTopology} from './engine.mjs'
import {prepareSurface} from './prepare-surface.mjs'
import {repairBaseBoundary} from './boundary-repair.mjs'
import {closeBaseMicroHoles} from './micro-holes.mjs'

// Return only a new index into the original attributes. Existing UV/color seams
// remain per-corner; tiny repair caps borrow existing rim vertices. No remeshing
// or movement of anatomy, and the main open rim is never closed.
export function prepareTrimCleanup(positions,index,groups=[]){
 const original=Array.from(index||Array.from({length:positions.length/3},(_,i)=>i))
 const key=id=>[positions[id*3],positions[id*3+1],positions[id*3+2]].join(',')
 const corners=new Map(),first=new Map(),expanded=new Float32Array(original.length*3)
 for(let i=0;i<original.length;i+=3){
  const ids=original.slice(i,i+3),keys=ids.map(key),face=keys.slice().sort().join('|')
  const material=groups.find(g=>i>=g.start&&i<g.start+g.count)?.materialIndex||0
  if(!corners.has(face))corners.set(face,{ids,keys,material})
  ids.forEach((id,k)=>{expanded.set(positions.subarray(id*3,id*3+3),(i+k)*3);if(!first.has(keys[k]))first.set(keys[k],{id,material})})
 }
 const source=indexed(expanded,{exact:true}),prepared=prepareSurface(source.vertices,source.faces)
 const repaired=repairBaseBoundary(prepared.vertices,prepared.faces),topology=meshTopology(repaired.vertices,repaired.faces)
 if(topology.nonManifold)throw Error('Síť vyžaduje ruční kontrolu.')
 const micro=closeBaseMicroHoles(repaired.vertices,repaired.faces,topology.loops)
 const result=[],outGroups=[]
 for(let i=0;i<micro.faces.length;i+=3){
  const keys=micro.faces.slice(i,i+3).map(id=>repaired.vertices.slice(id*3,id*3+3).join(',')),sourceFace=corners.get(keys.slice().sort().join('|'))
  const material=sourceFace?.material??first.get(keys[0]).material
  for(const value of keys){const corner=sourceFace?.keys.indexOf(value);result.push(corner>=0?sourceFace.ids[corner]:first.get(value).id)}
  const previous=outGroups[outGroups.length-1]
  if(previous?.materialIndex===material)previous.count+=3
  else outGroups.push({start:result.length-3,count:3,materialIndex:material})
 }
 return {index:new Uint32Array(result),groups:outGroups,changed:result.length!==original.length||result.some((id,i)=>id!==original[i]),stats:{removedFans:repaired.removedFans,removedDegenerate:repaired.removedDegenerate,closedMicroHoles:micro.closedMicroHoles}}
}
