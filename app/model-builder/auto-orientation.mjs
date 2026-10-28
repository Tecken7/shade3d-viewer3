import * as THREE from 'three'
// Suggested reference plane only; the operator still confirms or replaces it.
export function orientationLandmarks(orientation, center, span, arch, worldToRoot = new THREE.Matrix4()) {
  if (!orientation || orientation.confidence < .3) return null
  const up=orientation.up.clone().transformDirection(worldToRoot),front=orientation.front.clone().transformDirection(worldToRoot)
  front.addScaledVector(up,-front.dot(up)).normalize()
  if(front.lengthSq()<.9)return null
  const right=new THREE.Vector3().crossVectors(up,front).normalize().multiplyScalar(arch==='upper'?-1:1)
  const radius=Math.max(1,span*.3),back=center.clone().addScaledVector(front,-radius*.5)
  return [back.clone().addScaledVector(right,-radius),back.clone().addScaledVector(right,radius),center.clone().addScaledVector(front,radius)].map(p=>p.toArray())
}
