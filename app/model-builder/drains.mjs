import * as THREE from 'three'

// Inspect the disk, not just its centre line. A curved inner wall can leave a
// crescent of material even though the cutter already touches the cavity.
export function drainPassage(tree, center, outward, radius, reach) {
  const axis = outward.clone().normalize(), inward = axis.clone().negate()
  const up = new THREE.Vector3(0, 1, 0), right = new THREE.Vector3().crossVectors(up, axis).normalize()
  up.crossVectors(axis, right).normalize()
  const samples = [[0, 0]]
  for (let ring = 1; ring <= 6; ring++) for (let step = 0; step < 64; step++) {
    const angle = step * Math.PI * 2 / 64, r = radius * ring / 6
    samples.push([Math.cos(angle) * r, Math.sin(angle) * r])
  }
  let requiredLength = 0, frontExtension = 0.15, intersectingRays = 0
  const origin = new THREE.Vector3(), ray = new THREE.Ray(origin, inward)
  for (const [x, y] of samples) {
    origin.copy(center).addScaledVector(right, x).addScaledVector(up, y).addScaledVector(axis, reach)
    const hits = tree.raycast(ray, THREE.DoubleSide).sort((a, b) => a.distance - b.distance)
    const unique = hits.filter((hit, i) => !i || hit.distance - hits[i - 1].distance > 0.0001)
    let entry = null
    const intervals = []
    for (const hit of unique) {
      const depth = hit.distance - reach
      if (hit.face.normal.dot(inward) < -0.00001) entry = depth
      else if (entry != null && hit.face.normal.dot(inward) > 0.00001) { intervals.push([entry, depth]); entry = null }
    }
    // Select the wall around the placed opening, rather than the opposite side
    // of the arch encountered later by the same ray.
    const local = intervals.filter(([a, b]) => b >= -0.15 && a <= radius + 3 && a >= -radius - 3)
      .sort((a, b) => Math.abs(a[0]) - Math.abs(b[0]))[0]
    if (!local) continue
    intersectingRays++
    requiredLength = Math.max(requiredLength, local[1] + 0.3)
    frontExtension = Math.max(frontExtension, -local[0] + 0.3)
  }
  return { requiredLength, frontExtension, intersectingRays }
}
