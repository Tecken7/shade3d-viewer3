import * as THREE from "three"

// Bounded, one-off analysis. No geometry or model transforms are changed.
export function principalAxes(points) {
  if (points.length < 24) return null
  const center = new THREE.Vector3()
  points.forEach(p => center.add(p))
  center.divideScalar(points.length)
  const a = Array.from({ length: 3 }, () => [0, 0, 0])
  for (const point of points) {
    const d = point.clone().sub(center).toArray()
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) a[i][j] += d[i] * d[j] / points.length
  }
  const vectors = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  for (let step = 0; step < 32; step++) {
    let p = 0, q = 1
    for (const [i, j] of [[0, 2], [1, 2]]) if (Math.abs(a[i][j]) > Math.abs(a[p][q])) { p = i; q = j }
    if (Math.abs(a[p][q]) < 1e-10) break
    const angle = .5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p])
    const c = Math.cos(angle), s = Math.sin(angle)
    const pp = a[p][p], qq = a[q][q], pq = a[p][q]
    for (let k = 0; k < 3; k++) {
      if (k !== p && k !== q) {
        const kp = a[k][p], kq = a[k][q]
        a[k][p] = a[p][k] = c * kp - s * kq
        a[k][q] = a[q][k] = s * kp + c * kq
      }
      const vp = vectors[k][p], vq = vectors[k][q]
      vectors[k][p] = c * vp - s * vq
      vectors[k][q] = s * vp + c * vq
    }
    a[p][p] = c*c*pp - 2*s*c*pq + s*s*qq
    a[q][q] = s*s*pp + 2*s*c*pq + c*c*qq
    a[p][q] = a[q][p] = 0
  }
  return { center, axes: [0, 1, 2].map(i => ({ value: a[i][i], axis: new THREE.Vector3(...vectors.map(row => row[i])).normalize() })).sort((x, y) => y.value - x.value) }
}

const median = values => { values.sort((a,b) => a-b); return values[Math.floor(values.length / 2)] || 0 }

export function estimateArchOrientation(points, upHint = null) {
  const pca = principalAxes(points)
  if (!pca || pca.axes[1].value < 1e-8 || pca.axes[2].value / pca.axes[1].value > .45) return null
  const up = pca.axes[2].axis.clone()
  const reference = upHint?.lengthSq() > 1e-8 ? upHint : new THREE.Vector3(0, 1, 0)
  if (up.dot(reference) < 0) up.negate()
  let best = null
  // The closed anterior end of a complete arch is narrower than its open arms.
  for (let i = 0; i < 2; i++) {
    const front = pca.axes[i].axis.clone(), lateral = pca.axes[1-i].axis
    const projected = points.map(point => { const d = point.clone().sub(pca.center); return { z: d.dot(front), x: Math.abs(d.dot(lateral)) } })
    const depths = projected.map(p => p.z).sort((a,b) => a-b)
    const lo = depths[Math.floor(depths.length*.18)], hi = depths[Math.floor(depths.length*.82)]
    const negative = projected.filter(p => p.z <= lo).map(p => p.x)
    const positive = projected.filter(p => p.z >= hi).map(p => p.x)
    const leftWidth = median(negative), rightWidth = median(positive)
    const score = Math.abs(leftWidth-rightWidth) / Math.max(leftWidth, rightWidth, 1e-8)
    if (rightWidth > leftWidth) front.negate()
    if (!best || score > best.confidence) best = { up: up.clone(), front, confidence: score }
  }
  if (!best || best.confidence < .30) return null
  // PCA can lean toward the denser arm of an unevenly tessellated scan.
  // Refine yaw using the bilateral outline, rather than vertex density.
  const lateral = new THREE.Vector3().crossVectors(up, best.front).normalize()
  const projected = points.map(point => { const d = point.clone().sub(pca.center); return [d.dot(lateral), d.dot(best.front)] })
  let bestAngle = 0, bestCost = Infinity
  for (let degrees = -36; degrees <= 36; degrees += 3) {
    const angle = degrees * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle)
    const rotated = projected.map(([x,z]) => [c*x-s*z, s*x+c*z])
    let min = Infinity, max = -Infinity
    for (const [,z] of rotated) { min = Math.min(min,z); max = Math.max(max,z) }
    const bins = Array.from({length:10},()=>[])
    for (const [x,z] of rotated) bins[Math.min(9, Math.floor((z-min)/Math.max(max-min,1e-8)*10))].push(x)
    const midpoints = [], widths = []
    for (const bin of bins.slice(1,9)) {
      if (bin.length < 8) continue
      bin.sort((a,b)=>a-b)
      const lo=bin[Math.floor(bin.length*.08)], hi=bin[Math.floor(bin.length*.92)]
      midpoints.push((lo+hi)/2); widths.push(hi-lo)
    }
    if (midpoints.length < 5) continue
    const mean=midpoints.reduce((a,b)=>a+b,0)/midpoints.length
    const cost=midpoints.reduce((sum,x)=>sum+(x-mean)**2,0)/midpoints.length / Math.max(median(widths)**2,1e-8)
    if (cost < bestCost) { bestCost=cost; bestAngle=angle }
  }
  best.front.applyAxisAngle(up,bestAngle).normalize()
  return best
}

