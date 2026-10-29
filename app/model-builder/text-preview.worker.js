import * as THREE from 'three'
import {MeshBVH} from 'three-mesh-bvh'
import {FontLoader} from 'three/examples/jsm/loaders/FontLoader.js'
import {projectSurfaceText} from './surface-text.mjs'
let surface,font,options
self.onmessage=({data})=>{
 try{
  if(data.type==='init'){
   surface=new THREE.BufferGeometry().setAttribute('position',new THREE.BufferAttribute(data.positions,3))
   if(data.normals)surface.setAttribute('normal',new THREE.BufferAttribute(data.normals,3))
   if(data.index)surface.setIndex(new THREE.BufferAttribute(data.index,1))
   surface.boundsTree=new MeshBVH(surface);font=new FontLoader().parse(data.font);options=data.options;return
  }
  const result=projectSurfaceText(font,options,data.point,surface,{preview:true})
  const positions=result.geometry?.attributes.position.array,normals=result.geometry?.attributes.normal.array,local=result.geometry?.attributes.textLocal.array
  self.postMessage({id:data.id,valid:result.valid,error:result.error,positions,normals,local},[positions?.buffer,normals?.buffer,local?.buffer].filter(Boolean))
  result.geometry?.dispose()
 }catch(error){self.postMessage({id:data.id,valid:false,error:error.message})}
}
