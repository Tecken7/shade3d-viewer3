import * as THREE from 'three'
import {MeshBVH} from 'three-mesh-bvh'
import {runStepsSync, runStepsAsync} from './cooperative-work.mjs'

import {REPAIR_WELD_TOLERANCE, weldByDistance} from './mesh-weld.mjs'
export {REPAIR_WELD_TOLERANCE, weldByDistance}

function* prepareRepairVertexSteps(sourceObject, tolerance) {
  sourceObject.updateMatrixWorld(true)
  const inverse = sourceObject.matrixWorld.clone().invert(), meshes = [], points = [], triangles = [], vertexGroups = []
  const sourceMeshes = []
  sourceObject.traverse(mesh => { if (mesh.isMesh && mesh.geometry?.attributes.position) sourceMeshes.push(mesh) })
  for (const mesh of sourceMeshes) {
    // Auto Smooth has a separate per-corner display copy. Use the authoritative
    // mesh for welding so representative vertices do not depend on shading.
    const geometry = mesh.userData._baseGeom?.isBufferGeometry ? mesh.userData._baseGeom : mesh.geometry
    const displayGeometry = mesh.geometry, attribute = geometry.attributes.position
    const matrix = mesh === sourceObject ? new THREE.Matrix4() : inverse.clone().multiply(mesh.matrixWorld)
    const firstVertex = points.length / 3, firstFace = triangles.length / 3
    for (let i = 0; i < attribute.count; i++) {
      if (i % 512 === 0) yield
      points.push(...new THREE.Vector3().fromBufferAttribute(attribute, i).applyMatrix4(matrix).toArray())
      vertexGroups.push(meshes.length)
    }
    const indices = geometry.index ? Array.from(geometry.index.array) : Array.from({ length: attribute.count }, (_, i) => i)
    for (let i = 0; i < indices.length; i++) { if (i % 1536 === 0) yield; triangles.push(indices[i] + firstVertex) }
    meshes.push({ mesh, geometry, displayGeometry, matrix, firstVertex, firstFace, indices })
  }
  const welded = yield {type:"weld",points,triangles,tolerance,vertexGroups}
  const { stats } = welded
  if (!stats.moved && !stats.degenerate && !stats.duplicateFaces) return { stats, backup: [] }
  const keep = new Set(welded.keep), pending = [], backup = []
  try {
    for (const item of meshes) {
      const { mesh, geometry, displayGeometry, matrix, firstVertex, firstFace, indices } = item
      const next = geometry.clone(), attribute = next.attributes.position, toLocal = matrix.clone().invert()
      pending.push(next)
      const point = new THREE.Vector3()
      for (let i = 0; i < attribute.count; i++) {
        if (i % 512 === 0) yield
        point.fromArray(welded.positions, (firstVertex + i) * 3).applyMatrix4(toLocal)
        attribute.setXYZ(i, point.x, point.y, point.z)
      }
      const filtered = []
      next.clearGroups()
      for (let face = 0; face < indices.length / 3; face++) {
        if (face % 512 === 0) yield
        if (!keep.has(firstFace + face)) continue
        const material = geometry.groups.find(group => face * 3 >= group.start && face * 3 < group.start + group.count)?.materialIndex || 0
        const previous = next.groups[next.groups.length - 1]
        if (previous?.materialIndex === material) previous.count += 3
        else next.addGroup(filtered.length, 3, material)
        filtered.push(...indices.slice(face * 3, face * 3 + 3))
      }
      next.setIndex(filtered); next.computeBoundingBox(); next.computeBoundingSphere()
      if (!next.attributes.normal) next.computeVertexNormals()
      next.boundsTree = null
      yield {type:"bvh",geometry:next}
      backup.push({ mesh, geometry: displayGeometry, visible: mesh.visible, originalColors: mesh.userData._originalColors, baseGeom: mesh.userData._baseGeom, derivedGeom: mesh.userData._derivedGeom })
    }
    // Commit all meshes together; analysis and the CGAL worker see the exact
    // same snapped positions as the displayed and exported scan.
    meshes.forEach(({ mesh }, i) => {
      mesh.geometry = pending[i]; mesh.userData._baseGeom = pending[i]; mesh.userData._derivedGeom = pending[i]
      mesh.userData._originalColors = pending[i].getAttribute('color')?.clone() || null
      delete mesh.userData._comparisonColors; delete mesh.userData._comparisonDistances
    })
    return { stats, backup }
  } catch (error) { pending.forEach(geometry => geometry.dispose()); throw error }
}

function runPreflightTaskSync(task) {
  if (task.type === 'weld') return weldByDistance(task.points,task.triangles,task.tolerance,task.vertexGroups)
  task.geometry.computeBoundsTree?.({indirect:true})
}
export function prepareRepairVertices(sourceObject, tolerance = REPAIR_WELD_TOLERANCE) {
  return runStepsSync(prepareRepairVertexSteps(sourceObject,tolerance),runPreflightTaskSync)
}
export async function prepareRepairVerticesAsync(sourceObject, tolerance = REPAIR_WELD_TOLERANCE, {workerFactory = () => new Worker(new URL('../workers/repair-preflight.worker.js',import.meta.url),{type:'module'}), pause, preserveUnsafeBoundary = false} = {}) {
  const worker = workerFactory()
  const runTask = task => new Promise((resolve,reject) => {
    worker.onmessage = ({data}) => data.error ? reject(Object.assign(Error(data.error), {code:data.code})) : resolve(data.result)
    worker.onerror = () => reject(Error('Přípravu sítě na pozadí se nepodařilo dokončit.'))
    const payload = task.type === 'weld'
      ? {type:'weld',points:Float64Array.from(task.points),triangles:Uint32Array.from(task.triangles),vertexGroups:Uint32Array.from(task.vertexGroups),tolerance:task.tolerance}
      : {type:'bvh',positions:task.geometry.attributes.position.array.slice(),index:task.geometry.index.array.slice(),groups:task.geometry.groups}
    const transfers = task.type === 'weld' ? [payload.points.buffer,payload.triangles.buffer,payload.vertexGroups.buffer] : [payload.positions.buffer,payload.index.buffer]
    worker.postMessage(payload,transfers)
  }).then(result => {
    if (task.type === 'bvh') task.geometry.boundsTree = MeshBVH.deserialize(result,task.geometry,{setIndex:false})
    return result
  })
  try { return await runStepsAsync(prepareRepairVertexSteps(sourceObject,tolerance),{runTask,pause}) }
  catch (error) {
    // A refused weld has not committed any geometry. In the builder, keep the
    // exact trimmed boundary and let hole analysis inspect that original mesh.
    if (!preserveUnsafeBoundary || error.code !== 'UNSAFE_WELD_TOPOLOGY') throw error
    return {stats:{moved:0,degenerate:0,duplicateFaces:0,tolerance,unsafeWeldSkipped:true},backup:[]}
  }
  finally { worker.terminate() }
}
