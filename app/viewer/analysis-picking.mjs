import {MeshBVH} from 'three-mesh-bvh'

const pending = new WeakMap()
const defaultWorkerFactory = () => new Worker(new URL('../workers/repair-preflight.worker.js', import.meta.url), {type: 'module'})

// Picking uses the exact rendered geometry, including its original face order.
// Build once off the UI thread and reuse it for every subsequent pointer event.
export function ensureAnalysisPickingTree(geometry, {workerFactory = defaultWorkerFactory} = {}) {
  if (geometry.boundsTree) return Promise.resolve(geometry.boundsTree)
  if (pending.has(geometry)) return pending.get(geometry)
  const position = geometry.attributes.position, index = geometry.index
  if (!position || position.isInterleavedBufferAttribute) return Promise.resolve(null)
  const positionVersion = position.version, indexVersion = index?.version
  const promise = (async () => {
    const worker = workerFactory()
    let disposed = false
    const onDispose = () => {disposed = true}
    geometry.addEventListener('dispose', onDispose)
    try {
      const result = await new Promise((resolve, reject) => {
        worker.onmessage = ({data}) => data.error ? reject(new Error(data.error)) : resolve(data.result)
        worker.onerror = event => reject(new Error(event?.message || 'Příprava rychlého výběru selhala.'))
        worker.onmessageerror = () => reject(new Error('Výsledek rychlého výběru se nepodařilo převzít.'))
        const positions = position.array.slice(), indices = index?.array.slice() || null
        worker.postMessage({type:'bvh', positions, index:indices, groups:geometry.groups}, [positions.buffer, ...(indices ? [indices.buffer] : [])])
      })
      if (disposed || geometry.attributes.position !== position || position.version !== positionVersion || geometry.index !== index || index?.version !== indexVersion) return null
      if (!geometry.boundsTree) geometry.boundsTree = MeshBVH.deserialize(result, geometry, {setIndex:false})
      return geometry.boundsTree
    } finally {geometry.removeEventListener('dispose', onDispose); worker.terminate()}
  })()
  pending.set(geometry, promise)
  promise.then(() => pending.delete(geometry), () => pending.delete(geometry))
  return promise
}
