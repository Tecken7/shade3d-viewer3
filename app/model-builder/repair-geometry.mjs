import * as THREE from 'three'
import {MeshBVH, SAH} from 'three-mesh-bvh'
import {runStepsSync} from './cooperative-work.mjs'
import {orientRepairPatch} from './repair-orientation.mjs'
import {refreshLocalNormals} from './surface-edit.mjs'
const CGAL_REPAIR_DENSITY = 2.25
const CGAL_REPAIR_CONTINUITY = 1
const ALIGNMENT_BVH_OPTIONS = {strategy: SAH, maxLeafTris: 8, indirect: true}
const trimVec = point => Array.isArray(point) ? new THREE.Vector3(...point) : point.clone()
const trimArr = point => [point.x, point.y, point.z]

function repairAverageBoundaryNormal(boundary) {
  const normal = new THREE.Vector3()
  ;(boundary || []).forEach((sample) => {
    if (sample?.normal?.isVector3) normal.add(sample.normal)
  })
  if (normal.lengthSq() < 1e-12) normal.set(0, 0, 1)
  return normal.normalize()
}

export function buildCGALRepairWorkerPayload(context, hole) {
  return runStepsSync(buildCGALRepairPayloadSteps(context, hole))
}

export function* buildCGALRepairPayloadSteps(context, hole) {
  if (!context || !hole?.childUuid || !Array.isArray(hole.nodeIds) || hole.nodeIds.length < 3) {
    throw new Error("CGAL: otvor nemá platnou boundary.")
  }

  // Do CGAL neposíláme ostatní objekty/scény. Pouze skutečnou triangulaci child
  // meshe, ve kterém daná boundary leží. Tím se vyhneme náhodnému svaření
  // souřadnic mezi více modely ve stejné scéně.
  const sourceTriangles = []
  const usedNodeIds = new Set()
  for (let i = 0; i < context.triangles.length; i++) {
    if (i % 256 === 0) yield
    const triangle = context.triangles[i]
    if (triangle.childUuid !== hole.childUuid) continue
    sourceTriangles.push(triangle)
    for (const nodeId of triangle.nodeIds) usedNodeIds.add(nodeId)
  }
  if (!sourceTriangles.length) throw new Error("CGAL: model neobsahuje triangulaci pro vybraný otvor.")

  hole.nodeIds.forEach((nodeId) => usedNodeIds.add(nodeId))

  const sourceNodeIds = [...usedNodeIds].sort((a, b) => a - b)
  const localBySource = new Map()
  for (let i = 0; i < sourceNodeIds.length; i++) {
    if (i % 512 === 0) yield
    localBySource.set(sourceNodeIds[i], i)
  }

  const positions = new Float64Array(sourceNodeIds.length * 3)
  for (let index = 0; index < sourceNodeIds.length; index++) {
    if (index % 512 === 0) yield
    const nodeId = sourceNodeIds[index]
    const point = context.nodes[nodeId]
    if (!point?.isVector3) throw new Error("CGAL: boundary obsahuje neplatný vertex.")
    positions[index * 3 + 0] = point.x
    positions[index * 3 + 1] = point.y
    positions[index * 3 + 2] = point.z
  }

  const faces = new Uint32Array(sourceTriangles.length * 3)
  for (let triangleIndex = 0; triangleIndex < sourceTriangles.length; triangleIndex++) {
    if (triangleIndex % 512 === 0) yield
    const triangle = sourceTriangles[triangleIndex]
    for (let corner = 0; corner < 3; corner++) {
      const local = localBySource.get(triangle.nodeIds[corner])
      if (!Number.isInteger(local)) throw new Error("CGAL: nepodařilo se remapovat triangulaci.")
      faces[triangleIndex * 3 + corner] = local
    }
  }

  const boundary = new Uint32Array(hole.nodeIds.length)
  hole.nodeIds.forEach((nodeId, index) => {
    const local = localBySource.get(nodeId)
    if (!Number.isInteger(local)) throw new Error("CGAL: nepodařilo se remapovat boundary.")
    boundary[index] = local
  })

  return {
    payload: {
      positions: positions.buffer,
      faces: faces.buffer,
      boundary: boundary.buffer,
      vertexCount: sourceNodeIds.length,
      faceCount: sourceTriangles.length,
      boundaryCount: boundary.length,
      density: CGAL_REPAIR_DENSITY,
      continuity: CGAL_REPAIR_CONTINUITY,
    },
    transferables: [positions.buffer, faces.buffer, boundary.buffer],
    sourceNodeIds,
  }
}

