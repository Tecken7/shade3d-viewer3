// Regular sampling prevents the base from inheriting tiny teeth in the scan rim.
export function sampleContour(polygon, spacing = 0.4) {
  const result = []
  polygon.forEach((a, i) => {
    const b = polygon[(i + 1) % polygon.length]
    const count = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / spacing))
    for (let j = 0; j < count; j++) result.push([a[0] + (b[0] - a[0]) * j / count, a[1] + (b[1] - a[1]) * j / count])
  })
  return result
}

// Relax only the shoulder. The original scan outside the radius and the lower
// vertical wall are fixed; no dental surface away from the cut is filtered.
export function roundShoulder(vertices, faces, boundaryPoints, generatedWeights, originalCount, radius, preservedY) {
  if (!(radius > 0)) return
  const neighbors = Array.from({ length: vertices.length / 3 }, () => new Set())
  for (let i = 0; i < faces.length; i += 3) {
    const [a, b, c] = faces.slice(i, i + 3)
    neighbors[a].add(b).add(c); neighbors[b].add(a).add(c); neighbors[c].add(a).add(b)
  }
  const cells = new Map(), key = (x, y, z) => `${x},${y},${z}`
  for (const p of boundaryPoints) {
    const k = key(...p.map(x => Math.floor(x / radius)))
    if (!cells.has(k)) cells.set(k, [])
    cells.get(k).push(p)
  }
  const weights = new Float64Array(vertices.length / 3)
  for (let id = 0; id < originalCount; id++) {
    if (Math.abs(vertices[id * 3 + 1] - preservedY) < 0.00001) continue
    const p = vertices.slice(id * 3, id * 3 + 3), cell = p.map(x => Math.floor(x / radius))
    let distance2 = radius * radius
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
      for (const q of cells.get(key(cell[0] + x, cell[1] + y, cell[2] + z)) || []) {
        distance2 = Math.min(distance2, p.reduce((sum, value, k) => sum + (value - q[k]) ** 2, 0))
      }
    }
    const t = Math.max(0, 1 - Math.sqrt(distance2) / radius)
    weights[id] = t * t * (3 - 2 * t)
  }
  for (const [id, weight] of generatedWeights) weights[id] = weight
  const active = Array.from(weights.keys()).filter(id => weights[id] > 0)
  const next = new Float64Array(active.length * 3)
  for (let pass = 0; pass < 100; pass++) {
    active.forEach((id, i) => {
      const adjacent = neighbors[id]
      for (let axis = 0; axis < 3; axis++) {
        let mean = 0
        for (const other of adjacent) mean += vertices[other * 3 + axis]
        const current = vertices[id * 3 + axis]
        next[i * 3 + axis] = current + (mean / adjacent.size - current) * 0.45 * weights[id]
      }
    })
    active.forEach((id, i) => { for (let axis = 0; axis < 3; axis++) vertices[id * 3 + axis] = next[i * 3 + axis] })
  }
}
