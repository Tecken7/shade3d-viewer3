import * as THREE from 'three'

export function collectTrianglesInRoot(sourceObject, viewerRoot) {
  if (!sourceObject || !viewerRoot) throw new Error('Model není připravený pro vytvoření báze.')
  viewerRoot.updateMatrixWorld(true)
  sourceObject.updateMatrixWorld(true)
  // Hidden source primitives are detached by AnyModel. Their local coordinates
  // are already relative to viewerRoot, so no additional root inverse applies.
  const inverse = sourceObject.parent ? viewerRoot.matrixWorld.clone().invert() : new THREE.Matrix4()
  const positions = [], point = new THREE.Vector3()
  sourceObject.traverse(child => {
    if (!child.isMesh || !child.geometry?.attributes.position) return
    child.updateMatrixWorld(true)
    const matrix = inverse.clone().multiply(child.matrixWorld)
    const geometry = child.geometry, attribute = geometry.attributes.position
    const count = geometry.index ? geometry.index.count : attribute.count
    for (let i = 0; i < count; i++) {
      const id = geometry.index ? geometry.index.getX(i) : i
      point.fromBufferAttribute(attribute, id).applyMatrix4(matrix)
      positions.push(point.x, point.y, point.z)
    }
  })
  if (positions.length < 9) throw new Error('Model neobsahuje dostatek trojúhelníků.')
  return positions
}