function buildRepairBoundaryAttributeMap(hole) {
  const map = new Map()
  ;(hole?.boundary || []).forEach((sample) => {
    if (!Number.isInteger(sample?.nodeId)) return
    map.set(sample.nodeId, {
      color: Array.isArray(sample.color) && sample.color.length >= 3 ? sample.color.slice(0, 3) : null,
      uv: Array.isArray(sample.uv) && sample.uv.length >= 2 ? sample.uv.slice(0, 2) : null,
      normal: sample.normal?.isVector3
        ? [sample.normal.x, sample.normal.y, sample.normal.z]
        : null,
    })
  })
  return map
}

function harmonicRepairAttribute(vertexCount, triangleIndexArray, anchors, dimensions, options = {}) {
  if (!vertexCount || !triangleIndexArray?.length || !anchors?.length) return null
  const validAnchors = anchors.filter((value) => Array.isArray(value) && value.length >= dimensions)
  if (!validAnchors.length) return null

  const adjacency = Array.from({ length: vertexCount }, () => new Set())
  for (let i = 0; i + 2 < triangleIndexArray.length; i += 3) {
    const a = triangleIndexArray[i], b = triangleIndexArray[i + 1], c = triangleIndexArray[i + 2]
    if (a >= vertexCount || b >= vertexCount || c >= vertexCount) continue
    adjacency[a].add(b); adjacency[a].add(c)
    adjacency[b].add(a); adjacency[b].add(c)
    adjacency[c].add(a); adjacency[c].add(b)
  }

  const seed = new Array(dimensions).fill(0)
  validAnchors.forEach((value) => {
    for (let d = 0; d < dimensions; d++) seed[d] += Number(value[d]) || 0
  })
  for (let d = 0; d < dimensions; d++) seed[d] /= validAnchors.length

  // UV seam: u/v mohou přes 0/1 přecházet přes wrap. U malé repair boundary je
  // bezpečnější rozbalit pouze kanál s velkým skokem a po fairingu ho vrátit.
  const unwrap = new Array(dimensions).fill(false)
  if (options.wrap01) {
    for (let d = 0; d < dimensions; d++) {
      const values = validAnchors.map((value) => Number(value[d]) || 0)
      const min = Math.min(...values), max = Math.max(...values)
      unwrap[d] = max - min > 0.55 && min < 0.2 && max > 0.8
    }
  }

  const values = Array.from({ length: vertexCount }, (_, index) => {
    const anchor = anchors[index]
    const result = anchor
      ? Array.from({ length: dimensions }, (_, d) => Number(anchor[d]) || 0)
      : seed.slice()
    for (let d = 0; d < dimensions; d++) {
      if (unwrap[d] && result[d] < 0.5) result[d] += 1
    }
    return result
  })
  const fixed = anchors.map((anchor) => !!anchor)

  const iterations = Math.max(24, Math.min(140, Math.round(Math.sqrt(vertexCount) * 3.2)))
  const relaxation = 0.74

  for (let iteration = 0; iteration < iterations; iteration++) {
    const next = values.map((value) => value.slice())
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      if (fixed[vertex]) continue
      const neighbors = adjacency[vertex]
      if (!neighbors?.size) continue
      const avg = new Array(dimensions).fill(0)
      let count = 0
      neighbors.forEach((neighbor) => {
        const value = values[neighbor]
        if (!value) return
        for (let d = 0; d < dimensions; d++) avg[d] += value[d]
        count++
      })
      if (!count) continue
      for (let d = 0; d < dimensions; d++) {
        avg[d] /= count
        next[vertex][d] = values[vertex][d] * (1 - relaxation) + avg[d] * relaxation
      }
    }
    for (let vertex = 0; vertex < vertexCount; vertex++) values[vertex] = next[vertex]
  }

  if (options.wrap01) {
    values.forEach((value) => {
      for (let d = 0; d < dimensions; d++) {
        if (unwrap[d]) value[d] = ((value[d] % 1) + 1) % 1
      }
    })
  }
  if (options.clamp01) {
    values.forEach((value) => {
      for (let d = 0; d < dimensions; d++) value[d] = Math.max(0, Math.min(1, value[d]))
    })
  }
  return values
}

