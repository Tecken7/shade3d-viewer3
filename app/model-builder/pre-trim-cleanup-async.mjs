import * as THREE from 'three'
import {MeshBVH} from 'three-mesh-bvh'

export async function prepareTrimCleanupAsync(object,{workerFactory=()=>new Worker(new URL('../workers/pre-trim-cleanup.worker.js',import.meta.url),{type:'module'}),pause=()=>new Promise(resolve=>requestAnimationFrame(()=>resolve()))}={}){
 const worker=workerFactory(),meshes=[],pending=[],backup=[]
 object.traverse(mesh=>{if(mesh.isMesh&&mesh.geometry?.attributes.position)meshes.push(mesh)})
 try{
  for(const mesh of meshes){
   const geometry=mesh.userData._baseGeom?.isBufferGeometry?mesh.userData._baseGeom:mesh.geometry
   const positions=Float32Array.from(geometry.attributes.position.array),index=geometry.index?Uint32Array.from(geometry.index.array):undefined
   const result=await new Promise((resolve,reject)=>{
    worker.onmessage=({data})=>resolve(data.result||{skipped:true,error:data.error})
    worker.onerror=()=>reject(Error('Kontrolu sítě se nepodařilo dokončit.'))
    worker.postMessage({positions,index,groups:geometry.groups},[positions.buffer,...(index?[index.buffer]:[])])
   })
   if(!result.changed)continue
   const next=geometry.clone();next.setIndex(new THREE.BufferAttribute(result.index,1));next.groups=result.groups
   next.boundsTree=MeshBVH.deserialize(result.tree,next,{setIndex:false});next.computeBoundingBox();next.computeBoundingSphere()
   pending.push({mesh,next});await pause()
  }
  for(const {mesh,next} of pending){
   backup.push({mesh,geometry:mesh.geometry,visible:mesh.visible,originalColors:mesh.userData._originalColors,baseGeom:mesh.userData._baseGeom,derivedGeom:mesh.userData._derivedGeom})
   mesh.geometry=next;mesh.userData._baseGeom=next;mesh.userData._derivedGeom=next;mesh.userData._originalColors=next.getAttribute('color')?.clone()||null
   delete mesh.userData._comparisonColors;delete mesh.userData._comparisonDistances
  }
  return {backup}
 }catch(error){pending.forEach(({next})=>next.dispose());throw error}
 finally{worker.terminate()}
}
