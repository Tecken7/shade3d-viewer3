import * as THREE from 'three'
import {MeshBVH} from 'three-mesh-bvh'

export function packRepairGeometry(geometry) {
  const attributes = {}
  for (const name of Object.keys(geometry.attributes)) {
    const attribute = geometry.attributes[name].clone()
    attributes[name] = {array: attribute.array, itemSize: attribute.itemSize, normalized: attribute.normalized}
  }
  return {attributes, index: geometry.index?.array.slice() || null, groups: geometry.groups.map(group => ({...group}))}
}

export function unpackRepairGeometry(data) {
  const geometry = new THREE.BufferGeometry()
  try {
    for (const [name, attribute] of Object.entries(data.attributes)) {
      geometry.setAttribute(name, new THREE.BufferAttribute(attribute.array, attribute.itemSize, attribute.normalized))
    }
    if (data.index) geometry.setIndex(new THREE.BufferAttribute(data.index, 1))
    geometry.groups = data.groups
    if (data.boundingBox) geometry.boundingBox = new THREE.Box3(new THREE.Vector3(...data.boundingBox.min), new THREE.Vector3(...data.boundingBox.max))
    if (data.boundingSphere) geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(...data.boundingSphere.center), data.boundingSphere.radius)
    if (data.tree) geometry.boundsTree = MeshBVH.deserialize(data.tree, geometry, {setIndex: false})
    return geometry
  } catch (error) { geometry.dispose(); throw error }
}

