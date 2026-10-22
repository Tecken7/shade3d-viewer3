import * as THREE from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import { FontLoader } from 'three/examples/jsm/loaders/FontLoader.js'
import { projectSurfaceText } from './surface-text.mjs'
import { sampleContour, roundShoulder } from './transition.mjs'
import { drainPassage } from './drains.mjs'
import { prepareSurface } from './prepare-surface.mjs'
import { holeDirection, seatHoleOnContour } from './hole-placement.mjs'
import { baseDirection } from './base-direction.mjs'

import { DEFAULTS } from "./defaults.mjs"
export { DEFAULTS } from "./defaults.mjs"

export function indexed(positions, { exact = false } = {}) {
  const vertices = [], faces = [], map = new Map()
  for (let i = 0; i < positions.length; i += 3) {
    const key = [0, 1, 2].map(k => exact ? positions[i + k] : Math.round(positions[i + k] * 100000)).join(',')
    if (!map.has(key)) { map.set(key, vertices.length / 3); vertices.push(...positions.slice(i, i + 3)) }
    faces.push(map.get(key))
  }
  const clean = []
  for (let i = 0; i < faces.length; i += 3) {
    const [a, b, c] = faces.slice(i, i + 3)
    if (a !== b && b !== c && c !== a) clean.push(a, b, c)
  }
  return { vertices, faces: clean }
}

export function meshTopology(vertices, faces) {
  const edges = new Map()
  for (let i = 0; i < faces.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const a = faces[i + k], b = faces[i + (k + 1) % 3], key = a < b ? `${a}:${b}` : `${b}:${a}`
      const edge = edges.get(key)
      if (edge) { edge.count++; edge.balance += a < b ? 1 : -1 }
      else edges.set(key, { a, b, count: 1, balance: a < b ? 1 : -1 })
    }
  }
  const open = [...edges.values()].filter(e => e.count === 1)
  const next = new Map(), loops = []
  for (const edge of open) {
    if (next.has(edge.a)) throw new Error('Hranice skenu se větví. Vraťte se do opravy sítě.')
    next.set(edge.a, edge.b)
  }
  while (next.size) {
    const start = next.keys().next().value, loop = []
    let current = start
    do {
      loop.push(current)
      const n = next.get(current)
      next.delete(current)
      if (n == null) throw new Error('Hranice není uzavřená. Nejprve opravte síť.')
      current = n
    } while (current !== start && loop.length <= open.length)
    loops.push(loop)
  }
  const point = id => new THREE.Vector3().fromArray(vertices, id * 3)
  loops.sort((a, b) => {
    const perimeter = l => l.reduce((s, id, i) => s + point(id).distanceTo(point(l[(i + 1) % l.length])), 0)
    return perimeter(b) - perimeter(a)
  })
  return { loops, openEdges: open.length, nonManifold: [...edges.values()].filter(e => e.count > 2 || (e.count === 2 && e.balance !== 0)).length }
}

function signedVolume(v, f) {
  let result = 0
  for (let i = 0; i < f.length; i += 3) {
    const a = f[i] * 3, b = f[i + 1] * 3, c = f[i + 2] * 3
    result += v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) + v[a + 1] * (v[b + 2] * v[c] - v[b] * v[c + 2]) + v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c])
  }
  return result / 6
}

function bufferGeometry(v, f) {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3))
  g.setIndex(f)
  return g
}

function fromManifold(solid) {
  const m = solid.getMesh(), vertices = [], faces = [], remap = new Map()
  const parents = Array.from({ length: m.vertProperties.length / m.numProp }, (_, i) => i)
  const root = id => { while (parents[id] !== id) { parents[id] = parents[parents[id]]; id = parents[id] } return id }
  // Use the kernel's explicit seam correspondence. Rounding boolean intersections
  // can incorrectly merge nearby but distinct vertices and open a valid surface.
  m.mergeFromVert.forEach((id, i) => { parents[root(id)] = root(m.mergeToVert[i]) })
  for (const id of m.triVerts) {
    const canonical = root(id)
    if (!remap.has(canonical)) {
      remap.set(canonical, vertices.length / 3)
      const offset = canonical * m.numProp
      vertices.push(m.vertProperties[offset], m.vertProperties[offset + 1], m.vertProperties[offset + 2])
    }
    faces.push(remap.get(canonical))
  }
  return { vertices, faces }
}

