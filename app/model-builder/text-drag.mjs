import * as THREE from 'three'

function faceNormal(surface,faceIndex){
 const position=surface.attributes.position,index=surface.index
 return new THREE.Triangle(...[0,1,2].map(corner=>new THREE.Vector3().fromBufferAttribute(position,index?index.getX(faceIndex*3+corner):faceIndex*3+corner))).getNormal(new THREE.Vector3())
}

export function beginSurfaceTextDrag(surface,ray,placement){
 const hit=surface.boundsTree.raycastFirst(ray,THREE.DoubleSide)
 if(!hit)return null
 // Keep the full surface chord, including its normal component. Flattening
 // this offset makes an off-centre grab jump before the pointer even moves.
 return {offset:new THREE.Vector3(...placement.position).sub(hit.point),normal:hit.face.normal.clone()}
}

export function moveSurfaceTextDrag(surface,ray,gesture){
 const hit=surface.boundsTree.raycastFirst(ray,THREE.DoubleSide)
 if(!hit)return null
 const rotation=new THREE.Quaternion().setFromUnitVectors(gesture.normal,hit.face.normal)
 const target=hit.point.clone().add(gesture.offset.clone().applyQuaternion(rotation))
 const closest=surface.boundsTree.closestPointToPoint(target)
 if(!closest)return null
 const normal=faceNormal(surface,closest.faceIndex)
 // Never hop across a thin wall onto its opposite side during a drag.
 if(normal.dot(hit.face.normal)<.2||closest.distance>Math.max(.1,gesture.offset.length()*.6))return null
 // The anchor can lie several triangles away from the cursor. Its normal,
 // rather than the cursor's face normal, controls the new text frame.
 return {position:closest.point.toArray(),normal:normal.toArray()}
}
