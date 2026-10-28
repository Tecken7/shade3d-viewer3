import * as THREE from 'three'
import {sampleContour} from './transition.mjs'

export function smoothMargin(vertices, boundary, strength) {
  if (!(strength > 0)) return
  const original = boundary.map(id => new THREE.Vector3().fromArray(vertices, id * 3))
  const arc = [0]
  original.forEach((p, i) => arc.push(arc[i] + p.distanceTo(original[(i + 1) % original.length])))
  const perimeter = arc[arc.length - 1]
  const count = Math.max(32, Math.ceil(perimeter / 0.3))
  const sample = distance => {
    let lo = 0, hi = original.length - 1
    while (lo < hi) { const mid = Math.floor((lo + hi + 1) / 2); if (arc[mid] <= distance) lo = mid; else hi = mid - 1 }
    const next = (lo + 1) % original.length
    return original[lo].clone().lerp(original[next], (distance - arc[lo]) / Math.max(1e-12, arc[lo + 1] - arc[lo]))
  }
  let ring = Array.from({ length: count }, (_, i) => sample(i * perimeter / count))
  const iterations = Math.min(80, Math.max(2, Math.round(16 * strength * strength / 0.64)))
  for (let pass = 0; pass < iterations; pass++) ring = ring.map((p, i) => p.clone().multiplyScalar(0.5).addScaledVector(ring[(i + count - 1) % count], 0.25).addScaledVector(ring[(i + 1) % count], 0.25))
  const displacement = original.map((p, i) => {
    const t = arc[i] / perimeter * count, j = Math.floor(t)
    const delta = ring[j % count].clone().lerp(ring[(j + 1) % count], t - j).sub(p)
    if (delta.length() > strength) delta.setLength(strength)
    return delta
  })
  const band = Math.max(1, strength * 1.5), cells = new Map(), boundaryIds = new Map(boundary.map((id, i) => [id, i]))
  const key = (x, y, z) => `${x},${y},${z}`
  original.forEach((p, i) => { const k = key(Math.floor(p.x / band), Math.floor(p.y / band), Math.floor(p.z / band)); if (!cells.has(k)) cells.set(k, []); cells.get(k).push(i) })
  const point = new THREE.Vector3()
  for (let id = 0; id < vertices.length / 3; id++) {
    point.fromArray(vertices, id * 3)
    let nearest = boundaryIds.get(id), best = nearest == null ? band * band : 0
    if (nearest == null) {
      const x = Math.floor(point.x / band), y = Math.floor(point.y / band), z = Math.floor(point.z / band)
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
        for (const index of cells.get(key(x + a, y + b, z + c)) || []) {
          const distance = point.distanceToSquared(original[index])
          if (distance < best) { best = distance; nearest = index }
        }
      }
    }
    if (nearest == null) continue
    const w = 1 - Math.sqrt(best) / band
    point.addScaledVector(displacement[nearest], w * w * (3 - 2 * w)).toArray(vertices, id * 3)
  }
}

// Shared by the printable base and the lightweight height guide. Keep all
// regularization before sampling so scan-rim spikes never become preview miters.
export function prepareBaseContour(M,vertices,boundary,smoothing,own){
  const rawContour=boundary.map(id=>[vertices[id*3],vertices[id*3+2]])
  const raw=own(new M.CrossSection([rawContour],'EvenOdd'))
  const regular=smoothing>0?own(own(raw.offset(-smoothing,'Round',2,48)).offset(smoothing,'Round',2,48)):raw
  const polygons=own(regular.simplify(.015)).toPolygons()
  if(polygons.length!==1)throw new Error('Okraj skenu se při pohledu shora výrazně překrývá. Nejprve jej ořízněte čistou hranicí.')
  return sampleContour(polygons[0])
}

export function prepareBevelRings(M,contour,bevel,own){
  if(!(bevel>0))return []
  const section=own(new M.CrossSection([contour],'EvenOdd')),rings=[]
  const levels=Math.ceil(bevel/.125)
  for(let level=1;level<=levels;level++){
    const amount=bevel*level/levels
    const inset=own(section.offset(-amount,'Round',2,48))
    const polygons=own(inset.simplify(.002)).toPolygons()
    if(polygons.length!==1)throw new Error('Bevel rozděluje obrys báze. Zmenšete bevel nebo upravte ořez.')
    rings.push({points:polygons[0],y:-(bevel-amount)})
  }
  return rings
}