function separateTouchingSurfaces(vertices, faces) {
  const groups = new Map(), normals = new Float64Array(vertices.length)
  for (let id = 0; id < vertices.length / 3; id++) {
    const key = vertices.slice(id * 3, id * 3 + 3).join(',')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(id)
  }
  const contacts = [...groups.values()].filter(group => group.length > 1)
  if (!contacts.length) return 0
  for (let i = 0; i < faces.length; i += 3) {
    const a = faces[i] * 3, b = faces[i + 1] * 3, c = faces[i + 2] * 3
    const ab = [0, 1, 2].map(k => vertices[b + k] - vertices[a + k]), ac = [0, 1, 2].map(k => vertices[c + k] - vertices[a + k])
    const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]]
    for (const offset of [a, b, c]) for (let k = 0; k < 3; k++) normals[offset + k] += n[k]
  }
  // A distance-field saddle can have distinct topological sheets touching at
  // identical coordinates. STL has no vertex IDs, so separate these contacts
  // into their respective air regions by 2 microns before coordinate welding.
  for (const group of contacts) {
    for (const id of group) {
      const offset = id * 3, n = new THREE.Vector3().fromArray(normals, offset).normalize()
      if (n.lengthSq() < 0.5) throw new Error('Nepodařilo se oddělit dotýkající se vnitřní plochy. Změňte tloušťku stěny o 0,1 mm.')
      for (let k = 0; k < 3; k++) vertices[offset + k] += n.getComponent(k) * 0.002
    }
  }
  return contacts.length
}

function asSolid(M, v, f, own) {
  const mesh = new M.Mesh({ numProp: 3, vertProperties: new Float32Array(v), triVerts: new Uint32Array(f) })
  mesh.merge()
  const solid = own(new M.Manifold(mesh))
  if (solid.status() !== 'NoError' || solid.isEmpty()) throw new Error(`Síť nelze zpracovat (${solid.status()}). Zkontrolujte opravy a ořez.`)
  return solid
}

function cap(v, f, rings, normalY) {
  const shapes = rings.map(r => r.map(id => new THREE.Vector2(v[id * 3], v[id * 3 + 2])))
  const ids = rings.flat()
  const triangles = []
  for (const tri of THREE.ShapeUtils.triangulateShape(shapes[0], shapes.slice(1))) {
    let [a, b, c] = tri.map(i => ids[i])
    const crossY = (v[b * 3 + 2] - v[a * 3 + 2]) * (v[c * 3] - v[a * 3]) - (v[b * 3] - v[a * 3]) * (v[c * 3 + 2] - v[a * 3 + 2])
    if (Math.abs(crossY) < 1e-10) continue
    if (crossY * normalY < 0) [b, c] = [c, b]
    triangles.push(a, b, c)
  }
  // Earcut omits collinear contour samples. Restore them on triangle edges so
  // the densely sampled bevel remains exactly stitched to its wall and cap.
  const used = new Set(triangles)
  for (const id of ids) {
    if (used.has(id)) continue
    let inserted = false
    for (let i = 0; i < triangles.length && !inserted; i += 3) {
      for (let j = 0; j < 3; j++) {
        const a = triangles[i + j], b = triangles[i + (j + 1) % 3], c = triangles[i + (j + 2) % 3]
        const dx = v[b * 3] - v[a * 3], dz = v[b * 3 + 2] - v[a * 3 + 2], length2 = dx * dx + dz * dz
        const px = v[id * 3] - v[a * 3], pz = v[id * 3 + 2] - v[a * 3 + 2]
        const t = (px * dx + pz * dz) / Math.max(1e-20, length2)
        if (t > 1e-9 && t < 1 - 1e-9 && Math.abs(px * dz - pz * dx) < 1e-7 * Math.sqrt(length2)) {
          triangles.splice(i, 3, a, id, c)
          triangles.push(id, b, c)
          used.add(id); inserted = true; break
        }
      }
    }
    if (!inserted) throw new Error('Okraj báze obsahuje nejednoznačný bod. Změňte vyhlazení okraje nebo ořez.')
  }
  // The scan may arrive with globally inverted winding. Stitching follows that
  // winding, so the closing cap must follow its wall rather than assuming that
  // Upper/Lower alone determines face orientation. The complete closed solid
  // is oriented outward by signed volume afterwards.
  const rim = new Set(ids), wallDirections = new Set()
  for (let i = 0; i < f.length; i += 3) {
    for (let j = 0; j < 3; j++) {
      const a = f[i + j], b = f[i + (j + 1) % 3]
      if (rim.has(a) && rim.has(b)) wallDirections.add(`${a}:${b}`)
    }
  }
  let reverse = false, matched = false
  for (let i = 0; i < triangles.length && !matched; i += 3) {
    for (let j = 0; j < 3; j++) {
      const a = triangles[i + j], b = triangles[i + (j + 1) % 3]
      if (wallDirections.has(`${a}:${b}`)) { reverse = true; matched = true; break }
      if (wallDirections.has(`${b}:${a}`)) { matched = true; break }
    }
  }
  if (reverse) for (let i = 0; i < triangles.length; i += 3) [triangles[i + 1], triangles[i + 2]] = [triangles[i + 2], triangles[i + 1]]
  for (const id of triangles) f.push(id)
}


