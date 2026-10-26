import * as THREE from 'three'
import {MeshBVH} from 'three-mesh-bvh'
import {buildCGALRepairPatchData, applyRepairPatchesToObject} from '../model-builder/repair-geometry.mjs'
import {unpackRepairGeometry, packRepairGeometry} from '../model-builder/repair-geometry-codec.mjs'

self.onmessage = ({data}) => {
  try {
    if (data.type === 'patch') {
      const {hole, sourceFaces, sourceNodeIds} = data
      hole.boundary = hole.boundary.map(sample => ({...sample, normal: sample.normal ? new THREE.Vector3(...sample.normal) : null}))
      const triangles = []
      for (let i = 0; i < sourceFaces.length; i += 3) triangles.push({childUuid: hole.childUuid,
        nodeIds: [sourceNodeIds[sourceFaces[i]], sourceNodeIds[sourceFaces[i + 1]], sourceNodeIds[sourceFaces[i + 2]]],
      })
      const result = buildCGALRepairPatchData({triangles}, hole, data.result, sourceNodeIds, data.timings)
      self.postMessage({result})
    } else if (data.type === 'geometry') {
      const mesh = new THREE.Mesh(unpackRepairGeometry(data.source)), root = new THREE.Group()
      root.add(mesh)
      if (data.storedColor) mesh.userData._originalColors = new THREE.BufferAttribute(data.storedColor.array, data.storedColor.itemSize, data.storedColor.normalized)
      const context = {sourceObject: root, childMeta: new Map([[data.childUuid, {mesh, sourceToChild: new THREE.Matrix4().fromArray(data.sourceToChild)}]])}
      applyRepairPatchesToObject(context, data.patches)
      const geometry = mesh.geometry, result = packRepairGeometry(geometry)
      result.boundingBox = {min: geometry.boundingBox.min.toArray(), max: geometry.boundingBox.max.toArray()}
      result.boundingSphere = {center: geometry.boundingSphere.center.toArray(), radius: geometry.boundingSphere.radius}
      result.tree = geometry.boundsTree ? MeshBVH.serialize(geometry.boundsTree, {cloneBuffers: false}) : null
      const transfers = Object.values(result.attributes).map(attribute => attribute.array.buffer)
      if (result.index) transfers.push(result.index.buffer)
      if (result.tree) {
        transfers.push(...result.tree.roots)
        if (result.tree.index) transfers.push(result.tree.index.buffer)
        if (result.tree.indirectBuffer) transfers.push(result.tree.indirectBuffer.buffer)
      }
      self.postMessage({result}, [...new Set(transfers)])
    } else throw new Error('Neznámý krok opravy povrchu.')
  } catch (error) { self.postMessage({error: error?.message || 'Oprava povrchu selhala.'}) }
}