export function inferSceneOrientation(root, maxSamples = 6000) {
  root.updateMatrixWorld(true)
  const objects = []
  root.traverse(child => {
    if ((child.isMesh || child.isPoints) && child.geometry?.getAttribute("position")?.count) objects.push(child)
  })
  if (!objects.length) return null
  // Prefer a named complete arch over preparations, crowns, helpers or a mixed pair.
  const nameOf = object => { let text = ""; for (let p = object; p && p !== root.parent; p = p.parent) text += ` ${p.userData?.scanName || p.name || ""}`; return text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "") }
  const archOf = object => /upper|maxilla|horni/.test(nameOf(object)) ? "upper" : /lower|mandib|dolni/.test(nameOf(object)) ? "lower" : null
  const named = objects.filter(object => archOf(object))
  const candidates = (named.length ? named : objects).slice().sort((a,b) => b.geometry.getAttribute("position").count - a.geometry.getAttribute("position").count)
  const object = candidates[0], position = object.geometry.getAttribute("position")
  const points = [], point = new THREE.Vector3()
  const count = Math.min(maxSamples, position.count)
  for (let i = 0; i < count; i++) {
    point.fromBufferAttribute(position, Math.floor(i * position.count / count)).applyMatrix4(object.matrixWorld)
    if (point.toArray().every(Number.isFinite)) points.push(point.clone())
  }
  let upHint = null
  const centers = {}
  for (const arch of ["upper", "lower"]) {
    const box = new THREE.Box3()
    objects.filter(o => archOf(o) === arch).forEach(o => box.union(new THREE.Box3().setFromObject(o)))
    if (!box.isEmpty()) centers[arch] = box.getCenter(new THREE.Vector3())
  }
  if (centers.upper && centers.lower) upHint = centers.upper.clone().sub(centers.lower)
  // Open surface normals disambiguate the upright direction for isolated arches.
  if (!upHint && archOf(object) && object.geometry.getAttribute("normal")) {
    const normal = object.geometry.getAttribute("normal"), sum = new THREE.Vector3(), matrix = new THREE.Matrix3().getNormalMatrix(object.matrixWorld)
    for (let i = 0; i < count; i++) sum.add(new THREE.Vector3().fromBufferAttribute(normal, Math.floor(i*normal.count/count)).applyNormalMatrix(matrix))
    if (sum.length() > count * .1) upHint = sum.multiplyScalar(archOf(object) === "upper" ? -1 : 1).normalize()
  }
  return estimateArchOrientation(points, upHint)
}

export function fitOrientedBounds(box, front, up) {
  const right = new THREE.Vector3().crossVectors(up, front).normalize()
  const center = box.getCenter(new THREE.Vector3())
  let width = 0, height = 0
  for (const x of [box.min.x,box.max.x]) for (const y of [box.min.y,box.max.y]) for (const z of [box.min.z,box.max.z]) {
    const d = new THREE.Vector3(x,y,z).sub(center)
    width = Math.max(width, Math.abs(d.dot(right))*2)
    height = Math.max(height, Math.abs(d.dot(up))*2)
  }
  return { width, height }
}
