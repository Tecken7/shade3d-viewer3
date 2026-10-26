import {packRepairGeometry, unpackRepairGeometry} from './repair-geometry-codec.mjs'

const defaultWorkerFactory = () => new Worker(new URL('../workers/repair-geometry.worker.js', import.meta.url), {type: 'module'})

// The scan stays untouched and interactive while the worker builds a replacement.
export async function runRepairGeometryTask(task, transfers = [], workerFactory = defaultWorkerFactory) {
  const worker = workerFactory()
  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = ({data}) => data.error ? reject(new Error(data.error)) : resolve(data.result)
      worker.onerror = event => reject(new Error(event?.message || 'Přípravu opraveného povrchu se nepodařilo dokončit.'))
      worker.onmessageerror = () => reject(new Error('Výsledek opravy se nepodařilo převzít.'))
      worker.postMessage(task, transfers)
    })
  } finally { worker.terminate() }
}

export function finishRepairPatchAsync(hole, response, {workerFactory} = {}) {
  const boundary = (hole.boundary || []).map(sample => ({
    nodeId: sample.nodeId, color: sample.color, uv: sample.uv,
    normal: sample.normal?.isVector3 ? sample.normal.toArray() : null,
  }))
  const task = {type: 'patch', hole: {...hole, boundary}, ...response}
  return runRepairGeometryTask(task, [response.sourceFaces.buffer, response.result.positions.buffer, response.result.triangles.buffer, response.result.origins.buffer], workerFactory)
}

export async function applyRepairPatchesToObjectAsync(context, patches, {workerFactory} = {}) {
  if (!context || !Array.isArray(patches) || !patches.length) throw new Error('Není připravená žádná oprava.')
  const byChild = new Map(), pending = []
  for (const patch of patches) {
    if (!patch?.triangles?.length) continue
    if (!byChild.has(patch.childUuid)) byChild.set(patch.childUuid, [])
    byChild.get(patch.childUuid).push(patch)
  }
  try {
    for (const [childUuid, childPatches] of byChild) {
      const meta = context.childMeta.get(childUuid), mesh = meta?.mesh
      if (!mesh?.isMesh || !mesh.geometry?.attributes.position) continue
      const original = mesh.geometry, source = packRepairGeometry(original)
      const storedColor = mesh.userData?._originalColors?.clone?.()
      const transfers = Object.values(source.attributes).map(attribute => attribute.array.buffer)
      if (source.index) transfers.push(source.index.buffer)
      if (storedColor) transfers.push(storedColor.array.buffer)
      const result = await runRepairGeometryTask({type: 'geometry', childUuid, source,
        sourceToChild: meta.sourceToChild.toArray(), patches: childPatches,
        storedColor: storedColor ? {array: storedColor.array, itemSize: storedColor.itemSize, normalized: storedColor.normalized} : null,
      }, [...new Set(transfers)], workerFactory)
      pending.push({mesh, original, geometry: unpackRepairGeometry(result), backup: {
        mesh, geometry: original, visible: mesh.visible, originalColors: mesh.userData?._originalColors,
        baseGeom: mesh.userData?._baseGeom, derivedGeom: mesh.userData?._derivedGeom,
      }})
    }
    // Swap all completed meshes together. Errors never leave a partially repaired scan.
    if (pending.some(item => item.mesh.geometry !== item.original)) throw new Error('Model se během opravy změnil. Spusťte kontrolu znovu.')
    for (const {mesh, geometry} of pending) {
      mesh.geometry = geometry
      mesh.visible = true
      mesh.userData._baseGeom = geometry
      mesh.userData._derivedGeom = geometry
      mesh.userData._originalColors = geometry.getAttribute('color')?.clone() || null
      delete mesh.userData._comparisonColors; delete mesh.userData._comparisonDistances
      delete mesh.userData._occlusionColors; delete mesh.userData._occlusionDistances
    }
    context.sourceObject.updateMatrixWorld(true)
    return pending.map(item => item.backup)
  } catch (error) { pending.forEach(item => item.geometry.dispose()); throw error }
}
