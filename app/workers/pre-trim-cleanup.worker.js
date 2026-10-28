import * as THREE from 'three'
import {MeshBVH} from 'three-mesh-bvh'
import {prepareTrimCleanup} from '../model-builder/pre-trim-cleanup.mjs'
self.onmessage=({data})=>{
 let geometry
 try{
  const result=prepareTrimCleanup(data.positions,data.index,data.groups),transfer=[result.index.buffer]
  if(result.changed){
   geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(data.positions,3));geometry.setIndex(new THREE.BufferAttribute(result.index,1));geometry.groups=result.groups
   result.tree=MeshBVH.serialize(new MeshBVH(geometry,{indirect:true}),{cloneBuffers:false})
   transfer.push(...result.tree.roots);if(result.tree.index&&result.tree.index.buffer!==result.index.buffer)transfer.push(result.tree.index.buffer);if(result.tree.indirectBuffer)transfer.push(result.tree.indirectBuffer.buffer)
  }
  self.postMessage({result},transfer)
 }catch(error){self.postMessage({error:error.message})}
 finally{geometry?.dispose()}
}
