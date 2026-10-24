import * as THREE from 'three'
import { MeshBVH, CENTER } from 'three-mesh-bvh'

// Each worker owns immutable copies: editing a scan invalidates its versioned key.
export function prepareSliceGeometry({ positions, index }) {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  if (index) geometry.setIndex(new THREE.BufferAttribute(index, 1))
  geometry.computeBoundingBox()
  const tree = new MeshBVH(geometry, { strategy: CENTER, maxLeafTris: 16, indirect: true })
  return { geometry, tree }
}

export function intersectSlice(meshes, planeMatrix, geometries, { bruteForce = false } = {}) {
  const planeWorld = new THREE.Matrix4().fromArray(planeMatrix)
  const inversePlane = planeWorld.clone().invert()
  const worldPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(
    new THREE.Vector3(0, 0, 1).transformDirection(planeWorld),
    new THREE.Vector3().setFromMatrixPosition(planeWorld))
  const groups = []
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  let testedTriangles = 0
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  const edge = new THREE.Vector3(), point = new THREE.Vector3()
  for (const mesh of meshes) {
    const prepared = geometries.get(mesh.key)
    if (!prepared) throw new Error('Missing slice geometry')
    const { geometry, tree } = prepared
    const matrix = new THREE.Matrix4().fromArray(mesh.matrix)
    if (Math.abs(matrix.determinant()) < 1e-18) continue
    const localPlane = worldPlane.clone().applyMatrix4(matrix.clone().invert())
    if (!bruteForce && !geometry.boundingBox.intersectsPlane(localPlane)) continue
    const toPlane = inversePlane.clone().multiply(matrix)
    const points = []
    const triangle = (vA, vB, vC) => {
      testedTriangles++
      const da = localPlane.distanceToPoint(vA), db = localPlane.distanceToPoint(vB), dc = localPlane.distanceToPoint(vC)
      if ((da > 0 && db > 0 && dc > 0) || (da < 0 && db < 0 && dc < 0)) return
      let count = 0, x = 0, y = 0
      const checkEdge = (v1, v2, d1, d2) => {
        if (d1 * d2 < 0) edge.copy(v1).lerp(v2, d1 / (d1 - d2))
        else if (d1 === 0) edge.copy(v1)
        else return
        point.copy(edge).applyMatrix4(toPlane)
        if (count && Math.abs(x - point.x) <= 1e-5 && Math.abs(y - point.y) <= 1e-5) return
        if (!count) { x = point.x; y = point.y; count = 1 }
        else if (count === 1) {
          points.push(x, y, point.x, point.y)
          minX = Math.min(minX, x, point.x); maxX = Math.max(maxX, x, point.x)
          minY = Math.min(minY, y, point.y); maxY = Math.max(maxY, y, point.y)
          count = 2
        }
      }
      checkEdge(vA, vB, da, db); checkEdge(vB, vC, db, dc)
      if (count < 2) checkEdge(vC, vA, dc, da)
    }
    if (bruteForce) {
      const position = geometry.attributes.position, index = geometry.index
      const size = index ? index.count : position.count
      for (let i = 0; i < size; i += 3) {
        a.fromBufferAttribute(position, index ? index.getX(i) : i)
        b.fromBufferAttribute(position, index ? index.getX(i + 1) : i + 1)
        c.fromBufferAttribute(position, index ? index.getX(i + 2) : i + 2)
        triangle(a, b, c)
      }
    } else tree.shapecast({
      intersectsBounds: box => box.intersectsPlane(localPlane),
      intersectsTriangle: tri => { triangle(tri.a, tri.b, tri.c); return false },
    })
    if (points.length) groups.push({ points: new Float64Array(points), color: mesh.color, modelIndex: mesh.modelIndex })
  }
  return {
    groups,
    boundingBox: minX === Infinity ? null : { minX, minY, width: maxX - minX, height: maxY - minY },
    testedTriangles,
  }
}

export function unpackSliceResult(result) {
  const segments = []
  for (const { points, color, modelIndex } of result.groups) {
    for (let i = 0; i < points.length; i += 4) segments.push({
      a: { x: points[i], y: points[i + 1] }, b: { x: points[i + 2], y: points[i + 3] }, color, modelIndex,
    })
  }
  return { segments, boundingBox: result.boundingBox }
}