function stitch(v, f, top, bottom) {
  const area = ring => ring.reduce((s, id, i) => { const next = ring[(i + 1) % ring.length]; return s + v[id * 3] * v[next * 3 + 2] - v[next * 3] * v[id * 3 + 2] }, 0)
  if (area(top) * area(bottom) < 0) bottom.reverse()
  let closest = 0, distance = Infinity
  bottom.forEach((id, i) => { const d = Math.hypot(v[id * 3] - v[top[0] * 3], v[id * 3 + 2] - v[top[0] * 3 + 2]); if (d < distance) { distance = d; closest = i } })
  bottom = [...bottom.slice(closest), ...bottom.slice(0, closest)]
  const fractions = ring => {
    const lengths = [0]
    for (let i = 0; i < ring.length; i++) { const a = ring[i] * 3, b = ring[(i + 1) % ring.length] * 3; lengths.push(lengths[i] + Math.hypot(v[a] - v[b], v[a + 2] - v[b + 2])) }
    return lengths.map(x => x / lengths[lengths.length - 1])
  }
  const a = fractions(top), b = fractions(bottom)
  let i = 0, j = 0
  while (i < top.length || j < bottom.length) {
    const ti = top[i % top.length], bj = bottom[j % bottom.length]
    if (j < bottom.length && (i === top.length || b[j + 1] <= a[i + 1])) { f.push(ti, bj, bottom[(j + 1) % bottom.length]); j++ }
    else { f.push(ti, bj, top[(i + 1) % top.length]); i++ }
  }
}

