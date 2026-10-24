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
  const direction = b.clone().sub(a).normalize()
  const normal = camera.isPerspectiveCamera
    ? first.ray.direction.clone().cross(second.ray.direction).normalize()
    : direction.clone().cross(view).normalize()
  if (normal.lengthSq() < .5) return null
  // Keep vertical sections upright in 2D instead of mapping every stroke to X.
  const screenUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion)
  const y = screenUp.addScaledVector(normal, -screenUp.dot(normal))
  if (y.lengthSq() < 1e-6) y.copy(view).negate()
  y.normalize()
  const x = y.clone().cross(normal).normalize()
  const center = a.clone().add(b).multiplyScalar(.5)
  const matrix = new THREE.Matrix4().makeBasis(x, y, normal).setPosition(center)
  return { matrix, normal, center, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, center) }
}

// A repeated editor payload without CT must not reset a hand-drawn section.
export const sliceSourceChanged = (previous, next) => (previous?.u || null) !== (next?.u || null)

export function placeDrawnSlice({ rig, plane, worldMatrix, center }) {
  rig.position.copy(center); rig.quaternion.identity(); rig.scale.set(1, 1, 1)
  rig.updateWorldMatrix(true, true)
  const local = rig.matrixWorld.clone().invert().multiply(worldMatrix)
  local.decompose(plane.position, plane.quaternion, plane.scale)
  // Explicitly commit local matrices before snapshotting or mounting controls.
  rig.updateMatrix(); plane.updateMatrix()
  plane.updateWorldMatrix(true, true)
  return { rigMatrix: rig.matrix.clone(), planeMatrix: plane.matrix.clone() }
}

// Fit the visible disk to section-local bounds without moving the cut plane.
export function sliceSurfaceFit(bounds, fallbackRadius = 100) {
  if (!bounds || ![bounds.minX, bounds.minY, bounds.width, bounds.height].every(Number.isFinite) || bounds.width < 0 || bounds.height < 0) return null
  return {
    x: bounds.minX + bounds.width / 2,
    y: bounds.minY + bounds.height / 2,
    radius: Math.max(Math.hypot(bounds.width, bounds.height) * .56, fallbackRadius * .025, .1),
  }
}
