import * as THREE from "three"

// The stroke defines the horizontal axis of the section; depth follows the view.
export function planeFromScreenStroke({ start, end, viewport, camera, anchor }) {
  if (!camera || !viewport?.width || !viewport?.height || !anchor || Math.hypot(end.x - start.x, end.y - start.y) < 10) return null
  const ndc = point => new THREE.Vector2(point.x / viewport.width * 2 - 1, 1 - point.y / viewport.height * 2)
  camera.updateMatrixWorld(true)
  const view = camera.getWorldDirection(new THREE.Vector3()).normalize()
  const depth = new THREE.Plane().setFromNormalAndCoplanarPoint(view, anchor)
  const first = new THREE.Raycaster(), second = new THREE.Raycaster()
  first.setFromCamera(ndc(start), camera); second.setFromCamera(ndc(end), camera)
  const a = first.ray.intersectPlane(depth, new THREE.Vector3())
  const b = second.ray.intersectPlane(depth, new THREE.Vector3())
  if (!a || !b || a.distanceToSquared(b) < 1e-12) return null
  const x = b.clone().sub(a).normalize()
  const normal = camera.isPerspectiveCamera
    ? first.ray.direction.clone().cross(second.ray.direction).normalize()
    : x.clone().cross(view).normalize()
  if (normal.lengthSq() < .5) return null
  const y = normal.clone().cross(x).normalize()
  const center = a.clone().add(b).multiplyScalar(.5)
  const matrix = new THREE.Matrix4().makeBasis(x, y, normal).setPosition(center)
  return { matrix, normal, center, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, center) }
}
