import * as THREE from 'three'

// Move the last wrapped proposal with the pointer; wrap/validate it only when
// the pointer rests or is released. No mesh rebuild or React update per move.
export function textPreviewTransform(origin,target){
 const rotation=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(...origin.normal).normalize(),new THREE.Vector3(...target.normal).normalize())
 return new THREE.Matrix4().compose(new THREE.Vector3(...target.position),rotation,new THREE.Vector3(1,1,1)).multiply(new THREE.Matrix4().makeTranslation(...origin.position.map(v=>-v)))
}
