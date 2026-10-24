import { prepareSliceGeometry, intersectSlice, unpackSliceResult } from './slice-intersection.mjs'

export function createSliceEngine({ workerFactory = () => new Worker(new URL('../workers/slice.worker.js', import.meta.url), { type: 'module' }) } = {}) {
  let worker = null, unavailable = false, disposed = false, active = null, serial = 0, generation = 0, epoch = 0
  const versions = new WeakMap(), pending = new Map(), sent = new Set(), fallback = new Map()
  function snapshot(root, extraRoots = []) {
    root.updateMatrixWorld(true)
    const meshes = []
    for (const source of [root, ...extraRoots]) source.traverseVisible(child => {
      if (!child.isMesh || !child.geometry?.attributes.position) return
      const geometry = child.geometry, position = geometry.attributes.position, index = geometry.index
      let record = versions.get(geometry)
      if (!record || record.position !== position || record.array !== position.array || record.version !== position.version || record.index !== index || record.indexArray !== index?.array || record.indexVersion !== index?.version) {
        record = { key: `${geometry.uuid}:${++generation}`, position, array: position.array, version: position.version, index, indexArray: index?.array, indexVersion: index?.version }
        versions.set(geometry, record)
      }
      // Color belongs to the enclosing model; a shared geometry can have several instances.
      let modelRoot = child
      while (modelRoot.parent && modelRoot.parent !== root) modelRoot = modelRoot.parent
      meshes.push({ key: record.key, geometry, matrix: child.matrixWorld.toArray(),
        crop: child.userData.sliceCrop || null,
        color: child.userData._viewerColor || modelRoot.userData._viewerColor || '#ffffff',
        modelIndex: Number.isInteger(child.renderOrder) ? child.renderOrder : -1 })
    })
    return meshes
  }
  function payload(job) {
    const keep = new Set(job.meshes.map(mesh => mesh.key))
    for (const key of sent) if (!keep.has(key)) sent.delete(key)
    for (const [key, value] of fallback) if (!keep.has(key)) { value.geometry.dispose(); fallback.delete(key) }
    const updates = []
    for (const mesh of job.meshes) {
      if (sent.has(mesh.key)) continue
      const position = mesh.geometry.attributes.position
      const positions = position.array instanceof Float64Array ? new Float64Array(position.count * 3) : new Float32Array(position.count * 3)
      if (!position.isInterleavedBufferAttribute && position.itemSize === 3 && position.array instanceof Float32Array) positions.set(position.array)
      else for (let i = 0; i < position.count; i++) { positions[i * 3] = position.getX(i); positions[i * 3 + 1] = position.getY(i); positions[i * 3 + 2] = position.getZ(i) }
      const index = mesh.geometry.index ? mesh.geometry.index.array.slice() : null
      updates.push({ key: mesh.key, positions, index }); sent.add(mesh.key)
    }
    return { id: job.id, planeMatrix: job.planeMatrix, meshes: job.meshes.map(({ geometry, ...mesh }) => mesh), updates }
  }
  function finish(error, result) {
    const job = active
    if (!job) return
    active = null
    if (disposed || job.epoch !== epoch) job.resolve(null)
    else if (error) job.reject(error)
    else job.resolve(unpackSliceResult(result))
    pump()
  }
  function runFallback(job) {
    try {
      const data = payload(job)
      for (const update of data.updates) fallback.set(update.key, prepareSliceGeometry(update))
      finish(null, intersectSlice(data.meshes, data.planeMatrix, fallback))
    } catch (error) { finish(error) }
  }
  function disableWorker() {
    worker?.terminate(); worker = null; unavailable = true; sent.clear()
    if (active) runFallback(active)
  }
  function pump() {
    if (disposed || active || !pending.size) return
    const [lane, job] = pending.entries().next().value
    pending.delete(lane); active = job
    if (unavailable) { runFallback(job); return }
    try {
      if (!worker) {
        worker = workerFactory()
        worker.onmessage = ({ data }) => {
          if (data.id !== active?.id) return
          if (data.error) { disableWorker(); return }
          finish(null, data.result)
        }
        worker.onerror = disableWorker
      }
      const data = payload(job)
      worker.postMessage(data, data.updates.flatMap(update => [update.positions.buffer, ...(update.index ? [update.index.buffer] : [])]))
    } catch { disableWorker() }
  }
  return {
    compute(root, planeMatrix, lane = 'vertical', extraRoots = []) {
      if (disposed) return Promise.resolve(null)
      return new Promise((resolve, reject) => {
        const id = ++serial
        pending.get(lane)?.resolve(null)
        pending.set(lane, { id, lane, epoch, meshes: snapshot(root, extraRoots), planeMatrix: Array.from(planeMatrix), resolve, reject })
        pump()
      })
    },
    cancel() {
      epoch++
      for (const job of pending.values()) job.resolve(null)
      pending.clear()
    },
    dispose() {
      disposed = true; worker?.terminate(); worker = null
      active?.resolve(null); active = null
      for (const job of pending.values()) job.resolve(null)
      pending.clear(); sent.clear()
      for (const value of fallback.values()) value.geometry.dispose()
      fallback.clear()
    },
  }
}
