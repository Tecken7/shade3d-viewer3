import * as THREE from 'three'
import {toCreasedNormals} from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import {MeshBVH} from 'three-mesh-bvh'
import {FontLoader} from 'three/examples/jsm/loaders/FontLoader.js'
import {findLabLogoPlacement} from './lab-logo-placement.mjs'
self.onmessage=({data})=>{
 let raw,surface
 try{
  raw=new THREE.BufferGeometry().setAttribute('position',new THREE.BufferAttribute(data.positions,3))
  if(data.index)raw.setIndex(new THREE.BufferAttribute(data.index,1))
  surface=toCreasedNormals(raw,Math.PI/6);surface.boundsTree=new MeshBVH(surface)
  self.postMessage({result:findLabLogoPlacement(surface,new FontLoader().parse(data.font),data.options,data.placement)})
 }catch(error){self.postMessage({error:error.message})}finally{raw?.dispose();surface?.dispose()}
}
