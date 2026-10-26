export const REPAIR_WELD_TOLERANCE = 0.005

// Spatial neighbours, rather than rounded bins: two points on opposite sides
// of a bin boundary still merge when their Euclidean distance is within tolerance.
export function weldByDistance(points, triangles, tolerance = REPAIR_WELD_TOLERANCE, vertexGroups = null) {
  if (!(tolerance > 0 && tolerance <= 0.1)) throw new Error('Tolerance sloučení musí být větší než 0 a nejvýše 0,1 mm.')
  const cells = new Map(), exact = new Map(), representatives = [], ids = [], positions = []
  const sourceIds = [], sourceMap = new Map(), representativeSource = []
  for (let i = 0; i < points.length; i += 3) {
    const key = `${vertexGroups?.[i / 3] ?? 0}:${points.slice(i, i + 3).join(',')}`
    if (!sourceMap.has(key)) sourceMap.set(key, sourceMap.size)
    sourceIds.push(sourceMap.get(key))
  }
  const parents = Array.from({ length: sourceMap.size }, (_, i) => i)
  const incident = parents.map(() => new Set())
  const sourceFaces = []
  for (let i = 0; i < triangles.length; i += 3) {
    const face = triangles.slice(i, i + 3).map(id => sourceIds[id])
    sourceFaces.push(face)
    for (const id of face) incident[id].add(i / 3)
  }
  const root = id => { while (parents[id] !== id) { parents[id] = parents[parents[id]]; id = parents[id] } return id }
  const links = id => {
    const neighbors = new Map()
    for (const faceId of incident[id]) {
      const face = sourceFaces[faceId].map(root)
      if (new Set(face).size < 3) continue
      for (const other of face) if (other !== id) neighbors.set(other, (neighbors.get(other) || 0) + 1)
    }
    return neighbors
  }
  const canMerge = (a, b) => {
    a = root(a); b = root(b)
    if (a === b) return true
    const left = links(a), right = links(b), shared = [...left.keys()].filter(id => right.has(id)).length
    if (!left.size && !right.size) return true
    const edgeFaces = left.get(b) || 0
    const boundaryA = [...left.values()].some(n => n === 1), boundaryB = [...right.values()].some(n => n === 1)
    if (!edgeFaces) return boundaryA && boundaryB && shared <= 2
    // The link condition prevents collapsing a small edge that would pinch a
    // surface or join the two sides of a thin feature into a non-manifold edge.
    return edgeFaces <= 2 && shared === edgeFaces && !(boundaryA && boundaryB && edgeFaces === 2)
  }
  const merge = (a, b) => {
    a = root(a); b = root(b)
    if (a === b) return
    parents[a] = b
    for (const face of incident[a]) incident[b].add(face)
  }
  let moved = 0, maxDisplacement = 0
  const cellKey = (x, y, z) => `${x},${y},${z}`
  for (let i = 0; i < points.length; i += 3) {
    const p = points.slice(i, i + 3), group = vertexGroups?.[i / 3] ?? 0, key = `${group}:${p.join(',')}`
    if (!p.every(Number.isFinite)) throw new Error('Scan obsahuje neplatné souřadnice.')
    let id = exact.get(key)
    if (id == null) {
      const cell = p.map(x => Math.floor(x / tolerance))
      let best = tolerance * tolerance + Number.EPSILON
      for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
        for (const candidate of cells.get(`${group}:${cellKey(cell[0] + x, cell[1] + y, cell[2] + z)}`) || []) {
          const q = representatives[candidate], distance = p.reduce((sum, value, k) => sum + (value - q[k]) ** 2, 0)
          if (distance < best && canMerge(sourceIds[i / 3], representativeSource[candidate])) { best = distance; id = candidate }
        }
      }
      if (id == null) {
        id = representatives.length; representatives.push(p); representativeSource.push(sourceIds[i / 3])
        const k = `${group}:${cellKey(...cell)}`
        if (!cells.has(k)) cells.set(k, [])
        cells.get(k).push(id)
      }
      merge(sourceIds[i / 3], representativeSource[id])
      exact.set(key, id)
    }
    const q = representatives[id], displacement = Math.hypot(...p.map((value, k) => value - q[k]))
    if (displacement > 0) moved++
    maxDisplacement = Math.max(maxDisplacement, displacement)
    ids.push(id); positions.push(...q)
  }
  const keep = [], seen = new Set()
  let degenerate = 0, duplicateFaces = 0
  for (let i = 0; i < triangles.length; i += 3) {
    const face = triangles.slice(i, i + 3).map(id => ids[id])
    if (new Set(face).size < 3) { degenerate++; continue }
    const key = face.slice().sort((a, b) => a - b).join(',')
    if (seen.has(key)) { duplicateFaces++; continue }
    seen.add(key); keep.push(i / 3)
  }
  if (moved || degenerate || duplicateFaces) {
    const quality = faces => {
      const edges = new Map(), degree = new Map()
      for (const face of faces) for (let k = 0; k < 3; k++) {
        const a = face[k], b = face[(k + 1) % 3]
        if (a === b) continue
        const key = a < b ? `${a}:${b}` : `${b}:${a}`, edge = edges.get(key) || { a, b, count: 0, balance: 0 }
        edge.count++; edge.balance += a < b ? 1 : -1; edges.set(key, edge)
      }
      let invalid = 0, open = 0
      for (const edge of edges.values()) {
        if (edge.count > 2 || (edge.count === 2 && edge.balance !== 0)) invalid++
        if (edge.count === 1) { open++; for (const id of [edge.a, edge.b]) degree.set(id, (degree.get(id) || 0) + 1) }
      }
      return { invalid: invalid + [...degree.values()].filter(n => n !== 2).length, open }
    }
    const after = keep.map(face => triangles.slice(face * 3, face * 3 + 3).map(id => ids[id]))
    const beforeQuality = quality(sourceFaces), afterQuality = quality(after)
    if (afterQuality.invalid > beforeQuality.invalid || afterQuality.open > beforeQuality.open) throw new Error('Sloučení by vytvořilo neplatnou nebo novou otevřenou hranu. Původní scan zůstal zachovaný.')
  }
  return { positions, ids, keep, representatives, stats: { moved, degenerate, duplicateFaces, maxDisplacement, tolerance } }
}

