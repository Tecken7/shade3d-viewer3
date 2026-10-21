// Winding is determined by the actual shared edges, never by an averaged normal
// of a curved tooth. Neighbouring faces must traverse their common edge oppositely.
export function orientRepairPatch(sourceFaces, boundaryIds, patchFaces, origins, sourceNodeIds) {
  const key = (a, b) => a < b ? `${a}:${b}` : `${b}:${a}`
  const wanted = new Set(boundaryIds.map((id, i) => key(id, boundaryIds[(i + 1) % boundaryIds.length])))
  const sourceEdges = new Map()
  for (const face of sourceFaces) for (let k = 0; k < 3; k++) {
    const a = face[k], b = face[(k + 1) % 3], edge = key(a, b)
    if (wanted.has(edge)) {
      if (sourceEdges.has(edge)) throw new Error('Okraj opravy není jednoznačnou hranicí scanu.')
      sourceEdges.set(edge, [a, b])
    }
  }
  if (sourceEdges.size !== wanted.size) throw new Error('Oprava nemá úplný společný okraj se scanem.')
  const faces = new Uint32Array(patchFaces), edges = new Map(), neighbors = Array.from({ length: faces.length / 3 }, () => [])
  for (let face = 0; face < faces.length / 3; face++) for (let k = 0; k < 3; k++) {
    const a = faces[face * 3 + k], b = faces[face * 3 + (k + 1) % 3], edge = key(a, b)
    if (!edges.has(edge)) edges.set(edge, [])
    edges.get(edge).push({ face, a, b })
  }
  const anchors = []
  for (const list of edges.values()) {
    if (list.length > 2) throw new Error('Oprava obsahuje neplatnou sdílenou hranu.')
    if (list.length === 2) {
      const [a, b] = list, toggle = a.a === b.a ? 1 : 0
      neighbors[a.face].push([b.face, toggle]); neighbors[b.face].push([a.face, toggle])
    } else {
      const edge = list[0], a = sourceNodeIds[origins[edge.a]], b = sourceNodeIds[origins[edge.b]]
      const source = sourceEdges.get(key(a, b))
      if (!source) throw new Error('Okraj nové plochy nenavazuje na scan.')
      anchors.push({ face: edge.face, flip: a === source[0] ? 1 : 0, key: key(a, b) })
    }
  }
  if (anchors.length !== wanted.size || new Set(anchors.map(a => a.key)).size !== wanted.size) throw new Error('Nová plocha neuzavírá celý okraj díry.')
  const flips = new Int8Array(faces.length / 3).fill(-1), component = new Int32Array(flips.length), groups = []
  for (let start = 0; start < flips.length; start++) {
    if (flips[start] !== -1) continue
    const queue = [start], id = groups.length; flips[start] = 0
    for (let i = 0; i < queue.length; i++) {
      const face = queue[i]; component[face] = id
      for (const [next, toggle] of neighbors[face]) {
        const required = flips[face] ^ toggle
        if (flips[next] === -1) { flips[next] = required; queue.push(next) }
        else if (flips[next] !== required) throw new Error('Orientace nové plochy je nekonzistentní.')
      }
    }
    groups.push(queue)
  }
  const invert = new Array(groups.length).fill(null)
  for (const anchor of anchors) {
    const id = component[anchor.face], required = flips[anchor.face] ^ anchor.flip
    if (invert[id] != null && invert[id] !== required) throw new Error('Orientace okraje opravy neodpovídá okolnímu scanu.')
    invert[id] = required
  }
  let flippedFaces = 0
  for (let id = 0; id < groups.length; id++) {
    if (invert[id] == null) throw new Error('Oprava obsahuje oddělenou plochu.')
    for (const face of groups[id]) if (flips[face] ^ invert[id]) {
      const offset = face * 3, b = faces[offset + 1]; faces[offset + 1] = faces[offset + 2]; faces[offset + 2] = b; flippedFaces++
    }
  }
  return { triangles: faces, flippedFaces, matchedEdges: anchors.length, components: groups.length }
}
