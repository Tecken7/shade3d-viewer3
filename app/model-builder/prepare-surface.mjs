// Normalize face winding without moving the scan or remeshing anatomy.
// A reversed boundary triangle has two outgoing edges at a vertex, which the
// boundary walker otherwise reports as branching despite a valid surface.
export function prepareSurface(vertices, faces) {
  const clean = [], seen = new Set(), edges = new Map()
  for (let i = 0; i < faces.length; i += 3) {
    const triangle = faces.slice(i, i + 3)
    if (new Set(triangle).size !== 3) continue
    const key = triangle.slice().sort((a, b) => a - b).join(':')
    if (seen.has(key)) continue
    seen.add(key)
    clean.push(...triangle)
  }
  for (let i = 0; i < clean.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const a = clean[i + k], b = clean[i + (k + 1) % 3]
      const key = a < b ? `${a}:${b}` : `${b}:${a}`
      if (!edges.has(key)) edges.set(key, [])
      edges.get(key).push({ face: i / 3, direction: a < b ? 1 : -1 })
    }
  }
  const neighbors = Array.from({ length: clean.length / 3 }, () => [])
  for (const edge of edges.values()) {
    if (edge.length !== 2) continue
    const [a, b] = edge, flip = a.direction === b.direction ? 1 : 0
    neighbors[a.face].push([b.face, flip])
    neighbors[b.face].push([a.face, flip])
  }
  const flips = new Int8Array(neighbors.length).fill(-1)
  for (let seed = 0; seed < neighbors.length; seed++) {
    if (flips[seed] !== -1) continue
    const component = [seed]; flips[seed] = 0
    for (let j = 0; j < component.length; j++) {
      const current = component[j]
      for (const [next, difference] of neighbors[current]) {
        const expected = flips[current] ^ difference
        if (flips[next] === -1) { flips[next] = expected; component.push(next) }
        else if (flips[next] !== expected) throw new Error('Scan obsahuje překřížené napojení ploch. Opravte toto místo v úpravě scanu.')
      }
    }
    // Keep the original orientation of the majority, including when the first
    // triangle happens to be the reversed one.
    if (component.reduce((sum, id) => sum + flips[id], 0) > component.length / 2) {
      for (const id of component) flips[id] ^= 1
    }
  }
  for (let i = 0; i < flips.length; i++) {
    if (flips[i]) [clean[i * 3 + 1], clean[i * 3 + 2]] = [clean[i * 3 + 2], clean[i * 3 + 1]]
  }
  return { vertices, faces: clean }
}