function smoothMargin(vertices, boundary, strength) {
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

export async function buildModel(M, input, options, fontData, progress = () => {}) {
  const p = { ...DEFAULTS, ...options }, allocated = []
  const own = x => { allocated.push(x); return x }
  let surfaceGeometry, closedGeometry, textSurfaceGeometry, drainGeometry
  try {
    // Worker input already contains shared Float32 coordinates. Do not round
    // nearby, distinct cut vertices into a pinched/branching boundary.
    const source = indexed(input, { exact: true })
    const { vertices: v, faces: f } = prepareSurface(source.vertices, source.faces)
    const topology = meshTopology(v, f)
    if (topology.nonManifold) throw new Error('Scan obsahuje neplatné nebo obrácené hrany. Nejprve použijte opravu sítě.')
    if (topology.loops.length !== 1) throw new Error(`Scan má ${topology.loops.length} otevřených hranic. Potřebuji jednu hlavní hranici; ostatní díry nejprve opravte.`)
    const bounds = new THREE.Box3().setFromBufferAttribute(new THREE.Float32BufferAttribute(v, 3))
    const direction = baseDirection(v,topology.loops[0],options.arch,p.flipBaseDirection)
    const naturalHeight = bounds.max.y - bounds.min.y
    if (!Number.isFinite(p.totalHeight) || p.totalHeight < naturalHeight + 1) throw new Error(`Celková výška musí být alespoň ${(naturalHeight + 1).toFixed(1)} mm. Scan se nezmenšuje.`)
    if (!(p.wall >= 0.8 && p.wall <= 10) || !(p.bevel >= 0 && p.bevel <= Math.min(2, p.wall * 0.7))) throw new Error('Neplatná tloušťka stěny nebo bevel. Bevel musí být menší než 70 % stěny.')
    if (!(p.smoothing >= 0 && p.smoothing <= 2)) throw new Error('Vyhlazení okraje musí být 0–2 mm.')
    if (!(p.rounding >= 0 && p.rounding <= 3)) throw new Error('Zaoblení napojení musí být 0–3 mm.')
    const baseY = direction > 0 ? bounds.min.y + p.totalHeight : bounds.max.y - p.totalHeight
    const boundary = topology.loops[0]
    smoothMargin(v, boundary, p.smoothing ?? 0.8)
    const rawContour = boundary.map(id => [v[id * 3], v[id * 3 + 2]])
    const rawSection = own(new M.CrossSection([rawContour], 'EvenOdd'))
    // A morphological opening removes projecting spurs and rounds convex corners
    // without adding a widened platform to the model.
    const regularSection = p.smoothing > 0
      ? own(own(rawSection.offset(-p.smoothing, 'Round', 2, 48)).offset(p.smoothing, 'Round', 2, 48))
      : rawSection
    const cleanSection = own(regularSection.simplify(0.015))
    const cleanPolygons = cleanSection.toPolygons()
    if (cleanPolygons.length !== 1) throw new Error('Okraj skenu se při pohledu shora výrazně překrývá. Nejprve jej ořízněte čistou hranicí.')
    const originalCount = v.length / 3
    const boundaryPoints = boundary.map(id => v.slice(id * 3, id * 3 + 3))
    const sideRing = sampleContour(cleanPolygons[0]).map(pt => { const n = v.length / 3; v.push(pt[0], baseY - direction * p.bevel, pt[1]); return n })
    const ringArea = ring => ring.reduce((sum, id, i) => { const next = ring[(i + 1) % ring.length]; return sum + v[id * 3] * v[next * 3 + 2] - v[next * 3] * v[id * 3 + 2] }, 0)
    if (ringArea(boundary) * ringArea(sideRing) < 0) sideRing.reverse()
    const shoulderY = sideRing.map(id => {
      const x = v[id * 3], z = v[id * 3 + 2]
      let best = Infinity, y = 0
      for (let i = 0; i < boundary.length; i++) {
        const a = boundary[i] * 3, b = boundary[(i + 1) % boundary.length] * 3
        const dx = v[b] - v[a], dz = v[b + 2] - v[a + 2]
        const t = Math.max(0, Math.min(1, ((x - v[a]) * dx + (z - v[a + 2]) * dz) / Math.max(1e-12, dx * dx + dz * dz)))
        const d = Math.hypot(x - v[a] - dx * t, z - v[a + 2] - dz * t)
        if (d < best) { best = d; y = v[a + 1] + (v[b + 1] - v[a + 1]) * t }
      }
      const available = direction * (baseY - direction * p.bevel - y)
      if (available <= 0.1) throw new Error('U okraje nezbývá místo pro bevel. Zvětšete výšku nebo scan více ořízněte.')
      return { y, available }
    })
    const shoulderDepth = Math.max(0.8, p.rounding * 1.5)
    const rows = Math.max(2, Math.ceil(shoulderDepth / 0.3))
    const generatedWeights = new Map()
    let previous = boundary
    for (let row = 0; row <= rows; row++) {
      const t = row / rows
      const ring = sideRing.map((id, i) => {
        const { y, available } = shoulderY[i]
        const depth = Math.min(shoulderDepth, available * 0.75)
        const vertex = v.length / 3
        v.push(v[id * 3], y + direction * (0.12 + t * Math.max(0, depth - 0.12)), v[id * 3 + 2])
        generatedWeights.set(vertex, (1 - t) ** 2)
        return vertex
      })
      if (row === 0) stitch(v, f, previous, ring)
      else for (let i = 0; i < ring.length; i++) {
        const j = (i + 1) % ring.length
        f.push(previous[i], ring[i], ring[j], previous[i], ring[j], previous[j])
      }
      previous = ring
    }
    for (let i = 0; i < sideRing.length; i++) {
      const j = (i + 1) % sideRing.length
      f.push(previous[i], sideRing[i], sideRing[j], previous[i], sideRing[j], previous[j])
    }
    roundShoulder(v, f, boundaryPoints, generatedWeights, originalCount, p.rounding, direction > 0 ? bounds.min.y : bounds.max.y)
    let baseRings = [sideRing]
    if (p.bevel > 0) {
      const contour = sideRing.map(id => [v[id * 3], v[id * 3 + 2]])
      const section = own(new M.CrossSection([contour], 'EvenOdd'))
      // Thin nested offset strips avoid a single triangulation spanning the
      // whole concave annulus, which can fold across the inner horseshoe corners.
      let previousRing = sideRing
      const levels = Math.ceil(p.bevel / 0.125)
      for (let level = 1; level <= levels; level++) {
        const insetAmount = p.bevel * level / levels
        const inset = own(section.offset(-insetAmount, 'Round', 2, 48))
        const polygons = own(inset.simplify(0.002)).toPolygons()
        if (polygons.length !== 1) throw new Error('Bevel rozděluje obrys báze. Zmenšete bevel nebo upravte ořez.')
        const ring = polygons[0].map(pt => { const id = v.length / 3; v.push(pt[0], baseY - direction * (p.bevel - insetAmount), pt[1]); return id })
        stitch(v, f, previousRing, ring)
        previousRing = ring
      }
      baseRings = [previousRing]
    }
    const sideFaces = f.slice()
    cap(v, f, baseRings, direction)
    if (signedVolume(v, f) < 0) {
      for (let i = 0; i < f.length; i += 3) [f[i + 1], f[i + 2]] = [f[i + 2], f[i + 1]]
      for (let i = 0; i < sideFaces.length; i += 3) [sideFaces[i + 1], sideFaces[i + 2]] = [sideFaces[i + 2], sideFaces[i + 1]]
    }
    const closedTopology = meshTopology(v, f)
    if (closedTopology.openEdges || closedTopology.nonManifold) throw new Error('Obrys báze se překrývá nebo není uzavřený. Upravte ořez.')
    progress('Připravuji bázi a kontroluji síť…')
    let result = asSolid(M, v, f, own)
    closedGeometry = bufferGeometry(v, f)
    const outerBVH = new MeshBVH(closedGeometry)
    const ray = new THREE.Ray(), point = new THREE.Vector3(), hitTarget = {}, toBase = new THREE.Vector3(0, direction, 0)
    let cavityParts = []
    if (p.hollow) {
      progress('Vytvářím dutinu se stěnou ' + p.wall + ' mm…')
      surfaceGeometry = bufferGeometry(v, sideFaces)
      const surfaceBVH = new MeshBVH(surfaceGeometry)
      const min = [bounds.min.x - 0.5, Math.min(bounds.min.y, baseY) - 1, bounds.min.z - 0.5]
      const max = [bounds.max.x + 0.5, Math.max(bounds.max.y, baseY) + 1, bounds.max.z + 0.5]
      const cavity = own(M.Manifold.levelSet(xyz => {
        point.fromArray(xyz)
        // The cutter is the complement of the scan/side-wall distance band.
        // Exterior regions are harmless when subtracted from the solid, while
        // this continuous unsigned field avoids ray-sign discontinuities near
        // thin gingiva and continues naturally through the open bottom.
        surfaceBVH.closestPointToPoint(point, hitTarget)
        return hitTarget.distance - p.wall
      }, { min, max }, 0.65, 0, -1))
      if (cavity.isEmpty()) throw new Error('Pro tuto tloušťku stěny nevznikla dutina. Zmenšete stěnu nebo zvětšete výšku.')
      // Erosion may create small enclosed pockets in individual teeth. Only
      // cavities connected to the open underside are allowed (no trapped resin).
      const openParts = cavity.decompose().map(own).filter(part => {
        const box = part.boundingBox()
        return direction > 0 ? box.max[1] > baseY + 0.1 : box.min[1] < baseY - 0.1
      })
      if (!openParts.length) throw new Error('Dutina není propojená s otevřeným spodkem modelu. Upravte tloušťku nebo výšku.')
      cavityParts = openParts
      for (const part of openParts) result = own(result.subtract(part))
    }
    const bottomContour = baseRings[0].map(id => v.slice(id * 3, id * 3 + 3))
    const placement = { baseY, direction, bottomContour, min: bounds.min.toArray(), max: bounds.max.toArray(), boundary: boundary.map(id => v.slice(id * 3, id * 3 + 3)) }
    // Defaults are found by raycasting onto each distal end of the actual base.
    const defaultHoles = [-1, 1].map(side => {
      const x = (bounds.min.x + bounds.max.x) / 2 + side * (bounds.max.x - bounds.min.x) * 0.34
      const posterior = direction > 0 ? 1 : -1
      ray.origin.set(x, baseY - direction * 1.5, posterior > 0 ? bounds.max.z + 10 : bounds.min.z - 10)
      ray.direction.set(0, 0, -posterior)
      const hit = outerBVH.raycastFirst(ray, THREE.DoubleSide)
      return { enabled: !!hit, autoPosition: true, warning: hit ? null : `Otvor ${side < 0 ? 1 : 2} se nepodařilo automaticky umístit. Základna je vytvořena bez něj; umístěte ho ručně na její stěnu.`, diameter: 4.5, length: 8, autoDepth: true, position: hit ? hit.point.toArray() : [x, baseY - direction * 1.5, (bounds.max.z + bounds.min.z) / 2], normal: [0, 0, posterior] }
    })
    const holes = (p.holes.length ? p.holes : defaultHoles).map(hole => ({ ...hole,
      position: hole.position ? [hole.position[0], hole.position[1] + (Number.isFinite(hole.baseY) ? baseY - hole.baseY : 0), hole.position[2]] : undefined,
      baseY, baseDirection: direction }))
    if (p.cutHoles === false) {
      for (const [index, hole] of holes.entries()) {
        hole.position = seatHoleOnContour(bottomContour, hole, hole.position || defaultHoles[index % defaultHoles.length].position)
        hole.warning = null
        hole.through = false
        hole.outerLength = hole.outerLength ?? (p.holes.length ? hole.length : 3)
        if (!p.holes.length) { hole.length = 5; hole.enabled = true; hole.autoDepth = false; hole.autoPosition = false }
      }
    }
    progress({ preparedHoles: holes })
    progress('Přidávám popisek na stěnu modelu…')
    if (p.text.trim()) {
      if (!p.textPosition || !p.textNormal) throw new Error('Nejprve umístěte popisek kliknutím na povrch modelu.')
      if (!(p.textDepth > 0 && p.textDepth <= 3)) throw new Error('Hloubka textu musí být větší než 0 a nejvýše 3 mm.')
      const font = new FontLoader().parse(fontData)
      for (const char of p.text) if (!font.data.glyphs[char]) throw new Error(`Písmo nepodporuje znak „${char}“. Použijte podporované písmeno nebo číslici.`)
      if (!(p.textSize >= 1 && p.textSize <= 12)) throw new Error('Velikost textu musí být 1–12 mm.')
      const shell = fromManifold(result)
      textSurfaceGeometry = bufferGeometry(shell.vertices, shell.faces)
      textSurfaceGeometry.boundsTree = new MeshBVH(textSurfaceGeometry)
      const projected = projectSurfaceText(font,{...p,baseDirection:direction},{position:p.textPosition,normal:p.textNormal},textSurfaceGeometry)
      const text = projected.geometry
      try {
        if(!projected.valid)throw new Error(projected.error || 'Popisek nelze na tento povrch umístit.')
        const expanded = text.index ? text.toNonIndexed() : text
        const t = indexed(expanded.attributes.position.array)
        if (expanded !== text) expanded.dispose()
        const textSolid = asSolid(M, t.vertices, t.faces, own)
        const overlap = own(result.intersect(textSolid))
        if (overlap.isEmpty()) throw new Error('Popisek není spojený s povrchem. Umístěte jej znovu na povrch.')
        result = own(p.textMode === 'engrave' ? result.subtract(textSolid) : result.add(textSolid))
      } finally { text?.dispose() }
    }
    progress('Vyřezávám odtokové otvory přes spodní bevel…')
    const drainShell = fromManifold(result)
    drainGeometry = bufferGeometry(drainShell.vertices, drainShell.faces)
    const drainTree = new MeshBVH(drainGeometry)
    const reach = bounds.getSize(new THREE.Vector3()).length() + 20
    for (let i = 0; i < holes.length; i++) {
      const h = holes[i]
      if (!h.enabled || p.cutHoles === false) continue
      if (!(h.diameter >= 1 && h.diameter <= 15 && h.length >= 0.5 && h.length <= 50)) throw new Error(`Otvor ${i + 1}: neplatný průměr nebo hloubka.`)
      const originalLength = h.length
      try {
      const yaw = ((p.holeYaw ?? 0)+(h.yaw ?? 0)) * Math.PI / 180
      const posterior = direction > 0 ? 1 : -1
      h.normal = p.followContour ? holeDirection(bottomContour,h.position,(p.holeYaw ?? 0)+(h.yaw ?? 0)) : [posterior * Math.sin(yaw), 0, posterior * Math.cos(yaw)]
      const n = new THREE.Vector3().fromArray(h.normal).normalize(), center = new THREE.Vector3().fromArray(h.position)
      if (Math.abs(n.y) > 0.8) throw new Error(`Otvor ${i + 1} umístěte na boční stěnu.`)
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n.clone().negate())
      const clearance = drainPassage(drainTree, center, n, h.diameter / 2, reach)
      h.requiredLength = Math.ceil(clearance.requiredLength * 10) / 10
      if (p.hollow && h.autoDepth !== false) {
        h.autoDepth = true
        h.length = Math.max(h.length, h.requiredLength)
      }
      if (h.length > 50) throw new Error(`Otvor ${i + 1}: průchozí řez vyžaduje více než 50 mm. Změňte polohu otvoru.`)
      // Confirm the entire end disk by a solid intersection as well. A tiny
      // obstacle between the sampled rays must not be accepted as clear.
      let front = Number.isFinite(h.outerLength) ? h.outerLength : clearance.frontExtension
      if (!(front >= 0.15 && front <= 50)) throw new Error(`Otvor ${i + 1}: vnější délka musí být 0,15–50 mm.`)
      const probeAt = depth => {
        const probe = own(M.Manifold.cylinder(0.15, h.diameter / 2, h.diameter / 2, 64, false))
        const matrix = new THREE.Matrix4().compose(center.clone().addScaledVector(n, -depth), q, new THREE.Vector3(1, 1, 1))
        return own(result.intersect(own(probe.transform(matrix.toArray()))))
      }
      const frontLimit = Number.isFinite(h.outerLength) ? front : front + 2
      while (!probeAt(-front).isEmpty() && front + 0.25 <= frontLimit) front += 0.25
      if (!probeAt(-front).isEmpty()) throw new Error(`Otvor ${i + 1}: vnější konec válce ještě zasahuje do stěny. Prodlužte vnější šipku nebo změňte polohu otvoru.`)
      let clearDisk = probeAt(h.length).isEmpty()
      if (p.hollow && h.autoDepth) {
        const limit = Math.min(50, Math.max(h.length, h.requiredLength) + 2)
        while (!clearDisk && h.length + 0.25 <= limit) {
          h.length = Math.round((h.length + 0.25) * 100) / 100
          clearDisk = probeAt(h.length).isEmpty()
        }
        if (!clearDisk) throw new Error(`Otvor ${i + 1}: celý průřez nelze bezpečně otevřít do dutiny. Posuňte otvor nebo zmenšete průměr.`)
      }
      const transform = new THREE.Matrix4().compose(center.clone().addScaledVector(n, front), q, new THREE.Vector3(1, 1, 1))
      const cutter = own(M.Manifold.cylinder(h.length + front, h.diameter / 2, h.diameter / 2, 64, false))
      const positioned = own(cutter.transform(transform.toArray()))
      h.through = p.hollow && clearance.intersectingRays > 0 && h.length >= clearance.requiredLength && clearDisk && cavityParts.some(part => !own(part.intersect(positioned)).isEmpty())
      if (p.hollow && h.autoDepth && !h.through) throw new Error(`Otvor ${i + 1}: nepodařilo se ověřit úplné otevření do dutiny. Změňte polohu otvoru.`)
      const intersection = own(result.intersect(positioned))
      if (intersection.isEmpty()) throw new Error(`Otvor ${i + 1} neprotíná model. Upravte jeho polohu.`)
      const cut = own(result.subtract(positioned))
      if (cut.status() !== 'NoError' || cut.isEmpty()) throw new Error(`Otvor ${i + 1}: řez nelze bezpečně vytvořit.`)
      if (h.autoPosition && cut.decompose().map(own).filter(part => part.volume() > 0).length !== 1) throw new Error(`Otvor ${i + 1}: řez by oddělil část modelu.`)
      result = cut
      h.warning = null
      } catch (error) {
        // Automatic placement is optional. Keep the uncut solid for this hole,
        // expose the disabled candidate, and let the user place it on the preview.
        // Explicit manual edits still report their error instead of silently
        // accepting a different result than requested.
        if (!h.autoPosition) throw error
        h.enabled = false
        h.through = false
        h.length = originalLength
        h.warning = `Otvor ${i + 1} se nepodařilo automaticky umístit. Základna je vytvořena bez něj; umístěte ho ručně na její stěnu.`
      }
    }
    if (result.status() !== 'NoError' || result.isEmpty()) throw new Error('Výsledek operace není platná uzavřená síť.')
    result = own(result.simplify(0.0001))
    // Closed negative shells are sealed air pockets, not printable parts.
    // Keep the connected outer surface, which fills those pockets rather than
    // leaving resin trapped inside a tooth or a numerical sliver at the margin.
    const shells = result.decompose().map(own)
    const positiveShells = shells.filter(part => part.volume() > 0)
    if (positiveShells.length !== 1) throw new Error('Výsledek obsahuje oddělené části. Zkontrolujte polohu otvorů a zda celý popisek leží na stěně.')
    const sealedPockets = shells.length - positiveShells.length
    result = positiveShells[0]
    const output = fromManifold(result)
    const separatedContacts = separateTouchingSurfaces(output.vertices, output.faces)
    const check = meshTopology(output.vertices, output.faces)
    if (check.openEdges || check.nonManifold) throw new Error('Výsledek obsahuje otevřené nebo neplatné hrany. Export byl zastaven.')
    // STL encodes triangle coordinates only, not the kernel's vertex identity.
    // Validate that same representation as well, including Float32 rounding.
    const expanded = new Float32Array(output.faces.length * 3)
    output.faces.forEach((id, i) => expanded.set(output.vertices.slice(id * 3, id * 3 + 3), i * 3))
    const welded = indexed(expanded), stlCheck = meshTopology(welded.vertices, welded.faces)
    if (stlCheck.openEdges || stlCheck.nonManifold) throw new Error('Při převodu do STL se dotýkají vnitřní plochy. Upravte tloušťku stěny o 0,1 mm a přepočítejte náhled.')
    const components = 1
    return { positions: new Float32Array(output.vertices), indices: new Uint32Array(output.faces), holes, placement, warnings: holes.map(h => h.warning).filter(Boolean),
      stats: { triangles: output.faces.length / 3, totalHeight: p.totalHeight, wall: p.wall, openBoundaryLoops: 0, volume: signedVolume(output.vertices, output.faces), components, sealedPockets, separatedContacts } }
  } finally {
    surfaceGeometry?.dispose(); closedGeometry?.dispose(); textSurfaceGeometry?.dispose(); drainGeometry?.dispose()
    for (const obj of allocated.reverse()) obj.delete()
  }
}
