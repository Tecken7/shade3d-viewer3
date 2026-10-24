import { prepareSliceGeometry, intersectSlice } from '../viewer/slice-intersection.mjs'
const geometries = new Map()
self.onmessage = ({ data }) => {
  try {
    const keep = new Set(data.meshes.map(mesh => mesh.key))
    for (const [key, value] of geometries) if (!keep.has(key)) { value.geometry.dispose(); geometries.delete(key) }
    for (const update of data.updates) geometries.set(update.key, prepareSliceGeometry(update))
    const result = intersectSlice(data.meshes, data.planeMatrix, geometries)
    self.postMessage({ id: data.id, result }, result.groups.map(group => group.points.buffer))
  } catch (error) { self.postMessage({ id: data.id, error: error.message || String(error) }) }
}
