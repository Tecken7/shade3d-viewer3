import * as THREE from 'three'
import {predictEdgePatch} from '../model-builder/edge-edit.mjs'
let context=null,loops=[]
self.onmessage=event=>{
 const {type,id,payload}=event.data
 try {
  if(type==='init'){
   const nodes=Array.from({length:payload.positions.length/3},(_,i)=>new THREE.Vector3().fromArray(payload.positions,i*3)),positions=nodes.map(p=>p.toArray()),triangles=[],edgeTriangles=new Map()
   for(let i=0;i<payload.indices.length;i+=3){const nodeIds=Array.from(payload.indices.slice(i,i+3)),face=triangles.length;triangles.push({nodeIds,faceIndex:payload.faceIds[face],childUuid:payload.children[payload.childIndices[face]],corners:nodeIds.map(id=>({sourcePos:positions[id],sourceNormal:Array.from(payload.nodeNormals.slice(id*3,id*3+3)),color:payload.nodeColors?Array.from(payload.nodeColors.slice(id*3,id*3+3)):null,uv:payload.nodeUvs?Array.from(payload.nodeUvs.slice(id*2,id*2+2)):null}))});nodeIds.forEach((a,j)=>{const b=nodeIds[(j+1)%3],key=a<b?`${a}:${b}`:`${b}:${a}`;if(!edgeTriangles.has(key))edgeTriangles.set(key,[]);edgeTriangles.get(key).push(face)})}
   context={nodes,triangles,edgeTriangles}
   loops=payload.loops.map(loop=>({...loop,boundary:loop.boundary.map(s=>({...s,position:new THREE.Vector3(...s.position),normal:s.normal?new THREE.Vector3(...s.normal):null}))}))
   return
  }
  const {selection,bulge}=payload,loop=loops[selection[0].loop],patch=predictEdgePatch(context,loop,selection[0].index,selection[1].index,bulge)
  self.postMessage({id,patch,error:''})
 }catch(error){self.postMessage({id,patch:null,error:error.message})}
}