export function buildCGALPatchVertexNormals(positions, triangles, boundaryAnchors, origins, sourceNodeIds, hole) {
  const vertexCount = Math.floor(positions.length / 3)
  const normals = Array.from({ length: vertexCount }, () => new THREE.Vector3())
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), faceNormal = new THREE.Vector3()

  for (let i = 0; i + 2 < triangles.length; i += 3) {
    const ia = triangles[i], ib = triangles[i + 1], ic = triangles[i + 2]
    if (ia >= vertexCount || ib >= vertexCount || ic >= vertexCount) continue
    a.set(positions[ia * 3], positions[ia * 3 + 1], positions[ia * 3 + 2])
    b.set(positions[ib * 3], positions[ib * 3 + 1], positions[ib * 3 + 2])
    c.set(positions[ic * 3], positions[ic * 3 + 1], positions[ic * 3 + 2])
    ab.copy(b).sub(a); ac.copy(c).sub(a)
    faceNormal.copy(ab).cross(ac)
    if (faceNormal.lengthSq() < 1e-18) continue
    normals[ia].add(faceNormal); normals[ib].add(faceNormal); normals[ic].add(faceNormal)
  }

  const expected = repairAverageBoundaryNormal(hole?.boundary || [])

  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const originLocal = origins?.[vertex]
    const sourceNodeId = Number.isInteger(originLocal) && originLocal >= 0
      ? sourceNodeIds?.[originLocal]
      : null
    const sourceNormal = Number.isInteger(sourceNodeId) ? boundaryAnchors.get(sourceNodeId)?.normal : null
    if (sourceNormal && normals[vertex].dot(new THREE.Vector3(...sourceNormal)) >= 0) {
      normals[vertex].set(sourceNormal[0], sourceNormal[1], sourceNormal[2]).normalize()
    } else if (normals[vertex].lengthSq() > 1e-18) {
      normals[vertex].normalize()
    } else {
      normals[vertex].copy(expected)
    }
  }
  return normals.map((normal) => [normal.x, normal.y, normal.z])
}

export function buildCGALRepairPatchData(context, hole, workerResult, sourceNodeIds, timings = null) {
  if (!context || !hole || !workerResult) throw new Error("CGAL: chybí výsledek opravy.")
  if (!workerResult.fairSuccess) throw new Error("CGAL fairing nedokončil opravu sítě.")

  const positions = workerResult.positions instanceof Float64Array
    ? workerResult.positions
    : new Float64Array(workerResult.positions)
  let triangleIndices = workerResult.triangles instanceof Uint32Array
    ? workerResult.triangles
    : new Uint32Array(workerResult.triangles)
  const origins = workerResult.origins instanceof Int32Array
    ? workerResult.origins
    : new Int32Array(workerResult.origins)

  const vertexCount = Math.floor(positions.length / 3)
  if (!vertexCount || triangleIndices.length < 3 || origins.length !== vertexCount) {
    throw new Error("CGAL: worker vrátil neplatnou patch geometrii.")
  }
  const orientation = orientRepairPatch(
    context.triangles.filter(triangle => triangle.childUuid === hole.childUuid).map(triangle => triangle.nodeIds),
    hole.nodeIds, triangleIndices, origins, sourceNodeIds
  )
  triangleIndices = orientation.triangles

  const boundaryAnchors = buildRepairBoundaryAttributeMap(hole)
  const colorAnchors = new Array(vertexCount).fill(null)
  const uvAnchors = new Array(vertexCount).fill(null)

  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const originLocal = origins[vertex]
    if (originLocal < 0 || originLocal >= sourceNodeIds.length) continue
    const sourceNodeId = sourceNodeIds[originLocal]
    const anchor = boundaryAnchors.get(sourceNodeId)
    if (!anchor) continue
    if (anchor.color) colorAnchors[vertex] = anchor.color
    if (anchor.uv) uvAnchors[vertex] = anchor.uv
  }

  const colors = harmonicRepairAttribute(vertexCount, triangleIndices, colorAnchors, 3, { clamp01: true })
  const uvs = harmonicRepairAttribute(vertexCount, triangleIndices, uvAnchors, 2, { wrap01: true })
  const normals = buildCGALPatchVertexNormals(
    positions,
    triangleIndices,
    boundaryAnchors,
    origins,
    sourceNodeIds,
    hole
  )

  const corners = Array.from({ length: vertexCount }, (_, vertex) => ({
    sourcePos: [
      positions[vertex * 3 + 0],
      positions[vertex * 3 + 1],
      positions[vertex * 3 + 2],
    ],
    sourceNormal: normals?.[vertex] || null,
    color: colors?.[vertex] || null,
    uv: uvs?.[vertex] || null,
  }))

  const triangles = []
  for (let i = 0; i + 2 < triangleIndices.length; i += 3) {
    const a = triangleIndices[i], b = triangleIndices[i + 1], c = triangleIndices[i + 2]
    if (a >= vertexCount || b >= vertexCount || c >= vertexCount) continue
    triangles.push([corners[a], corners[b], corners[c]])
  }
  if (!triangles.length) throw new Error("CGAL: výsledný patch neobsahuje trojúhelníky.")

  return {
    holeId: hole.id,
    childUuid: hole.childUuid,
    materialIndex: hole.materialIndex || 0,
    triangles,
    boundaryPoints: (hole.points || []).map(trimArr),
    reconstruction: {
      method: "cgal-wasm-c1-dense225",
      densityControlFactor: CGAL_REPAIR_DENSITY,
      continuity: CGAL_REPAIR_CONTINUITY,
      fairSuccess: true,
      orientation: { flippedFaces: orientation.flippedFaces, matchedEdges: orientation.matchedEdges },
      vertexCount,
      triangleCount: triangles.length,
      timings,
    },
  }
}
export function applyRepairPatchesToObject(context, patches) {
  if (!context || !Array.isArray(patches) || !patches.length) throw new Error("Není připravená žádná oprava.")
  const byChild = new Map()
  patches.forEach((patch) => {
    if (!patch?.triangles?.length) return
    const list = byChild.get(patch.childUuid) || []
    list.push(patch)
    byChild.set(patch.childUuid, list)
  })
  const backup = []
  for (const [childUuid, childPatches] of byChild) {
    const meta = context.childMeta.get(childUuid)
    const mesh = meta?.mesh
    if (!mesh?.isMesh || !mesh.geometry?.getAttribute?.("position")) continue
    const original = mesh.geometry
    const base = original.index ? original.toNonIndexed() : original.clone()
    const position = base.getAttribute("position")
    const normal = base.getAttribute("normal")
    const baseColor = base.getAttribute("color")
    const storedColor = mesh.userData?._originalColors
    const color = baseColor || (storedColor && storedColor.count === base.getAttribute("position")?.count ? storedColor : null)
    const uv = base.getAttribute("uv")
    const positions = Array.from(position.array)
    const normals = normal ? Array.from(normal.array) : []
    const colors = color ? Array.from(color.array) : []
    const uvs = uv ? Array.from(uv.array) : []
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(meta.sourceToChild)
    const patchMaterialGroups = []
    const appendCorner = (corner) => {
      const local = trimVec(corner.sourcePos).applyMatrix4(meta.sourceToChild)
      positions.push(local.x, local.y, local.z)
      if (normal) {
        const sourceNormal = corner.sourceNormal ? trimVec(corner.sourceNormal) : new THREE.Vector3(0,0,1)
        const localNormal = sourceNormal.applyMatrix3(normalMatrix).normalize()
        normals.push(localNormal.x, localNormal.y, localNormal.z)
      }
      if (color) {
        const c = corner.color || [1,1,1]
        colors.push(c[0], c[1], c[2])
      }
      if (uv) {
        const t = corner.uv || [0.5,0.5]
        uvs.push(t[0], t[1])
      }
    }
    const removedFaces=new Set(childPatches.flatMap(p=>(p.removeFaces||[]).filter(f=>f.childUuid===childUuid).map(f=>f.faceIndex)))
    const originalBaseCount=position.count
    const baseCount = position.count
    let appendedTriangles = 0
    childPatches.forEach((patch) => {
      const start = baseCount + appendedTriangles * 3
      patch.triangles.forEach((triangle) => { triangle.forEach(appendCorner); appendedTriangles++ })
      patchMaterialGroups.push({ start, count: patch.triangles.length * 3, materialIndex: patch.materialIndex || 0 })
    })
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3))
    if (normal && normals.length === positions.length) geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3))
    else geometry.computeVertexNormals()
    if (color && colors.length === positions.length) geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3))
    if (uv && uvs.length * 3 === positions.length * 2) geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2))
    if(removedFaces.size){
      const kept=[];for(let f=0;f<geometry.attributes.position.count/3;f++)if(f>=originalBaseCount/3||!removedFaces.has(f))kept.push(f)
      for(const name of Object.keys(geometry.attributes)){const attribute=geometry.attributes[name],array=new attribute.array.constructor(kept.length*3*attribute.itemSize);kept.forEach((f,i)=>array.set(attribute.array.subarray(f*3*attribute.itemSize,(f+1)*3*attribute.itemSize),i*3*attribute.itemSize));geometry.setAttribute(name,new THREE.BufferAttribute(array,attribute.itemSize,attribute.normalized))}
      geometry.clearGroups();let cursor=0
      for(const f of kept){const group=base.groups?.find(g=>f*3>=g.start&&f*3<g.start+g.count)||patchMaterialGroups.find(g=>f*3>=g.start&&f*3<g.start+g.count),materialIndex=group?.materialIndex||0,last=geometry.groups.at(-1);if(last?.materialIndex===materialIndex)last.count+=3;else geometry.addGroup(cursor,3,materialIndex);cursor+=3}
    }
    else if (base.groups?.length) base.groups.forEach((group) => geometry.addGroup(group.start, group.count, group.materialIndex || 0))
    else geometry.addGroup(0, baseCount, 0)
    if(!removedFaces.size)patchMaterialGroups.forEach((group) => geometry.addGroup(group.start, group.count, group.materialIndex))
    refreshLocalNormals(geometry,new Set(Array.from({length:geometry.attributes.position.count-(baseCount-removedFaces.size*3)},(_,i)=>baseCount-removedFaces.size*3+i)))
    geometry.computeBoundingBox(); geometry.computeBoundingSphere()
    try { geometry.boundsTree = new MeshBVH(geometry, ALIGNMENT_BVH_OPTIONS) } catch {}
    backup.push({ mesh, geometry: original, visible: mesh.visible, originalColors: mesh.userData?._originalColors, baseGeom: mesh.userData?._baseGeom, derivedGeom: mesh.userData?._derivedGeom })
    mesh.geometry = geometry
    mesh.visible = true
    mesh.userData._baseGeom = geometry
    mesh.userData._derivedGeom = geometry
    mesh.userData._originalColors = geometry.getAttribute("color")?.clone?.() || null
    delete mesh.userData._comparisonColors; delete mesh.userData._comparisonDistances; delete mesh.userData._occlusionColors; delete mesh.userData._occlusionDistances
    if (base !== original) base.dispose?.()
  }
  context.sourceObject.updateMatrixWorld(true)
  return backup
}

