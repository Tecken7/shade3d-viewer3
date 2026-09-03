"use client"

import React, { Suspense, useEffect, useMemo, useRef, useState, useCallback } from "react"
import { Canvas, useThree, useFrame } from "@react-three/fiber"
import * as THREE from "three"
import { Html, TransformControls } from "@react-three/drei"
import { TrackballControls } from "three/examples/jsm/controls/TrackballControls"
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader"
import { STLLoader } from "three/examples/jsm/loaders/STLLoader"
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader"
import { STLExporter } from "three/examples/jsm/exporters/STLExporter"
import { PLYExporter } from "three/examples/jsm/exporters/PLYExporter"
import { OBJExporter } from "three/examples/jsm/exporters/OBJExporter"
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast, SAH } from "three-mesh-bvh"
import { Unzip, UnzipInflate } from "fflate"
import * as dicomParser from "dicom-parser"

// DICOM podpora vyžaduje v projektu balíčky: fflate a dicom-parser.

/* ---------- Instalace BVH do Three.js ---------- */
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree
THREE.Mesh.prototype.raycast = acceleratedRaycast

/* ---------- Konst + konfigurace ---------- */
const LIVE_MSG_TYPES = new Set(["SHADE3D_LIVE", "SHADE3D_LIVE_V6", "SHADE3D_LIVE_V5"])
const SUPABASE_URL = "https://jqnkdjgmenerioodqcpa.supabase.co"
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpxbmtkamdtZW5lcmlvb2RxY3BhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU4Njg1OTcsImV4cCI6MjA3MTQ0NDU5N30.QREluCZ2N1NLPRD_B788rbwOwLFyXKYi8Sm2oYeDDQk"
const PUBLIC_BUCKET = "shade3d-viewer2"
const DEFAULT_LOGO = "/Arthetic_logo.png"

/* ---------- Helpers ---------- */
const stripExt = (s) => (s ? s.replace(/\.[^.]+$/, "") : "")
const clamp01 = (x) => Math.max(0, Math.min(1, x))
const getParam = (name) => {
  if (typeof window === "undefined") return null
  try { return new URL(window.location.href).searchParams.get(name) } catch { return null }
}
async function fetchJSON(url) {
  const r = await fetch(url, { cache: "no-store" })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

function getBaseCaseCloudSceneId(value) {
  if (!value) return null
  const match = String(value).match(/^(.*)--r\d{10,}$/)
  return match ? match[1] : String(value)
}

async function resolveCaseCloudManifestKey(requestedKey) {
  const sceneId = getBaseCaseCloudSceneId(requestedKey)
  const fallback = {
    sceneId,
    manifestKey: requestedKey,
    resolved: false,
    labCaseId: null,
    patientName: null,
  }
  if (!sceneId) return fallback

  const rpcFetch = async (functionName) => fetch(`${SUPABASE_URL}/rest/v1/rpc/${functionName}`, {
    method: "POST",
    cache: "no-store",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_scene_id: sceneId }),
  })

  try {
    // Nový resolver vrací kromě CURRENT revision také aktuální zakázku a jméno
    // pacienta. Jméno se proto nikdy necachuje v manifestu a po přejmenování
    // pacienta stačí viewer znovu otevřít / refreshnout.
    // v1.40: nový resolver v2 používá DB-triggerovanou vazbu scene -> lab_case.
    // Nový název RPC zároveň obchází případnou starou PostgREST schema cache
    // po předchozím CREATE OR REPLACE stejné funkce.
    let contextResponse = await rpcFetch("get_case_cloud_scene_context_v2")
    if (!contextResponse.ok) {
      // Zpětná kompatibilita během postupného deploye SQL/vieweru.
      contextResponse = await rpcFetch("get_case_cloud_scene_context")
    }
    if (contextResponse.ok) {
      const payload = await contextResponse.json()
      const row = Array.isArray(payload) ? payload[0] : payload
      const currentRevision = row?.current_revision
      return {
        sceneId,
        manifestKey:
          typeof currentRevision === "string" && currentRevision.trim()
            ? currentRevision.trim()
            : requestedKey,
        resolved: typeof currentRevision === "string" && !!currentRevision.trim(),
        labCaseId: typeof row?.lab_case_id === "string" ? row.lab_case_id : null,
        patientName:
          typeof row?.patient_name === "string" && row.patient_name.trim()
            ? row.patient_name.trim()
            : null,
      }
    }

    // Kompatibilita při postupném deployi: pokud ještě není nahraný nový SQL
    // resolver, zkusíme původní CURRENT-revision RPC.
    const response = await rpcFetch("get_case_cloud_current_revision")
    if (!response.ok) {
      console.warn(`[ARTHETIC Case Cloud] Context resolver HTTP ${contextResponse.status}/${response.status}; používám kompatibilní fallback.`)
      return fallback
    }

    const payload = await response.json()
    const row = Array.isArray(payload) ? payload[0] : payload
    const currentRevision = row?.current_revision
    if (typeof currentRevision === "string" && currentRevision.trim()) {
      return { ...fallback, manifestKey: currentRevision.trim(), resolved: true }
    }
    return fallback
  } catch (error) {
    console.warn("[ARTHETIC Case Cloud] Scene context resolver failed; používám kompatibilní fallback.", error)
    return fallback
  }
}
function inferExt(nameOrUrl) {
  if (!nameOrUrl) return ""
  const s = nameOrUrl.split("?")[0]
  const m = s.match(/\.([a-z0-9]+)$/i)
  return m ? m[1].toLowerCase() : ""
}
function filesChanged(prev, next) {
  if (prev.length !== next.length) return true
  for (let i = 0; i < prev.length; i++) if (prev[i].url !== next[i].url) return true
  return false
}


/* ---------- Export zarovnaného modelu ---------- */
function makeAlignedExportName(file) {
  const raw = file?.rawName || file?.name || "aligned-model.stl"
  const ext = inferExt(raw) || inferExt(file?.url) || "stl"
  const base = stripExt(String(raw).split("/").pop() || "model")
  return `${base}_aligned.${ext}`
}

function alignedExportMime(ext) {
  if (ext === "obj") return "text/plain;charset=utf-8"
  if (ext === "ply") return "application/octet-stream"
  if (ext === "stl") return "application/octet-stream"
  return "application/octet-stream"
}

// Vytvoří exportní objekt v lokálním prostoru rootGroup scény. Tím se zapéká
// Alignment transformace Moving B, ale NE interní AutoCenter posun celého vieweru.
function buildBakedAlignedExportObject(sourceObject, viewerRoot) {
  if (!sourceObject || !viewerRoot) throw new Error("Model není připravený k exportu.")
  viewerRoot.updateMatrixWorld(true)
  sourceObject.updateMatrixWorld(true)

  const rootInverse = viewerRoot.matrixWorld.clone().invert()
  const exportRoot = new THREE.Group()
  exportRoot.name = `${sourceObject.name || "model"}_aligned_export`

  sourceObject.traverse((child) => {
    if (!child?.isMesh || !child.geometry) return
    child.updateMatrixWorld(true)
    const localToViewerRoot = rootInverse.clone().multiply(child.matrixWorld)
    const geometry = child.geometry.clone()
    // Analysis heatmapa používá dočasně atribut `color`. Do exportu ale musí jít
    // původní TEX / vertex colors, nikoli barvy Odchylky nebo Okluze.
    if (child.userData?._originalColors) {
      geometry.setAttribute("color", child.userData._originalColors.clone())
    } else if (
      child.geometry?.getAttribute?.("_analysisDist") ||
      child.userData?._comparisonColors ||
      child.userData?._occlusionColors
    ) {
      geometry.deleteAttribute("color")
    }
    geometry.deleteAttribute("_analysisDist")
    geometry.applyMatrix4(localToViewerRoot)
    geometry.computeBoundingBox?.()
    geometry.computeBoundingSphere?.()

    let material = child.material
    if (Array.isArray(material)) material = material.map((item) => item?.clone?.() || item)
    else material = material?.clone?.() || material

    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = child.name || sourceObject.name || "mesh"
    mesh.matrixAutoUpdate = true
    exportRoot.add(mesh)
  })

  if (exportRoot.children.length === 0) throw new Error("Model neobsahuje exportovatelnou geometrii.")
  exportRoot.updateMatrixWorld(true)
  return exportRoot
}

function disposeAlignedExportObject(object) {
  object?.traverse?.((child) => {
    if (!child?.isMesh) return
    child.geometry?.dispose?.()
    const materials = Array.isArray(child.material) ? child.material : [child.material]
    materials.filter(Boolean).forEach((material) => material.dispose?.())
  })
}

async function alignedObjectToBlob(object, ext) {
  if (ext === "stl") {
    const result = new STLExporter().parse(object, { binary: true })
    return new Blob([result], { type: alignedExportMime(ext) })
  }
  if (ext === "ply") {
    return await new Promise((resolve, reject) => {
      try {
        new PLYExporter().parse(
          object,
          (result) => resolve(new Blob([result], { type: alignedExportMime(ext) })),
          { binary: true }
        )
      } catch (error) {
        reject(error)
      }
    })
  }
  if (ext === "obj") {
    const result = new OBJExporter().parse(object)
    return new Blob([result], { type: alignedExportMime(ext) })
  }
  throw new Error(`Export formátu .${ext || "?"} zatím není podporovaný.`)
}


/* ---------- Ořez modelu po povrchu ---------- */
function makeTrimmedExportName(file, aligned = false) {
  const raw = file?.rawName || file?.name || "trimmed-model.stl"
  const ext = inferExt(raw) || inferExt(file?.url) || "stl"
  const base = stripExt(String(raw).split("/").pop() || "model")
  return `${base}${aligned ? "_aligned" : ""}_trimmed.${ext}`
}

const trimEdgeKey = (a, b) => a < b ? `${a}:${b}` : `${b}:${a}`
const trimVertexKey = (v) => `${v.x.toFixed(5)}|${v.y.toFixed(5)}|${v.z.toFixed(5)}`
const trimPointKey = (point) => `${point[0].toFixed(6)}|${point[1].toFixed(6)}|${point[2].toFixed(6)}`
const trimVec = (point) => Array.isArray(point) ? new THREE.Vector3(point[0], point[1], point[2]) : point.clone()
const trimArr = (point) => [point.x, point.y, point.z]

function buildTrimMeshContext(sourceObject) {
  if (!sourceObject) throw new Error("Model není připravený pro Ořez.")
  sourceObject.updateMatrixWorld(true)
  const sourceInverse = sourceObject.matrixWorld.clone().invert()
  const nodes = []
  const nodeMap = new Map()
  const triangles = []
  const edgeTriangles = new Map()
  const triangleLookup = new Map()
  const childMeta = new Map()
  const bounds = new THREE.Box3()

  const ensureNode = (point) => {
    const key = trimVertexKey(point)
    const existing = nodeMap.get(key)
    if (existing !== undefined) return existing
    const id = nodes.length
    nodes.push(point.clone())
    nodeMap.set(key, id)
    bounds.expandByPoint(point)
    return id
  }

  const registerEdge = (a, b, triIndex) => {
    if (a === b) return
    const key = trimEdgeKey(a, b)
    const list = edgeTriangles.get(key)
    if (list) list.push(triIndex)
    else edgeTriangles.set(key, [triIndex])
  }

  sourceObject.traverse((child) => {
    if (!child?.isMesh || !child.geometry?.getAttribute?.("position")) return
    child.updateMatrixWorld(true)
    const geometry = child.geometry
    const position = geometry.getAttribute("position")
    const normal = geometry.getAttribute("normal")
    const originalColor = child.userData?._originalColors || geometry.getAttribute("color")
    const uv = geometry.getAttribute("uv")
    const index = geometry.index
    const childToSource = sourceInverse.clone().multiply(child.matrixWorld)
    const sourceToChild = childToSource.clone().invert()
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(childToSource)
    const faceCount = Math.floor((index ? index.count : position.count) / 3)
    const triangleIndices = []

    childMeta.set(child.uuid, {
      mesh: child,
      childToSource,
      sourceToChild,
      triangleIndices,
      hasNormal: !!normal,
      hasColor: !!originalColor,
      hasUv: !!uv,
    })

    const readCorner = (vertexIndex) => {
      const localPos = new THREE.Vector3().fromBufferAttribute(position, vertexIndex)
      const sourcePos = localPos.clone().applyMatrix4(childToSource)
      const nodeId = ensureNode(sourcePos)
      let localNormal = null
      if (normal) localNormal = [normal.getX(vertexIndex), normal.getY(vertexIndex), normal.getZ(vertexIndex)]
      let sourceNormal = null
      if (localNormal) {
        const n = new THREE.Vector3(localNormal[0], localNormal[1], localNormal[2]).applyMatrix3(normalMatrix).normalize()
        sourceNormal = [n.x, n.y, n.z]
      }
      const color = originalColor ? [originalColor.getX(vertexIndex), originalColor.getY(vertexIndex), originalColor.getZ(vertexIndex)] : null
      const tex = uv ? [uv.getX(vertexIndex), uv.getY(vertexIndex)] : null
      return {
        nodeId,
        sourcePos: [sourcePos.x, sourcePos.y, sourcePos.z],
        localPos: [localPos.x, localPos.y, localPos.z],
        localNormal,
        sourceNormal,
        color,
        uv: tex,
      }
    }

    for (let faceIndex = 0; faceIndex < faceCount; faceIndex++) {
      const offset = faceIndex * 3
      const ia = index ? index.getX(offset) : offset
      const ib = index ? index.getX(offset + 1) : offset + 1
      const ic = index ? index.getX(offset + 2) : offset + 2
      const corners = [readCorner(ia), readCorner(ib), readCorner(ic)]
      const nodeIds = corners.map((corner) => corner.nodeId)
      if (nodeIds[0] === nodeIds[1] || nodeIds[1] === nodeIds[2] || nodeIds[2] === nodeIds[0]) continue
      const triIndex = triangles.length
      const materialIndex = geometry.groups?.find?.((group) => offset >= group.start && offset < group.start + group.count)?.materialIndex || 0
      const centroid = new THREE.Vector3()
        .add(trimVec(corners[0].sourcePos))
        .add(trimVec(corners[1].sourcePos))
        .add(trimVec(corners[2].sourcePos))
        .multiplyScalar(1 / 3)
      const edgeKeys = [
        trimEdgeKey(nodeIds[0], nodeIds[1]),
        trimEdgeKey(nodeIds[1], nodeIds[2]),
        trimEdgeKey(nodeIds[2], nodeIds[0]),
      ]
      triangles.push({ childUuid: child.uuid, faceIndex, nodeIds, corners, materialIndex, centroid, edgeKeys })
      triangleIndices.push(triIndex)
      triangleLookup.set(`${child.uuid}:${faceIndex}`, triIndex)
      registerEdge(nodeIds[0], nodeIds[1], triIndex)
      registerEdge(nodeIds[1], nodeIds[2], triIndex)
      registerEdge(nodeIds[2], nodeIds[0], triIndex)
    }
  })

  if (!triangles.length || !nodes.length) throw new Error("Model neobsahuje použitelnou triangulaci pro Ořez.")

  const triangleNeighbors = Array.from({ length: triangles.length }, () => [])
  const sharedEdgeByPair = new Map()
  for (const [edgeKey, list] of edgeTriangles) {
    if (!Array.isArray(list) || list.length < 2) continue
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j]
        if (!triangleNeighbors[a].includes(b)) triangleNeighbors[a].push(b)
        if (!triangleNeighbors[b].includes(a)) triangleNeighbors[b].push(a)
        sharedEdgeByPair.set(a < b ? `${a}:${b}` : `${b}:${a}`, edgeKey)
      }
    }
  }

  const size = new THREE.Vector3()
  bounds.getSize(size)
  const diagonal = Math.max(1e-3, size.length())
  return {
    sourceObject,
    nodes,
    nodeMap,
    triangles,
    edgeTriangles,
    triangleLookup,
    childMeta,
    triangleNeighbors,
    sharedEdgeByPair,
    bounds,
    diagonal,
  }
}

function resolveTrimHit(context, sourceObject, event) {
  if (!context || !sourceObject || !event?.object?.isMesh) return null
  const faceIndex = Number.isInteger(event.faceIndex)
    ? event.faceIndex
    : (event.face && Number.isInteger(event.face.a) ? Math.floor(event.face.a / 3) : null)
  if (!Number.isInteger(faceIndex)) return null
  const triangleIndex = context.triangleLookup.get(`${event.object.uuid}:${faceIndex}`)
  if (triangleIndex === undefined) return null
  sourceObject.updateMatrixWorld(true)
  const point = sourceObject.worldToLocal(event.point.clone())
  return { point: [point.x, point.y, point.z], triangleIndex }
}

function trimSharedEdgeNodes(context, triA, triB) {
  const pairKey = triA < triB ? `${triA}:${triB}` : `${triB}:${triA}`
  const edgeKey = context.sharedEdgeByPair.get(pairKey)
  if (!edgeKey) return null
  const [a, b] = edgeKey.split(":").map(Number)
  return Number.isInteger(a) && Number.isInteger(b) ? [a, b] : null
}

function trimTriangleSurfacePath(context, startHit, endHit) {
  if (!context || !startHit || !endHit) return null
  const startTriangle = startHit.triangleIndex
  const endTriangle = endHit.triangleIndex
  if (!Number.isInteger(startTriangle) || !Number.isInteger(endTriangle)) return null
  const startPoint = trimVec(startHit.point)
  const endPoint = trimVec(endHit.point)
  if (startTriangle === endTriangle) {
    return {
      points: [trimArr(startPoint), trimArr(endPoint)],
      pieces: [{ triangleIndex: startTriangle, a: trimArr(startPoint), b: trimArr(endPoint) }],
    }
  }

  const count = context.triangles.length
  const distance = new Float64Array(count)
  distance.fill(Infinity)
  const previous = new Int32Array(count)
  previous.fill(-1)
  const closed = new Uint8Array(count)
  const heapNodes = []
  const heapScores = []
  const heuristic = (triIndex) => context.triangles[triIndex].centroid.distanceTo(endPoint)

  const push = (node, score) => {
    let index = heapNodes.length
    heapNodes.push(node); heapScores.push(score)
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (heapScores[parent] <= score) break
      heapNodes[index] = heapNodes[parent]; heapScores[index] = heapScores[parent]
      index = parent
    }
    heapNodes[index] = node; heapScores[index] = score
  }
  const pop = () => {
    if (!heapNodes.length) return null
    const node = heapNodes[0]
    const lastNode = heapNodes.pop()
    const lastScore = heapScores.pop()
    if (heapNodes.length) {
      let index = 0
      while (true) {
        const left = index * 2 + 1
        if (left >= heapNodes.length) break
        const right = left + 1
        const child = right < heapNodes.length && heapScores[right] < heapScores[left] ? right : left
        if (heapScores[child] >= lastScore) break
        heapNodes[index] = heapNodes[child]; heapScores[index] = heapScores[child]
        index = child
      }
      heapNodes[index] = lastNode; heapScores[index] = lastScore
    }
    return node
  }

  distance[startTriangle] = 0
  push(startTriangle, heuristic(startTriangle))
  while (heapNodes.length) {
    const current = pop()
    if (current == null || closed[current]) continue
    if (current === endTriangle) break
    closed[current] = 1
    const currentCentroid = context.triangles[current].centroid
    for (const next of context.triangleNeighbors[current] || []) {
      if (closed[next]) continue
      const weight = currentCentroid.distanceTo(context.triangles[next].centroid)
      const candidate = distance[current] + weight
      if (candidate >= distance[next]) continue
      distance[next] = candidate
      previous[next] = current
      push(next, candidate + heuristic(next))
    }
  }

  if (!Number.isFinite(distance[endTriangle])) return null
  const trianglePath = []
  let cursor = endTriangle
  while (cursor !== -1) {
    trianglePath.push(cursor)
    if (cursor === startTriangle) break
    cursor = previous[cursor]
  }
  trianglePath.reverse()
  if (trianglePath[0] !== startTriangle) return null

  const portals = []
  for (let i = 0; i < trianglePath.length - 1; i++) {
    const edgeNodes = trimSharedEdgeNodes(context, trianglePath[i], trianglePath[i + 1])
    if (!edgeNodes) return null
    const a = context.nodes[edgeNodes[0]], b = context.nodes[edgeNodes[1]]
    portals.push({ a: a.clone(), b: b.clone(), point: a.clone().add(b).multiplyScalar(0.5) })
  }

  // „Elastic band“ optimalizace přes portály. Na rozdíl od v9 nejde křivka po
  // hranách polygonů, ale protíná jednotlivé faces a body na společných hranách
  // si najdou lokálně nejkratší pozici.
  const points = [startPoint, ...portals.map((portal) => portal.point.clone()), endPoint]
  const optimizePortal = (portal, previousPoint, nextPoint) => {
    let lo = 0, hi = 1
    const evaluate = (t) => {
      const p = portal.a.clone().lerp(portal.b, t)
      return previousPoint.distanceTo(p) + p.distanceTo(nextPoint)
    }
    for (let iter = 0; iter < 18; iter++) {
      const t1 = lo + (hi - lo) / 3
      const t2 = hi - (hi - lo) / 3
      if (evaluate(t1) <= evaluate(t2)) hi = t2
      else lo = t1
    }
    return portal.a.clone().lerp(portal.b, (lo + hi) * 0.5)
  }
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 0; i < portals.length; i++) {
      points[i + 1] = optimizePortal(portals[i], points[i], points[i + 2])
    }
  }

  const pathPoints = points.map(trimArr)
  const pieces = []
  for (let i = 0; i < trianglePath.length; i++) {
    pieces.push({ triangleIndex: trianglePath[i], a: pathPoints[i], b: pathPoints[i + 1] })
  }
  return { points: pathPoints, pieces }
}

function trimPointInPolygon2D(point, polygon) {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j]
    const intersects = ((a.y > point.y) !== (b.y > point.y)) &&
      (point.x < (b.x - a.x) * (point.y - a.y) / ((b.y - a.y) || 1e-12) + a.x)
    if (intersects) inside = !inside
  }
  return inside
}

function trimTriangleProjection(triangle) {
  const p0 = trimVec(triangle.corners[0].sourcePos)
  const p1 = trimVec(triangle.corners[1].sourcePos)
  const p2 = trimVec(triangle.corners[2].sourcePos)
  const u = p1.clone().sub(p0).normalize()
  const normal = p1.clone().sub(p0).cross(p2.clone().sub(p0)).normalize()
  const v = normal.clone().cross(u).normalize()
  const project = (point) => {
    const rel = trimVec(point).sub(p0)
    return new THREE.Vector2(rel.dot(u), rel.dot(v))
  }
  return { p0, p1, p2, u, v, normal, project }
}

function trimPerimeterInfo(triangle, point, diagonal = 1) {
  const p = trimVec(point)
  const corners = triangle.corners.map((corner) => trimVec(corner.sourcePos))
  let best = null
  for (let edge = 0; edge < 3; edge++) {
    const a = corners[edge]
    const b = corners[(edge + 1) % 3]
    const ab = b.clone().sub(a)
    const lengthSq = Math.max(1e-16, ab.lengthSq())
    const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / lengthSq, 0, 1)
    const closest = a.clone().addScaledVector(ab, t)
    const distance = closest.distanceTo(p)
    if (!best || distance < best.distance) best = { edge, t, s: edge + t, distance, point: trimArr(closest) }
  }
  const tolerance = Math.max(1e-6, diagonal * 2e-5)
  return best && best.distance <= tolerance ? best : best
}

function trimForwardPerimeterArc(triangle, fromInfo, toInfo) {
  const corners = triangle.corners.map((corner) => corner.sourcePos)
  const result = [fromInfo.point]
  let fromS = fromInfo.s
  let toS = toInfo.s
  if (toS <= fromS + 1e-8) toS += 3
  for (let integer = Math.floor(fromS) + 1; integer < toS - 1e-8; integer++) {
    const cornerIndex = ((integer % 3) + 3) % 3
    result.push(corners[cornerIndex])
  }
  result.push(toInfo.point)
  return result
}

function trimRemoveDuplicatePoints(points, epsilon = 1e-8) {
  const result = []
  for (const point of points || []) {
    if (!point) continue
    const p = Array.isArray(point) ? point : trimArr(point)
    const previous = result[result.length - 1]
    if (previous && trimVec(previous).distanceToSquared(trimVec(p)) <= epsilon * epsilon) continue
    result.push([p[0], p[1], p[2]])
  }
  if (result.length > 2 && trimVec(result[0]).distanceToSquared(trimVec(result[result.length - 1])) <= epsilon * epsilon) result.pop()
  return result
}

function trimChainPiecesInTriangle(pieces) {
  if (!pieces?.length) return null
  const pointsByKey = new Map()
  const graph = new Map()
  const edges = []
  const addPoint = (point) => {
    const key = trimPointKey(point)
    if (!pointsByKey.has(key)) pointsByKey.set(key, point)
    if (!graph.has(key)) graph.set(key, [])
    return key
  }
  for (const piece of pieces) {
    if (!piece?.a || !piece?.b) continue
    const a = addPoint(piece.a), b = addPoint(piece.b)
    if (a === b) continue
    const edgeIndex = edges.length
    edges.push([a, b])
    graph.get(a).push(edgeIndex)
    graph.get(b).push(edgeIndex)
  }
  if (!edges.length) return null
  const endpoints = Array.from(graph.entries()).filter(([, list]) => list.length === 1).map(([key]) => key)
  if (endpoints.length < 2) return null
  let current = endpoints[0]
  const ordered = [pointsByKey.get(current)]
  const used = new Set()
  for (let guard = 0; guard < edges.length + 3; guard++) {
    const nextEdge = (graph.get(current) || []).find((index) => !used.has(index))
    if (nextEdge === undefined) break
    used.add(nextEdge)
    const [a, b] = edges[nextEdge]
    current = a === current ? b : a
    ordered.push(pointsByKey.get(current))
  }
  if (used.size !== edges.length) return null
  return trimRemoveDuplicatePoints(ordered)
}

function buildTrimBoundarySplit(context, plan, triangleIndex, pieces) {
  const triangle = context.triangles[triangleIndex]
  const chain = trimChainPiecesInTriangle(pieces)
  if (!triangle || !chain || chain.length < 2) return null
  const startInfo = trimPerimeterInfo(triangle, chain[0], context.diagonal)
  const endInfo = trimPerimeterInfo(triangle, chain[chain.length - 1], context.diagonal)
  if (!startInfo || !endInfo) return null

  const arcA = trimForwardPerimeterArc(triangle, endInfo, startInfo)
  const arcB = trimForwardPerimeterArc(triangle, startInfo, endInfo)
  const polygonA = trimRemoveDuplicatePoints([...chain, ...arcA.slice(1)])
  const polygonB = trimRemoveDuplicatePoints([...chain].reverse().concat(arcB.slice(1)))
  if (polygonA.length < 3 || polygonB.length < 3) return null

  const projection = trimTriangleProjection(triangle)
  const polygonA2 = polygonA.map(projection.project)
  const polygonB2 = polygonB.map(projection.project)
  const votesA = new Map(), votesB = new Map()
  const sideAComponents = new Set(), sideBComponents = new Set()

  for (let edge = 0; edge < 3; edge++) {
    const key = triangle.edgeKeys[edge]
    const neighbors = (context.edgeTriangles.get(key) || []).filter((index) => index !== triangleIndex)
    if (!neighbors.length) continue
    const pa = trimVec(triangle.corners[edge].sourcePos)
    const pb = trimVec(triangle.corners[(edge + 1) % 3].sourcePos)
    const centroid = triangle.centroid
    const inward = pa.clone().add(pb).multiplyScalar(0.5).lerp(centroid, 0.12)
    const p2 = projection.project(inward)
    const inA = trimPointInPolygon2D(p2, polygonA2)
    const inB = trimPointInPolygon2D(p2, polygonB2)
    for (const neighbor of neighbors) {
      const component = plan.componentIds[neighbor]
      if (component < 0) continue
      if (inA && !inB) {
        sideAComponents.add(component)
        votesA.set(component, (votesA.get(component) || 0) + 1)
      } else if (inB && !inA) {
        sideBComponents.add(component)
        votesB.set(component, (votesB.get(component) || 0) + 1)
      }
    }
  }

  return {
    triangleIndex,
    chain,
    polygonA,
    polygonB,
    polygonA2,
    polygonB2,
    projection,
    sideAComponents,
    sideBComponents,
    votesA,
    votesB,
  }
}

function buildTrimBoundaryPlan(context, segments) {
  if (!context || !segments?.length) return null
  const piecesByTriangle = new Map()
  for (const segment of segments) {
    for (const piece of segment?.pieces || []) {
      if (!Number.isInteger(piece?.triangleIndex)) continue
      const list = piecesByTriangle.get(piece.triangleIndex)
      if (list) list.push(piece)
      else piecesByTriangle.set(piece.triangleIndex, [piece])
    }
  }
  const boundaryTriangles = new Set(piecesByTriangle.keys())
  if (!boundaryTriangles.size) return null

  const componentIds = new Int32Array(context.triangles.length)
  componentIds.fill(-1)
  for (const triIndex of boundaryTriangles) componentIds[triIndex] = -2
  const components = []
  for (let start = 0; start < context.triangles.length; start++) {
    if (componentIds[start] !== -1) continue
    const component = components.length
    const queue = [start]
    componentIds[start] = component
    const triangles = []
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const triIndex = queue[cursor]
      triangles.push(triIndex)
      for (const next of context.triangleNeighbors[triIndex] || []) {
        if (componentIds[next] !== -1) continue
        componentIds[next] = component
        queue.push(next)
      }
    }
    components.push(triangles)
  }

  const plan = { piecesByTriangle, boundaryTriangles, componentIds, components, splits: new Map() }
  for (const [triIndex, pieces] of piecesByTriangle) {
    const split = buildTrimBoundarySplit(context, plan, triIndex, pieces)
    if (split) plan.splits.set(triIndex, split)
  }
  return plan
}

function trimBoundarySideForComponent(split, componentId) {
  if (!split || componentId == null || componentId < 0) return null
  const a = split.sideAComponents.has(componentId)
  const b = split.sideBComponents.has(componentId)
  if (a && !b) return "a"
  if (b && !a) return "b"
  if (a && b) return (split.votesA.get(componentId) || 0) >= (split.votesB.get(componentId) || 0) ? "a" : "b"
  if (split.sideAComponents.size && !split.sideBComponents.size) return "b"
  if (split.sideBComponents.size && !split.sideAComponents.size) return "a"
  return null
}

function resolveTrimComponentFromHit(context, plan, hit) {
  if (!context || !plan || !hit || !Number.isInteger(hit.triangleIndex)) return null
  const direct = plan.componentIds[hit.triangleIndex]
  if (direct >= 0) return direct
  const split = plan.splits.get(hit.triangleIndex)
  if (!split) return null
  const point2 = split.projection.project(hit.point)
  const inA = trimPointInPolygon2D(point2, split.polygonA2)
  const inB = trimPointInPolygon2D(point2, split.polygonB2)
  const candidates = inA && !inB ? split.sideAComponents : inB && !inA ? split.sideBComponents : null
  if (candidates?.size) return candidates.values().next().value
  const all = new Set([...split.sideAComponents, ...split.sideBComponents])
  if (all.size === 1) return all.values().next().value
  return null
}

function interpolateTrimCorner(triangle, point) {
  const p = trimVec(point)
  const a = trimVec(triangle.corners[0].sourcePos)
  const b = trimVec(triangle.corners[1].sourcePos)
  const c = trimVec(triangle.corners[2].sourcePos)
  const bary = new THREE.Vector3()
  THREE.Triangle.getBarycoord(p, a, b, c, bary)
  if (!Number.isFinite(bary.x)) bary.set(1, 0, 0)
  bary.x = THREE.MathUtils.clamp(bary.x, -1e-5, 1 + 1e-5)
  bary.y = THREE.MathUtils.clamp(bary.y, -1e-5, 1 + 1e-5)
  bary.z = THREE.MathUtils.clamp(bary.z, -1e-5, 1 + 1e-5)
  const sum = bary.x + bary.y + bary.z || 1
  bary.multiplyScalar(1 / sum)
  const weights = [bary.x, bary.y, bary.z]
  const mix = (key, length) => {
    if (!triangle.corners.every((corner) => Array.isArray(corner[key]))) return null
    const out = new Array(length).fill(0)
    for (let i = 0; i < 3; i++) for (let j = 0; j < length; j++) out[j] += triangle.corners[i][key][j] * weights[i]
    return out
  }
  const localPos = mix("localPos", 3)
  let localNormal = mix("localNormal", 3)
  if (localNormal) {
    const n = new THREE.Vector3(...localNormal).normalize()
    localNormal = [n.x, n.y, n.z]
  }
  return {
    sourcePos: [p.x, p.y, p.z],
    localPos,
    localNormal,
    color: mix("color", 3),
    uv: mix("uv", 2),
  }
}

function triangulateTrimPolygon(triangle, polygon) {
  const clean = trimRemoveDuplicatePoints(polygon, 1e-7)
  if (clean.length < 3) return []
  const projection = trimTriangleProjection(triangle)
  const contour = clean.map(projection.project)
  const faces = THREE.ShapeUtils.triangulateShape(contour, [])
  const corners = clean.map((point) => interpolateTrimCorner(triangle, point))
  return faces.map((face) => [corners[face[0]], corners[face[1]], corners[face[2]]])
}

function trimBoundaryPolygonForComponent(plan, triangleIndex, componentId, keep = true) {
  const split = plan?.splits?.get(triangleIndex)
  if (!split) return null
  const side = trimBoundarySideForComponent(split, componentId)
  if (!side) return null
  const selected = side === "a" ? split.polygonA : split.polygonB
  const other = side === "a" ? split.polygonB : split.polygonA
  return keep ? selected : other
}

function createTrimRegionPreviewGeometry(context, plan, componentId, keep = true) {
  if (!context || !plan || componentId == null) return null
  const positions = []
  for (let triIndex = 0; triIndex < context.triangles.length; triIndex++) {
    const triangle = context.triangles[triIndex]
    const component = plan.componentIds[triIndex]
    if (component >= 0) {
      if ((component === componentId) !== !!keep) continue
      for (const corner of triangle.corners) positions.push(...corner.sourcePos)
      continue
    }
    if (component !== -2) continue
    const polygon = trimBoundaryPolygonForComponent(plan, triIndex, componentId, keep)
    if (!polygon) continue
    for (const tri of triangulateTrimPolygon(triangle, polygon)) {
      for (const corner of tri) positions.push(...corner.sourcePos)
    }
  }
  if (!positions.length) return null
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3))
  geometry.computeBoundingBox(); geometry.computeBoundingSphere()
  return geometry
}

function buildTrimmedGeometryForChild(context, plan, componentId, childUuid) {
  const meta = context.childMeta.get(childUuid)
  if (!meta) return new THREE.BufferGeometry()
  const positions = []
  const normals = []
  const colors = []
  const uvs = []
  const materialIndices = []
  let hasNormal = true, hasColor = true, hasUv = true

  const appendTriangle = (triangle, corners) => {
    materialIndices.push(triangle.materialIndex || 0)
    for (const corner of corners) {
      positions.push(...corner.localPos)
      if (corner.localNormal) normals.push(...corner.localNormal); else hasNormal = false
      if (corner.color) colors.push(...corner.color); else hasColor = false
      if (corner.uv) uvs.push(...corner.uv); else hasUv = false
    }
  }

  for (const triIndex of meta.triangleIndices) {
    const triangle = context.triangles[triIndex]
    const component = plan.componentIds[triIndex]
    if (component >= 0) {
      if (component === componentId) appendTriangle(triangle, triangle.corners)
      continue
    }
    if (component !== -2) continue
    const polygon = trimBoundaryPolygonForComponent(plan, triIndex, componentId, true)
    if (!polygon) continue
    for (const corners of triangulateTrimPolygon(triangle, polygon)) appendTriangle(triangle, corners)
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3))
  if (hasNormal && normals.length === positions.length) geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3))
  else if (positions.length) geometry.computeVertexNormals()
  if (hasColor && colors.length === positions.length) geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3))
  if (hasUv && uvs.length * 3 === positions.length * 2) geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2))

  if (materialIndices.length) {
    let groupStart = 0
    let current = materialIndices[0]
    for (let i = 1; i <= materialIndices.length; i++) {
      if (i === materialIndices.length || materialIndices[i] !== current) {
        geometry.addGroup(groupStart * 3, (i - groupStart) * 3, current)
        groupStart = i
        current = materialIndices[i]
      }
    }
  }
  geometry.computeBoundingBox(); geometry.computeBoundingSphere()
  try { if (positions.length) geometry.computeBoundsTree?.(ALIGNMENT_BVH_OPTIONS) } catch {}
  return geometry
}

function applyTrimRegionToObject(context, plan, componentId) {
  if (!context || !plan || componentId == null) throw new Error("Chybí vybraná oblast Ořezu.")
  const backup = []
  for (const [childUuid, meta] of context.childMeta) {
    const mesh = meta.mesh
    if (!mesh?.isMesh) continue
    const newGeometry = buildTrimmedGeometryForChild(context, plan, componentId, childUuid)
    backup.push({
      mesh,
      geometry: mesh.geometry,
      visible: mesh.visible,
      originalColors: mesh.userData?._originalColors,
      baseGeom: mesh.userData?._baseGeom,
      derivedGeom: mesh.userData?._derivedGeom,
    })
    mesh.geometry = newGeometry
    mesh.visible = !!newGeometry.getAttribute("position")?.count
    mesh.userData._baseGeom = newGeometry
    mesh.userData._derivedGeom = newGeometry
    mesh.userData._originalColors = newGeometry.getAttribute("color")?.clone?.() || null
    delete mesh.userData._comparisonColors
    delete mesh.userData._comparisonDistances
    delete mesh.userData._occlusionColors
    delete mesh.userData._occlusionDistances
  }
  context.sourceObject.updateMatrixWorld(true)
  return backup
}

function restoreTrimBackup(backup) {
  if (!Array.isArray(backup)) return
  for (const item of backup) {
    const mesh = item.mesh
    if (!mesh?.isMesh) continue
    const current = mesh.geometry
    mesh.geometry = item.geometry
    mesh.visible = item.visible
    mesh.userData._originalColors = item.originalColors
    mesh.userData._baseGeom = item.baseGeom
    mesh.userData._derivedGeom = item.derivedGeom
    if (current && current !== item.geometry) {
      try { current.disposeBoundsTree?.() } catch {}
      current.dispose?.()
    }
  }
}

function TrimRegionPreview({ context, plan, componentId }) {
  const geometries = useMemo(() => {
    if (!context || !plan || componentId == null) return { keep: null, drop: null }
    return {
      keep: createTrimRegionPreviewGeometry(context, plan, componentId, true),
      drop: createTrimRegionPreviewGeometry(context, plan, componentId, false),
    }
  }, [context, plan, componentId])
  useEffect(() => () => {
    geometries.keep?.dispose?.(); geometries.drop?.dispose?.()
  }, [geometries])
  return (
    <>
      {geometries.keep && (
        <mesh geometry={geometries.keep} renderOrder={1450} raycast={() => null}>
          <meshBasicMaterial color="#4ade80" transparent opacity={0.17} side={THREE.DoubleSide} depthWrite={false} depthTest polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} />
        </mesh>
      )}
      {geometries.drop && (
        <mesh geometry={geometries.drop} renderOrder={1449} raycast={() => null}>
          <meshBasicMaterial color="#ef4444" transparent opacity={0.11} side={THREE.DoubleSide} depthWrite={false} depthTest polygonOffset polygonOffsetFactor={-1} polygonOffsetUnits={-1} />
        </mesh>
      )}
    </>
  )
}

function makeTrimPolylineCurve(points) {
  const vectors = []
  for (const point of points || []) {
    const vector = trimVec(point)
    if (!vectors.length || vectors[vectors.length - 1].distanceToSquared(vector) > 1e-14) vectors.push(vector)
  }
  if (vectors.length < 2) return null
  const cumulative = [0]
  for (let i = 1; i < vectors.length; i++) cumulative.push(cumulative[i - 1] + vectors[i - 1].distanceTo(vectors[i]))
  const total = cumulative[cumulative.length - 1] || 1
  const curve = new THREE.Curve()
  curve.getPoint = (t, target = new THREE.Vector3()) => {
    const distance = THREE.MathUtils.clamp(t, 0, 1) * total
    let index = 0
    while (index < cumulative.length - 2 && cumulative[index + 1] < distance) index++
    const start = cumulative[index]
    const end = cumulative[index + 1]
    const local = end > start ? (distance - start) / (end - start) : 0
    return target.copy(vectors[index]).lerp(vectors[index + 1], local)
  }
  curve.getPointAt = curve.getPoint
  return curve
}

function TrimBoundaryTube({ points, radius }) {
  const geometry = useMemo(() => {
    const curve = makeTrimPolylineCurve(points)
    if (!curve) return null
    const tubularSegments = Math.max(4, Math.min(900, (points.length - 1) * 3))
    return new THREE.TubeGeometry(curve, tubularSegments, radius, 6, false)
  }, [points, radius])
  useEffect(() => () => geometry?.dispose?.(), [geometry])
  if (!geometry) return null
  return (
    <mesh geometry={geometry} renderOrder={1500} raycast={() => null}>
      <meshBasicMaterial color="#69a7d8" transparent opacity={0.72} depthTest depthWrite={false} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} />
    </mesh>
  )
}

function TrimSurfaceOverlay({
  context,
  modelMatrix,
  controlNodes,
  segments,
  boundaryPlan,
  keepComponent,
  hoverComponent,
  draggingPoint,
  onBeginPointDrag,
  onCloseLoop,
}) {
  const groupRef = useRef(null)
  useEffect(() => {
    const group = groupRef.current
    if (!group) return
    group.matrixAutoUpdate = false
    if (Array.isArray(modelMatrix) && modelMatrix.length === 16) group.matrix.fromArray(modelMatrix)
    else group.matrix.identity()
    group.matrixWorldNeedsUpdate = true
    group.updateMatrixWorld(true)
  }, [modelMatrix])

  if (!context) return null
  const pointRadius = Math.max(0.10, Math.min(1.15, context.diagonal * 0.0067))
  const lineRadius = Math.max(0.018, Math.min(0.18, context.diagonal * 0.00062))
  const previewComponent = keepComponent ?? hoverComponent

  return (
    <group ref={groupRef} matrixAutoUpdate={false}>
      {boundaryPlan && previewComponent != null && (
        <TrimRegionPreview context={context} plan={boundaryPlan} componentId={previewComponent} />
      )}
      {(segments || []).map((segment, index) => (
        <TrimBoundaryTube key={`trim-line-${index}`} points={segment?.points || []} radius={lineRadius} />
      ))}
      {(controlNodes || []).map((control, index) => {
        const point = control?.point
        if (!point) return null
        const isFirst = index === 0
        const active = draggingPoint === index
        return (
          <mesh
            key={`${index}-${trimPointKey(point)}`}
            position={point}
            renderOrder={1510}
            raycast={draggingPoint != null ? () => null : undefined}
            onPointerDown={(event) => {
              event.stopPropagation()
              event.nativeEvent?.preventDefault?.()
              onBeginPointDrag?.(index)
            }}
            onDoubleClick={isFirst && controlNodes.length >= 3 ? (event) => {
              event.stopPropagation()
              onCloseLoop?.()
            } : undefined}
          >
            <sphereGeometry args={[pointRadius * (active ? 1.16 : 1), 20, 16]} />
            <meshBasicMaterial
              color={active ? "#8bc5ef" : isFirst ? "#fbbf24" : "#6fa8d6"}
              depthTest
              depthWrite={false}
              transparent
              opacity={0.92}
            />
          </mesh>
        )
      })}
    </group>
  )
}


/* ---------- Ikony ---------- */
const ICON_BASE = (() => {
  const q = getParam("iconBase")
  if (q && /^(https?:)?\/\//i.test(q)) return q.replace(/\/+$/, "") + "/"
  if (q && q.startsWith("/")) return q.replace(/\/+$/, "") + "/"
  return "/icons/"
})()
const ICONS = { eye: `${ICON_BASE}Eye.png`, eyeOff: `${ICON_BASE}Eye-off.png` }
function PreloadIcons() {
  useEffect(() => {
    try { Object.values(ICONS).forEach((src) => { const i = new Image(); i.decoding="async"; i.src = src }) } catch {}
  }, [])
  return null
}

/* ---------- Auto Smooth ---------- */
const DEFAULT_SMOOTH_ANGLE = 30
function autoSmoothGeometry(geometry, angleDeg = DEFAULT_SMOOTH_ANGLE) {
  const angle = Math.max(0, Math.min(89.9, angleDeg))
  const angleRad = (angle * Math.PI) / 180
  const g = geometry.index ? geometry.toNonIndexed() : geometry.clone()
  const pos = g.getAttribute("position")
  const triCount = pos.count / 3
  const faceNormals = new Array(triCount)
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  const cb = new THREE.Vector3(), ab = new THREE.Vector3()
  for (let f = 0; f < triCount; f++) {
    const i0 = f * 3, i1 = i0 + 1, i2 = i0 + 2
    a.fromBufferAttribute(pos, i0)
    b.fromBufferAttribute(pos, i1)
    c.fromBufferAttribute(pos, i2)
    cb.subVectors(c, b)
    ab.subVectors(a, b)
    cb.cross(ab).normalize()
    faceNormals[f] = cb.clone()
  }
  const groups = new Map()
  const keyOf = (ix) => `${pos.getX(ix).toFixed(5)},${pos.getY(ix).toFixed(5)},${pos.getZ(ix).toFixed(5)}`
  for (let i = 0; i < pos.count; i++) {
    const k = keyOf(i)
    let arr = groups.get(k); if (!arr) { arr = []; groups.set(k, arr) }
    arr.push(i)
  }
  const normals = new Float32Array(pos.count * 3)
  const tmp = new THREE.Vector3()
  const cosThresh = Math.cos(angleRad)
  groups.forEach((cornerIndices) => {
    const localFaceNs = cornerIndices.map((ci) => faceNormals[Math.floor(ci / 3)])
    for (let idx = 0; idx < cornerIndices.length; idx++) {
      const ci = cornerIndices[idx]
      const nRef = localFaceNs[idx]
      let nx = 0, ny = 0, nz = 0
      for (let j = 0; j < localFaceNs.length; j++) {
        const nj = localFaceNs[j]
        if (nRef.dot(nj) >= cosThresh) { nx += nj.x; ny += nj.y; nz += nj.z }
      }
      tmp.set(nx, ny, nz); if (tmp.lengthSq() === 0) tmp.copy(nRef); tmp.normalize()
      const w = ci * 3; normals[w] = tmp.x; normals[w+1] = tmp.y; normals[w+2] = tmp.z
    }
  })
  g.setAttribute("normal", new THREE.BufferAttribute(normals, 3))
  g.computeBoundingBox(); g.computeBoundingSphere()
  return g
}

/* ---------- Analýzy povrchu a heatmapy ---------- */
function rememberOriginalColors(mesh) {
  if (mesh.userData._originalColors !== undefined) return
  mesh.userData._originalColors = mesh.geometry.attributes.color
    ? mesh.geometry.attributes.color.clone()
    : null
}

/* ---------- DICOM ZIP + 3D volume rendering ---------- */
const DICOM_HU_MIN = -1024
const DICOM_HU_MAX = 3071
const DICOM_DETAIL_QUALITY = 512
const DICOM_SLICE_INTERACTIVE_RESOLUTION = 256
const DICOM_SLICE_DETAIL_RESOLUTION = 640
const DEFAULT_DICOM_SETTINGS = {
  preset: "teeth",
  viewMode: "only2d",
  quality: DICOM_DETAIL_QUALITY,
  opacity: 0.82,
  densityMin: 350,
  densityMax: 2200,
  cropMin: 0,
  cropMax: 1,
  visible: true,
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: 1,
}
const normalizeDicomViewMode = (value) => (
  value === "light" || value === "solid" || value === "only2d" ? value : "only2d"
)

const parseDicomNumbers = (value, fallback = []) => {
  if (typeof value !== "string") return fallback
  const parsed = value.split("\\").map(Number)
  return parsed.every(Number.isFinite) ? parsed : fallback
}

function dicomSlicePosition(dataSet) {
  const position = parseDicomNumbers(dataSet.string("x00200032"), [])
  const orientation = parseDicomNumbers(dataSet.string("x00200037"), [])
  if (position.length === 3 && orientation.length === 6) {
    const row = new THREE.Vector3(orientation[0], orientation[1], orientation[2])
    const column = new THREE.Vector3(orientation[3], orientation[4], orientation[5])
    const normal = row.cross(column).normalize()
    return normal.dot(new THREE.Vector3(position[0], position[1], position[2]))
  }
  const instance = dataSet.intString("x00200013")
  return Number.isFinite(instance) ? instance : 0
}

function decodeDicomSlice(bytes, targetSize) {
  let dataSet
  try {
    dataSet = dicomParser.parseDicom(bytes)
  } catch {
    return null
  }
  const pixelElement = dataSet.elements.x7fe00010
  const rows = dataSet.uint16("x00280010")
  const columns = dataSet.uint16("x00280011")
  if (!pixelElement || !rows || !columns) return null

  const transferSyntax = (dataSet.string("x00020010") || "").trim()
  const supportedSyntax = !transferSyntax || [
    "1.2.840.10008.1.2",
    "1.2.840.10008.1.2.1",
  ].includes(transferSyntax)
  if (!supportedSyntax || pixelElement.encapsulatedPixelData) {
    return { unsupported: true, transferSyntax }
  }

  const bitsAllocated = dataSet.uint16("x00280100") || 16
  const signed = (dataSet.uint16("x00280103") || 0) === 1
  if (bitsAllocated !== 8 && bitsAllocated !== 16) return null

  const slope = dataSet.floatString("x00281053") || 1
  const intercept = dataSet.floatString("x00281052") || 0
  const maxXY = Math.max(rows, columns)
  const width = Math.max(16, Math.round(columns * Math.min(1, targetSize / maxXY)))
  const height = Math.max(16, Math.round(rows * Math.min(1, targetSize / maxXY)))
  const pixels = new Uint8Array(width * height)
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset + pixelElement.dataOffset,
    pixelElement.length
  )
  const bytesPerPixel = bitsAllocated / 8
  const huRange = DICOM_HU_MAX - DICOM_HU_MIN

  for (let y = 0; y < height; y++) {
    const sourceY = Math.min(rows - 1, Math.floor((y + 0.5) * rows / height))
    for (let x = 0; x < width; x++) {
      const sourceX = Math.min(columns - 1, Math.floor((x + 0.5) * columns / width))
      const offset = (sourceY * columns + sourceX) * bytesPerPixel
      let stored
      if (bitsAllocated === 16) stored = signed ? view.getInt16(offset, true) : view.getUint16(offset, true)
      else stored = signed ? view.getInt8(offset) : view.getUint8(offset)
      const hu = stored * slope + intercept
      pixels[y * width + x] = Math.max(0, Math.min(255, Math.round(((hu - DICOM_HU_MIN) / huRange) * 255)))
    }
  }

  const spacing = parseDicomNumbers(dataSet.string("x00280030"), [1, 1])
  const thickness = dataSet.floatString("x00180050") || 1
  return {
    unsupported: false,
    series: dataSet.string("x0020000e") || "default",
    rows,
    columns,
    width,
    height,
    pixels,
    position: dicomSlicePosition(dataSet),
    spacingX: Math.abs(spacing[1] || spacing[0] || 1),
    spacingY: Math.abs(spacing[0] || 1),
    thickness: Math.abs(thickness || 1),
  }
}

async function loadDicomZip(url, quality, expectedSize, onProgress, signal) {
  const response = await fetch(url, { cache: "no-store", signal })
  if (!response.ok) throw new Error(`DICOM ZIP nelze stáhnout (HTTP ${response.status}).`)
  if (!response.body) throw new Error("Prohlížeč nepodporuje průběžné načítání DICOM dat.")

  const total = Number(response.headers.get("content-length")) || Number(expectedSize) || 0
  const reader = response.body.getReader()
  const series = new Map()
  let downloaded = 0
  let lastYieldAt = 0
  let activeFiles = 0
  let archiveEnded = false
  let unsupportedSyntax = null
  let fatalError = null

  let resolveFinished, rejectFinished
  const finished = new Promise((resolve, reject) => {
    resolveFinished = resolve
    rejectFinished = reject
  })
  const maybeFinish = () => {
    if (fatalError) return rejectFinished(fatalError)
    if (archiveEnded && activeFiles === 0) resolveFinished()
  }

  const unzip = new Unzip((file) => {
    if (file.name.endsWith("/") || /(^|\/)DICOMDIR$/i.test(file.name)) return
    activeFiles += 1
    const chunks = []
    let length = 0
    file.ondata = (error, chunk, final) => {
      if (error) {
        fatalError = error
        activeFiles -= 1
        maybeFinish()
        return
      }
      if (chunk?.length) {
        chunks.push(chunk)
        length += chunk.length
      }
      if (!final) return
      // Každý řez zpracujeme v samostatném úkolu, aby hlavní vlákno mezi
      // řezy mohlo překreslit průběh a ovládání nepůsobilo zamrzle.
      setTimeout(() => {
        try {
          const bytes = new Uint8Array(length)
          let offset = 0
          chunks.forEach((part) => { bytes.set(part, offset); offset += part.length })
          const slice = decodeDicomSlice(bytes, quality)
          if (slice?.unsupported) unsupportedSyntax = slice.transferSyntax || "neznámá"
          else if (slice?.pixels) {
            if (!series.has(slice.series)) series.set(slice.series, [])
            series.get(slice.series).push(slice)
          }
        } catch (error) {
          console.warn("DICOM soubor byl přeskočen:", error)
        } finally {
          activeFiles -= 1
          maybeFinish()
        }
      }, 0)
    }
    file.start()
  })
  unzip.register(UnzipInflate)

  while (true) {
    if (signal?.aborted) throw new DOMException("Načítání zrušeno", "AbortError")
    const { value, done } = await reader.read()
    if (done) {
      archiveEnded = true
      unzip.push(new Uint8Array(0), true)
      maybeFinish()
      break
    }
    downloaded += value.byteLength
    onProgress?.({
      phase: "download",
      percent: total ? Math.min(100, (downloaded / total) * 100) : 0,
      downloaded,
      total,
    })
    unzip.push(value, false)
    if (downloaded - lastYieldAt >= 4 * 1024 * 1024) {
      lastYieldAt = downloaded
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  onProgress?.({ phase: "process", percent: 100, downloaded, total })
  await finished

  const candidates = [...series.values()].filter((items) => items.length > 1)
  candidates.sort((a, b) => b.length - a.length)
  const slices = candidates[0]
  if (!slices?.length) {
    if (unsupportedSyntax) {
      throw new Error(`DICOM používá nepodporovanou kompresi (${unsupportedSyntax}).`)
    }
    throw new Error("V ZIP archivu nebyla nalezena použitelná DICOM CT série.")
  }
  slices.sort((a, b) => a.position - b.position)

  const first = slices[0]
  const depth = Math.min(slices.length, quality)
  const voxels = new Uint8Array(first.width * first.height * depth)
  for (let z = 0; z < depth; z++) {
    const sourceIndex = Math.min(slices.length - 1, Math.round(z * (slices.length - 1) / Math.max(1, depth - 1)))
    voxels.set(slices[sourceIndex].pixels, z * first.width * first.height)
  }
  const positionRange = Math.abs(slices[slices.length - 1].position - slices[0].position)
  const physicalDepth = positionRange > 0 ? positionRange + first.thickness : slices.length * first.thickness

  return {
    data: voxels,
    width: first.width,
    height: first.height,
    depth,
    size: [
      first.columns * first.spacingX,
      first.rows * first.spacingY,
      physicalDepth,
    ],
    sourceDimensions: [first.columns, first.rows, slices.length],
  }
}

const DICOM_VERTEX_SHADER = `
  out vec3 vOrigin;
  out vec3 vDirection;
  uniform vec3 uSize;
  void main() {
    vec3 cameraLocal = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
    vOrigin = cameraLocal / uSize + 0.5;
    vec3 texturePosition = position / uSize + 0.5;
    vDirection = texturePosition - vOrigin;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const DICOM_FRAGMENT_SHADER = `
  precision highp float;
  precision highp sampler3D;
  in vec3 vOrigin;
  in vec3 vDirection;
  out vec4 outColor;
  uniform sampler3D uVolume;
  uniform float uDensityLow;
  uniform float uDensityHigh;
  uniform float uOpacity;
  uniform float uCropMin;
  uniform float uCropMax;
  uniform float uStep;
  uniform float uInteractive;
  uniform float uViewMode;
  uniform vec3 uVoxel;

  vec2 hitBox(vec3 origin, vec3 direction) {
    vec3 invDirection = 1.0 / direction;
    vec3 tMin = (vec3(0.0) - origin) * invDirection;
    vec3 tMax = (vec3(1.0) - origin) * invDirection;
    vec3 t1 = min(tMin, tMax);
    vec3 t2 = max(tMin, tMax);
    return vec2(max(max(t1.x, t1.y), t1.z), min(min(t2.x, t2.y), t2.z));
  }

  vec3 densityGradient(vec3 point) {
    return vec3(
      texture(uVolume, point + vec3(uVoxel.x, 0.0, 0.0)).r - texture(uVolume, point - vec3(uVoxel.x, 0.0, 0.0)).r,
      texture(uVolume, point + vec3(0.0, uVoxel.y, 0.0)).r - texture(uVolume, point - vec3(0.0, uVoxel.y, 0.0)).r,
      texture(uVolume, point + vec3(0.0, 0.0, uVoxel.z)).r - texture(uVolume, point - vec3(0.0, 0.0, uVoxel.z)).r
    );
  }

  void main() {
    vec3 direction = normalize(vDirection);
    vec2 bounds = hitBox(vOrigin, direction);
    if (bounds.x > bounds.y) discard;
    bounds.x = max(bounds.x, 0.0);
    vec3 point = vOrigin + bounds.x * direction;
    float distanceTravelled = bounds.x;
    vec4 accumulated = vec4(0.0);
    float low = clamp((uDensityLow - ${DICOM_HU_MIN.toFixed(1)}) / ${(DICOM_HU_MAX - DICOM_HU_MIN).toFixed(1)}, 0.0, 0.998);
    float high = clamp((uDensityHigh - ${DICOM_HU_MIN.toFixed(1)}) / ${(DICOM_HU_MAX - DICOM_HU_MIN).toFixed(1)}, low + 0.002, 1.0);
    float isoLevel = mix(low, high, 0.16);
    float previousDensity = 0.0;
    vec3 previousPoint = point;

    for (int i = 0; i < 1024; i++) {
      if (distanceTravelled > bounds.y || (uInteractive > 0.5 && accumulated.a > 0.985)) break;
      if (point.z >= uCropMin && point.z <= uCropMax) {
        float density = texture(uVolume, point).r;
        if (uInteractive < 0.5 && uViewMode > 0.5) {
          if (density >= isoLevel && previousDensity < isoLevel) {
            vec3 lowerPoint = previousPoint;
            vec3 upperPoint = point;
            for (int refinement = 0; refinement < 5; refinement++) {
              vec3 middlePoint = mix(lowerPoint, upperPoint, 0.5);
              if (texture(uVolume, middlePoint).r >= isoLevel) upperPoint = middlePoint;
              else lowerPoint = middlePoint;
            }
            vec3 surfacePoint = mix(lowerPoint, upperPoint, 0.5);
            float surfaceDensity = texture(uVolume, surfacePoint).r;
            vec3 normal = normalize(-densityGradient(surfacePoint) + vec3(0.00001));
            vec3 viewDirection = normalize(-direction);
            if (dot(normal, viewDirection) < 0.0) normal = -normal;
            vec3 keyDirection = normalize(viewDirection + vec3(0.42, 0.58, 0.72));
            vec3 halfDirection = normalize(keyDirection + viewDirection);
            float diffuse = max(dot(normal, keyDirection), 0.0);
            float fill = max(dot(normal, viewDirection), 0.0);
            float rim = pow(1.0 - fill, 2.0);
            float specular = pow(max(dot(normal, halfDirection), 0.0), 30.0);
            float surfaceTone = smoothstep(isoLevel, max(isoLevel + 0.02, high), surfaceDensity);
            vec3 boneColor = mix(vec3(0.62, 0.45, 0.27), vec3(0.98, 0.90, 0.70), surfaceTone);
            vec3 color = boneColor * (0.34 + diffuse * 0.72 + fill * 0.16 + rim * 0.08);
            color += vec3(1.0, 0.95, 0.82) * specular * 0.34;
            outColor = vec4(color, clamp(uOpacity * 1.2, 0.08, 1.0));
            return;
          }
        } else {
          float transfer = smoothstep(low, high, density);
          float alpha = pow(transfer, 1.35) * uOpacity * (uInteractive > 0.5 ? 0.06 : 0.09);
          if (alpha > 0.002) {
            vec3 boneColor = mix(vec3(0.72, 0.61, 0.43), vec3(1.0, 0.97, 0.86), transfer);
            float shade = 0.78;
            if (uInteractive < 0.5) {
              vec3 gradient = densityGradient(point);
              vec3 normal = normalize(gradient + vec3(0.0001));
              float diffuse = abs(dot(normal, normalize(vec3(0.45, 0.65, 1.0))));
              float facing = abs(dot(normal, -direction));
              float specular = pow(max(facing, 0.0), 22.0);
              float edgeStrength = clamp(length(gradient) * 16.0, 0.0, 1.0);
              shade = 0.34 + diffuse * 0.56 + specular * 0.34;
              alpha *= 0.62 + edgeStrength * 0.9;
            }
            accumulated.rgb += (1.0 - accumulated.a) * alpha * boneColor * shade;
            accumulated.a += (1.0 - accumulated.a) * alpha;
          }
        }
        previousDensity = density;
        previousPoint = point;
      } else {
        previousDensity = 0.0;
        previousPoint = point;
      }
      point += direction * uStep;
      distanceTravelled += uStep;
    }
    if (uInteractive < 0.5 && uViewMode > 0.5) discard;
    if (accumulated.a < 0.01) discard;
    outColor = accumulated;
  }
`

function DicomVolume({ volume, settings, interactive = false }) {
  const texture = useMemo(() => {
    if (!volume) return null
    const value = new THREE.Data3DTexture(volume.data, volume.width, volume.height, volume.depth)
    value.format = THREE.RedFormat
    value.type = THREE.UnsignedByteType
    value.minFilter = THREE.LinearFilter
    value.magFilter = THREE.LinearFilter
    value.unpackAlignment = 1
    value.needsUpdate = true
    return value
  }, [volume])

  const material = useMemo(() => {
    if (!texture || !volume) return null
    return new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: DICOM_VERTEX_SHADER,
      fragmentShader: DICOM_FRAGMENT_SHADER,
      side: THREE.BackSide,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      uniforms: {
        uVolume: { value: texture },
        uSize: { value: new THREE.Vector3(...volume.size) },
        uDensityLow: { value: settings.densityMin },
        uDensityHigh: { value: settings.densityMax },
        uOpacity: { value: settings.opacity },
        uCropMin: { value: settings.cropMin },
        uCropMax: { value: settings.cropMax },
        uStep: { value: 1.1 / Math.max(volume.width, volume.height, volume.depth) },
        uInteractive: { value: 0 },
        uViewMode: { value: settings.viewMode === "light" ? 0 : 1 },
        uVoxel: { value: new THREE.Vector3(1 / volume.width, 1 / volume.height, 1 / volume.depth) },
      },
    })
  }, [texture, volume])

  useEffect(() => () => {
    material?.dispose()
    texture?.dispose()
  }, [material, texture])

  useEffect(() => {
    if (!material) return
    material.uniforms.uDensityLow.value = settings.densityMin
    material.uniforms.uDensityHigh.value = Math.max(settings.densityMin + 10, settings.densityMax)
    material.uniforms.uOpacity.value = settings.opacity
    material.uniforms.uCropMin.value = Math.min(settings.cropMin, settings.cropMax - 0.01)
    material.uniforms.uCropMax.value = Math.max(settings.cropMax, settings.cropMin + 0.01)
    material.uniforms.uInteractive.value = interactive ? 1 : 0
    material.uniforms.uViewMode.value = settings.viewMode === "light" ? 0 : 1
    material.uniforms.uStep.value = (interactive ? 2.5 : 0.9) / Math.max(volume.width, volume.height, volume.depth)
  }, [material, volume, interactive, settings.viewMode, settings.densityMin, settings.densityMax, settings.opacity, settings.cropMin, settings.cropMax])

  if (!volume || !material || settings.visible === false) return null
  const rotation = (settings.rotation || [0, 0, 0]).map((value) => THREE.MathUtils.degToRad(value || 0))
  return (
    <mesh
      position={settings.position || [0, 0, 0]}
      rotation={rotation}
      scale={settings.scale || 1}
      material={material}
      renderOrder={-1000}
    >
      <boxGeometry args={volume.size} />
    </mesh>
  )
}

function sampleDicomTrilinear(volume, tx, ty, tz) {
  const x = Math.max(0, Math.min(volume.width - 1, tx * (volume.width - 1)))
  const y = Math.max(0, Math.min(volume.height - 1, ty * (volume.height - 1)))
  const z = Math.max(0, Math.min(volume.depth - 1, tz * (volume.depth - 1)))
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z)
  const x1 = Math.min(volume.width - 1, x0 + 1)
  const y1 = Math.min(volume.height - 1, y0 + 1)
  const z1 = Math.min(volume.depth - 1, z0 + 1)
  const fx = x - x0, fy = y - y0, fz = z - z0
  const row = volume.width
  const layer = volume.width * volume.height
  const data = volume.data
  const value = (ix, iy, iz) => data[iz * layer + iy * row + ix]
  const c00 = value(x0, y0, z0) * (1 - fx) + value(x1, y0, z0) * fx
  const c10 = value(x0, y1, z0) * (1 - fx) + value(x1, y1, z0) * fx
  const c01 = value(x0, y0, z1) * (1 - fx) + value(x1, y0, z1) * fx
  const c11 = value(x0, y1, z1) * (1 - fx) + value(x1, y1, z1) * fx
  const c0 = c00 * (1 - fy) + c10 * fy
  const c1 = c01 * (1 - fy) + c11 * fy
  return c0 * (1 - fz) + c1 * fz
}

function buildDicomSliceImage(volume, settings, planeMatrixWorld, maxResolution = 224) {
  if (!volume || !planeMatrixWorld || settings.visible === false || typeof document === "undefined") return null

  const position = new THREE.Vector3(...(settings.position || [0, 0, 0]))
  const rotationValues = settings.rotation || [0, 0, 0]
  const rotation = new THREE.Euler(
    THREE.MathUtils.degToRad(rotationValues[0] || 0),
    THREE.MathUtils.degToRad(rotationValues[1] || 0),
    THREE.MathUtils.degToRad(rotationValues[2] || 0)
  )
  const scaleValue = settings.scale || 1
  const dicomMatrix = new THREE.Matrix4().compose(
    position,
    new THREE.Quaternion().setFromEuler(rotation),
    new THREE.Vector3(scaleValue, scaleValue, scaleValue)
  )
  const inversePlane = planeMatrixWorld.clone().invert()
  const planeToDicom = dicomMatrix.clone().invert().multiply(planeMatrixWorld)
  const half = new THREE.Vector3(volume.size[0] / 2, volume.size[1] / 2, volume.size[2] / 2)

  const corners = []
  for (let z = -1; z <= 1; z += 2) {
    for (let y = -1; y <= 1; y += 2) {
      for (let x = -1; x <= 1; x += 2) {
        corners.push(
          new THREE.Vector3(x * half.x, y * half.y, z * half.z)
            .applyMatrix4(dicomMatrix)
            .applyMatrix4(inversePlane)
        )
      }
    }
  }
  const edges = [
    [0, 1], [0, 2], [0, 4], [1, 3], [1, 5], [2, 3],
    [2, 6], [3, 7], [4, 5], [4, 6], [5, 7], [6, 7],
  ]
  const intersections = []
  edges.forEach(([aIndex, bIndex]) => {
    const a = corners[aIndex], b = corners[bIndex]
    if (Math.abs(a.z) < 1e-5) intersections.push(a.clone())
    if (a.z * b.z < 0) {
      const t = a.z / (a.z - b.z)
      intersections.push(a.clone().lerp(b, t))
    }
  })
  if (intersections.length < 3) return null

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  intersections.forEach((point) => {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x)
    minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y)
  })
  const physicalWidth = maxX - minX
  const physicalHeight = maxY - minY
  if (!(physicalWidth > 0.01 && physicalHeight > 0.01)) return null

  const largestSide = Math.max(physicalWidth, physicalHeight)
  const width = Math.max(48, Math.round(maxResolution * physicalWidth / largestSide))
  const height = Math.max(48, Math.round(maxResolution * physicalHeight / largestSide))
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext("2d")
  if (!context) return null
  const image = context.createImageData(width, height)
  const elements = planeToDicom.elements
  const huSpan = DICOM_HU_MAX - DICOM_HU_MIN
  const densitySpan = Math.max(10, settings.densityMax - settings.densityMin)

  for (let py = 0; py < height; py++) {
    const planeY = maxY - ((py + 0.5) / height) * physicalHeight
    for (let px = 0; px < width; px++) {
      const planeX = minX + ((px + 0.5) / width) * physicalWidth
      const localX = elements[0] * planeX + elements[4] * planeY + elements[12]
      const localY = elements[1] * planeX + elements[5] * planeY + elements[13]
      const localZ = elements[2] * planeX + elements[6] * planeY + elements[14]
      const tx = localX / volume.size[0] + 0.5
      const ty = localY / volume.size[1] + 0.5
      const tz = localZ / volume.size[2] + 0.5
      const outputIndex = (py * width + px) * 4
      if (tx < 0 || tx > 1 || ty < 0 || ty > 1 || tz < 0 || tz > 1 || tz < settings.cropMin || tz > settings.cropMax) {
        image.data[outputIndex + 3] = 0
        continue
      }
      const encoded = sampleDicomTrilinear(volume, tx, ty, tz)
      const hu = DICOM_HU_MIN + (encoded / 255) * huSpan
      const normalized = clamp01((hu - settings.densityMin) / densitySpan)
      const gray = Math.round(Math.pow(normalized, 0.72) * 255)
      image.data[outputIndex] = gray
      image.data[outputIndex + 1] = gray
      image.data[outputIndex + 2] = gray
      image.data[outputIndex + 3] = 255
    }
  }
  context.putImageData(image, 0, 0)

  // Pravá 2D okna používají původní neprůhledný snímek. Samostatná kopie
  // pro roviny ve 3D scéně zprůhlední pouze pixely s přesnou hodnotou #000000.
  const sceneCanvas = document.createElement("canvas")
  sceneCanvas.width = width
  sceneCanvas.height = height
  const sceneContext = sceneCanvas.getContext("2d")
  if (sceneContext) {
    const sceneImage = sceneContext.createImageData(width, height)
    sceneImage.data.set(image.data)
    for (let i = 0; i < sceneImage.data.length; i += 4) {
      if (sceneImage.data[i] === 0 && sceneImage.data[i + 1] === 0 && sceneImage.data[i + 2] === 0 && sceneImage.data[i + 3] > 0) {
        sceneImage.data[i + 3] = 0
      }
    }
    sceneContext.putImageData(sceneImage, 0, 0)
  }
  return {
    canvas,
    sceneCanvas: sceneContext ? sceneCanvas : canvas,
    url: canvas.toDataURL("image/png"),
    bounds: { minX, minY, width: physicalWidth, height: physicalHeight },
  }
}

function DicomSlicePlane3D({ slice }) {
  const texture = useMemo(() => {
    const textureCanvas = slice?.sceneCanvas || slice?.canvas
    if (!textureCanvas) return null
    const value = new THREE.CanvasTexture(textureCanvas)
    value.colorSpace = THREE.SRGBColorSpace
    value.minFilter = THREE.LinearFilter
    value.magFilter = THREE.LinearFilter
    value.needsUpdate = true
    return value
  }, [slice])
  useEffect(() => () => texture?.dispose(), [texture])
  if (!slice || !texture) return null
  const { bounds } = slice
  return (
    <mesh
      position={[bounds.minX + bounds.width / 2, bounds.minY + bounds.height / 2, 0.015]}
      renderOrder={997}
    >
      <planeGeometry args={[bounds.width, bounds.height]} />
      <meshBasicMaterial
        map={texture}
        side={THREE.DoubleSide}
        transparent
        opacity={0.9}
        depthTest={true}
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  )
}

function configureMaterialTransparency(material, opacity) {
  if (!material) return
  const translucent = opacity < 0.999
  material.opacity = opacity
  material.depthTest = true
  material.side = THREE.DoubleSide

  // Plynulé alpha blending bez bodového rastru. Stabilitu mezi modely drží renderOrder.
  if ("alphaHash" in material) material.alphaHash = false
  material.transparent = translucent
  material.depthWrite = !translucent
  material.blending = THREE.NormalBlending
  if ("premultipliedAlpha" in material) material.premultipliedAlpha = false
  if ("forceSinglePass" in material) material.forceSinglePass = false
}

const GHOST_VERTEX_SHADER = `
  varying vec3 vGhostNormalView;
  varying vec3 vGhostViewDir;

  #ifdef USE_COLOR
    varying vec3 vGhostVertexColor;
  #endif

  #ifdef USE_GHOST_MAP
    varying vec2 vGhostUv;
    uniform mat3 uGhostMapTransform;
  #endif

  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vGhostNormalView = normalize(normalMatrix * normal);
    vGhostViewDir = normalize(-mvPosition.xyz);

    #ifdef USE_COLOR
      vGhostVertexColor = color;
    #endif

    #ifdef USE_GHOST_MAP
      vGhostUv = (uGhostMapTransform * vec3(uv, 1.0)).xy;
    #endif

    gl_Position = projectionMatrix * mvPosition;
  }
`

const GHOST_FRAGMENT_SHADER = `
  uniform vec3 uGhostBase;
  uniform float uGhostStrength;

  #ifdef USE_GHOST_MAP
    uniform sampler2D uGhostMap;
    varying vec2 vGhostUv;
  #endif

  #ifdef USE_COLOR
    varying vec3 vGhostVertexColor;
  #endif

  varying vec3 vGhostNormalView;
  varying vec3 vGhostViewDir;

  void main() {
    vec3 N = normalize(vGhostNormalView);
    vec3 V = normalize(vGhostViewDir);
    float facing = abs(dot(N, V));
    float fresnel = pow(clamp(1.0 - facing, 0.0, 1.0), 1.45);
    float rim = smoothstep(0.05, 0.92, fresnel);

    // Ghost respektuje skutečný vzhled modelu. Když je TEX aktivní,
    // použijeme vertex colors / mapu; jinak vycházíme z color pickeru.
    vec3 sourceColor = uGhostBase;

    #ifdef USE_GHOST_TEXTURE_DATA
      sourceColor = vec3(1.0);

      #ifdef USE_GHOST_MAP
        sourceColor *= texture2D(uGhostMap, vGhostUv).rgb;
      #endif

      #ifdef USE_COLOR
        sourceColor *= vGhostVertexColor;
      #endif
    #endif

    sourceColor = clamp(sourceColor, 0.0, 1.0);

    // Fill je velmi světlý a jemně tónovaný, rim nese většinu původní
    // barvy/textury. Díky tomu zůstává shell čistý a přitom identifikovatelný.
    vec3 fillColor = mix(vec3(1.0), sourceColor, 0.30);
    vec3 rimColor = mix(vec3(0.93), sourceColor, 0.84);

    // Backfaces jsou o něco výraznější, aby zůstal čitelný vnitřní tvar.
    float backBoost = gl_FrontFacing ? 0.0 : 0.12;
    vec3 ghostColor = mix(fillColor, rimColor, clamp(rim + backBoost, 0.0, 1.0));
    float alpha = (0.065 + 0.54 * pow(fresnel, 0.72) + backBoost * 0.16) * uGhostStrength;
    alpha = clamp(alpha, 0.0, 0.74);

    gl_FragColor = vec4(ghostColor, alpha);
  }
`

function ghostMaterialList(material) {
  return Array.isArray(material) ? material.filter(Boolean) : (material ? [material] : [])
}

function disposeGhostMaterial(material) {
  ghostMaterialList(material).forEach((item) => {
    if (item?.userData?._artheticGhost) item.dispose?.()
  })
}

function getGhostSourceMap(sourceMaterial, useTextureData) {
  if (!useTextureData || !sourceMaterial || Array.isArray(sourceMaterial)) return null
  const map = sourceMaterial.map || null
  if (map?.updateMatrix) map.updateMatrix()
  return map
}

function makeGhostSingleMaterial(sourceMaterial, {
  opacity = 1,
  baseColor = '#ffffff',
  useTextureData = false,
  hasVertexColors = false,
  forceVertexColors = false,
} = {}) {
  const sourceMap = getGhostSourceMap(sourceMaterial, useTextureData && !forceVertexColors)
  const useMap = !!sourceMap
  // Analysis heatmapa používá stejný geometry color atribut jako běžné vertex colors,
  // ale musí fungovat i když uživatel nemá zapnuté TEX. forceVertexColors ji proto
  // dovolí použít samostatně a současně potlačí původní texture mapu materiálu.
  const useColors = !!hasVertexColors && (!!useTextureData || !!forceVertexColors)
  const useVisualData = useMap || useColors

  const defines = {}
  if (useVisualData) defines.USE_GHOST_TEXTURE_DATA = 1
  if (useMap) defines.USE_GHOST_MAP = 1

  const material = new THREE.ShaderMaterial({
    defines,
    uniforms: {
      uGhostBase: { value: new THREE.Color(baseColor || '#ffffff') },
      uGhostStrength: { value: clamp01(opacity) },
      uGhostMap: { value: sourceMap },
      uGhostMapTransform: { value: sourceMap?.matrix?.clone?.() || new THREE.Matrix3() },
    },
    vertexShader: GHOST_VERTEX_SHADER,
    fragmentShader: GHOST_FRAGMENT_SHADER,
    vertexColors: useColors,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
    toneMapped: false,
  })

  material.userData._artheticGhost = true
  material.userData._ghostVariant = `${useMap ? 1 : 0}:${useColors ? 1 : 0}`
  material.userData._ghostMapUuid = sourceMap?.uuid || ''
  if ('forceSinglePass' in material) material.forceSinglePass = false
  return material
}

function makeGhostMaterial(sourceMaterial, options = {}) {
  if (Array.isArray(sourceMaterial)) {
    return sourceMaterial.map((material) => makeGhostSingleMaterial(material, options))
  }
  return makeGhostSingleMaterial(sourceMaterial, options)
}

function isGhostMaterial(material) {
  const materials = ghostMaterialList(material)
  return materials.length > 0 && materials.every((item) => !!item?.userData?._artheticGhost)
}

function updateGhostMaterial(material, sourceMaterial, {
  opacity = 1,
  baseColor = '#ffffff',
  useTextureData = false,
  hasVertexColors = false,
  forceVertexColors = false,
} = {}) {
  const ghosts = ghostMaterialList(material)
  const sources = Array.isArray(sourceMaterial) ? sourceMaterial.filter(Boolean) : (sourceMaterial ? [sourceMaterial] : [])
  if (!ghosts.length || ghosts.length !== sources.length) return false

  for (let i = 0; i < ghosts.length; i += 1) {
    const ghostMaterial = ghosts[i]
    const source = sources[i]
    const sourceMap = getGhostSourceMap(source, useTextureData && !forceVertexColors)
    const useMap = !!sourceMap
    const useColors = !!hasVertexColors && (!!useTextureData || !!forceVertexColors)
    const expectedVariant = `${useMap ? 1 : 0}:${useColors ? 1 : 0}`

    if (
      ghostMaterial.userData?._ghostVariant !== expectedVariant ||
      (ghostMaterial.userData?._ghostMapUuid || '') !== (sourceMap?.uuid || '')
    ) {
      return false
    }
  }

  for (let i = 0; i < ghosts.length; i += 1) {
    const ghostMaterial = ghosts[i]
    const source = sources[i]
    const sourceMap = getGhostSourceMap(source, useTextureData && !forceVertexColors)

    ghostMaterial.uniforms?.uGhostBase?.value?.set?.(baseColor || '#ffffff')
    if (ghostMaterial.uniforms?.uGhostStrength) ghostMaterial.uniforms.uGhostStrength.value = clamp01(opacity)
    if (ghostMaterial.uniforms?.uGhostMap) ghostMaterial.uniforms.uGhostMap.value = sourceMap
    if (ghostMaterial.uniforms?.uGhostMapTransform && sourceMap?.matrix) {
      ghostMaterial.uniforms.uGhostMapTransform.value.copy(sourceMap.matrix)
    }
  }

  return true
}

function faceNormalLocal(geometry, faceIndex, target, a, b, c) {
  if (!Number.isFinite(faceIndex) || faceIndex < 0) return target.set(0, 0, 1)
  const pos = geometry.attributes.position
  const index = geometry.index
  const offset = faceIndex * 3
  const ia = index ? index.getX(offset) : offset
  const ib = index ? index.getX(offset + 1) : offset + 1
  const ic = index ? index.getX(offset + 2) : offset + 2
  a.fromBufferAttribute(pos, ia)
  b.fromBufferAttribute(pos, ib)
  c.fromBufferAttribute(pos, ic)
  return target.subVectors(b, a).cross(c.sub(a)).normalize()
}

function makeClosestSurfaceSampler(targetMesh) {
  targetMesh.updateMatrixWorld(true)
  if (!targetMesh.geometry.boundsTree) targetMesh.geometry.computeBoundsTree()

  const inverseTarget = new THREE.Matrix4().copy(targetMesh.matrixWorld).invert()
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(targetMesh.matrixWorld)
  const localPoint = new THREE.Vector3()
  const closestWorld = new THREE.Vector3()
  const deltaWorld = new THREE.Vector3()
  const normalWorld = new THREE.Vector3()
  const triangleA = new THREE.Vector3()
  const triangleB = new THREE.Vector3()
  const triangleC = new THREE.Vector3()
  const result = { point: new THREE.Vector3(), distance: Infinity, faceIndex: -1 }
  const sampleResult = { distance: 0, signedDistance: 0 }

  return (worldPoint) => {
    localPoint.copy(worldPoint).applyMatrix4(inverseTarget)
    result.distance = Infinity
    result.faceIndex = -1
    targetMesh.geometry.boundsTree.closestPointToPoint(localPoint, result)
    closestWorld.copy(result.point).applyMatrix4(targetMesh.matrixWorld)
    deltaWorld.subVectors(worldPoint, closestWorld)
    faceNormalLocal(targetMesh.geometry, result.faceIndex, normalWorld, triangleA, triangleB, triangleC)
      .applyMatrix3(normalMatrix)
      .normalize()
    const distance = deltaWorld.length()
    const sign = deltaWorld.dot(normalWorld) < 0 ? -1 : 1
    sampleResult.distance = distance
    sampleResult.signedDistance = distance * sign
    return sampleResult
  }
}

function writeColor(target, index, color) {
  target[index * 3] = color.r
  target[index * 3 + 1] = color.g
  target[index * 3 + 2] = color.b
}

const OCCLUSION_COLORS = ["#7e22ce", "#ef4444", "#facc15", "#22c55e", "#ffffff"].map((value) => new THREE.Color(value))
const COMPARISON_COLORS = ["#2563eb", "#22c55e", "#facc15", "#ef4444", "#a21caf"].map((value) => new THREE.Color(value))

function occlusionColor(distance, maxDist, target) {
  const [deep, penetration, contact, clearance, far] = OCCLUSION_COLORS
  if (distance < -1) return target.copy(deep)
  if (distance < 0) return target.lerpColors(deep, penetration, distance + 1)
  if (distance < 0.25) return target.lerpColors(penetration, contact, distance / 0.25)
  if (distance < 1) return target.lerpColors(contact, clearance, (distance - 0.25) / 0.75)
  if (distance < maxDist) return target.lerpColors(clearance, far, (distance - 1) / Math.max(0.001, maxDist - 1))
  return target.copy(far)
}

export function applyOcclusionHeatmap(meshA, meshB, maxDist = 2.0, invertSign = false) {
  meshA.updateMatrixWorld(true)
  rememberOriginalColors(meshA)
  const posA = meshA.geometry.attributes.position
  const colors = new Float32Array(posA.count * 3)
  const distances = new Float32Array(posA.count)
  const sourceWorld = new THREE.Vector3()
  const color = new THREE.Color()
  const sample = makeClosestSurfaceSampler(meshB)

  for (let i = 0; i < posA.count; i++) {
    sourceWorld.fromBufferAttribute(posA, i).applyMatrix4(meshA.matrixWorld)
    const hit = sample(sourceWorld)
    const signedDistance = hit.signedDistance * (invertSign ? -1 : 1)
    distances[i] = signedDistance
    writeColor(colors, i, occlusionColor(signedDistance, maxDist, color))
  }

  meshA.userData._occlusionColors = new THREE.BufferAttribute(colors, 3)
  meshA.userData._occlusionDistances = new THREE.BufferAttribute(distances, 1)
}

function comparisonColor(distance, tolerance, target) {
  const [excellent, within, warning, mismatch, severe] = COMPARISON_COLORS
  if (distance <= tolerance) return target.lerpColors(excellent, within, distance / tolerance)
  if (distance <= tolerance * 2) return target.lerpColors(within, warning, (distance - tolerance) / tolerance)
  if (distance <= tolerance * 4) return target.lerpColors(warning, mismatch, (distance - tolerance * 2) / (tolerance * 2))
  return target.lerpColors(mismatch, severe, Math.min(1, (distance - tolerance * 4) / (tolerance * 4)))
}

function applyComparisonPass(sourceMesh, targetMesh, tolerance) {
  sourceMesh.updateMatrixWorld(true)
  rememberOriginalColors(sourceMesh)
  const positions = sourceMesh.geometry.attributes.position
  const colors = new Float32Array(positions.count * 3)
  const distances = new Float32Array(positions.count)
  const values = []
  const sourceWorld = new THREE.Vector3()
  const color = new THREE.Color()
  const sample = makeClosestSurfaceSampler(targetMesh)
  const stride = Math.max(1, Math.ceil(positions.count / 100000))
  let sum = 0, sumSq = 0, max = 0, within = 0

  for (let i = 0; i < positions.count; i++) {
    sourceWorld.fromBufferAttribute(positions, i).applyMatrix4(sourceMesh.matrixWorld)
    const distance = sample(sourceWorld).distance
    distances[i] = distance
    sum += distance
    sumSq += distance * distance
    max = Math.max(max, distance)
    if (distance <= tolerance) within++
    if (i % stride === 0) values.push(distance)
    writeColor(colors, i, comparisonColor(distance, tolerance, color))
  }

  sourceMesh.userData._comparisonColors = new THREE.BufferAttribute(colors, 3)
  sourceMesh.userData._comparisonDistances = new THREE.BufferAttribute(distances, 1)
  return { count: positions.count, sum, sumSq, max, within, values }
}

export function applySurfaceComparison(meshA, meshB, tolerance = 0.25) {
  const aToB = applyComparisonPass(meshA, meshB, tolerance)
  const bToA = applyComparisonPass(meshB, meshA, tolerance)
  const count = aToB.count + bToA.count
  const values = [...aToB.values, ...bToA.values].sort((a, b) => a - b)
  const percentile95 = values.length ? values[Math.min(values.length - 1, Math.floor(values.length * 0.95))] : 0
  return {
    mean: (aToB.sum + bToA.sum) / Math.max(1, count),
    rms: Math.sqrt((aToB.sumSq + bToA.sumSq) / Math.max(1, count)),
    percentile95,
    max: Math.max(aToB.max, bToA.max),
    withinTolerance: ((aToB.within + bToA.within) / Math.max(1, count)) * 100,
    samples: count,
  }
}


/* ---------- Zarovnání modelů / metrologie ---------- */
const ALIGNMENT_POINT_COLORS = ["#fbbf24", "#ef4444", "#22c55e"]
const IDENTITY_MATRIX_ARRAY = new THREE.Matrix4().identity().toArray()
const USE_ALIGNMENT_WORKER = true

// Stejné nastavení používá i legacy fallback, aby měl při případném selhání Workeru
// stejnou exact-surface matematiku a podobný výkon jako hlavní Best Fit engine.
const ALIGNMENT_BVH_OPTIONS = { strategy: SAH, maxLeafTris: 8 }

function copyPositionAttributeForWorker(attribute) {
  if (!attribute?.count) return null
  const output = new Float32Array(attribute.count * 3)

  if (!attribute.isInterleavedBufferAttribute && attribute.itemSize === 3 && attribute.array) {
    const source = attribute.array
    const usable = Math.min(output.length, source.length)
    if (typeof source.subarray === "function") output.set(source.subarray(0, usable))
    else {
      for (let i = 0; i < usable; i++) output[i] = source[i]
    }
    return output
  }

  for (let i = 0; i < attribute.count; i++) {
    output[i * 3] = attribute.getX(i)
    output[i * 3 + 1] = attribute.getY(i)
    output[i * 3 + 2] = attribute.getZ(i)
  }
  return output
}

function copyIndexAttributeForWorker(attribute) {
  if (!attribute?.count) return null
  const output = new Uint32Array(attribute.count)

  if (!attribute.isInterleavedBufferAttribute && attribute.itemSize === 1 && attribute.array) {
    const source = attribute.array
    for (let i = 0; i < output.length; i++) output[i] = source[i]
    return output
  }

  for (let i = 0; i < attribute.count; i++) output[i] = attribute.getX(i)
  return output
}

function objectLocalMatrixArray(object) {
  if (object?.matrix?.elements?.length === 16) return object.matrix.toArray()
  return IDENTITY_MATRIX_ARRAY.slice()
}

function objectParentWorldMatrixArray(object) {
  if (object?.parent?.matrixWorld?.elements?.length === 16) return object.parent.matrixWorld.toArray()
  return IDENTITY_MATRIX_ARRAY.slice()
}

function meshRelativeToRootMatrixArray(root, mesh) {
  const inverseRoot = new THREE.Matrix4().copy(root.matrixWorld).invert()
  return new THREE.Matrix4().multiplyMatrices(inverseRoot, mesh.matrixWorld).toArray()
}

function buildAlignmentWorkerPayload({
  sourceMesh,
  sourceRoot,
  targetMesh,
  targetRoot,
  initialMatrix,
  landmarkSeeded,
}) {
  sourceRoot.parent?.updateMatrixWorld?.(true)
  targetRoot.parent?.updateMatrixWorld?.(true)
  sourceRoot.updateMatrixWorld(true)
  targetRoot.updateMatrixWorld(true)
  sourceMesh.updateMatrixWorld(true)
  targetMesh.updateMatrixWorld(true)

  const sourcePosition = sourceMesh.geometry?.getAttribute?.("position")
  const targetPosition = targetMesh.geometry?.getAttribute?.("position")
  if (!sourcePosition?.count || !targetPosition?.count) throw new Error("Vybrané modely nemají použitelnou geometrii pro Best Fit.")

  const sourcePositions = copyPositionAttributeForWorker(sourcePosition)
  const targetPositions = copyPositionAttributeForWorker(targetPosition)
  const targetIndex = copyIndexAttributeForWorker(targetMesh.geometry?.index)

  const targetBox = new THREE.Box3().setFromObject(targetRoot)
  const targetDiagonal = Math.max(1, targetBox.getSize(new THREE.Vector3()).length())

  const payload = {
    source: {
      positions: sourcePositions,
      parentWorld: objectParentWorldMatrixArray(sourceRoot),
      rootLocal: objectLocalMatrixArray(sourceRoot),
      meshLocal: meshRelativeToRootMatrixArray(sourceRoot, sourceMesh),
    },
    target: {
      positions: targetPositions,
      index: targetIndex,
      parentWorld: objectParentWorldMatrixArray(targetRoot),
      rootLocal: objectLocalMatrixArray(targetRoot),
      meshLocal: meshRelativeToRootMatrixArray(targetRoot, targetMesh),
    },
    initialMatrix: matrixArrayOrIdentity(initialMatrix).slice(),
    targetDiagonal,
    landmarkSeeded: !!landmarkSeeded,
  }

  const transferables = [sourcePositions.buffer, targetPositions.buffer]
  if (targetIndex) transferables.push(targetIndex.buffer)

  return { payload, transferables }
}

function buildSurfaceAnalysisWorkerPayload(meshA, meshB, extra = {}) {
  meshA?.updateMatrixWorld?.(true)
  meshB?.updateMatrixWorld?.(true)

  const positionA = meshA?.geometry?.getAttribute?.("position")
  const positionB = meshB?.geometry?.getAttribute?.("position")
  if (!positionA?.count || !positionB?.count) throw new Error("Vybrané modely nemají použitelnou geometrii pro analýzu.")

  const positionsA = copyPositionAttributeForWorker(positionA)
  const positionsB = copyPositionAttributeForWorker(positionB)
  const indexA = copyIndexAttributeForWorker(meshA.geometry?.index)
  const indexB = copyIndexAttributeForWorker(meshB.geometry?.index)

  const payload = {
    a: {
      positions: positionsA,
      index: indexA,
      matrixWorld: meshA.matrixWorld.toArray(),
    },
    b: {
      positions: positionsB,
      index: indexB,
      matrixWorld: meshB.matrixWorld.toArray(),
    },
    ...extra,
  }

  const transferables = [positionsA.buffer, positionsB.buffer]
  if (indexA) transferables.push(indexA.buffer)
  if (indexB) transferables.push(indexB.buffer)
  return { payload, transferables }
}

function installWorkerOcclusionResult(mesh, result) {
  if (!mesh || !result?.colors || !result?.distances) throw new Error("Worker nevrátil platnou mapu okluze.")
  rememberOriginalColors(mesh)
  mesh.userData._occlusionColors = new THREE.BufferAttribute(result.colors, 3)
  mesh.userData._occlusionDistances = new THREE.BufferAttribute(result.distances, 1)
}

function installWorkerComparisonResult(meshA, meshB, result) {
  if (!meshA || !meshB || !result?.a?.colors || !result?.a?.distances || !result?.b?.colors || !result?.b?.distances) {
    throw new Error("Worker nevrátil platná data porovnání povrchů.")
  }
  rememberOriginalColors(meshA)
  rememberOriginalColors(meshB)
  meshA.userData._comparisonColors = new THREE.BufferAttribute(result.a.colors, 3)
  meshA.userData._comparisonDistances = new THREE.BufferAttribute(result.a.distances, 1)
  meshB.userData._comparisonColors = new THREE.BufferAttribute(result.b.colors, 3)
  meshB.userData._comparisonDistances = new THREE.BufferAttribute(result.b.distances, 1)
  return result.stats || null
}

function matrixArrayOrIdentity(value) {
  return Array.isArray(value) && value.length === 16 ? value : IDENTITY_MATRIX_ARRAY
}

function matrixArraysAlmostEqual(a, b, epsilon = 1e-5) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 16 || b.length !== 16) return false
  for (let i = 0; i < 16; i++) {
    if (Math.abs((Number(a[i]) || 0) - (Number(b[i]) || 0)) > epsilon) return false
  }
  return true
}

function largestEigenvectorSymmetric4(values) {
  // Jacobiho diagonalizace 4x4 symetrické matice. Hornova registration potřebuje
  // vlastní vektor NEJVĚTŠÍ ALGEBRAICKÉ vlastní hodnoty. Obyčejná power iteration
  // zde není bezpečná: Hornova N matice často obsahuje ±lambda se stejnou absolutní
  // velikostí a power iteration pak může skončit u nesprávného quaternionu.
  const a = Array.from({ length: 4 }, (_, r) =>
    Array.from({ length: 4 }, (_, c) => Number(values[r * 4 + c]) || 0)
  )
  const v = Array.from({ length: 4 }, (_, r) =>
    Array.from({ length: 4 }, (_, c) => (r === c ? 1 : 0))
  )

  for (let sweep = 0; sweep < 64; sweep++) {
    let p = 0, q = 1, largest = 0
    for (let r = 0; r < 4; r++) {
      for (let c = r + 1; c < 4; c++) {
        const magnitude = Math.abs(a[r][c])
        if (magnitude > largest) { largest = magnitude; p = r; q = c }
      }
    }
    if (largest < 1e-12) break

    const app = a[p][p]
    const aqq = a[q][q]
    const apq = a[p][q]
    const angle = 0.5 * Math.atan2(2 * apq, aqq - app)
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)

    for (let k = 0; k < 4; k++) {
      if (k === p || k === q) continue
      const akp = a[k][p]
      const akq = a[k][q]
      a[k][p] = a[p][k] = cos * akp - sin * akq
      a[k][q] = a[q][k] = sin * akp + cos * akq
    }

    a[p][p] = cos * cos * app - 2 * sin * cos * apq + sin * sin * aqq
    a[q][q] = sin * sin * app + 2 * sin * cos * apq + cos * cos * aqq
    a[p][q] = a[q][p] = 0

    for (let k = 0; k < 4; k++) {
      const vkp = v[k][p]
      const vkq = v[k][q]
      v[k][p] = cos * vkp - sin * vkq
      v[k][q] = sin * vkp + cos * vkq
    }
  }

  let best = 0
  for (let i = 1; i < 4; i++) if (a[i][i] > a[best][best]) best = i
  const result = [v[0][best], v[1][best], v[2][best], v[3][best]]
  const length = Math.hypot(result[0], result[1], result[2], result[3])
  if (!Number.isFinite(length) || length < 1e-12) return null
  return result.map((value) => value / length)
}

function landmarkConfigurationIsDegenerate(points) {
  if (!points || points.length < 3) return true
  let maxBaselineSq = 0
  let maxArea2 = 0
  const ab = new THREE.Vector3()
  const ac = new THREE.Vector3()
  const cross = new THREE.Vector3()
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      maxBaselineSq = Math.max(maxBaselineSq, points[i].distanceToSquared(points[j]))
      for (let k = j + 1; k < points.length; k++) {
        ab.subVectors(points[j], points[i])
        ac.subVectors(points[k], points[i])
        maxArea2 = Math.max(maxArea2, cross.crossVectors(ab, ac).length())
      }
    }
  }
  if (maxBaselineSq < 1e-10) return true
  // 2*plocha trojúhelníku je |AB x AC|. Povolujeme i poměrně ploché landmarky,
  // ale odmítneme prakticky kolineární konfiguraci, u níž rotace není jednoznačná.
  return maxArea2 < maxBaselineSq * 1e-4
}

function rigidTransformHorn(sourcePoints, targetPoints) {
  const count = Math.min(sourcePoints?.length || 0, targetPoints?.length || 0)
  if (count < 3) return null

  const source = sourcePoints.slice(0, count)
  const target = targetPoints.slice(0, count)
  if (landmarkConfigurationIsDegenerate(source) || landmarkConfigurationIsDegenerate(target)) return null

  const sourceCenter = new THREE.Vector3()
  const targetCenter = new THREE.Vector3()
  for (let i = 0; i < count; i++) {
    sourceCenter.add(source[i])
    targetCenter.add(target[i])
  }
  sourceCenter.multiplyScalar(1 / count)
  targetCenter.multiplyScalar(1 / count)

  let sxx = 0, sxy = 0, sxz = 0
  let syx = 0, syy = 0, syz = 0
  let szx = 0, szy = 0, szz = 0
  for (let i = 0; i < count; i++) {
    const a = source[i].clone().sub(sourceCenter)
    const b = target[i].clone().sub(targetCenter)
    sxx += a.x * b.x; sxy += a.x * b.y; sxz += a.x * b.z
    syx += a.y * b.x; syy += a.y * b.y; syz += a.y * b.z
    szx += a.z * b.x; szy += a.z * b.y; szz += a.z * b.z
  }

  const trace = sxx + syy + szz
  const N = [
    trace,        syz - szy,    szx - sxz,     sxy - syx,
    syz - szy,    sxx-syy-szz,  sxy+syx,       szx+sxz,
    szx - sxz,    sxy+syx,     -sxx+syy-szz,   syz+szy,
    sxy - syx,    szx+sxz,      syz+szy,       -sxx-syy+szz,
  ]

  const q = largestEigenvectorSymmetric4(N)
  if (!q) return null

  // Hornův vektor je [w, x, y, z].
  const rotation = new THREE.Quaternion(q[1], q[2], q[3], q[0]).normalize()
  const rotatedSourceCenter = sourceCenter.clone().applyQuaternion(rotation)
  const translation = targetCenter.clone().sub(rotatedSourceCenter)
  return new THREE.Matrix4().compose(translation, rotation, new THREE.Vector3(1, 1, 1))
}

function landmarkFitRms(sourcePoints, targetPoints, matrix) {
  const count = Math.min(sourcePoints?.length || 0, targetPoints?.length || 0)
  if (!count || !matrix) return Infinity
  const point = new THREE.Vector3()
  let sumSq = 0
  for (let i = 0; i < count; i++) {
    point.copy(sourcePoints[i]).applyMatrix4(matrix)
    sumSq += point.distanceToSquared(targetPoints[i])
  }
  return Math.sqrt(sumSq / count)
}

function solveLinearSystem6(matrix, rhs) {
  const n = 6
  const a = Array.from({ length: n }, (_, r) => {
    const row = new Array(n + 1)
    for (let c = 0; c < n; c++) row[c] = matrix[r * n + c]
    row[n] = rhs[r]
    return row
  })

  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r
    if (Math.abs(a[pivot][col]) < 1e-12) return null
    if (pivot !== col) [a[pivot], a[col]] = [a[col], a[pivot]]
    const div = a[col][col]
    for (let c = col; c <= n; c++) a[col][c] /= div
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const factor = a[r][col]
      if (Math.abs(factor) < 1e-18) continue
      for (let c = col; c <= n; c++) a[r][c] -= factor * a[col][c]
    }
  }
  return a.map((row) => row[n])
}

function ensureAlignmentBoundsTree(geometry) {
  if (!geometry?.boundsTree) geometry?.computeBoundsTree?.(ALIGNMENT_BVH_OPTIONS)
  return geometry?.boundsTree || null
}

function makeClosestSurfaceQuery(targetMesh) {
  targetMesh.updateMatrixWorld(true)
  const boundsTree = ensureAlignmentBoundsTree(targetMesh.geometry)
  if (!boundsTree) throw new Error("Nepodařilo se připravit BVH pro Best Fit.")

  const inverseTarget = new THREE.Matrix4().copy(targetMesh.matrixWorld).invert()
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(targetMesh.matrixWorld)
  const targetScale = new THREE.Vector3()
  targetMesh.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), targetScale)
  const minWorldScale = Math.max(1e-8, Math.min(Math.abs(targetScale.x), Math.abs(targetScale.y), Math.abs(targetScale.z)))

  const localPoint = new THREE.Vector3()
  const closestWorld = new THREE.Vector3()
  const deltaWorld = new THREE.Vector3()
  const normalWorld = new THREE.Vector3()
  const triangleA = new THREE.Vector3(), triangleB = new THREE.Vector3(), triangleC = new THREE.Vector3()
  const result = { point: new THREE.Vector3(), distance: Infinity, faceIndex: -1 }
  const output = { pointWorld: new THREE.Vector3(), normalWorld: new THREE.Vector3(), distance: Infinity, faceIndex: -1 }

  return (worldPoint, maxWorldDistance = Infinity, needNormal = true) => {
    localPoint.copy(worldPoint).applyMatrix4(inverseTarget)
    result.distance = Infinity
    result.faceIndex = -1

    // three-mesh-bvh umí maxThreshold přímo uvnitř nearest-surface search. Dříve jsme
    // vždy hledali absolutně nejbližší trojúhelník na celém modelu a teprve potom
    // výsledek zahodili, pokud byl dál než maxDistance. Tohle dovolí BVH celé vzdálené
    // větve přeskočit bez jakékoli změny accepted correspondence.
    const localMaxDistance = Number.isFinite(maxWorldDistance)
      ? Math.max(0, maxWorldDistance) / minWorldScale
      : Infinity
    const hit = boundsTree.closestPointToPoint(localPoint, result, 0, localMaxDistance)
    if (!hit) return null

    closestWorld.copy(result.point).applyMatrix4(targetMesh.matrixWorld)
    output.pointWorld.copy(closestWorld)
    output.distance = deltaWorld.subVectors(worldPoint, closestWorld).length()
    output.faceIndex = result.faceIndex

    // Normála je drahá a point-to-point + validační průchody ji vůbec nepotřebují.
    if (needNormal) {
      faceNormalLocal(targetMesh.geometry, result.faceIndex, normalWorld, triangleA, triangleB, triangleC)
        .applyMatrix3(normalMatrix)
        .normalize()
      output.normalWorld.copy(normalWorld)
    } else {
      output.normalWorld.set(0, 0, 0)
    }

    return output
  }
}

function sampledVertexIndices(positionCount, desiredCount) {
  if (!positionCount) return []
  const count = Math.min(positionCount, Math.max(100, desiredCount || positionCount))
  const step = positionCount / count
  const result = new Array(count)
  for (let i = 0; i < count; i++) result[i] = Math.min(positionCount - 1, Math.floor((i + 0.37) * step))
  return result
}

const ALIGNMENT_CPU_SLICE_MS = 8

async function alignmentYield() {
  // Skutečný nový macrotask dá browseru prostor pro React paint, pointer eventy
  // a hlavně přípravu A/B preview oken bez zamrznutí UI.
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function alignmentPaintYield() {
  // Garantuje alespoň jeden paint před těžší synchronní částí výpočtu.
  if (typeof requestAnimationFrame !== "function") {
    await alignmentYield()
    return
  }
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
}

function alignmentCellHash(value) {
  let x = value | 0
  x ^= x >>> 16
  x = Math.imul(x, 0x7feb352d)
  x ^= x >>> 15
  x = Math.imul(x, 0x846ca68b)
  x ^= x >>> 16
  return x >>> 0
}

// Vytvoří jeden prostorově rovnoměrný master sample. STL často obsahuje stejné
// vrcholy opakovaně pro každý trojúhelník; voxelový výběr tak automaticky neplýtvá
// sample budgetem na stejné místo a současně lépe pokryje celý dentální povrch.
function buildSpatialSamplePool(positionAttribute, matrixToRoot, desiredCount) {
  if (!positionAttribute?.count || desiredCount <= 0) return []

  const total = positionAttribute.count
  const point = new THREE.Vector3()
  const min = new THREE.Vector3(Infinity, Infinity, Infinity)
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity)

  for (let i = 0; i < total; i++) {
    point.fromBufferAttribute(positionAttribute, i).applyMatrix4(matrixToRoot)
    min.min(point)
    max.max(point)
  }

  const size = max.clone().sub(min)
  const safeX = Math.max(size.x, 1e-8)
  const safeY = Math.max(size.y, 1e-8)
  const safeZ = Math.max(size.z, 1e-8)
  const target = Math.min(total, Math.max(100, desiredCount))

  let resolution = Math.max(16, Math.ceil(Math.sqrt(target) * 1.55))
  let selectedEntries = []

  for (let attempt = 0; attempt < 3; attempt++) {
    resolution = Math.min(480, resolution)
    const stride = resolution + 1
    const stride2 = stride * stride
    const cells = new Map()

    for (let i = 0; i < total; i++) {
      point.fromBufferAttribute(positionAttribute, i).applyMatrix4(matrixToRoot)
      const ix = Math.min(resolution, Math.max(0, Math.floor(((point.x - min.x) / safeX) * resolution)))
      const iy = Math.min(resolution, Math.max(0, Math.floor(((point.y - min.y) / safeY) * resolution)))
      const iz = Math.min(resolution, Math.max(0, Math.floor(((point.z - min.z) / safeZ) * resolution)))
      const key = ix + iy * stride + iz * stride2
      if (!cells.has(key)) cells.set(key, i)
    }

    selectedEntries = Array.from(cells.entries())
    if (selectedEntries.length >= target || resolution >= 480) break
    resolution = Math.ceil(resolution * 1.55)
  }

  // Deterministicky promícháme voxel cells, aby případný pořádek trojúhelníků v STL/PLY
  // neovlivňoval, které oblasti se dostanou do menšího coarse sample.
  selectedEntries.sort((a, b) => alignmentCellHash(a[0]) - alignmentCellHash(b[0]))

  const take = Math.min(target, selectedEntries.length)
  const output = new Array(take)
  const step = selectedEntries.length / Math.max(1, take)
  for (let i = 0; i < take; i++) {
    const entryIndex = Math.min(selectedEntries.length - 1, Math.floor((i + 0.37) * step))
    const sourceIndex = selectedEntries[entryIndex][1]
    output[i] = new THREE.Vector3().fromBufferAttribute(positionAttribute, sourceIndex).applyMatrix4(matrixToRoot)
  }
  return output
}

function resampleSpatialPool(pool, desiredCount) {
  if (!pool?.length) return []
  const count = Math.min(pool.length, Math.max(1, desiredCount || pool.length))
  if (count === pool.length) return pool.slice()
  const result = new Array(count)
  const step = pool.length / count
  for (let i = 0; i < count; i++) {
    result[i] = pool[Math.min(pool.length - 1, Math.floor((i + 0.37) * step))]
  }
  return result
}

async function robustPointToPlaneICP({
  sourceMesh,
  sourceRoot,
  targetMesh,
  targetRoot,
  initialMatrix,
  landmarkSeeded = false,
  onProgress,
}) {
  if (!sourceMesh || !sourceRoot || !targetMesh || !targetRoot) throw new Error("Chybí model pro Best Fit.")

  sourceRoot.updateMatrixWorld(true)
  targetRoot.updateMatrixWorld(true)
  sourceMesh.updateMatrixWorld(true)
  targetMesh.updateMatrixWorld(true)

  const sourcePosition = sourceMesh.geometry.getAttribute("position")
  if (!sourcePosition?.count) throw new Error("Moving model nemá použitelnou geometrii.")

  // Geometrii Moving B držíme v lokálním prostoru jeho kořenového objektu.
  // ICP transformaci řešíme v prostoru společného parentu modelů.
  const sourceRootInverse = new THREE.Matrix4().copy(sourceRoot.matrixWorld).invert()
  const meshToRoot = new THREE.Matrix4().multiplyMatrices(sourceRootInverse, sourceMesh.matrixWorld)
  const parentWorld = sourceRoot.parent?.matrixWorld?.clone?.() || new THREE.Matrix4().identity()
  const parentWorldInverse = new THREE.Matrix4().copy(parentWorld).invert()
  const worldNormalToParent = new THREE.Matrix3().setFromMatrix4(parentWorldInverse)

  const query = makeClosestSurfaceQuery(targetMesh)
  const targetBox = new THREE.Box3().setFromObject(targetRoot)
  const targetSize = targetBox.getSize(new THREE.Vector3())
  const diagonal = Math.max(1, targetSize.length())

  // Skutečná aktuální matice objektu — chrání před závodem React state.
  const current = new THREE.Matrix4()
  if (sourceRoot.matrix && sourceRoot.matrix.elements?.length === 16) current.copy(sourceRoot.matrix)
  else current.fromArray(matrixArrayOrIdentity(initialMatrix))
  const initialCurrent = current.clone()

  // Jeden master spatial sample používáme pro centroid, coarse/fine pass i validaci.
  // U triangulovaného STL tak stejné vrcholy nezabírají sample budget opakovaně.
  const spatialSamplePool = buildSpatialSamplePool(sourcePosition, meshToRoot, 7200)
  if (spatialSamplePool.length < 30) throw new Error("Moving model nemá dostatek prostorově rozložených bodů pro Best Fit.")

  // Best Fit po landmark seedu je pouze refinement. Hlídáme drift od seedu.
  const centroidSamples = resampleSpatialPool(spatialSamplePool, 1200)
  const sourceCentroidRoot = new THREE.Vector3()
  for (let i = 0; i < centroidSamples.length; i++) sourceCentroidRoot.add(centroidSamples[i])
  sourceCentroidRoot.multiplyScalar(1 / Math.max(1, centroidSamples.length))
  const initialCentroidParent = sourceCentroidRoot.clone().applyMatrix4(initialCurrent)
  const initialPosition = new THREE.Vector3(), initialQuaternion = new THREE.Quaternion(), initialScale = new THREE.Vector3()
  initialCurrent.decompose(initialPosition, initialQuaternion, initialScale)
  const maxSeedDrift = Math.max(2.5, diagonal * 0.035)
  const maxSeedRotation = THREE.MathUtils.degToRad(7)

  const pParent = new THREE.Vector3()
  const pWorld = new THREE.Vector3()
  const qParent = new THREE.Vector3()
  const nParent = new THREE.Vector3()
  const delta = new THREE.Vector3()
  const cross = new THREE.Vector3()

  // Jednotlivé scale úrovně jsou pouze levné podvýběry z jednoho spatial master poolu.
  const buildSourceSamples = (desiredCount) => resampleSpatialPool(spatialSamplePool, desiredCount)

  const metricsFromCorrespondences = (correspondences) => {
    if (!correspondences || correspondences.length < 30) {
      return { rms: Infinity, mean: Infinity, count: correspondences?.length || 0 }
    }
    let sum = 0, sumSq = 0
    for (let i = 0; i < correspondences.length; i++) {
      const d = correspondences[i].distance
      sum += d
      sumSq += d * d
    }
    return {
      rms: Math.sqrt(sumSq / correspondences.length),
      mean: sum / correspondences.length,
      count: correspondences.length,
    }
  }

  // Nejdražší část Best Fitu. Místo pevného počtu BVH dotazů používáme
  // časové řezy. Na hustém scanu může být 420 dotazů několik sekund práce,
  // zatímco na lehkém modelu jen pár ms. Po ~8 ms CPU proto vždy uvolníme
  // hlavní vlákno a zároveň pošleme skutečný průběh do UI.
  const makeCorrespondences = async (matrix, sourceSamples, maxDistance, trim, progressTick = null, needNormals = false) => {
    const result = []
    let sliceStarted = performance.now()
    let lastProgress = -1
    for (let k = 0; k < sourceSamples.length; k++) {
      const pRoot = sourceSamples[k]
      pParent.copy(pRoot).applyMatrix4(matrix)
      pWorld.copy(pParent).applyMatrix4(parentWorld)
      const hit = query(pWorld, maxDistance, needNormals)
      if (hit && Number.isFinite(hit.distance) && hit.distance <= maxDistance) {
        qParent.copy(hit.pointWorld).applyMatrix4(parentWorldInverse)
        nParent.copy(hit.normalWorld).applyMatrix3(worldNormalToParent).normalize()
        result.push({
          p: pParent.clone(),
          q: qParent.clone(),
          ...(needNormals ? { n: nParent.clone() } : {}),
          distance: pParent.distanceTo(qParent),
        })
      }

      const now = performance.now()
      if (now - sliceStarted >= ALIGNMENT_CPU_SLICE_MS) {
        const fraction = Math.min(1, (k + 1) / Math.max(1, sourceSamples.length))
        // Nezahlcujeme React tisíci prakticky totožnými aktualizacemi.
        if (fraction - lastProgress >= 0.004 || lastProgress < 0) {
          progressTick?.(fraction)
          lastProgress = fraction
        }
        await alignmentYield()
        sliceStarted = performance.now()
      }
    }
    progressTick?.(1)

    result.sort((a, b) => a.distance - b.distance)
    const keepCount = Math.min(result.length, Math.max(30, Math.floor(result.length * trim)))
    if (result.length > keepCount) result.length = keepCount
    return result
  }

  const evaluateMatrix = async (matrix, sourceSamples, maxDistance, trim, progressTick = null) => {
    return metricsFromCorrespondences(await makeCorrespondences(matrix, sourceSamples, maxDistance, trim, progressTick, false))
  }

  const scaleRigidIncrement = (matrix, factor, maxTranslation, maxRotation) => {
    const position = new THREE.Vector3()
    const quaternion = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    matrix.decompose(position, quaternion, scale)
    quaternion.normalize()
    if (quaternion.w < 0) quaternion.set(-quaternion.x, -quaternion.y, -quaternion.z, -quaternion.w)

    let angle = 2 * Math.acos(THREE.MathUtils.clamp(quaternion.w, -1, 1))
    if (!Number.isFinite(angle)) angle = 0
    const rotationFactor = angle > maxRotation && angle > 1e-12 ? maxRotation / angle : 1
    const applied = Math.min(1, factor, rotationFactor)

    const q = new THREE.Quaternion().slerp(quaternion, applied)
    const t = position.multiplyScalar(applied)
    return new THREE.Matrix4().compose(t, q, new THREE.Vector3(1, 1, 1))
  }

  const pointToPlaneIncrement = (correspondences) => {
    const pivot = new THREE.Vector3()
    for (let i = 0; i < correspondences.length; i++) pivot.add(correspondences[i].p)
    pivot.multiplyScalar(1 / Math.max(1, correspondences.length))

    const residualAbs = correspondences
      .map((c) => Math.abs(c.n.dot(delta.subVectors(c.p, c.q))))
      .sort((a, b) => a - b)
    const medianResidual = residualAbs[Math.floor(residualAbs.length / 2)] || 0.01
    const robustScale = Math.max(0.02, medianResidual * 1.4826 * 4.685)

    const normalMatrix = new Float64Array(36)
    const rhs = new Float64Array(6)
    const centered = new THREE.Vector3()
    let used = 0

    for (let i = 0; i < correspondences.length; i++) {
      const c = correspondences[i]
      delta.subVectors(c.p, c.q)
      const residual = c.n.dot(delta)
      const u = Math.abs(residual) / robustScale
      if (u >= 1) continue
      const robustWeight = Math.pow(1 - u * u, 2)
      centered.subVectors(c.p, pivot)
      cross.crossVectors(centered, c.n)
      const J = [cross.x, cross.y, cross.z, c.n.x, c.n.y, c.n.z]
      for (let r = 0; r < 6; r++) {
        rhs[r] += -robustWeight * J[r] * residual
        for (let col = 0; col < 6; col++) normalMatrix[r * 6 + col] += robustWeight * J[r] * J[col]
      }
      used++
    }

    if (used < 20) return null
    for (let d = 0; d < 6; d++) normalMatrix[d * 6 + d] += 1e-7
    const solution = solveLinearSystem6(normalMatrix, rhs)
    if (!solution) return null

    const rotationVector = new THREE.Vector3(solution[0], solution[1], solution[2])
    const rotationAngle = rotationVector.length()
    const quaternion = rotationAngle > 1e-12
      ? new THREE.Quaternion().setFromAxisAngle(rotationVector.clone().normalize(), rotationAngle)
      : new THREE.Quaternion()
    const localTranslation = new THREE.Vector3(solution[3], solution[4], solution[5])

    const rotatedPivot = pivot.clone().applyQuaternion(quaternion)
    const matrixTranslation = pivot.clone().add(localTranslation).sub(rotatedPivot)
    return new THREE.Matrix4().compose(matrixTranslation, quaternion, new THREE.Vector3(1, 1, 1))
  }

  // Rychlé ohodnocení line-search faktoru nad JIŽ nalezenými correspondence.
  // Nevolá BVH. Slouží jen k výběru nejperspektivnějších 1–2 faktorů, které pak
  // jako jediné ověříme plným nearest-surface dotazem.
  const fixedCorrespondenceRms = (increment, correspondences) => {
    if (!correspondences.length) return Infinity
    const point = new THREE.Vector3()
    let sumSq = 0
    for (let i = 0; i < correspondences.length; i++) {
      point.copy(correspondences[i].p).applyMatrix4(increment)
      const d = point.distanceTo(correspondences[i].q)
      sumSq += d * d
    }
    return Math.sqrt(sumSq / correspondences.length)
  }

  // Po kvalitním 3bodovém seedu není potřeba brutálně hustý ICP. Menší počty
  // vzorků + více scale úrovní dávají velmi podobnou přesnost a podstatně nižší čas.
  const stages = [
    { mode: "point", samples: 1600, iterations: 5, maxDistance: Math.max(3.0, diagonal * 0.055), trim: 0.70, maxTranslation: 1.2, maxRotation: THREE.MathUtils.degToRad(5) },
    { mode: "point", samples: 3200, iterations: 6, maxDistance: Math.max(1.5, diagonal * 0.030), trim: 0.80, maxTranslation: 0.65, maxRotation: THREE.MathUtils.degToRad(2.5) },
    { mode: "plane", samples: 6000, iterations: 4, maxDistance: Math.max(0.65, diagonal * 0.014), trim: 0.86, maxTranslation: 0.22, maxRotation: THREE.MathUtils.degToRad(0.8) },
  ]

  const stageSamples = stages.map((stage) => buildSourceSamples(stage.samples))
  const validationSamples = buildSourceSamples(5000)
  const validationMaxDistance = Math.max(4.0, diagonal * 0.065)
  const validationTrim = 0.82

  onProgress?.({ stage: 0, stages: stages.length, iteration: 0, iterations: 1, rms: null, correspondences: 0, mode: "prepare" })
  await alignmentYield()

  const initialValidation = await evaluateMatrix(
    current, validationSamples, validationMaxDistance, validationTrim,
    (fraction) => onProgress?.({ stage: 0, stages: stages.length, iteration: 0, iterations: 1, rms: null, correspondences: 0, mode: "prepare", percent: 3 + fraction * 7 })
  )
  let bestMatrix = current.clone()
  let bestValidationRms = initialValidation.rms
  let finalRms = initialValidation.rms
  let finalCount = initialValidation.count

  const stageRanges = [[10, 34], [34, 62], [62, 88]]

  for (let stageIndex = 0; stageIndex < stages.length; stageIndex++) {
    const stage = stages[stageIndex]
    const samples = stageSamples[stageIndex]
    if (samples.length < 30) continue
    const [stageStartPercent, stageEndPercent] = stageRanges[stageIndex]
    const iterationPercentSpan = (stageEndPercent - stageStartPercent) / Math.max(1, stage.iterations)

    for (let iteration = 0; iteration < stage.iterations; iteration++) {
      const iterationStartPercent = stageStartPercent + iteration * iterationPercentSpan
      const emitStageProgress = (localFraction, extra = {}) => onProgress?.({
        stage: stageIndex + 1,
        stages: stages.length,
        iteration: iteration + Math.min(0.99, Math.max(0, localFraction)),
        iterations: stage.iterations,
        rms: finalRms,
        correspondences: finalCount,
        mode: stage.mode,
        percent: iterationStartPercent + iterationPercentSpan * Math.min(0.98, Math.max(0, localFraction)),
        ...extra,
      })
      // Correspondence hledáme pro current pouze jednou. Jeho RMS spočítáme rovnou
      // ze stejného výsledku — v2.2 zde dělala druhý kompletní BVH průchod.
      const correspondences = await makeCorrespondences(
        current, samples, stage.maxDistance, stage.trim,
        (fraction) => emitStageProgress(fraction * 0.55, { phase: "correspondences" }),
        stage.mode === "plane"
      )
      if (correspondences.length < 30) {
        if (stageIndex === 0 && iteration === 0) throw new Error("Příliš málo překrývající se geometrie pro Best Fit.")
        break
      }
      const currentEval = metricsFromCorrespondences(correspondences)

      let rawIncrement = null
      if (stage.mode === "point") {
        const source = correspondences.map((c) => c.p)
        const target = correspondences.map((c) => c.q)
        rawIncrement = rigidTransformHorn(source, target)
      } else {
        rawIncrement = pointToPlaneIncrement(correspondences)
      }
      if (!rawIncrement) break

      // Nejprve velmi levně seřadíme line-search faktory podle fixed correspondences.
      // Teprve nejlepší kandidáty podrobíme drahému nearest-surface přepočtu.
      const factorCandidates = [1, 0.5, 0.25, 0.125]
        .map((factor) => {
          const increment = scaleRigidIncrement(rawIncrement, factor, stage.maxTranslation, stage.maxRotation)
          return { factor, increment, approxRms: fixedCorrespondenceRms(increment, correspondences) }
        })
        .filter((candidate) => candidate.approxRms + 1e-7 < currentEval.rms)
        .sort((a, b) => a.approxRms - b.approxRms)
        .slice(0, 2)

      if (!factorCandidates.length) break

      let accepted = null
      for (let f = 0; f < factorCandidates.length; f++) {
        const { increment } = factorCandidates[f]
        const candidate = current.clone().premultiply(increment)

        if (landmarkSeeded) {
          const candidateCentroid = sourceCentroidRoot.clone().applyMatrix4(candidate)
          const candidatePosition = new THREE.Vector3(), candidateQuaternion = new THREE.Quaternion(), candidateScale = new THREE.Vector3()
          candidate.decompose(candidatePosition, candidateQuaternion, candidateScale)
          const centroidDrift = candidateCentroid.distanceTo(initialCentroidParent)
          const rotationDrift = initialQuaternion.angleTo(candidateQuaternion)
          if (centroidDrift > maxSeedDrift || rotationDrift > maxSeedRotation) continue
        }

        const candidateCorrespondences = await makeCorrespondences(
          candidate, samples, stage.maxDistance, stage.trim,
          (fraction) => emitStageProgress(0.58 + ((f + fraction) / Math.max(1, factorCandidates.length)) * 0.32, { phase: "verify" }),
          false
        )
        const candidateEval = metricsFromCorrespondences(candidateCorrespondences)
        const enoughPairs = candidateEval.count >= Math.max(30, Math.floor(currentEval.count * 0.65))
        if (enoughPairs && candidateEval.rms + 1e-6 < currentEval.rms) {
          accepted = { matrix: candidate, eval: candidateEval, increment }
          break
        }
      }

      if (!accepted) break
      current.copy(accepted.matrix)
      finalRms = accepted.eval.rms
      finalCount = accepted.eval.count

      const incPosition = new THREE.Vector3()
      const incQuaternion = new THREE.Quaternion()
      const incScale = new THREE.Vector3()
      accepted.increment.decompose(incPosition, incQuaternion, incScale)
      const incAngle = 2 * Math.acos(THREE.MathUtils.clamp(Math.abs(incQuaternion.w), -1, 1))

      onProgress?.({
        stage: stageIndex + 1,
        stages: stages.length,
        iteration: iteration + 1,
        iterations: stage.iterations,
        rms: finalRms,
        correspondences: finalCount,
        mode: stage.mode,
        percent: Math.min(stageEndPercent - 0.5, iterationStartPercent + iterationPercentSpan * 0.96),
      })
      await alignmentYield()

      if (incPosition.length() < 0.0005 && incAngle < 0.00004) break
    }

    // Drahá 5k validační sada se v2.2 počítala po KAŽDÉ iteraci.
    // Pro safety rollback ji stačí provést jednou na konci každého scale passu.
    const validation = await evaluateMatrix(
      current, validationSamples, validationMaxDistance, validationTrim,
      (fraction) => onProgress?.({
        stage: stageIndex + 1, stages: stages.length, iteration: stage.iterations, iterations: stage.iterations,
        rms: finalRms, correspondences: finalCount, mode: stage.mode, phase: "validation",
        percent: (stageEndPercent - 1.6) + fraction * 1.6,
      })
    )
    if (validation.count >= 30 && validation.rms < bestValidationRms) {
      bestValidationRms = validation.rms
      bestMatrix.copy(current)
    }
    await alignmentYield()
  }

  // Finální safety check. Best Fit nikdy nesmí být horší než landmark seed.
  const finalValidation = await evaluateMatrix(
    bestMatrix, validationSamples, validationMaxDistance, validationTrim,
    (fraction) => onProgress?.({ stage: 4, stages: 4, iteration: 1, iterations: 1, rms: finalRms, correspondences: finalCount, mode: "validation", percent: 88 + fraction * 6 })
  )
  if (finalValidation.count >= 30 && finalValidation.rms < bestValidationRms) bestValidationRms = finalValidation.rms

  const improved = Number.isFinite(bestValidationRms) && (
    !Number.isFinite(initialValidation.rms) || bestValidationRms + 1e-5 < initialValidation.rms
  )
  return {
    matrix: (improved ? bestMatrix : initialCurrent).toArray(),
    rms: improved ? bestValidationRms : initialValidation.rms,
    correspondences: finalCount,
    improved,
  }
}

async function computeAlignmentMetrics(meshA, meshB, tolerance = 0.25, maxSamples = 8000, onProgress = null) {
  if (!meshA || !meshB) return null
  meshA.updateMatrixWorld(true)
  meshB.updateMatrixWorld(true)
  const posA = meshA.geometry.getAttribute("position")
  const posB = meshB.geometry.getAttribute("position")
  if (!posA?.count || !posB?.count) return null
  const sampleA = makeClosestSurfaceSampler(meshB)
  const sampleB = makeClosestSurfaceSampler(meshA)
  const values = []
  const point = new THREE.Vector3()
  let sum = 0, sumSq = 0, max = 0, within = 0

  const collect = async (position, mesh, sampler, progressStart, progressSpan) => {
    const indices = sampledVertexIndices(position.count, Math.floor(maxSamples / 2))
    let sliceStarted = performance.now()
    for (let i = 0; i < indices.length; i++) {
      point.fromBufferAttribute(position, indices[i]).applyMatrix4(mesh.matrixWorld)
      const distance = sampler(point).distance
      if (Number.isFinite(distance)) {
        values.push(distance)
        sum += distance
        sumSq += distance * distance
        max = Math.max(max, distance)
        if (distance <= tolerance) within++
      }
      const now = performance.now()
      if (now - sliceStarted >= ALIGNMENT_CPU_SLICE_MS) {
        onProgress?.(progressStart + ((i + 1) / Math.max(1, indices.length)) * progressSpan)
        await alignmentYield()
        sliceStarted = performance.now()
      }
    }
    onProgress?.(progressStart + progressSpan)
  }

  await collect(posA, meshA, sampleA, 0, 0.5)
  await collect(posB, meshB, sampleB, 0.5, 0.5)
  onProgress?.(1)
  values.sort((a, b) => a - b)
  const count = values.length || 1
  const at = (fraction) => values.length ? values[Math.min(values.length - 1, Math.floor((values.length - 1) * fraction))] : 0
  return {
    mean: sum / count,
    median: at(0.5),
    rms: Math.sqrt(sumSq / count),
    percentile95: at(0.95),
    max,
    withinTolerance: (within / count) * 100,
    samples: values.length,
  }
}

function AlignmentMarker({ point, index, radius = 0.8, muted = false }) {
  const color = ALIGNMENT_POINT_COLORS[index % ALIGNMENT_POINT_COLORS.length]
  return (
    <group position={point}>
      <mesh renderOrder={1000}>
        <sphereGeometry args={[radius, 20, 14]} />
        <meshBasicMaterial color={color} transparent opacity={muted ? 0.62 : 1} depthTest={false} depthWrite={false} />
      </mesh>
      <Html center style={{ pointerEvents: "none" }} zIndexRange={[1000, 0]}>
        <div style={{
          width: 22, height: 22, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
          background: color, color: "#050505", fontFamily: "sans-serif", fontSize: 11, fontWeight: 900,
          border: "2px solid rgba(0,0,0,.7)", boxShadow: "0 2px 6px rgba(0,0,0,.55)", transform: "translate(12px,-12px)",
          opacity: muted ? 0.66 : 1, filter: muted ? "saturate(.72) brightness(.92)" : "none",
          transition: "opacity .22s ease, filter .22s ease",
        }}>{index + 1}</div>
      </Html>
    </group>
  )
}

function AlignmentPreviewModel({ file, sourceObject, color, points, active, muted = false, onPickPoint, onLoaded }) {
  const [object3D, setObject3D] = useState(null)
  const rootRef = useRef(null)
  const ext = useMemo(() => inferExt(file?.rawName || file?.name || file?.url), [file])

  useEffect(() => {
    if (!file?.url) { setObject3D(null); return }
    let cancelled = false
    setObject3D(null)
    ;(async () => {
      try {
        // Necháme React nejdřív vykreslit loading overlay, teprve potom klonujeme / načítáme geometrii.
        await alignmentYield()
        if (cancelled) return
        let obj
        if (sourceObject) {
          obj = sourceObject.clone(true)
          obj.matrixAutoUpdate = true
          obj.position.set(0, 0, 0)
          obj.quaternion.identity()
          obj.scale.set(1, 1, 1)
          obj.updateMatrix()
          obj.traverse((child) => {
            if (!child.isMesh) return
            child.material = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide })
          })
        } else if (ext === "stl") {
          const geometry = await new STLLoader().loadAsync(file.url)
          if (!geometry.attributes.normal) geometry.computeVertexNormals()
          obj = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide }))
        } else if (ext === "ply") {
          const geometry = await new PLYLoader().loadAsync(file.url)
          if (!geometry.attributes.normal) geometry.computeVertexNormals()
          obj = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide }))
        } else {
          obj = await new OBJLoader().loadAsync(file.url)
          obj.traverse((child) => {
            if (!child.isMesh) return
            if (!child.geometry.attributes.normal) child.geometry.computeVertexNormals()
            child.material = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide })
          })
        }
        if (!cancelled) {
          obj.traverse((child) => { if (child.isMesh && !child.geometry.boundsTree) child.geometry.computeBoundsTree() })
          setObject3D(obj)
          onLoaded?.()
        }
      } catch (error) {
        console.error("Alignment preview load error:", error)
      }
    })()
    return () => { cancelled = true }
  }, [file?.url, ext, sourceObject])

  useEffect(() => {
    if (!object3D) return
    const baseColor = new THREE.Color(color || "#ffffff")
    const mutedColor = baseColor.clone().lerp(new THREE.Color("#62666a"), 0.86)
    object3D.traverse((child) => {
      if (!child.isMesh || !child.material) return
      const materials = Array.isArray(child.material) ? child.material : [child.material]
      materials.filter(Boolean).forEach((material) => {
        if (material.color?.copy) material.color.copy(muted ? mutedColor : baseColor)
        if ("roughness" in material) material.roughness = muted ? 0.72 : 0.55
        if ("metalness" in material) material.metalness = muted ? 0 : 0.05
      })
    })
  }, [object3D, color, muted])

  const localPointFromEvent = (event) => {
    if (!rootRef.current) return null
    rootRef.current.updateMatrixWorld(true)
    return rootRef.current.worldToLocal(event.point.clone())
  }

  if (!object3D) return null
  return (
    <group ref={rootRef}>
      <primitive
        object={object3D}
        onClick={active ? (event) => {
          event.stopPropagation()
          const local = localPointFromEvent(event)
          if (local) onPickPoint?.([local.x, local.y, local.z])
        } : undefined}
      />
      {(points || []).map((p, index) => <AlignmentMarker key={`${index}-${p.join("-")}`} point={p} index={index} radius={0.55} muted={muted} />)}
    </group>
  )
}

function AlignmentModelDropdown({ badge, value, files = [], otherValue = "", disabled = false, docked = false, onChange, style = {} }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  const selected = files.find((item) => item.url === value)
  const selectedLabel = selected ? stripExt(selected.name || selected.rawName || "Model") : "Vyberte model…"

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false)
    }
    const onKeyDown = (event) => {
      if (event.key === "Escape") setOpen(false)
    }
    window.addEventListener("pointerdown", onPointerDown, true)
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true)
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  const choose = (url) => {
    setOpen(false)
    requestAnimationFrame(() => onChange?.(url))
  }

  return (
    <div ref={rootRef} style={{ position: "relative", zIndex: open ? 500 : 1, width: docked ? 205 : "100%", minWidth: docked ? 180 : 0, maxWidth: docked ? 280 : "none", ...style }}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Vybrat model ${badge}`}
        onClick={() => !disabled && setOpen((value) => !value)}
        style={{
          width: "100%", height: docked ? 31 : 36, boxSizing: "border-box",
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
          padding: "0 9px 0 10px", borderRadius: docked ? 9 : 10,
          border: open ? "1px solid rgba(255,255,255,.20)" : "1px solid rgba(255,255,255,.10)",
          background: open ? "#1b1b1b" : "#151515", color: disabled ? "#616161" : "#f0f0f0",
          boxShadow: open ? "0 0 0 3px rgba(255,255,255,.035)" : "none",
          cursor: disabled ? "not-allowed" : "pointer", outline: "none",
          fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif", fontSize: docked ? 10 : 11, fontWeight: 680,
          transition: "background .16s ease, border-color .16s ease, box-shadow .16s ease, color .16s ease",
        }}
      >
        <span style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left" }}>{selectedLabel}</span>
        <svg width="13" height="13" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flex: "0 0 auto", opacity: .66, transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform .18s ease" }}>
          <path d="M5.5 7.5L10 12L14.5 7.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && !disabled && (
        <div role="listbox" style={{
          position: "absolute", left: 0, right: 0, top: "calc(100% + 6px)", zIndex: 510,
          padding: 5, maxHeight: 238, overflowY: "auto", overscrollBehavior: "contain",
          borderRadius: 12, border: "1px solid rgba(255,255,255,.10)",
          background: "rgba(17,17,17,.97)", boxShadow: "0 18px 46px rgba(0,0,0,.52)",
          backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)",
          animation: "artheticAlignMenuIn .15s cubic-bezier(.22,.61,.36,1) both",
        }}>
          <button type="button" role="option" aria-selected={!value} onClick={() => choose("")} style={{
            width: "100%", minHeight: 32, padding: "7px 9px", border: 0, borderRadius: 8,
            background: !value ? "rgba(255,255,255,.075)" : "transparent", color: !value ? "#f2f2f2" : "#929292",
            display: "flex", alignItems: "center", textAlign: "left", cursor: "pointer",
            fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif", fontSize: 10, fontWeight: 650,
          }}>Vyberte model…</button>
          {files.map((candidate) => {
            const blocked = candidate.url === otherValue
            const current = candidate.url === value
            const label = stripExt(candidate.name || candidate.rawName || "Model")
            return (
              <button
                key={`${badge}-custom-${candidate.url}`}
                type="button"
                role="option"
                aria-selected={current}
                disabled={blocked}
                onClick={() => !blocked && choose(candidate.url)}
                style={{
                  width: "100%", minHeight: 32, padding: "7px 9px", border: 0, borderRadius: 8,
                  background: current ? "rgba(255,255,255,.075)" : "transparent",
                  color: blocked ? "#454545" : current ? "#f4f4f4" : "#bdbdbd",
                  display: "flex", alignItems: "center", gap: 8, textAlign: "left",
                  cursor: blocked ? "not-allowed" : "pointer",
                  fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif", fontSize: 10, fontWeight: current ? 720 : 620,
                  transition: "background .13s ease, color .13s ease",
                }}
                onPointerEnter={(event) => { if (!blocked && !current) event.currentTarget.style.background = "rgba(255,255,255,.045)" }}
                onPointerLeave={(event) => { if (!current) event.currentTarget.style.background = "transparent" }}
              >
                <span style={{ width: 5, height: 5, borderRadius: "50%", flex: "0 0 auto", background: current ? "#4ade80" : blocked ? "#3a3a3a" : "#737373" }} />
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function AlignmentPreviewViewport({ badge, file, sourceObject, color, points, active, dimmed = false, selectionDisabled = false, inactivePointHint = "", onPickPoint, onClearPoints, forceLoading = false, locked = false, onPreviewLoaded, sceneIntensity = 1, highlightIntensity = 1, headlightCfg = { enabled: true, intensity: 2 }, eligibleFiles = [], selectedUrl = "", otherSelectedUrl = "", onSelectModel, selectStyle = {} }) {
  const rootRef = useRef(null)
  const controlsRef = useRef(null)
  const viewportRef = useRef(null)
  const inactiveHintRef = useRef(null)
  const inactiveHintFrameRef = useRef(0)
  const inactiveHintPositionRef = useRef({ x: 0, y: 0 })
  const [target, setTarget] = useState([0, 0, 0])
  const [loadedNonce, setLoadedNonce] = useState(0)
  const [previewLoading, setPreviewLoading] = useState(!!file)
  const roleLabel = badge === "A" ? "Reference A" : "Moving B"
  const selectorDocked = !!file && !previewLoading && !forceLoading
  const showInactivePointHint = !!inactivePointHint && dimmed && !locked && !previewLoading && !forceLoading

  const updateInactivePointHint = useCallback((event) => {
    if (!showInactivePointHint || !viewportRef.current || !inactiveHintRef.current) return
    inactiveHintPositionRef.current.x = event.clientX
    inactiveHintPositionRef.current.y = event.clientY
    if (inactiveHintFrameRef.current) return
    inactiveHintFrameRef.current = requestAnimationFrame(() => {
      inactiveHintFrameRef.current = 0
      const viewport = viewportRef.current
      const hint = inactiveHintRef.current
      if (!viewport || !hint) return
      const rect = viewport.getBoundingClientRect()
      const x = Math.max(8, Math.min(rect.width - 12, inactiveHintPositionRef.current.x - rect.left + 14))
      const y = Math.max(8, Math.min(rect.height - 12, inactiveHintPositionRef.current.y - rect.top + 14))
      hint.style.transform = `translate3d(${x}px,${y}px,0)`
      hint.style.opacity = "1"
    })
  }, [showInactivePointHint])

  const hideInactivePointHint = useCallback(() => {
    if (inactiveHintFrameRef.current) {
      cancelAnimationFrame(inactiveHintFrameRef.current)
      inactiveHintFrameRef.current = 0
    }
    if (inactiveHintRef.current) inactiveHintRef.current.style.opacity = "0"
  }, [])

  useEffect(() => () => {
    if (inactiveHintFrameRef.current) cancelAnimationFrame(inactiveHintFrameRef.current)
  }, [])

  useEffect(() => {
    if (!showInactivePointHint) hideInactivePointHint()
  }, [showInactivePointHint, hideInactivePointHint])

  // Track the inactive-point badge from the window capture phase too. TrackballControls
  // can capture the pointer during RMB camera drags, which otherwise starves the
  // viewport's React onPointerMove handler until the button is released.
  useEffect(() => {
    if (!showInactivePointHint) return
    const onWindowPointerMove = (event) => {
      const viewport = viewportRef.current
      if (!viewport) return
      const rect = viewport.getBoundingClientRect()
      const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom
      if (inside) updateInactivePointHint(event)
      else hideInactivePointHint()
    }
    window.addEventListener("pointermove", onWindowPointerMove, true)
    return () => window.removeEventListener("pointermove", onWindowPointerMove, true)
  }, [showInactivePointHint, updateInactivePointHint, hideInactivePointHint])

  useEffect(() => {
    setPreviewLoading(!!file)
    setLoadedNonce(0)
  }, [file?.url])

  return (
    <div
      ref={viewportRef}
      onPointerEnter={updateInactivePointHint}
      onPointerMove={updateInactivePointHint}
      onPointerLeave={hideInactivePointHint}
      style={{ position: "relative", minWidth: 0, minHeight: 0, background: "#0C0C0C", overflow: "hidden", borderRadius: 13 }}
    >
      <div style={{
        position: "absolute", zIndex: 12,
        top: selectorDocked ? 12 : "50%",
        left: selectorDocked ? 14 : "50%",
        transform: selectorDocked ? "translate(0,0)" : "translate(-50%,-50%)",
        width: selectorDocked ? "auto" : "min(330px, calc(100% - 56px))",
        padding: selectorDocked ? 0 : "16px 16px 14px",
        borderRadius: selectorDocked ? 10 : 16,
        background: selectorDocked ? "transparent" : "rgba(15,15,15,.92)",
        border: selectorDocked ? "1px solid transparent" : "1px solid rgba(255,255,255,.09)",
        boxShadow: selectorDocked ? "none" : "0 18px 48px rgba(0,0,0,.38)",
        backdropFilter: selectorDocked ? "none" : "blur(16px)",
        pointerEvents: selectionDisabled ? "none" : "auto",
        filter: selectionDisabled ? "grayscale(1) blur(.7px)" : "none",
        opacity: selectionDisabled ? .54 : 1,
        fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        transition: "top .42s cubic-bezier(.22,.61,.36,1), left .42s cubic-bezier(.22,.61,.36,1), transform .42s cubic-bezier(.22,.61,.36,1), width .34s ease, padding .34s ease, background .25s ease, border-color .25s ease, box-shadow .25s ease, filter .24s ease, opacity .24s ease",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: selectorDocked ? 10 : 12, minWidth: 0 }}>
          <span style={{
            width: selectorDocked ? 28 : 36, height: selectorDocked ? 28 : 36, borderRadius: selectorDocked ? 9 : 12,
            display: "grid", placeItems: "center", flex: "0 0 auto",
            background: active ? "#ffffff" : selectorDocked ? "rgba(255,255,255,.08)" : "rgba(255,255,255,.07)",
            color: active ? "#0C0C0C" : "#c7c7c7",
            border: "1px solid rgba(255,255,255,.10)", fontSize: selectorDocked ? 11 : 13, fontWeight: 850,
            boxShadow: active ? "0 5px 18px rgba(255,255,255,.10)" : "none",
            transition: "width .34s ease, height .34s ease, border-radius .34s ease, background .2s ease, color .2s ease",
          }}>{badge}</span>
          <div style={{ minWidth: 0, flex: "1 1 auto", display: "flex", flexDirection: "column", gap: selectorDocked ? 3 : 7 }}>
            {!selectorDocked && (
              <div style={{ color: "#f1f1f1", fontSize: 11, fontWeight: 760, letterSpacing: "-.01em" }}>
                {selectionDisabled ? "Nejdřív vyberte Reference A" : `Vyberte ${roleLabel}`}
              </div>
            )}
            <AlignmentModelDropdown
              badge={badge}
              value={selectedUrl || ""}
              files={eligibleFiles}
              otherValue={otherSelectedUrl}
              disabled={selectionDisabled || locked || forceLoading || previewLoading}
              docked={selectorDocked}
              onChange={onSelectModel}
              style={{ opacity: locked ? .55 : 1, transition: "width .34s ease, opacity .2s ease" }}
            />
            {!selectorDocked && !selectionDisabled && (
              <div style={{ color: "#777", fontSize: 9, lineHeight: 1.35, fontWeight: 570, paddingLeft: 1 }}>
                Vyberte ze seznamu nebo kliknutím na model v hlavní scéně.
              </div>
            )}
          </div>
        </div>
      </div>

      {selectorDocked && (
        <div style={{
          position: "absolute", top: 12, right: 14, zIndex: 22,
          display: "flex", alignItems: "center", gap: 8,
          fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          opacity: selectionDisabled ? .45 : 1, transition: "opacity .24s ease",
        }}>
          <div style={{
            color: "rgba(255,255,255,.82)", fontSize: 10, fontWeight: 700, letterSpacing: "-.01em",
            textShadow: "0 2px 12px rgba(0,0,0,.55)", pointerEvents: "none",
          }}>{roleLabel}</div>
          <button
            type="button"
            onClick={(event) => { event.stopPropagation(); onClearPoints?.() }}
            disabled={locked || !points?.length}
            title={`Smazat body v okně ${badge}`}
            style={{
              height: 27, padding: "0 9px", borderRadius: 8,
              border: "1px solid rgba(255,255,255,.09)",
              background: points?.length && !locked ? "rgba(255,255,255,.055)" : "rgba(255,255,255,.025)",
              color: points?.length && !locked ? "#bdbdbd" : "#555",
              fontSize: 9, fontWeight: 680, whiteSpace: "nowrap",
              cursor: points?.length && !locked ? "pointer" : "not-allowed",
              transition: "background .16s ease, border-color .16s ease, color .16s ease, opacity .16s ease",
            }}
            onPointerEnter={(event) => { if (points?.length && !locked) { event.currentTarget.style.background = "rgba(255,255,255,.09)"; event.currentTarget.style.color = "#eeeeee" } }}
            onPointerLeave={(event) => { if (points?.length && !locked) { event.currentTarget.style.background = "rgba(255,255,255,.055)"; event.currentTarget.style.color = "#bdbdbd" } }}
          >
            Smazat body
          </button>
        </div>
      )}

      {showInactivePointHint && (
        <div
          ref={inactiveHintRef}
          style={{
            position: "absolute", left: 0, top: 0, zIndex: 34, opacity: 0, pointerEvents: "none",
            transform: "translate3d(-9999px,-9999px,0)", willChange: "transform, opacity",
            display: "flex", alignItems: "center", gap: 7,
            minHeight: 30, padding: "7px 10px", borderRadius: 10,
            background: "rgba(12,12,12,.93)", border: "1px solid rgba(255,255,255,.12)",
            boxShadow: "0 8px 28px rgba(0,0,0,.34)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
            color: "#eeeeee", fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
            fontSize: 9.5, fontWeight: 720, whiteSpace: "nowrap",
            transition: "opacity .10s ease",
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: "50%", flex: "0 0 auto", background: "#9a9a9a" }} />
          <span>{inactivePointHint}</span>
        </div>
      )}

      <Canvas
        orthographic
        camera={{ position: [0, 0, 250], near: 0.01, far: 100000, zoom: 1 }}
        gl={{ antialias: true }}
        style={{
          position: "absolute", inset: 0,
          filter: (selectionDisabled || dimmed) && !locked ? "brightness(.69) blur(.55px)" : "none",
          opacity: (selectionDisabled || dimmed) && !locked ? .74 : 1,
          transition: "filter .26s ease, opacity .26s ease",
        }}
      >
        <color attach="background" args={["#0C0C0C"]} />
        <ambientLight intensity={0.35 * sceneIntensity} />
        <directionalLight position={[0, 5, 5]} intensity={1.2 * sceneIntensity} />
        <directionalLight position={[-10, 0, 0]} intensity={0.9 * sceneIntensity} />
        <directionalLight position={[10, 0, 0]} intensity={1.0 * sceneIntensity} />
        <directionalLight position={[0, -5, -5]} intensity={0.7 * sceneIntensity} />
        <Headlight enabled={headlightCfg.enabled} intensity={headlightCfg.intensity * highlightIntensity} />
        <group ref={rootRef}>
          {file && (
            <AlignmentPreviewModel
              file={file}
              sourceObject={sourceObject}
              color={color}
              points={points}
              active={active}
              muted={(selectionDisabled || dimmed) && !locked}
              onPickPoint={onPickPoint}
              onLoaded={() => {
                setPreviewLoading(false)
                setLoadedNonce((n) => n + 1)
                onPreviewLoaded?.()
              }}
            />
          )}
        </group>
        {file && loadedNonce > 0 && (
          <AutoCenterAndFrame
            rootRef={rootRef}
            triggerKey={`${file.url}-${loadedNonce}`}
            margin={1.18}
            desktopScale={1}
            mobileScale={1}
            centerMode="combined"
            setTarget={setTarget}
          />
        )}
        <TouchTrackballControls ref={controlsRef} target={target} enabled={!selectionDisabled && !locked && !!file} />
        <RightButtonPan setTarget={setTarget} trackballRef={controlsRef} />
      </Canvas>

      {(previewLoading || forceLoading) && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 18, display: "flex", alignItems: "center", justifyContent: "center",
          background: "rgba(12,12,12,.72)", backdropFilter: "blur(2px)", pointerEvents: "all",
          fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif", borderRadius: "inherit",
        }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
            <div style={{
              width: 28, height: 28, borderRadius: "50%", boxSizing: "border-box",
              border: "2px solid rgba(255,255,255,.10)", borderTopColor: "#f5f5f5",
              animation: "artheticAlignSpin .8s linear infinite",
            }} />
            <div style={{ color: "#d4d4d4", fontSize: 10, fontWeight: 700 }}>Načítám model…</div>
          </div>
        </div>
      )}

      {locked && !previewLoading && !forceLoading && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 16, pointerEvents: "all",
          background: "rgba(12,12,12,.16)",
          backdropFilter: "blur(2.4px) grayscale(1) saturate(0)",
          WebkitBackdropFilter: "blur(2.4px) grayscale(1) saturate(0)",
          overflow: "hidden", borderRadius: "inherit",
        }}>
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }}>
            <line x1="0" y1="0" x2="100" y2="100" stroke="rgba(255,255,255,.24)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          </svg>
        </div>
      )}

      <div style={{
        position: "absolute", inset: 0, pointerEvents: "none", boxSizing: "border-box", borderRadius: "inherit", zIndex: 20,
        border: active ? "1px solid rgba(255,255,255,.34)" : "1px solid rgba(255,255,255,.08)",
        boxShadow: active ? "inset 0 0 0 1px rgba(255,255,255,.04), inset 0 18px 50px rgba(255,255,255,.015), 0 0 0 1px rgba(255,255,255,.025)" : "none",
        transition: "border-color .2s ease, box-shadow .2s ease",
      }} />
    </div>
  )
}

/* ---------- Loader ---------- */
function InlineLoader({ text }) {
  return (
    <Html center>
      <div style={{ background: "rgba(0,0,0,0.7)", padding: "16px 28px", borderRadius: 10, color: "white", fontFamily: "sans-serif", fontSize: 16 }}>
        ⏳ {text || "Načítám…"}
      </div>
    </Html>
  )
}

/* ---------- 3D Auto Rotate (Cinematic Spin) ---------- */
function AutoRotateScene({ enabled, target, speedFactor = 1.0 }) {
  const { camera, gl } = useThree()
  const vTarget = useMemo(() => new THREE.Vector3(), [])
  const isInteracting = useRef(false)

  useEffect(() => {
    const onDown = () => { isInteracting.current = true }
    const onUp = () => { isInteracting.current = false }
    gl.domElement.addEventListener('pointerdown', onDown)
    window.addEventListener('pointerup', onUp)
    return () => {
      gl.domElement.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointerup', onUp)
    }
  }, [gl])

  useFrame((_, delta) => {
    if (!enabled || isInteracting.current) return
    
    vTarget.fromArray(target)
    const speed = 1.0 * speedFactor * delta 
    
    const axis = camera.up.clone().normalize()
    
    camera.position.sub(vTarget)
    camera.position.applyAxisAngle(axis, speed)
    camera.position.add(vTarget)
    
    camera.up.applyAxisAngle(axis, speed)
    
    camera.lookAt(vTarget)
  })
  return null
}

/* ---------- 3D Vektorová linie na rovině řezu ---------- */
const segmentStart = (segment) => segment.a || segment[0]
const segmentEnd = (segment) => segment.b || segment[1]

function SliceLineGroup({ points, color }) {
  const geometry = useMemo(() => {
    const result = new THREE.BufferGeometry()
    result.setAttribute("position", new THREE.Float32BufferAttribute(points, 3))
    result.computeBoundingBox()
    result.computeBoundingSphere()
    return result
  }, [points])

  useEffect(() => () => geometry.dispose(), [geometry])

  return (
    <lineSegments geometry={geometry} renderOrder={998}>
      <lineBasicMaterial color={color} depthTest={false} depthWrite={false} transparent opacity={0.95} />
    </lineSegments>
  )
}

function SliceOutline3D({ segments, modelColors, color = "#fbbf24" }) {
  const groups = useMemo(() => {
    const grouped = new Map()
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]
      const modelIndex = Number.isInteger(segment.modelIndex) ? segment.modelIndex : -1
      if (!grouped.has(modelIndex)) grouped.set(modelIndex, [])
      const points = grouped.get(modelIndex)
      const start = segmentStart(segment)
      const end = segmentEnd(segment)
      points.push(start.x, start.y, 0, end.x, end.y, 0)
    }
    return Array.from(grouped, ([modelIndex, points]) => ({ modelIndex, points }))
  }, [segments])

  if (!segments || segments.length === 0) return null

  return (
    <group>
      {groups.map(({ modelIndex, points }) => (
        <SliceLineGroup key={modelIndex} points={points} color={modelColors?.[modelIndex] || color} />
      ))}
    </group>
  )
}

/* ---------- 3D Měření (Body a linka na rovině) ---------- */
function Measurement3D({ measureState, boundingBox }) {
  const geomRef = useRef(null)

  useEffect(() => {
    if (geomRef.current && measureState.p1 && measureState.snappedP2) {
      const pts = [
        measureState.p1.x, measureState.p1.y, 0,
        measureState.snappedP2.x, measureState.snappedP2.y, 0
      ]
      geomRef.current.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
      geomRef.current.computeBoundingBox()
      geomRef.current.computeBoundingSphere()
    }
  }, [measureState])

  if (!measureState.p1 || !measureState.snappedP2) return null

  const rad = boundingBox ? boundingBox.width * 0.008 : 0.5
  
  const dx = measureState.snappedP2.x - measureState.p1.x;
  const dy = measureState.snappedP2.y - measureState.p1.y;
  const midX = measureState.p1.x + dx / 2;
  const midY = measureState.p1.y + dy / 2;
  const distVal = Math.sqrt(dx * dx + dy * dy).toFixed(2);

  return (
    <group>
      <lineSegments renderOrder={999}>
        <bufferGeometry ref={geomRef} />
        <lineBasicMaterial color="#fbbf24" depthTest={false} depthWrite={false} transparent opacity={0.95} />
      </lineSegments>
      <mesh position={[measureState.p1.x, measureState.p1.y, 0]} renderOrder={999}>
        <circleGeometry args={[rad, 32]} />
        <meshBasicMaterial color="#fbbf24" depthTest={false} depthWrite={false} transparent opacity={0.95} />
      </mesh>
      <mesh position={[measureState.snappedP2.x, measureState.snappedP2.y, 0]} renderOrder={999}>
        <circleGeometry args={[rad, 32]} />
        <meshBasicMaterial color="#fbbf24" depthTest={false} depthWrite={false} transparent opacity={0.95} />
      </mesh>

      <Html position={[midX, midY, 0]} center style={{ pointerEvents: "none" }} zIndexRange={[100, 0]}>
        <div style={{
          fontSize: 16,
          fontWeight: 'bold',
          color: '#fbbf24',
          textShadow: "0 2px 4px rgba(0,0,0,0.8)",
          whiteSpace: "nowrap",
          transform: "translate(8px, -12px)"
        }}>
          {distVal} mm
        </div>
      </Html>
    </group>
  )
}

function AlignmentFastRaycast({ enabled = false }) {
  const { raycaster } = useThree()
  useEffect(() => {
    const previous = raycaster.firstHitOnly
    raycaster.firstHitOnly = !!enabled
    return () => { raycaster.firstHitOnly = previous }
  }, [raycaster, enabled])
  return null
}

/* ---------- AnyModel ---------- */
function AnyModel({
  name, url,
  color, opacity, visible,
  onLoaded, onMeshReady, onObjectReady, autoSmooth, smoothAngle = DEFAULT_SMOOTH_ANGLE,
  roughness = 0.5, metalness = 0.5,
  useVertexColors = false,
  keepMaterials = false,
  wireframe = false,
  ghost = false,
  analysisMode = null,
  renderOrder = 0,
  modelMatrix = null,
  onHoverDist,
  onPinNote,
  onAlignmentSelect,
  onAlignmentHover,
  onTrimSurfaceClick,
  onTrimSurfaceMove,
  onTrimSurfaceOut,
}) {
  const [object3D, setObject3D] = useState(null)
  const ext = useMemo(() => inferExt(name || url), [name, url])

  const makeMat = (opts = {}) => {
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color || "#ffffff"),
      roughness: typeof roughness === "number" ? roughness : 0.5,
      metalness: typeof metalness === "number" ? metalness : 0.5,
      opacity,
      side: THREE.DoubleSide,
      wireframe: !!wireframe,
      ...opts,
    })
    configureMaterialTransparency(material, opacity)
    return material
  }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        let obj
        if (ext === "stl") {
          const geom = await new STLLoader().loadAsync(url)
          if (!geom.attributes.normal) geom.computeVertexNormals()
          const base = autoSmooth ? autoSmoothGeometry(geom, smoothAngle) : (geom.computeVertexNormals(), geom)
          const mat = makeMat()
          obj = new THREE.Mesh(base, mat)
          obj.userData._baseGeom = geom
          obj.userData._derivedGeom = base
          obj.userData._hasVisualTexture = false
        } else if (ext === "ply") {
          const geom = await new PLYLoader().loadAsync(url)
          const hasVC = !!geom.getAttribute("color")
          let base = geom
          if (autoSmooth) base = autoSmoothGeometry(geom, smoothAngle)
          else if (!geom.attributes.normal) geom.computeVertexNormals()
          const mat = hasVC && useVertexColors ? makeMat({ vertexColors: true, color: new THREE.Color("#ffffff") }) : makeMat()
          obj = new THREE.Mesh(base, mat)
          obj.userData._baseGeom = geom
          obj.userData._derivedGeom = base
          obj.userData._hasVisualTexture = hasVC
        } else {
          const loaded = await new OBJLoader().loadAsync(url)
          let objHasVisualTexture = false
          loaded.traverse((ch) => {
            if (!ch.isMesh) return
            if (ch.geometry?.getAttribute?.("color")) objHasVisualTexture = true
            const materials = Array.isArray(ch.material) ? ch.material : [ch.material]
            if (materials.filter(Boolean).some((material) => !!material.map)) objHasVisualTexture = true
          })
          if (keepMaterials) {
            loaded.traverse((ch) => {
              if (ch.isMesh && ch.material) {
                const materials = Array.isArray(ch.material) ? ch.material : [ch.material]
                materials.forEach((m) => {
                  configureMaterialTransparency(m, opacity)
                  if ("roughness" in m && typeof roughness === "number") m.roughness = roughness
                  if ("metalness" in m && typeof metalness === "number") m.metalness = metalness
                  m.wireframe = !!wireframe
                  m.needsUpdate = true
                })
              }
            })
            obj = loaded
          } else {
            const mat = makeMat()
            loaded.traverse((ch) => { if (ch.isMesh) ch.material = mat })
            obj = loaded
          }
          obj.userData._hasVisualTexture = objHasVisualTexture
        }
        if (!cancelled) {
          obj.userData._viewerColor = color || "#ffffff"
          obj.renderOrder = renderOrder
          obj.traverse((child) => {
            if (!child.isMesh) return
            child.userData._viewerColor = color || "#ffffff"
            child.renderOrder = renderOrder
          })
          setObject3D(obj)
          onLoaded && onLoaded(url)
          onObjectReady && onObjectReady(obj, url)
          
          let foundMesh = null;
          obj.traverse((child) => { if (child.isMesh && !foundMesh) foundMesh = child });
          if (foundMesh && onMeshReady) onMeshReady(foundMesh, url);
        }
      } catch (e) {
        console.error("Model load error:", e)
      }
    })()
    return () => { cancelled = true }
  }, [url, ext])

  useEffect(() => {
    if (!object3D) return
    object3D.matrixAutoUpdate = false
    if (Array.isArray(modelMatrix) && modelMatrix.length === 16) object3D.matrix.fromArray(modelMatrix)
    else object3D.matrix.identity()
    object3D.matrixWorldNeedsUpdate = true
    object3D.updateMatrixWorld(true)
  }, [object3D, modelMatrix])

  useEffect(() => {
    if (!object3D) return
    object3D.traverse((child) => {
      if (!child.isMesh) return
      if (child.userData._originalColors === undefined) {
          if (child.geometry.attributes.color) {
              child.userData._originalColors = child.geometry.attributes.color.clone();
          } else {
              child.userData._originalColors = null;
          }
      }

      child.userData._viewerColor = color || "#ffffff"
      child.renderOrder = renderOrder
      const analysisColors = analysisMode === "occlusion"
        ? child.userData._occlusionColors
        : analysisMode === "comparison"
          ? child.userData._comparisonColors
          : null
      const analysisDistances = analysisMode === "occlusion"
        ? child.userData._occlusionDistances
        : analysisMode === "comparison"
          ? child.userData._comparisonDistances
          : null
      const isHeatmapActive = !!analysisColors
      
      if (isHeatmapActive) {
          child.geometry.setAttribute('color', analysisColors);
          child.geometry.setAttribute('_analysisDist', analysisDistances);
      } else {
          if (child.userData._originalColors) {
              child.geometry.setAttribute('color', child.userData._originalColors);
          } else {
              child.geometry.deleteAttribute('color');
          }
          child.geometry.deleteAttribute('_analysisDist');
      }
      
      if (child.geometry.attributes.color) {
          child.geometry.attributes.color.needsUpdate = true;
      }

      const isOriginalTexActive = useVertexColors && child.userData._originalColors;
      const wantVertexColors = isHeatmapActive || isOriginalTexActive;
      const ghostActive = !!ghost;

      // Ghost je samostatný diagnostický render režim. Původní materiál si necháváme
      // bokem, aby vypnutí Ghostu přesně navázalo na aktuální TEX/WF/barvu/opacity.
      // Pokud je TEX aktivní, Ghost převezme reálnou mapu / vertex colors modelu;
      // jinak používá aktuální barvu z color pickeru.
      if (!ghostActive && isGhostMaterial(child.material)) {
        const ghostMaterial = child.material
        const restoreMaterial = child.userData._preGhostMaterial
        if (restoreMaterial) child.material = restoreMaterial
        child.userData._preGhostMaterial = null
        disposeGhostMaterial(ghostMaterial)
      }

      if (ghostActive) {
        const ghostOptions = {
          opacity,
          baseColor: color || '#ffffff',
          // Během Comparison/Occlusion má diagnostická mapa přednost před běžnou
          // barvou/texturou. Ghost tak zůstává Ghostem, ale nepřijdeme o heatmapu.
          useTextureData: !isHeatmapActive && !!useVertexColors,
          hasVertexColors: isHeatmapActive
            ? !!child.geometry.attributes.color
            : !!child.userData._originalColors,
          forceVertexColors: isHeatmapActive,
        }

        if (!isGhostMaterial(child.material)) {
          child.userData._preGhostMaterial = child.material
          child.material = makeGhostMaterial(child.material, ghostOptions)
        } else {
          const sourceMaterial = child.userData._preGhostMaterial
          const updated = updateGhostMaterial(child.material, sourceMaterial, ghostOptions)
          if (!updated && sourceMaterial) {
            const oldGhostMaterial = child.material
            child.material = makeGhostMaterial(sourceMaterial, ghostOptions)
            disposeGhostMaterial(oldGhostMaterial)
          }
        }

        ghostMaterialList(child.material).forEach((material) => {
          material.needsUpdate = true
        })
        return
      }

      if (keepMaterials) {
          const materials = Array.isArray(child.material) ? child.material : [child.material]
          materials.filter(Boolean).forEach((m) => {
            configureMaterialTransparency(m, opacity)
            if (typeof roughness === "number" && "roughness" in m) m.roughness = roughness
            if (typeof metalness === "number" && "metalness" in m) m.metalness = metalness
            m.wireframe = !!wireframe
            m.vertexColors = wantVertexColors
            if ("color" in m) m.color = new THREE.Color(wantVertexColors ? "#ffffff" : color)
            m.needsUpdate = true
          })
      } else {
          const newMat = wantVertexColors 
              ? makeMat({ vertexColors: true, color: new THREE.Color("#ffffff") }) 
              : makeMat({ vertexColors: false, color: new THREE.Color(color) })

          const oldMaterial = child.material
          child.material = newMat
          if (oldMaterial && oldMaterial !== newMat) {
            if (Array.isArray(oldMaterial)) oldMaterial.filter(Boolean).forEach((m) => m.dispose?.())
            else oldMaterial.dispose?.()
          }
      }
    })
  }, [object3D, color, opacity, roughness, metalness, useVertexColors, keepMaterials, wireframe, ghost, analysisMode, renderOrder])

  useEffect(() => {
    if (!object3D || !onAlignmentSelect) return
    let cancelled = false
    const meshes = []
    object3D.traverse((child) => {
      if (child.isMesh && child.geometry && !child.geometry.boundsTree && typeof child.geometry.computeBoundsTree === "function") meshes.push(child)
    })
    ;(async () => {
      for (let i = 0; i < meshes.length; i++) {
        if (cancelled) return
        await alignmentYield()
        if (cancelled) return
        try { if (!meshes[i].geometry.boundsTree) meshes[i].geometry.computeBoundsTree() } catch {}
      }
    })()
    return () => { cancelled = true }
  }, [object3D, !!onAlignmentSelect])

  const setAlignmentHoverVisual = (enabled) => {
    if (!object3D) return
    if (enabled && !onAlignmentSelect) return
    object3D.traverse((child) => {
      if (!child.isMesh || !child.material) return
      const materials = Array.isArray(child.material) ? child.material : [child.material]
      materials.filter(Boolean).forEach((material) => {
        material.userData = material.userData || {}
        if (enabled) {
          if (!material.userData._alignmentHoverBackup) {
            material.userData._alignmentHoverBackup = {
              emissive: material.emissive?.clone?.() || null,
              emissiveIntensity: typeof material.emissiveIntensity === "number" ? material.emissiveIntensity : null,
            }
          }
          if (material.emissive?.set) {
            material.emissive.set("#22c55e")
            material.emissiveIntensity = Math.max(0.18, Number(material.emissiveIntensity) || 0)
          }
        } else {
          const backup = material.userData._alignmentHoverBackup
          if (backup) {
            if (backup.emissive && material.emissive?.copy) material.emissive.copy(backup.emissive)
            if (backup.emissiveIntensity !== null && typeof backup.emissiveIntensity === "number") material.emissiveIntensity = backup.emissiveIntensity
            delete material.userData._alignmentHoverBackup
          }
        }
      })
    })
  }

  useEffect(() => {
    if (!onAlignmentSelect) setAlignmentHoverVisual(false)
    return () => setAlignmentHoverVisual(false)
  }, [object3D, onAlignmentSelect])

  if (!object3D) return null

  return visible ? (
    <primitive 
      object={object3D} 
      renderOrder={renderOrder}
      onClick={onAlignmentSelect ? (e) => {
        e.stopPropagation()
        onAlignmentSelect(url)
      } : onTrimSurfaceClick ? (e) => {
        e.stopPropagation()
        if (e.delta != null && e.delta > 4) return
        onTrimSurfaceClick(url, e)
      } : undefined}
      onPointerOver={onAlignmentSelect ? (e) => {
        e.stopPropagation()
        setAlignmentHoverVisual(true)
        onAlignmentHover?.(url, true)
      } : undefined}
      onPointerMove={onTrimSurfaceMove || (analysisMode && onHoverDist) ? (e) => {
        if (onTrimSurfaceMove) onTrimSurfaceMove(url, e)
        if (analysisMode && onHoverDist) {
          e.stopPropagation(); 
          const distAttr = e.object.geometry.getAttribute('_analysisDist');
          
          if (distAttr && e.face) {
            const dA = distAttr.getX(e.face.a);
            const dB = distAttr.getX(e.face.b);
            const dC = distAttr.getX(e.face.c);
            const avgDist = (dA + dB + dC) / 3;
            onHoverDist(avgDist, e.clientX, e.clientY);
          } else if (distAttr && e.index !== undefined) {
            onHoverDist(distAttr.getX(e.index), e.clientX, e.clientY);
          }
        }
      } : undefined}
      onPointerOut={(analysisMode && onHoverDist) || onAlignmentSelect || onTrimSurfaceMove || onTrimSurfaceOut ? () => {
        if (onAlignmentSelect) {
          setAlignmentHoverVisual(false)
          onAlignmentHover?.(url, false)
        }
        if (analysisMode && onHoverDist) onHoverDist(null)
        if (onTrimSurfaceOut) onTrimSurfaceOut(url)
      } : undefined}
      onDoubleClick={analysisMode && onPinNote ? (e) => {
        e.stopPropagation();
        const distAttr = e.object.geometry.getAttribute('_analysisDist');
        let dist = null;
        if (distAttr && e.face) {
          const dA = distAttr.getX(e.face.a);
          const dB = distAttr.getX(e.face.b);
          const dC = distAttr.getX(e.face.c);
          dist = (dA + dB + dC) / 3;
        } else if (distAttr && e.index !== undefined) {
          dist = distAttr.getX(e.index);
        }
        if (dist !== null) {
           onPinNote(dist, e.point);
        }
      } : undefined}
    />
  ) : null
}


/* ---------- Mobilní dotykové ovládání roviny řezu ---------- */
function MobileSlicePlaneTouchController({
  radius = 100,
  enabled = false,
  onChange,
  onInteractionChange,
}) {
  const { camera, size } = useThree()
  const pointersRef = useRef(new Map())
  const gestureRef = useRef({
    singleY: null,
    twoCenter: null,
  })
  const cameraRightRef = useRef(new THREE.Vector3())
  const cameraUpRef = useRef(new THREE.Vector3())

  const resetGestureAnchor = useCallback(() => {
    const points = [...pointersRef.current.values()]
    if (points.length === 1) {
      gestureRef.current.singleY = points[0].y
      gestureRef.current.twoCenter = null
    } else if (points.length >= 2) {
      gestureRef.current.singleY = null
      gestureRef.current.twoCenter = {
        x: (points[0].x + points[1].x) * 0.5,
        y: (points[0].y + points[1].y) * 0.5,
      }
    } else {
      gestureRef.current.singleY = null
      gestureRef.current.twoCenter = null
    }
  }, [])

  const finishPointer = useCallback((event) => {
    pointersRef.current.delete(event.pointerId)
    try { event.target?.releasePointerCapture?.(event.pointerId) } catch {}
    resetGestureAnchor()
    if (pointersRef.current.size === 0) onInteractionChange?.(false)
  }, [onInteractionChange, resetGestureAnchor])

  if (!enabled) return null

  return (
    <mesh
      position={[0, 0, 0.035]}
      renderOrder={1200}
      onPointerDown={(event) => {
        event.stopPropagation()
        event.nativeEvent?.preventDefault?.()
        pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
        try { event.target?.setPointerCapture?.(event.pointerId) } catch {}
        onInteractionChange?.(true)
        resetGestureAnchor()
      }}
      onPointerMove={(event) => {
        if (!pointersRef.current.has(event.pointerId)) return
        event.stopPropagation()
        event.nativeEvent?.preventDefault?.()

        pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
        const points = [...pointersRef.current.values()].slice(0, 2)
        const plane = event.object?.parent
        if (!plane) return

        if (points.length === 1) {
          const previousY = gestureRef.current.singleY
          const currentY = points[0].y
          if (Number.isFinite(previousY)) {
            const dy = currentY - previousY
            // Pohyb po lokální normále roviny. Citlivost se škáluje podle velikosti
            // řezu, takže je podobná na různých velikostech dentálních modelů.
            const worldPerPixel = Math.max(0.012, radius / Math.max(950, size.height * 2.2))
            plane.translateZ(-dy * worldPerPixel)
            plane.updateMatrixWorld(true)
            onChange?.()
          }
          gestureRef.current.singleY = currentY
          gestureRef.current.twoCenter = null
          return
        }

        if (points.length >= 2) {
          const center = {
            x: (points[0].x + points[1].x) * 0.5,
            y: (points[0].y + points[1].y) * 0.5,
          }
          const previous = gestureRef.current.twoCenter
          if (previous) {
            const dx = center.x - previous.x
            const dy = center.y - previous.y
            const rotateSpeed = 0.0062

            cameraRightRef.current.set(1, 0, 0).applyQuaternion(camera.quaternion).normalize()
            cameraUpRef.current.set(0, 1, 0).applyQuaternion(camera.quaternion).normalize()

            // Dva prsty fungují jako přímé "naklánění" roviny podle obrazovky.
            // Rotace kolem normály řezu nemění samotný řez, proto používáme jen
            // screen-right a screen-up osy.
            plane.rotateOnWorldAxis(cameraUpRef.current, dx * rotateSpeed)
            plane.rotateOnWorldAxis(cameraRightRef.current, dy * rotateSpeed)
            plane.updateMatrixWorld(true)
            onChange?.()
          }
          gestureRef.current.twoCenter = center
          gestureRef.current.singleY = null
        }
      }}
      onPointerUp={finishPointer}
      onPointerCancel={finishPointer}
      onLostPointerCapture={finishPointer}
    >
      {/* Neviditelná touch plocha je menší než vizuální rovina, aby šlo kolem
          jejího okraje dál pohodlně orbitovat kamerou. */}
      <circleGeometry args={[radius * 0.72, 48]} />
      <meshBasicMaterial
        transparent
        opacity={0}
        depthTest={false}
        depthWrite={false}
        side={THREE.DoubleSide}
      />
    </mesh>
  )
}

/* ---------- Headlight ---------- */
function Headlight({ enabled = true, intensity = 2, color = "#ffffff" }) {
  const { camera } = useThree()
  const ref = useRef(null)
  useFrame(() => { if (ref.current) ref.current.position.copy(camera.position) })
  return <pointLight ref={ref} color={color} intensity={enabled ? intensity : 0} distance={0} decay={0} />
}

/* ---------- Trackball ---------- */
const TouchTrackballControls = React.forwardRef(({ target = [0, 0, 0], onInteractionChange, enabled = true }, ref) => {
  const { camera, gl, size } = useThree()
  const controlsRef = useRef(null)

  useEffect(() => {
    const c = new TrackballControls(camera, gl.domElement)
    c.rotateSpeed = 5.0
    c.zoomSpeed = 1.2
    c.panSpeed = 1.0
    c.staticMoving = true
    c.dynamicDampingFactor = 0.15
    c.enabled = enabled
    c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ZOOM, RIGHT: THREE.MOUSE.PAN }
    const handleStart = () => onInteractionChange?.(true)
    const handleEnd = () => onInteractionChange?.(false)
    c.addEventListener("start", handleStart)
    c.addEventListener("end", handleEnd)
    controlsRef.current = c
    if (typeof ref === "function") ref(c)
    else if (ref) ref.current = c
    return () => {
      c.removeEventListener("start", handleStart)
      c.removeEventListener("end", handleEnd)
      c.dispose()
      controlsRef.current = null
      if (typeof ref === "function") ref(null)
      else if (ref?.current === c) ref.current = null
    }
  }, [camera, gl, onInteractionChange, ref])

  useEffect(() => {
    if (controlsRef.current) controlsRef.current.enabled = enabled
  }, [enabled])

  useEffect(() => {
    const c = controlsRef.current; if (!c) return
    c.target.set(target[0], target[1], target[2])
    c.update()
  }, [target])
  
  useFrame(() => { controlsRef.current?.update() })
  useEffect(() => { controlsRef.current?.handleResize() }, [size.width, size.height])
  return null
})

/* ---------- Vlastní pan ---------- */
function RightButtonPan({ setTarget, trackballRef, onInteractionChange }) {
  const { camera, gl, size } = useThree()
  const isPanning = useRef(false)
  const last = useRef({ x: 0, y: 0 })
  const pointerIdRef = useRef(null)

  const PAN_SENSITIVITY = 0.85
  const right = new THREE.Vector3()
  const up = new THREE.Vector3()
  const deltaWorld = new THREE.Vector3()

  useEffect(() => {
    const el = gl.domElement
    const onContext = (e) => { e.preventDefault() }

    const onDown = (e) => {
      if (trackballRef && trackballRef.current && !trackballRef.current.enabled) return;
      if ((e.button !== 2) && !(e.button === 0 && e.ctrlKey)) return
      e.preventDefault()
      e.stopPropagation()
      isPanning.current = true
      onInteractionChange?.(true)
      last.current = { x: e.clientX, y: e.clientY }
      try { 
        el.setPointerCapture?.(e.pointerId); 
        pointerIdRef.current = e.pointerId 
      } catch {}
    }

    const onMove = (e) => {
      if (!isPanning.current) return
      e.preventDefault()
      e.stopPropagation()

      const dx = e.clientX - last.current.x
      const dy = e.clientY - last.current.y
      last.current = { x: e.clientX, y: e.clientY }

      right.setFromMatrixColumn(camera.matrixWorld, 0).normalize()
      up.setFromMatrixColumn(camera.matrixWorld, 1).normalize()

      if (camera.isOrthographicCamera) {
        const wppX = ((camera.right - camera.left) / (size.width * camera.zoom))
        const wppY = ((camera.top - camera.bottom) / (size.height * camera.zoom))
        const moveRight = -dx * wppX * PAN_SENSITIVITY
        const moveUp    =  dy * wppY * PAN_SENSITIVITY

        deltaWorld.copy(right).multiplyScalar(moveRight).addScaledVector(up, moveUp)
        camera.position.add(deltaWorld)
        setTarget?.((t) => [t[0] + deltaWorld.x, t[1] + deltaWorld.y, t[2] + deltaWorld.z])
        camera.updateProjectionMatrix()
      } else {
        const dist = camera.position.length()
        const scale = (dist / Math.max(size.width, size.height)) * PAN_SENSITIVITY
        deltaWorld.copy(right).multiplyScalar(-dx * scale).addScaledVector(up, dy * scale)
        camera.position.add(deltaWorld)
        setTarget?.((t) => [t[0] + deltaWorld.x, t[1] + deltaWorld.y, t[2] + deltaWorld.z])
      }
    }

    const onUp = (e) => {
      if (!isPanning.current) return
      e.preventDefault()
      e.stopPropagation()
      isPanning.current = false
      onInteractionChange?.(false)
      if (pointerIdRef.current !== null) {
          try { el.releasePointerCapture?.(pointerIdRef.current) } catch {}
          pointerIdRef.current = null
      }
    }

    el.addEventListener("contextmenu", onContext)
    el.addEventListener("pointerdown", onDown)
    el.addEventListener("pointermove", onMove)
    el.addEventListener("pointerup", onUp)
    el.addEventListener("pointercancel", onUp)
    el.addEventListener("pointerleave", onUp)

    return () => {
      el.removeEventListener("contextmenu", onContext)
      el.removeEventListener("pointerdown", onDown)
      el.removeEventListener("pointermove", onMove)
      el.removeEventListener("pointerup", onUp)
      el.removeEventListener("pointercancel", onUp)
      el.removeEventListener("pointerleave", onUp)
    }
  }, [camera, gl, size.width, size.height, setTarget, trackballRef, onInteractionChange])

  return null
}

/* ---------- AutoCenter & AutoFrame ---------- */
function AutoCenterAndFrame({ rootRef, triggerKey, onFramed, margin = 1.12, isMobile = false, desktopScale = 1.0, mobileScale = 1.0, centerMode = "combined", setTarget }) {
  const { camera, size } = useThree()
  
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    
    root.updateMatrixWorld(true)
    const boxAll = new THREE.Box3().setFromObject(root)
    if (boxAll.isEmpty()) return

    const centerAll = new THREE.Vector3()
    boxAll.getCenter(centerAll)

    if (centerMode === "per") {
      root.children.forEach((child) => {
        const b = new THREE.Box3().setFromObject(child)
        if (!b.isEmpty()) {
            const cWorld = new THREE.Vector3(); b.getCenter(cWorld)
            child.position.sub(cWorld)
        }
      })
      root.updateMatrixWorld(true)
    } else if (centerMode === "combined") {
      root.position.sub(centerAll)
      root.updateMatrixWorld(true)
    }

    const after = new THREE.Box3().setFromObject(root)
    const dims2 = new THREE.Vector3(), ctr = new THREE.Vector3()
    after.getSize(dims2); after.getCenter(ctr)

    const objW = Math.max(dims2.x, 1e-6)
    const objH = Math.max(dims2.y, 1e-6)
    const zoomX = size.width / (objW * margin)
    const zoomY = size.height / (objH * margin)
    let newZoom = Math.min(zoomX, zoomY) * (isMobile ? mobileScale : desktopScale)

    const depth = Math.max(dims2.z, Math.max(dims2.x, dims2.y) * 0.75) || 1
    const safeDist = depth * 10
    camera.near = Math.max(0.01, safeDist * 0.001)
    camera.far = safeDist * 80 + 200
    camera.position.set(ctr.x, ctr.y, ctr.z + safeDist)
    camera.up.set(0, 1, 0)
    camera.zoom = Math.max(newZoom, 0.01)
    camera.updateProjectionMatrix()
      
    if (setTarget) setTarget([ctr.x, ctr.y, ctr.z])

    onFramed && onFramed()
  }, [triggerKey]) 
  
  return null
}

/* ---------- Nasazení uložené kamery ---------- */
function CustomCameraSetter({ camState, triggerKey, onFramed, setTarget }) {
  const { camera, size } = useThree()
  
  useEffect(() => {
    if (!camState) return
    
    if (camState.matrix) {
      camera.matrix.fromArray(camState.matrix)
      camera.matrix.decompose(camera.position, camera.quaternion, camera.scale)
    }
    if (camState.up) camera.up.fromArray(camState.up)
    
    if (camState.zoom) {
       if (camState.canvasSize) {
          const savedMin = Math.min(camState.canvasSize[0], camState.canvasSize[1])
          const currentMin = Math.min(size.width, size.height)
          camera.zoom = camState.zoom * (currentMin / savedMin)
       } else {
          camera.zoom = camState.zoom
       }
    }
    
    camera.updateProjectionMatrix()

    if (camState.target && setTarget) {
      setTarget(camState.target)
    }

    onFramed && onFramed()
  }, [triggerKey, camState, camera, setTarget, size.width, size.height])

  return null
}

/* ---------- SYNC STAVU POHLEDU DO FRAMERU A ODESLÁNÍ SNAPSHOTU ---------- */
function ViewStateSync({ trackballRef, getViewerState }) {
  const { gl, camera, size } = useThree()

  useEffect(() => {
    const interval = setInterval(() => {
      if (typeof window === "undefined" || !trackballRef?.current) return
      
      const c = trackballRef.current
      camera.updateMatrixWorld(true)
      
      const camData = {
        matrix: camera.matrix.toArray(),
        up: [camera.up.x, camera.up.y, camera.up.z],
        zoom: camera.zoom,
        canvasSize: [size.width, size.height],
        target: [c.target.x, c.target.y, c.target.z] 
      }
      
      const targetWindow = window.top || window.parent;
      if (targetWindow) {
        targetWindow.postMessage({
          type: "SHADE3D_VIEW_SYNC",
          payload: { camera: camData }
        }, "*")
      }
    }, 500)

    return () => clearInterval(interval)
  }, [camera, trackballRef, size.width, size.height])

  useEffect(() => {
    const handleMessage = (e) => {
      const d = e.data
      if (d && d.type === "SHADE3D_REQUEST_SNAPSHOT") {
        if (!trackballRef?.current) return
        
        const c = trackballRef.current
        camera.updateMatrixWorld(true)
        
        const camData = {
          matrix: camera.matrix.toArray(),
          up: [camera.up.x, camera.up.y, camera.up.z],
          zoom: camera.zoom,
          canvasSize: [size.width, size.height],
          target: [c.target.x, c.target.y, c.target.z] 
        }

        const snapshotUrl = gl.domElement.toDataURL("image/jpeg", 0.75) 
        const viewerState = getViewerState ? getViewerState() : null
        
        const targetWindow = window.top || window.parent;
        if (targetWindow) {
          targetWindow.postMessage({
            type: "SHADE3D_SNAPSHOT_RESPONSE",
            payload: { 
              camera: camData,
              snapshot: snapshotUrl,
              viewerState,
            }
          }, "*")
        }
      }
    }
    
    window.addEventListener("message", handleMessage)
    return () => window.removeEventListener("message", handleMessage)
  }, [gl, camera, trackballRef, size.width, size.height, getViewerState])

  return null
}

/* ---------- Lightbox ---------- */
function Lightbox({ open, onClose, src, alt }) {
  if (!open || !src) return null
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
      <img src={src} alt={alt || ""} style={{ maxWidth: "96vw", maxHeight: "92vh", objectFit: "contain", borderRadius: 12, boxShadow: "0 10px 40px rgba(0,0,0,.6)", border: "1px solid rgba(255,255,255,.15)" }} />
    </div>
  )
}

/* ---------- Switch ---------- */
function Switch({ checked, onChange, label }) {
  const onKey = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onChange(!checked) } }
  const TRACK_W = 34, TRACK_H = 19, KNOB = 15
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {label && <span style={{ color: "inherit", fontSize: "inherit", fontWeight: 680, letterSpacing: "-.01em" }}>{label}</span>}
      <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} onKeyDown={onKey}
        style={{
          position: "relative", width: TRACK_W, height: TRACK_H, borderRadius: 999, outline: "none", padding: 0, cursor: "pointer",
          border: checked ? "1px solid rgba(74,222,128,.26)" : "1px solid rgba(255,255,255,.14)",
          background: checked ? "rgba(34,197,94,.13)" : "rgba(255,255,255,.055)",
          transition: "background .15s ease, border-color .15s ease",
        }}>
        <span aria-hidden style={{
          position: "absolute", top: "50%", transform: "translateY(-50%)", left: checked ? TRACK_W - KNOB - 2 : 2,
          width: KNOB, height: KNOB, borderRadius: "50%", background: checked ? "#dffbea" : "#d7d7d7",
          boxShadow: "0 1px 3px rgba(0,0,0,.35)", transition: "left .15s ease, background .15s ease"
        }}/>
      </button>
    </div>
  )
}

/* ---------- 2D OVERLAY ---------- */
function Overlay2D({ segments, modelColors, boundingBox, measureState, setMeasureState, dicomSlice, onInteractionChange, embedded = false, mobile = false, title = "", active = false, onActivate, accent = "#f59e9e" }) {
  const svgRef = useRef(null)
  const containerRef = useRef(null)

  const [winSize, setWinSize] = useState({ w: 550, h: 400 })
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const userResizedRef = useRef(false)

  const setDefaultWindowSize = useCallback(() => {
    if (embedded || userResizedRef.current || typeof window === "undefined") return
    const anchor = document.querySelector('[data-slice-window-anchor="true"]')
    const anchorBottom = anchor?.getBoundingClientRect().bottom ?? 140
    const availableHeight = window.innerHeight - anchorBottom - 30
    setWinSize({
      w: Math.min(550, Math.max(320, window.innerWidth - 40)),
      h: Math.max(220, availableHeight),
    })
  }, [embedded])

  useEffect(() => {
    if (embedded) return
    const frame = requestAnimationFrame(setDefaultWindowSize)
    window.addEventListener("resize", setDefaultWindowSize)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener("resize", setDefaultWindowSize)
    }
  }, [embedded, setDefaultWindowSize])

  useEffect(() => {
    if (!embedded || !containerRef.current || typeof ResizeObserver === "undefined") return
    const element = containerRef.current
    const updateSize = () => {
      const rect = element.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) setWinSize({ w: rect.width, h: rect.height })
    }
    const observer = new ResizeObserver(updateSize)
    observer.observe(element)
    updateSize()
    return () => observer.disconnect()
  }, [embedded])

  const pathDataByModel = useMemo(() => {
      const grouped = new Map()
      if (!segments || segments.length === 0) return []
      for (let i = 0; i < segments.length; i++) {
          const s = segments[i]
          const start = segmentStart(s)
          const end = segmentEnd(s)
          const modelIndex = Number.isInteger(s.modelIndex) ? s.modelIndex : -1
          const d = `${grouped.get(modelIndex) || ""}M${start.x.toFixed(2)},${start.y.toFixed(2)}L${end.x.toFixed(2)},${end.y.toFixed(2)}`
          grouped.set(modelIndex, d)
      }
      return Array.from(grouped, ([modelIndex, d]) => ({ modelIndex, d }))
  }, [segments])

  const distSq = (v, w) => Math.pow(v.x - w.x, 2) + Math.pow(v.y - w.y, 2)
  const closestPointOnSegment = (p, v, w) => {
    const l2 = distSq(v, w)
    if (l2 === 0) return v
    let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2
    t = Math.max(0, Math.min(1, t))
    return { x: v.x + t * (w.x - v.x), y: v.y + t * (w.y - v.y) }
  }

  const getSnappedPoint = (mousePoint) => {
    let bestPoint = null
    let minDist = Infinity
    for(let i = 0; i < segments.length; i++) {
      const pt = closestPointOnSegment(mousePoint, segmentStart(segments[i]), segmentEnd(segments[i]))
      const d = distSq(mousePoint, pt)
      if (d < minDist) { minDist = d; bestPoint = pt }
    }
    return bestPoint || mousePoint 
  }

  const getLogicalMousePos = (e) => {
    if (!svgRef.current) return { x: 0, y: 0 }
    const CTM = svgRef.current.getScreenCTM()
    return { x: (e.clientX - CTM.e) / CTM.a, y: (e.clientY - CTM.f) / CTM.d }
  }

  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const handleWheel = (e) => {
       e.preventDefault()
       e.stopPropagation()
       const zoomFactor = e.deltaY < 0 ? 1.15 : 0.85
       setZoom(z => Math.max(0.1, Math.min(20, z * zoomFactor)))
    }
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [])

  const isDragging = useRef(false)
  const lastPos = useRef({ x: 0, y: 0 })
  const hasMoved = useRef(false)

  const stopPointerInteraction = useCallback(() => {
    if (!isDragging.current) return
    isDragging.current = false
    onInteractionChange?.(false)
  }, [onInteractionChange])

  useEffect(() => {
    const finish = () => stopPointerInteraction()
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    window.addEventListener('blur', finish)
    return () => {
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', finish)
      stopPointerInteraction()
    }
  }, [stopPointerInteraction])

  const handlePointerDown = (e) => {
    if (e.button !== 0 && e.button !== 1 && e.button !== 2) return
    e.preventDefault()
    e.stopPropagation()
    isDragging.current = true
    onInteractionChange?.(true)
    hasMoved.current = false
    lastPos.current = { x: e.clientX, y: e.clientY }
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch {}
  }

  const handlePointerMove = (e) => {
    if (isDragging.current) {
        const dx = e.clientX - lastPos.current.x
        const dy = e.clientY - lastPos.current.y
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) hasMoved.current = true
        
        if (boundingBox) {
            const padX = boundingBox.width * 0.1 || 10
            const padY = boundingBox.height * 0.1 || 10
            const vW = (boundingBox.width + padX * 2) / zoom
            const vH = (boundingBox.height + padY * 2) / zoom
            
            const uniformScale = Math.max(vW / winSize.w, vH / winSize.h)
            
            setPan(p => ({ x: p.x - dx * uniformScale, y: p.y + dy * uniformScale }))
        }
        lastPos.current = { x: e.clientX, y: e.clientY }
    } else if (measureState.active && segments.length > 0) {
        const pos = getLogicalMousePos(e)
        const snap = getSnappedPoint(pos)
        setMeasureState(prev => ({ ...prev, p2: pos, snappedP2: snap }))
    }
  }

  const handlePointerUp = (e) => {
    const wasDragging = isDragging.current
    stopPointerInteraction()
    try {
      if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {}
    if (wasDragging && !hasMoved.current && e.button === 0) {
        if (measureState.active) {
            const pos = getLogicalMousePos(e)
            const snap = getSnappedPoint(pos)
            setMeasureState(prev => ({ ...prev, active: false, p2: snap, snappedP2: snap }))
        }
    }
  }

  const handleDoubleClick = (e) => {
    if (segments.length === 0) return
    const pos = getLogicalMousePos(e)
    const snap = getSnappedPoint(pos)
    setMeasureState({ active: true, p1: snap, p2: snap, snappedP2: snap })
  }
  
  const handleContextMenu = (e) => {
    e.preventDefault()
    if (measureState.active || measureState.p1) {
      setMeasureState({ active: false, p1: null, p2: null, snappedP2: null })
    }
  }

  const startResize = (e, dir) => {
      e.preventDefault()
      e.stopPropagation()
      userResizedRef.current = true
      onInteractionChange?.(true)
      const resizeHandle = e.currentTarget
      const pointerId = e.pointerId
      resizeHandle.setPointerCapture?.(pointerId)
      const startW = winSize.w
      const startH = winSize.h
      const startX = e.clientX
      const startY = e.clientY
      const previousUserSelect = document.body.style.userSelect
      document.body.style.userSelect = 'none'
      const onMove = (me) => {
          me.preventDefault()
          let newW = startW
          let newH = startH
          if (dir.includes('left')) newW = startW + (startX - me.clientX)
          if (dir.includes('right')) newW = startW + (me.clientX - startX)
          if (dir.includes('top')) newH = startH + (startY - me.clientY)

          setWinSize({ w: Math.max(250, newW), h: Math.max(200, newH) })
      }
      let finished = false
      const onUp = (upEvent) => {
          if (finished) return
          finished = true
          upEvent?.preventDefault?.()
          upEvent?.stopPropagation?.()
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onUp)
          window.removeEventListener('blur', onUp)
          if (resizeHandle.hasPointerCapture?.(pointerId)) resizeHandle.releasePointerCapture(pointerId)
          document.body.style.userSelect = previousUserSelect
          onInteractionChange?.(false)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
      window.addEventListener('blur', onUp)
  }

  if (!boundingBox) return null

  const padX = boundingBox.width * 0.1 || 10
  const padY = boundingBox.height * 0.1 || 10
  const baseW = boundingBox.width + padX * 2
  const baseH = boundingBox.height + padY * 2
  const vW = baseW / zoom
  const vH = baseH / zoom
  const vX = boundingBox.minX - padX + pan.x + (baseW - vW)/2
  const vY = boundingBox.minY - padY + pan.y + (baseH - vH)/2

  const vBox = `${vX} ${vY} ${vW} ${vH}`

  const svgToScreenRatio = Math.max(vW / winSize.w, vH / winSize.h)
  const dynamicStrokeWidth = 1.5 * svgToScreenRatio
  const dynamicPointRadius = 4 * svgToScreenRatio

  const distVal = measureState.p1 && measureState.snappedP2 
      ? Math.sqrt(distSq(measureState.p1, measureState.snappedP2)).toFixed(2) 
      : null

  return (
    <div 
      ref={containerRef}
      onPointerDownCapture={() => onActivate?.()}
      onWheel={(e) => {
         e.stopPropagation()
         const zoomFactor = e.deltaY < 0 ? 1.15 : 0.85
         setZoom(z => Math.max(0.1, Math.min(20, z * zoomFactor)))
      }}
      style={{
        position: embedded ? 'relative' : 'absolute',
        bottom: embedded ? 'auto' : 20,
        right: embedded ? 'auto' : 20,
        width: embedded ? '100%' : winSize.w,
        height: embedded ? '100%' : winSize.h,
        minWidth: 0,
        minHeight: 0,
        boxSizing: 'border-box',
        background: '#1a1a1a', border: active ? `2px solid ${accent}` : '1px solid #444', borderRadius: 8,
        zIndex: 100, overflow: embedded ? 'hidden' : 'visible', boxShadow: active ? `inset 0 0 0 1px ${accent}55, 0 0 18px ${accent}33` : embedded ? 'none' : '0 8px 32px rgba(0,0,0,0.5)',
        cursor: measureState.active ? 'crosshair' : 'grab',
        touchAction: mobile ? 'none' : 'auto',
        overscrollBehavior: mobile ? 'contain' : 'auto',
        WebkitUserSelect: mobile ? 'none' : 'auto',
        userSelect: mobile ? 'none' : 'auto'
      }}
    >
      <div style={{ position: 'absolute', top: 8, left: 16, fontSize: 11, color: '#aaa', pointerEvents: 'none', zIndex: 11 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          <b style={{ color: active ? accent : '#fff' }}>{title || (dicomSlice ? "DICOM řez + obrysy modelů" : "Obrysy modelů")}</b>
          {active && <span style={{ padding: '2px 5px', borderRadius: 4, background: `${accent}30`, border: `1px solid ${accent}88`, color: accent, fontSize: 9, fontWeight: 800 }}>AKTIVNÍ</span>}
        </span><br/>{mobile ? "Tažení = posun · dvojklep = měření" : "Levé tl. = posun, Kolečko = zoom, Dvojklik = měření"}
      </div>

      {!embedded && (
        <div 
          onPointerDown={(e) => startResize(e, 'top-left')}
          style={{ position: 'absolute', top: -5, left: -5, width: 16, height: 16, cursor: 'nwse-resize', zIndex: 12, background: 'rgba(255,255,255,0.15)', borderRadius: '50%' }}
          title="Zvětšit/Zmenšit"
        />
      )}

      <svg 
        ref={svgRef} 
        width="100%" height="100%" 
        viewBox={vBox}
        style={{ display: 'block', transform: 'scale(1, -1)', borderRadius: 8, overflow: 'hidden', touchAction: mobile ? 'none' : 'auto', overscrollBehavior: mobile ? 'contain' : 'auto' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
      >
        {dicomSlice && (
          <image
            href={dicomSlice.url}
            x={dicomSlice.bounds.minX}
            y={dicomSlice.bounds.minY}
            width={dicomSlice.bounds.width}
            height={dicomSlice.bounds.height}
            preserveAspectRatio="none"
            transform={`translate(0 ${dicomSlice.bounds.minY * 2 + dicomSlice.bounds.height}) scale(1 -1)`}
            opacity={0.96}
          />
        )}
        {pathDataByModel.map(({ modelIndex, d }) => (
          <path key={modelIndex} d={d} stroke={modelColors?.[modelIndex] || "#ffffff"} strokeWidth={dynamicStrokeWidth} strokeLinecap="round" strokeLinejoin="round" fill="none" />
        ))}

        {measureState.p1 && (
          <circle cx={measureState.p1.x} cy={measureState.p1.y} r={dynamicPointRadius} fill="#fbbf24" />
        )}
        
        {measureState.p1 && measureState.snappedP2 && (
          <>
            <line 
              x1={measureState.p1.x} y1={measureState.p1.y} 
              x2={measureState.snappedP2.x} y2={measureState.snappedP2.y} 
              stroke="#fbbf24" strokeWidth={dynamicStrokeWidth} opacity={0.7}
            />
            <circle cx={measureState.snappedP2.x} cy={measureState.snappedP2.y} r={dynamicPointRadius} fill="#fbbf24" />
            
            <text
              x={ (measureState.p1.x + measureState.snappedP2.x) / 2 }
              y={ -((measureState.p1.y + measureState.snappedP2.y) / 2 + 15 * svgToScreenRatio) }
              transform="scale(1, -1)"
              fill="none"
              stroke="black"
              strokeWidth={4 * svgToScreenRatio}
              strokeLinejoin="round"
              fontSize={14 * svgToScreenRatio}
              fontWeight="bold"
              textAnchor="middle"
              dominantBaseline="middle"
              style={{ pointerEvents: "none", userSelect: "none" }}
            >
              {distVal} mm
            </text>
            <text
              x={ (measureState.p1.x + measureState.snappedP2.x) / 2 }
              y={ -((measureState.p1.y + measureState.snappedP2.y) / 2 + 15 * svgToScreenRatio) }
              transform="scale(1, -1)"
              fill="#fbbf24"
              fontSize={14 * svgToScreenRatio}
              fontWeight="bold"
              textAnchor="middle"
              dominantBaseline="middle"
              style={{ pointerEvents: "none", userSelect: "none" }}
            >
              {distVal} mm
            </text>
          </>
        )}
      </svg>
    </div>
  )
}

/* ---------- Silnější vizuál rotačních oblouků ---------- */
function ThickRotationGizmo({ controlRef }) {
  const helpersRef = useRef([])
  const hiddenAxisLinesRef = useRef([])

  useEffect(() => {
    const control = controlRef.current
    const root = control?.getHelper ? control.getHelper() : control
    if (!root?.traverse) return

    const helpers = []
    const hiddenAxisLines = []
    const orbitNames = new Set(["X", "Y", "Z", "E", "XYZE"])
    root.traverse((child) => {
      if (child.isLine && child.name === "AXIS") {
        hiddenAxisLines.push({ line: child, visible: child.visible })
        child.visible = false
        return
      }
      if (!child.isLine || !orbitNames.has(child.name) || child.userData._thickOrbitSource) return
      const position = child.geometry?.attributes?.position
      if (!position || position.count < 8) return

      const points = []
      for (let i = 0; i < position.count; i++) points.push(new THREE.Vector3().fromBufferAttribute(position, i))
      const curve = new THREE.CatmullRomCurve3(points, false, "centripetal")
      const geometry = new THREE.TubeGeometry(curve, Math.max(32, position.count * 2), 0.022, 6, false)
      const material = new THREE.MeshBasicMaterial({
        color: child.material?.color || "#ffffff",
        transparent: true,
        opacity: child.material?.opacity ?? 1,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      })
      const helper = new THREE.Mesh(geometry, material)
      helper.name = "_thickOrbit"
      helper.userData._thickOrbitSource = true
      helper.raycast = () => {}
      const sourceMaterialVisible = child.material.visible
      child.material.visible = false
      child.add(helper)
      helpers.push({ source: child, helper, sourceMaterialVisible })
    })
    helpersRef.current = helpers
    hiddenAxisLinesRef.current = hiddenAxisLines

    return () => {
      helpers.forEach(({ source, helper, sourceMaterialVisible }) => {
        source.remove(helper)
        source.material.visible = sourceMaterialVisible
        helper.geometry.dispose()
        helper.material.dispose()
      })
      hiddenAxisLines.forEach(({ line, visible }) => { line.visible = visible })
      helpersRef.current = []
      hiddenAxisLinesRef.current = []
    }
  }, [controlRef])

  useFrame(() => {
    hiddenAxisLinesRef.current.forEach(({ line }) => { line.visible = false })
    helpersRef.current.forEach(({ source, helper }) => {
      if (source.material?.color) helper.material.color.copy(source.material.color)
      helper.material.opacity = source.material?.opacity ?? 1
    })
  })

  return null
}

/* ---------- Manažer kolize gizma a ovládání kamery ---------- */
function GizmoManager({ rotateRef, translateRef, secondaryTranslateRef, trackballRef, cameraInteractingRef, interactionBlocked = false }) {
  const isCamDragging = useRef(false)

  useEffect(() => {
    const ctrl = trackballRef.current
    if (!ctrl) return
    const disableGizmosForCamera = () => {
      const controls = [rotateRef?.current, translateRef?.current, secondaryTranslateRef?.current]
      controls.forEach((control) => {
        if (!control || control.dragging) return
        control.enabled = false
        control.axis = null
      })
    }
    const onStart = () => {
      isCamDragging.current = true
      disableGizmosForCamera()
    }
    const onEnd = () => { isCamDragging.current = false }
    ctrl.addEventListener('start', onStart)
    ctrl.addEventListener('end', onEnd)
    return () => {
      ctrl.removeEventListener('start', onStart)
      ctrl.removeEventListener('end', onEnd)
    }
  }, [rotateRef, translateRef, secondaryTranslateRef, trackballRef])

  useFrame(() => {
    const rotate = rotateRef?.current
    const translate = translateRef?.current
    const secondaryTranslate = secondaryTranslateRef?.current
    const translateActive = !!translate && (translate.axis !== null || translate.dragging)
    const secondaryTranslateActive = !!secondaryTranslate && (secondaryTranslate.axis !== null || secondaryTranslate.dragging)
    const rotateActive = !!rotate && (rotate.axis !== null || rotate.dragging)

    // Jakmile uživatel začne otáčet kamerou mimo gizmo, gizmo po celý tah
    // ignoruje hover i raycast. Přejetí přes jeho oblouky tak kameru nezastaví.
    if (isCamDragging.current || cameraInteractingRef?.current) {
      if (rotate && !rotate.dragging) { rotate.enabled = false; rotate.axis = null }
      if (translate && !translate.dragging) { translate.enabled = false; translate.axis = null }
      if (secondaryTranslate && !secondaryTranslate.dragging) { secondaryTranslate.enabled = false; secondaryTranslate.axis = null }
      if (trackballRef.current) trackballRef.current.enabled = true
      return
    }

    // Při překryvu má modrá posuvná osa přednost před rotačním kruhem.
    if (rotate) rotate.enabled = (!translateActive && !secondaryTranslateActive) || !!rotate.dragging
    if (translate) translate.enabled = !rotate?.dragging && !secondaryTranslate?.dragging
    if (secondaryTranslate) secondaryTranslate.enabled = !rotate?.dragging && !translate?.dragging
    const isHovered = translateActive || secondaryTranslateActive || rotateActive
    const isDragging = !!translate?.dragging || !!secondaryTranslate?.dragging || !!rotate?.dragging

    if (trackballRef.current) {
      if (interactionBlocked) {
        trackballRef.current.enabled = false
        return
      }
      if (isCamDragging.current) {
         trackballRef.current.enabled = true;
      } else {
         trackballRef.current.enabled = !(isHovered || isDragging);
      }
    }
  })
  return null
}

/* ---------- Hlavní komponenta ---------- */

/* ---------- ARTHETIC Color Picker ---------- */
const ARTHETIC_COLOR_PRESETS = ["#7F7F7F", "#AAA08E", "#DAD7D1", "#C68787", "#728E70", "#74849B"]

function normalizeColorHex(value, fallback = "#ffffff") {
  const text = String(value || "").trim()
  const short = text.match(/^#?([0-9a-f]{3})$/i)
  if (short) return `#${short[1].split("").map((part) => part + part).join("")}`.toLowerCase()
  const full = text.match(/^#?([0-9a-f]{6})$/i)
  return full ? `#${full[1]}`.toLowerCase() : fallback
}

function colorHexToRgb(value) {
  const hex = normalizeColorHex(value).slice(1)
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  }
}

function colorRgbToHex({ r, g, b }) {
  const part = (value) => Math.max(0, Math.min(255, Math.round(Number(value) || 0))).toString(16).padStart(2, "0")
  return `#${part(r)}${part(g)}${part(b)}`
}

function colorRgbToHsv({ r, g, b }) {
  const rn = r / 255, gn = g / 255, bn = b / 255
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn)
  const delta = max - min
  let h = 0
  if (delta > 0.000001) {
    if (max === rn) h = 60 * (((gn - bn) / delta) % 6)
    else if (max === gn) h = 60 * (((bn - rn) / delta) + 2)
    else h = 60 * (((rn - gn) / delta) + 4)
  }
  if (h < 0) h += 360
  return { h, s: max === 0 ? 0 : delta / max, v: max }
}

function colorHsvToRgb({ h, s, v }) {
  const hue = ((h % 360) + 360) % 360
  const c = v * s
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = v - c
  let rn = 0, gn = 0, bn = 0
  if (hue < 60) [rn, gn, bn] = [c, x, 0]
  else if (hue < 120) [rn, gn, bn] = [x, c, 0]
  else if (hue < 180) [rn, gn, bn] = [0, c, x]
  else if (hue < 240) [rn, gn, bn] = [0, x, c]
  else if (hue < 300) [rn, gn, bn] = [x, 0, c]
  else [rn, gn, bn] = [c, 0, x]
  return { r: (rn + m) * 255, g: (gn + m) * 255, b: (bn + m) * 255 }
}

function ArtheticInlineColorPicker({ value, onChange }) {
  const initialHex = normalizeColorHex(value)
  const [hsv, setHsv] = useState(() => colorRgbToHsv(colorHexToRgb(initialHex)))
  const [hexDraft, setHexDraft] = useState(initialHex.toUpperCase())
  const svRef = useRef(null)
  const hueRef = useRef(null)
  const lastEmittedHexRef = useRef("")

  useEffect(() => {
    const normalized = normalizeColorHex(value)
    // Do not collapse the hue UI endpoint 360° back to 0° when our own drag
    // emits #ff0000. They are the same color, but 360° intentionally means
    // "thumb parked at the right edge" while 0° means the left edge.
    if (normalized !== lastEmittedHexRef.current) {
      setHsv(colorRgbToHsv(colorHexToRgb(normalized)))
    }
    setHexDraft(normalized.toUpperCase())
    lastEmittedHexRef.current = ""
  }, [value])

  const emitHsv = useCallback((next) => {
    // Keep 360 as a valid UI endpoint. Color conversion treats 360° exactly like
    // 0° (red), but preserving 360 here keeps the hue thumb clamped to the right
    // edge instead of wrapping it instantly back to the left while dragging.
    const rawHue = Number(next.h)
    const normalized = {
      h: Math.max(0, Math.min(360, Number.isFinite(rawHue) ? rawHue : 0)),
      s: Math.max(0, Math.min(1, Number(next.s) || 0)),
      v: Math.max(0, Math.min(1, Number(next.v) || 0)),
    }
    setHsv(normalized)
    const nextHex = colorRgbToHex(colorHsvToRgb(normalized))
    setHexDraft(nextHex.toUpperCase())
    lastEmittedHexRef.current = normalizeColorHex(nextHex)
    onChange?.(nextHex)
  }, [onChange])

  const updateSvFromPointer = useCallback((event) => {
    const element = svRef.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const s = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)))
    const v = 1 - Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height)))
    emitHsv({ ...hsv, s, v })
  }, [emitHsv, hsv])

  const updateHueFromPointer = useCallback((event) => {
    const element = hueRef.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)))
    emitHsv({ ...hsv, h: ratio * 360 })
  }, [emitHsv, hsv])

  const rgb = colorHsvToRgb(hsv)
  const rgbRounded = { r: Math.round(rgb.r), g: Math.round(rgb.g), b: Math.round(rgb.b) }
  const currentHex = colorRgbToHex(rgbRounded)
  const canUseEyeDropper =
    typeof window !== "undefined" && typeof window.EyeDropper === "function"

  const pickScreenColor = async () => {
    if (!canUseEyeDropper) return
    try {
      const eyeDropper = new window.EyeDropper()
      const result = await eyeDropper.open()
      if (!result?.sRGBHex) return
      const nextHex = normalizeColorHex(result.sRGBHex)
      setHsv(colorRgbToHsv(colorHexToRgb(nextHex)))
      setHexDraft(nextHex.toUpperCase())
      lastEmittedHexRef.current = nextHex
      onChange?.(nextHex)
    } catch (error) {
      if (error?.name !== "AbortError") console.warn("[ARTHETIC] EyeDropper failed", error)
    }
  }


  return (
    <div style={{
      marginTop: 2, padding: 10, borderRadius: 11, gridColumn: "1 / -1",
      background: "rgba(8,8,8,.96)", border: "1px solid rgba(255,255,255,.085)",
      boxShadow: "0 14px 34px rgba(0,0,0,.28)", overflow: "hidden",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 9 }}>
        <div>
          <div style={{ color: "#d7d7d7", fontSize: 9.5, fontWeight: 720 }}>Barva modelu</div>
          <div style={{ color: "#676767", fontSize: 8.4, marginTop: 1 }}>HEX / PRESETY</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: "#8a8a8a", fontSize: 9, fontVariantNumeric: "tabular-nums" }}>{currentHex.toUpperCase()}</span>
          <button
            type="button"
            onClick={pickScreenColor}
            disabled={!canUseEyeDropper}
            title={canUseEyeDropper ? "Kapátko – vybrat barvu z obrazovky" : "Kapátko není v tomto prohlížeči podporované"}
            aria-label="Vybrat barvu kapátkem"
            style={{
              width: 25, height: 25, padding: 0, display: "grid", placeItems: "center",
              borderRadius: 7, border: "1px solid rgba(255,255,255,.09)",
              background: "rgba(255,255,255,.035)", color: canUseEyeDropper ? "#cfcfcf" : "#555",
              cursor: canUseEyeDropper ? "pointer" : "not-allowed", opacity: canUseEyeDropper ? 1 : .45,
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m19 3 2 2-9.6 9.6-3.1.7.7-3.1L19 3Z" />
              <path d="m14 6 4 4" />
              <path d="M6.5 14.5 3 18v3h3l3.5-3.5" />
            </svg>
          </button>
        </div>
      </div>

      <div
        ref={svRef}
        onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture?.(event.pointerId); updateSvFromPointer(event) }}
        onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture?.(event.pointerId)) updateSvFromPointer(event) }}
        onPointerUp={(event) => { try { event.currentTarget.releasePointerCapture?.(event.pointerId) } catch {} }}
        onPointerCancel={(event) => { try { event.currentTarget.releasePointerCapture?.(event.pointerId) } catch {} }}
        style={{
          position: "relative", height: 118, borderRadius: 9, overflow: "hidden", cursor: "crosshair", touchAction: "none",
          background: "#0b0b0b",
          border: "1px solid rgba(255,255,255,.08)", boxShadow: "inset 0 0 0 1px rgba(0,0,0,.18)",
        }}
      >
        {/* Neutral 1px gutter prevents saturated edge pixels from bleeding through
            the anti-aliased rounded corners on the opposite side of the SV field. */}
        <span style={{
          position: "absolute", inset: 1, borderRadius: 8, pointerEvents: "none",
          background: `linear-gradient(to top, #000 0%, transparent 100%), linear-gradient(to right, #fff 0%, hsl(${hsv.h}, 100%, 50%) 100%)`,
        }} />
        <span style={{
          position: "absolute", left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, width: 13, height: 13,
          borderRadius: "50%", border: "2px solid white", boxShadow: "0 1px 5px rgba(0,0,0,.8)",
          transform: "translate(-50%, -50%)", pointerEvents: "none", background: "transparent",
        }} />
      </div>

      <div
        ref={hueRef}
        onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture?.(event.pointerId); updateHueFromPointer(event) }}
        onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture?.(event.pointerId)) updateHueFromPointer(event) }}
        onPointerUp={(event) => { try { event.currentTarget.releasePointerCapture?.(event.pointerId) } catch {} }}
        onPointerCancel={(event) => { try { event.currentTarget.releasePointerCapture?.(event.pointerId) } catch {} }}
        style={{
          position: "relative", height: 12, marginTop: 9, borderRadius: 999, cursor: "ew-resize", touchAction: "none",
          background: "linear-gradient(90deg,#ff3b30 0%,#ffd60a 16.6%,#32d74b 33.3%,#64d2ff 50%,#0a84ff 66.6%,#bf5af2 83.3%,#ff375f 100%)",
          border: "1px solid rgba(255,255,255,.08)",
        }}
      >
        <span style={{
          position: "absolute", left: `${(hsv.h / 360) * 100}%`, top: "50%", width: 14, height: 14, borderRadius: "50%",
          background: `hsl(${hsv.h},100%,50%)`, border: "2px solid white", boxShadow: "0 1px 5px rgba(0,0,0,.7)",
          transform: "translate(-50%, -50%)", pointerEvents: "none",
        }} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(88px, 1fr) minmax(0, 1.72fr)", gap: 7, marginTop: 10, alignItems: "end" }}>
        <label style={{ minWidth: 0 }}>
          <span style={{ display: "block", color: "#666", fontSize: 8, fontWeight: 700, marginBottom: 4 }}>HEX</span>
          <input
            value={hexDraft}
            onChange={(event) => {
              const text = event.target.value.toUpperCase()
              setHexDraft(text)
              if (/^#?[0-9A-F]{6}$/.test(text)) {
                const nextHex = normalizeColorHex(text)
                setHsv(colorRgbToHsv(colorHexToRgb(nextHex)))
                onChange?.(nextHex)
              }
            }}
            onBlur={() => setHexDraft(normalizeColorHex(value).toUpperCase())}
            spellCheck={false}
            style={{ width: "100%", height: 29, boxSizing: "border-box", borderRadius: 7, border: "1px solid rgba(255,255,255,.085)", background: "rgba(255,255,255,.035)", color: "#e5e5e5", padding: "0 8px", outline: "none", fontSize: 9, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", textTransform: "uppercase" }}
          />
        </label>

        <div style={{ minWidth: 0 }}>
          <span style={{ display: "block", color: "#666", fontSize: 8, fontWeight: 700, marginBottom: 4 }}>PRESETY</span>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 4, height: 29, alignItems: "center" }}>
            {ARTHETIC_COLOR_PRESETS.map((preset) => {
              const normalizedPreset = normalizeColorHex(preset)
              const isActive = normalizedPreset === normalizeColorHex(currentHex)
              return (
                <button
                  key={preset}
                  type="button"
                  title={preset}
                  aria-label={`Použít barvu ${preset}`}
                  aria-pressed={isActive}
                  onClick={() => {
                    setHsv(colorRgbToHsv(colorHexToRgb(normalizedPreset)))
                    setHexDraft(normalizedPreset.toUpperCase())
                    lastEmittedHexRef.current = normalizedPreset
                    onChange?.(normalizedPreset)
                  }}
                  style={{
                    width: "100%", maxWidth: 23, minWidth: 0, aspectRatio: "1 / 1", justifySelf: "center", padding: 0,
                    borderRadius: 6, border: isActive ? "2px solid rgba(255,255,255,.92)" : "1px solid rgba(255,255,255,.13)",
                    background: preset, cursor: "pointer",
                    boxShadow: isActive ? "0 0 0 2px rgba(255,255,255,.10), inset 0 0 0 1px rgba(0,0,0,.18)" : "inset 0 0 0 1px rgba(0,0,0,.16)",
                    transform: isActive ? "scale(1.04)" : "scale(1)",
                    transition: "transform .14s ease, border-color .14s ease, box-shadow .14s ease",
                  }}
                />
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}


function AlignmentTerminalTypedText({ text, speed = 15, enabled = true, delay = 28 }) {
  const safeText = String(text || "")
  const [visibleLength, setVisibleLength] = useState(enabled ? 0 : safeText.length)

  useEffect(() => {
    if (!enabled) {
      setVisibleLength(safeText.length)
      return undefined
    }

    setVisibleLength(0)
    if (!safeText) return undefined

    let cancelled = false
    let timer = null
    let index = 0

    const typeNext = () => {
      if (cancelled) return
      index = Math.min(safeText.length, index + 1)
      setVisibleLength(index)
      if (index >= safeText.length) return

      const previousChar = safeText[index - 1] || ""
      const pause = /[.,:;/]/.test(previousChar) ? 24 : previousChar === " " ? 4 : 0
      timer = window.setTimeout(typeNext, speed + pause)
    }

    // Delay dovoluje dokončovací sekvenci psát skutečně řádek po řádku.
    timer = window.setTimeout(typeNext, Math.max(0, delay))
    return () => {
      cancelled = true
      if (timer != null) window.clearTimeout(timer)
    }
  }, [safeText, speed, enabled, delay])

  return <>{safeText.slice(0, visibleLength)}</>
}

export default function ClientPage() {
  const hideSidebar = getParam("hideSidebar") === "1"; // ÚPRAVA 1: Zjištění, jestli máme schovat levý panel
  const [sceneIntensity, setSceneIntensity] = useState(1)
  const [highlightIntensity, setHighlightIntensity] = useState(1)
  const [headlightCfg, setHeadlightCfg] = useState({ enabled: true, intensity: 2.0 })

  const [isMobile, setIsMobile] = useState(false)

  // ÚPRAVA 2: Zapnutý auto-spin ve výchozím stavu a rychlost nastavena na 0.25
  const [isAutoRotating, setIsAutoRotating] = useState(true)
  const [spinSpeed, setSpinSpeed] = useState(0.25)
  const [spinIconNonce, setSpinIconNonce] = useState(0)

  useEffect(() => {
    try {
      const uaMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
      const coarse = typeof window !== "undefined" && window.matchMedia && window.matchMedia("(pointer: coarse)").matches
      const narrow = typeof window !== "undefined" && window.innerWidth < 768
      setIsMobile(uaMobile || coarse || narrow)
    } catch {}
  }, [])

  // ÚPRAVA 3: Jakmile uživatel klikne nebo zatočí kolečkem NA PLÁTNĚ, vypneme rotaci
  useEffect(() => {
    const stopSpin = (e) => {
      // Chceme to vypnout jen, když uživatel zasáhne do samotného 3D renderu
      if (e.target && e.target.tagName && e.target.tagName.toLowerCase() === 'canvas') {
        setIsAutoRotating(false)
      }
    }
    window.addEventListener('pointerdown', stopSpin, true)
    window.addEventListener('wheel', stopSpin, true)
    return () => {
      window.removeEventListener('pointerdown', stopSpin, true)
      window.removeEventListener('wheel', stopSpin, true)
    }
  }, [])

  const [title, setTitle] = useState(null)
  const [caseCloudContext, setCaseCloudContext] = useState({
    sceneId: null,
    labCaseId: null,
    patientName: null,
  })
  const [logoCfg, setLogoCfg] = useState({ url: DEFAULT_LOGO, opacity: 0.9, width: 160, pos: "bc" })

  const [files, setFiles] = useState([])
  const [colors, setColors] = useState([])
  const [openColorPickerUrl, setOpenColorPickerUrl] = useState(null)
  const [opacities, setOpacities] = useState([])
  const [visibles, setVisibles] = useState([])
  const [roughnesses, setRoughnesses] = useState([])
  const [metalnesses, setMetalnesses] = useState([])
  const [vertexColors, setVertexColors] = useState([])
  const [wireframes, setWireframes] = useState([])
  const [ghostModes, setGhostModes] = useState([])
  const [fatal, setFatal] = useState(null)

  const [dicomSource, setDicomSource] = useState(null)
  const [dicomSettings, setDicomSettings] = useState(DEFAULT_DICOM_SETTINGS)
  const [dicomVolume, setDicomVolume] = useState(null)
  const [dicomStatus, setDicomStatus] = useState("idle")
  const [dicomProgress, setDicomProgress] = useState(0)
  const [dicomError, setDicomError] = useState("")
  const dicomAbortRef = useRef(null)

  const applyDicomSource = useCallback((source) => {
    if (!source?.u) {
      dicomAbortRef.current?.abort()
      dicomAbortRef.current = null
      setDicomSource(null)
      setDicomVolume(null)
      setDicomStatus("idle")
      setDicomError("")
      isPlaneInitialized.current = false
      isHorizontalPlaneInitialized.current = false
      isSliceRigInitialized.current = false
      return
    }
    setDicomSource((previous) => {
      if (previous?.u && previous.u !== source.u) {
        dicomAbortRef.current?.abort()
        setDicomVolume(null)
        setDicomStatus("idle")
        setDicomError("")
        isPlaneInitialized.current = false
        isHorizontalPlaneInitialized.current = false
        isSliceRigInitialized.current = false
      }
      return source
    })
    setDicomSettings((previous) => ({
      ...DEFAULT_DICOM_SETTINGS,
      ...previous,
      ...(source.settings || {}),
      viewMode: normalizeDicomViewMode(source.settings?.viewMode),
      quality: DICOM_DETAIL_QUALITY,
      position: Array.isArray(source.settings?.position) ? source.settings.position : previous.position,
      rotation: Array.isArray(source.settings?.rotation) ? source.settings.rotation : previous.rotation,
    }))
  }, [])

  const startDicomLoad = useCallback(async (sourceOverride = null, force = false) => {
    const source = sourceOverride?.u ? sourceOverride : dicomSource
    if (!source?.u || (!force && (dicomStatus === "downloading" || dicomStatus === "processing"))) return
    dicomAbortRef.current?.abort()
    const controller = new AbortController()
    dicomAbortRef.current = controller
    setDicomSettings((previous) => {
      const sourceSettings = { ...(source.settings || {}) }
      return {
        ...previous,
        ...sourceSettings,
        viewMode: normalizeDicomViewMode(sourceSettings.viewMode ?? previous.viewMode),
        quality: DICOM_DETAIL_QUALITY,
      }
    })
    setDicomError("")
    setDicomProgress(0)
    setDicomStatus("downloading")
    try {
      const volume = await loadDicomZip(
        source.u,
        DICOM_DETAIL_QUALITY,
        source.size,
        (progress) => {
          setDicomProgress(progress.percent || 0)
          setDicomStatus(progress.phase === "process" ? "processing" : "downloading")
        },
        controller.signal
      )
      if (controller.signal.aborted) return
      setDicomVolume(volume)
      setDicomStatus("ready")
    } catch (error) {
      if (error?.name === "AbortError") {
        setDicomStatus("idle")
        return
      }
      console.error("DICOM load error:", error)
      setDicomError(error?.message || "DICOM data se nepodařilo načíst.")
      setDicomStatus("error")
    }
  }, [dicomSource, dicomSettings, dicomStatus])

  useEffect(() => () => dicomAbortRef.current?.abort(), [])

  // -- STAVY PRO ŘEZÁNÍ A ANIMACI --
  const [clippingEnabled, setClippingEnabled] = useState(false)
  const [sliceRigGroup, setSliceRigGroup] = useState(null)
  const [planeGroup, setPlaneGroup] = useState(null) 
  const [horizontalPlaneGroup, setHorizontalPlaneGroup] = useState(null)
  const [planeRadius, setPlaneRadius] = useState(100) 
  const [activeSlice, setActiveSlice] = useState("vertical")
  const clipPlaneRef = useRef(new THREE.Plane(new THREE.Vector3(1, 0, 0), 0))
  
  const transformRotateRef = useRef(null) 
  const transformTranslateRef = useRef(null) 
  
  const isPlaneInitialized = useRef(false)
  const isHorizontalPlaneInitialized = useRef(false)
  const isSliceRigInitialized = useRef(false)
  const sliceRigMatrixRef = useRef(new THREE.Matrix4())
  const planeMatrixRef = useRef(new THREE.Matrix4())
  const horizontalPlaneMatrixRef = useRef(new THREE.Matrix4())

  const [sliceSegments, setSliceSegments] = useState([])
  const [sliceBBox, setSliceBBox] = useState(null)
  const [dicomSlice2D, setDicomSlice2D] = useState(null)
  const [measureState, setMeasureState] = useState({ active: false, p1: null, p2: null, snappedP2: null })
  const [horizontalSliceSegments, setHorizontalSliceSegments] = useState([])
  const [horizontalSliceBBox, setHorizontalSliceBBox] = useState(null)
  const [horizontalDicomSlice2D, setHorizontalDicomSlice2D] = useState(null)
  const [horizontalMeasureState, setHorizontalMeasureState] = useState({ active: false, p1: null, p2: null, snappedP2: null })

  // DICOM rozvržení používá oba řezy automaticky. Efekt se spustí při dokončení
  // načtení CT, uživatel ale může průřezy následně ručně vypnout.
  useEffect(() => {
    if (dicomSource && dicomStatus === "ready") setClippingEnabled(true)
  }, [dicomSource, dicomStatus])

  useEffect(() => {
    if (dicomSource && dicomSettings.viewMode === "only2d") setClippingEnabled(true)
  }, [dicomSource, dicomSettings.viewMode])

  const [mobileFunctionsOpen, setMobileFunctionsOpen] = useState(false)
  const [mobileFunctionsSheetHeight, setMobileFunctionsSheetHeight] = useState(null)
  const [mobileFunctionsSheetDragging, setMobileFunctionsSheetDragging] = useState(false)
  const mobileFunctionsSheetDragRef = useRef(null)

  const getMobileFunctionsSheetBounds = useCallback(() => {
    if (typeof window === "undefined") return { min: 300, compact: 430, expanded: 650 }
    const viewport = Math.max(520, window.innerHeight || 0)
    return {
      min: Math.min(320, viewport * 0.38),
      compact: Math.min(500, viewport * 0.56),
      expanded: Math.min(760, viewport * 0.84),
    }
  }, [])

  const beginMobileFunctionsSheetDrag = useCallback((event) => {
    if (typeof window === "undefined") return
    event.preventDefault()
    event.stopPropagation()
    const bounds = getMobileFunctionsSheetBounds()
    const startHeight = Number.isFinite(mobileFunctionsSheetHeight) ? mobileFunctionsSheetHeight : bounds.compact
    const target = event.currentTarget
    try { target.setPointerCapture?.(event.pointerId) } catch {}
    mobileFunctionsSheetDragRef.current = {
      pointerId: event.pointerId,
      target,
      startY: event.clientY,
      startHeight,
      lastHeight: startHeight,
      ...bounds,
    }
    setMobileFunctionsSheetDragging(true)
  }, [getMobileFunctionsSheetBounds, mobileFunctionsSheetHeight])

  const moveMobileFunctionsSheetDrag = useCallback((event) => {
    const drag = mobileFunctionsSheetDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    const next = Math.max(drag.min, Math.min(drag.expanded, drag.startHeight + drag.startY - event.clientY))
    drag.lastHeight = next
    setMobileFunctionsSheetHeight(next)
  }, [])

  const endMobileFunctionsSheetDrag = useCallback((event) => {
    const drag = mobileFunctionsSheetDragRef.current
    if (!drag || (event?.pointerId != null && drag.pointerId !== event.pointerId)) return
    event?.preventDefault?.()
    event?.stopPropagation?.()
    try { drag.target?.releasePointerCapture?.(drag.pointerId) } catch {}
    const height = drag.lastHeight
    mobileFunctionsSheetDragRef.current = null
    setMobileFunctionsSheetDragging(false)

    if (height < drag.compact * 0.72) {
      setMobileFunctionsOpen(false)
      setMobileFunctionsSheetHeight(null)
      return
    }
    const snap = height >= (drag.compact + drag.expanded) / 2 ? drag.expanded : drag.compact
    setMobileFunctionsSheetHeight(snap)
  }, [])

  useEffect(() => {
    if (!mobileFunctionsOpen || !isMobile) return
    const bounds = getMobileFunctionsSheetBounds()
    setMobileFunctionsSheetHeight((current) => Number.isFinite(current) ? current : bounds.compact)
    return () => {
      mobileFunctionsSheetDragRef.current = null
      setMobileFunctionsSheetDragging(false)
    }
  }, [mobileFunctionsOpen, isMobile, getMobileFunctionsSheetBounds])
  const [heatmapMenuOpen, setHeatmapMenuOpen] = useState(false)
  const [heatmapSelection, setHeatmapSelection] = useState([])
  const [isCalculatingHeatmap, setIsCalculatingHeatmap] = useState(false)
  
  const [hasComputedHeatmap, setHasComputedHeatmap] = useState(false)
  const [showHeatmap, setShowHeatmap] = useState(false)

  const [comparisonMenuOpen, setComparisonMenuOpen] = useState(false)
  const [comparisonSelection, setComparisonSelection] = useState([])
  const [isCalculatingComparison, setIsCalculatingComparison] = useState(false)
  const [surfaceAnalysisProgress, setSurfaceAnalysisProgress] = useState(null)
  const [hasComputedComparison, setHasComputedComparison] = useState(false)
  const [showComparison, setShowComparison] = useState(false)
  const [comparisonTolerance, setComparisonTolerance] = useState(0.25)
  const [comparisonStats, setComparisonStats] = useState(null)
  const [comparisonDirection, setComparisonDirection] = useState("A_TO_B") // A_TO_B | B_TO_A
  // Persistovaný výsledek deviation mapy. Obsahuje komprimované vzdálenosti pro
  // oba směry + fingerprint modelů a jejich přesných transformací.
  const [comparisonSnapshot, setComparisonSnapshot] = useState(null)
  const [restoringAnalysisMode, setRestoringAnalysisMode] = useState(null)
  const [surfaceAnalysisStartedAt, setSurfaceAnalysisStartedAt] = useState(null)
  const [surfaceAnalysisElapsed, setSurfaceAnalysisElapsed] = useState(0)
  const surfaceAnalysisElapsedDisplayRef = useRef(null)
  const [surfaceAnalysisCompletion, setSurfaceAnalysisCompletion] = useState(null) // null | { kind: "comparison" | "occlusion", phase: "show" | "fade", elapsed }

  useEffect(() => {
    if (!isMobile) {
      setMobileFunctionsOpen(false)
      setMobileFunctionsSheetHeight(null)
    }
  }, [isMobile])

  // -- ZAROVNÁNÍ / REGISTRACE MODELŮ --
  const [alignmentMode, setAlignmentMode] = useState(false)
  const [alignmentTransition, setAlignmentTransition] = useState("idle") // idle | entering | active | exiting
  const [alignmentSelection, setAlignmentSelection] = useState([])
  const [alignmentPointsA, setAlignmentPointsA] = useState([])
  const [alignmentPointsB, setAlignmentPointsB] = useState([])
  const [alignmentBusy, setAlignmentBusy] = useState(false)
  const [alignmentProgress, setAlignmentProgress] = useState(null)
  const [alignmentStats, setAlignmentStats] = useState(null)
  const [alignmentMessage, setAlignmentMessage] = useState("")
  const [alignmentStartedAt, setAlignmentStartedAt] = useState(null)
  const [alignmentElapsed, setAlignmentElapsed] = useState(0)
  const alignmentElapsedDisplayRef = useRef(null)
  const [alignmentCompletion, setAlignmentCompletion] = useState(null) // null | { kind: "alignment" | "deviation", phase: "show" | "fade", elapsed, improved? }
  const [alignmentOperation, setAlignmentOperation] = useState(null) // null | "bestfit" | "deviation"
  const [alignmentPreviewBusy, setAlignmentPreviewBusy] = useState({ A: false, B: false })
  const [alignmentWorkflowStage, setAlignmentWorkflowStage] = useState("points") // points | prealigned | bestfit
  const [alignmentStep, setAlignmentStep] = useState("models") // models | points | prealign | bestfit
  const [alignmentPrealignMatrix, setAlignmentPrealignMatrix] = useState(null)
  const [modelTransforms, setModelTransforms] = useState({})
  // Session výsledky Best Fitu. U veřejného odkazu existují jen do zavření stránky;
  // interní editor je může explicitně uložit jako nový Attachment do zakázky.
  const [alignedExportsByUrl, setAlignedExportsByUrl] = useState({})
  const [alignedExportBusyUrl, setAlignedExportBusyUrl] = useState("")
  const [editorCapabilities, setEditorCapabilities] = useState({ canSaveAlignedToCase: false, canSaveTrimmedToCase: false })
  const alignmentPointerHintRef = useRef(null)
  const alignmentSceneHoveredUrlRef = useRef("")
  const alignmentWorkerRef = useRef(null)
  const alignmentWorkerRequestsRef = useRef(new Map())
  const alignmentWorkerRequestIdRef = useRef(0)
  const alignmentWorkerFailedRef = useRef(false)

  // -- OŘEZ MODELU --
  const [trimMode, setTrimMode] = useState(false)
  const [trimStage, setTrimStage] = useState("model") // model | boundary | region | result
  const [trimSelection, setTrimSelection] = useState("")
  const [trimContext, setTrimContext] = useState(null)
  // Control point je přesný bod uvnitř face, ne snapnutý vertex. Díky tomu může
  // křivka v10 skutečně protínat jednotlivé trojúhelníky.
  const [trimControlNodes, setTrimControlNodes] = useState([])
  const [trimSegments, setTrimSegments] = useState([])
  const [trimClosed, setTrimClosed] = useState(false)
  const [trimKeepComponent, setTrimKeepComponent] = useState(null)
  const [trimHoverComponent, setTrimHoverComponent] = useState(null)
  const [trimDraggingPoint, setTrimDraggingPoint] = useState(null)
  const [trimBusy, setTrimBusy] = useState(false)
  const [trimMessage, setTrimMessage] = useState("")
  const [trimmedExportsByUrl, setTrimmedExportsByUrl] = useState({})
  const [trimExportBusyUrl, setTrimExportBusyUrl] = useState("")
  const trimHistoryByUrlRef = useRef({})
  const trimLastDragUpdateRef = useRef(0)
  const trimPendingDragHitRef = useRef(null)
  const trimBoundaryPlan = useMemo(() => {
    if (!trimClosed || !trimContext || !trimSegments.length) return null
    try { return buildTrimBoundaryPlan(trimContext, trimSegments) }
    catch (error) { console.warn("Trim boundary plan failed:", error); return null }
  }, [trimClosed, trimContext, trimSegments])

  // Komunikace s interním Case Cloud editorem. Veřejný viewer může stejné
  // zprávy posílat, ale bez autorizovaného parentu se nic neuloží.
  useEffect(() => {
    if (typeof window === "undefined") return undefined
    const onMessage = (event) => {
      if (event.source !== window.parent) return
      if (event.data?.type !== "ARTHETIC_EDITOR_CAPABILITIES") return
      const payload = event.data?.payload || {}
      setEditorCapabilities({ canSaveAlignedToCase: !!payload.canSaveAlignedToCase, canSaveTrimmedToCase: !!payload.canSaveTrimmedToCase })
    }
    window.addEventListener("message", onMessage)
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: "ARTHETIC_VIEWER_READY_FOR_EDITOR_CAPABILITIES" }, "*")
    }
    return () => window.removeEventListener("message", onMessage)
  }, [])

  useEffect(() => {
    if (typeof window === "undefined" || !window.parent || window.parent === window) return
    window.parent.postMessage({
      type: "ARTHETIC_ALIGNMENT_MODE",
      payload: { active: !!alignmentMode && alignmentTransition !== "exiting" },
    }, "*")
  }, [alignmentMode, alignmentTransition])

  useEffect(() => {
    if (typeof window === "undefined" || !window.parent || window.parent === window) return
    window.parent.postMessage({
      type: "ARTHETIC_TRIM_MODE",
      payload: { active: !!trimMode },
    }, "*")
  }, [trimMode])

  useEffect(() => {
    if (!USE_ALIGNMENT_WORKER || typeof Worker === "undefined") return undefined

    let worker = null
    try {
      worker = new Worker(new URL("./workers/analysis.worker.js", import.meta.url), { type: "module" })
    } catch (error) {
      alignmentWorkerFailedRef.current = true
      console.warn("[ARTHETIC Align Worker] Worker se nepodařilo vytvořit, používám legacy Best Fit.", error)
      return undefined
    }

    alignmentWorkerRef.current = worker
    alignmentWorkerFailedRef.current = false

    const rejectAll = (error) => {
      for (const request of alignmentWorkerRequestsRef.current.values()) request.reject(error)
      alignmentWorkerRequestsRef.current.clear()
    }

    const handleMessage = (event) => {
      const message = event.data || {}
      if (message.type === "READY") {
        console.info("[ARTHETIC Align Worker] připraven")
        return
      }

      const request = alignmentWorkerRequestsRef.current.get(message.requestId)
      if (!request) return

      if (message.type === "PROGRESS") {
        request.onProgress?.(message.progress)
        return
      }

      alignmentWorkerRequestsRef.current.delete(message.requestId)

      if (message.type === "RESULT") {
        request.resolve({ result: message.result, timings: message.timings || null })
        return
      }

      if (message.type === "ERROR") {
        const error = new Error(message.message || "Best Fit Worker selhal.")
        error.alignmentWorkerKind = message.kind || "algorithm"
        if (message.stack) error.workerStack = message.stack
        request.reject(error)
      }
    }

    const handleError = (event) => {
      alignmentWorkerFailedRef.current = true
      const error = new Error(event?.message || "Best Fit Worker není dostupný.")
      error.alignmentWorkerKind = "infrastructure"
      console.error("[ARTHETIC Align Worker] runtime error:", event)
      rejectAll(error)
      try { worker?.terminate() } catch {}
      if (alignmentWorkerRef.current === worker) alignmentWorkerRef.current = null
    }

    worker.addEventListener("message", handleMessage)
    worker.addEventListener("error", handleError)

    return () => {
      worker.removeEventListener("message", handleMessage)
      worker.removeEventListener("error", handleError)
      const error = new Error("Best Fit Worker byl ukončen.")
      error.alignmentWorkerKind = "infrastructure"
      rejectAll(error)
      try { worker.terminate() } catch {}
      if (alignmentWorkerRef.current === worker) alignmentWorkerRef.current = null
    }
  }, [])

  const runAlignmentWorkerBestFit = useCallback((payload, transferables, onProgress) => {
    const worker = alignmentWorkerRef.current
    if (!USE_ALIGNMENT_WORKER || !worker || alignmentWorkerFailedRef.current) {
      const error = new Error("Best Fit Worker není připravený.")
      error.alignmentWorkerKind = "infrastructure"
      return Promise.reject(error)
    }

    const requestId = `align-${Date.now()}-${++alignmentWorkerRequestIdRef.current}`
    return new Promise((resolve, reject) => {
      alignmentWorkerRequestsRef.current.set(requestId, { resolve, reject, onProgress })
      try {
        worker.postMessage({ type: "BEST_FIT", requestId, payload }, transferables)
      } catch (error) {
        alignmentWorkerRequestsRef.current.delete(requestId)
        error.alignmentWorkerKind = "infrastructure"
        reject(error)
      }
    })
  }, [])

  const runSurfaceWorkerAnalysis = useCallback((type, payload, transferables, onProgress) => {
    const worker = alignmentWorkerRef.current
    if (!USE_ALIGNMENT_WORKER || !worker || alignmentWorkerFailedRef.current) {
      const error = new Error("Analysis Worker není připravený.")
      error.alignmentWorkerKind = "infrastructure"
      return Promise.reject(error)
    }

    const requestId = `surface-${Date.now()}-${++alignmentWorkerRequestIdRef.current}`
    return new Promise((resolve, reject) => {
      alignmentWorkerRequestsRef.current.set(requestId, { resolve, reject, onProgress })
      try {
        worker.postMessage({ type, requestId, payload }, transferables)
      } catch (error) {
        alignmentWorkerRequestsRef.current.delete(requestId)
        error.alignmentWorkerKind = "infrastructure"
        reject(error)
      }
    })
  }, [])

  const runOcclusionAnalysis = useCallback(async (meshA, meshB, maxDist = 2.0, invertSign = false, onProgress) => {
    if (USE_ALIGNMENT_WORKER && alignmentWorkerRef.current && !alignmentWorkerFailedRef.current) {
      try {
        const { payload, transferables } = buildSurfaceAnalysisWorkerPayload(meshA, meshB, { maxDist, invertSign })
        const response = await runSurfaceWorkerAnalysis("OCCLUSION", payload, transferables, onProgress)
        installWorkerOcclusionResult(meshA, response.result)
        if (response.timings) console.info("[ARTHETIC Analysis Worker] Okluze timing", response.timings)
        return
      } catch (workerError) {
        if (workerError?.alignmentWorkerKind === "algorithm") throw workerError
        console.warn("[ARTHETIC Analysis Worker] Okluze používá legacy výpočet:", workerError)
      }
    }
    onProgress?.({ percent: 5, phase: "legacy" })
    applyOcclusionHeatmap(meshA, meshB, maxDist, invertSign)
    onProgress?.({ percent: 100, phase: "done" })
  }, [runSurfaceWorkerAnalysis])

  const runComparisonAnalysis = useCallback(async (meshA, meshB, tolerance = 0.25, onProgress) => {
    if (USE_ALIGNMENT_WORKER && alignmentWorkerRef.current && !alignmentWorkerFailedRef.current) {
      try {
        const { payload, transferables } = buildSurfaceAnalysisWorkerPayload(meshA, meshB, { tolerance })
        const response = await runSurfaceWorkerAnalysis("COMPARISON", payload, transferables, onProgress)
        const stats = installWorkerComparisonResult(meshA, meshB, response.result)
        if (response.timings) console.info("[ARTHETIC Analysis Worker] Porovnání timing", response.timings)
        return { stats, snapshotData: response.result?.snapshot || null }
      } catch (workerError) {
        if (workerError?.alignmentWorkerKind === "algorithm") throw workerError
        console.warn("[ARTHETIC Analysis Worker] Porovnání používá legacy výpočet:", workerError)
      }
    }
    onProgress?.({ percent: 5, phase: "legacy" })
    const stats = applySurfaceComparison(meshA, meshB, tolerance)
    onProgress?.({ percent: 100, phase: "done" })
    return { stats, snapshotData: null }
  }, [runSurfaceWorkerAnalysis])

  const restoreComparisonAnalysisSnapshot = useCallback(async (meshA, meshB, snapshotEnvelope, tolerance, onProgress) => {
    if (!snapshotEnvelope?.data) throw new Error("Uložený výsledek odchylky neobsahuje data.")
    const worker = alignmentWorkerRef.current
    if (!USE_ALIGNMENT_WORKER || !worker || alignmentWorkerFailedRef.current) {
      throw new Error("Analysis Worker není připravený pro rychlé obnovení uložené odchylky.")
    }
    const response = await runSurfaceWorkerAnalysis(
      "RESTORE_COMPARISON_SNAPSHOT",
      { snapshot: snapshotEnvelope.data, tolerance, stats: snapshotEnvelope.stats || null },
      [],
      onProgress,
    )
    const stats = installWorkerComparisonResult(meshA, meshB, response.result)
    if (response.timings) console.info("[ARTHETIC Analysis Worker] Uložená odchylka obnovena", response.timings)
    return stats || snapshotEnvelope.stats || null
  }, [runSurfaceWorkerAnalysis])

  useEffect(() => {
    if (alignmentCompletion) {
      const frozen = Number.isFinite(alignmentCompletion.elapsed) ? alignmentCompletion.elapsed : alignmentElapsed
      if (alignmentElapsedDisplayRef.current) alignmentElapsedDisplayRef.current.textContent = `${Math.max(0, frozen).toFixed(2)} s`
      return undefined
    }

    if (!alignmentBusy || !alignmentStartedAt) {
      if (!alignmentBusy) setAlignmentElapsed(0)
      if (alignmentElapsedDisplayRef.current) alignmentElapsedDisplayRef.current.textContent = "0.00 s"
      return undefined
    }

    let raf = 0
    let lastStateUpdateAt = 0
    const update = (now) => {
      const elapsed = Math.max(0, (performance.now() - alignmentStartedAt) / 1000)

      // Čas vpravo aktualizujeme přímo přes rAF, takže běží plynule bez rerenderu
      // celého vieweru na každém snímku. React state stačí pro heartbeat terminálu.
      if (alignmentElapsedDisplayRef.current) {
        alignmentElapsedDisplayRef.current.textContent = `${elapsed.toFixed(2)} s`
      }
      if (now - lastStateUpdateAt >= 180) {
        lastStateUpdateAt = now
        setAlignmentElapsed(elapsed)
      }
      raf = requestAnimationFrame(update)
    }

    raf = requestAnimationFrame(update)
    return () => cancelAnimationFrame(raf)
  }, [alignmentBusy, alignmentStartedAt, alignmentCompletion])

  useEffect(() => {
    if (surfaceAnalysisCompletion) {
      const frozen = Number.isFinite(surfaceAnalysisCompletion.elapsed) ? surfaceAnalysisCompletion.elapsed : surfaceAnalysisElapsed
      if (surfaceAnalysisElapsedDisplayRef.current) surfaceAnalysisElapsedDisplayRef.current.textContent = `${Math.max(0, frozen).toFixed(2)} s`
      return undefined
    }

    const running = isCalculatingHeatmap || isCalculatingComparison
    if (!running || !surfaceAnalysisStartedAt) {
      if (!running) setSurfaceAnalysisElapsed(0)
      if (surfaceAnalysisElapsedDisplayRef.current) surfaceAnalysisElapsedDisplayRef.current.textContent = "0.00 s"
      return undefined
    }

    let raf = 0
    let lastStateUpdateAt = 0
    const update = (now) => {
      const elapsed = Math.max(0, (performance.now() - surfaceAnalysisStartedAt) / 1000)
      if (surfaceAnalysisElapsedDisplayRef.current) {
        surfaceAnalysisElapsedDisplayRef.current.textContent = `${elapsed.toFixed(2)} s`
      }
      if (now - lastStateUpdateAt >= 180) {
        lastStateUpdateAt = now
        setSurfaceAnalysisElapsed(elapsed)
      }
      raf = requestAnimationFrame(update)
    }

    raf = requestAnimationFrame(update)
    return () => cancelAnimationFrame(raf)
  }, [isCalculatingHeatmap, isCalculatingComparison, surfaceAnalysisStartedAt, surfaceAnalysisCompletion])

  const runSurfaceCompletionSequence = useCallback(async (kind, startedAt) => {
    const completedElapsed = Math.max(0, (performance.now() - startedAt) / 1000)
    setSurfaceAnalysisElapsed(completedElapsed)
    setSurfaceAnalysisStartedAt(null)
    setSurfaceAnalysisCompletion({ kind, phase: "show", elapsed: completedElapsed })
    // Hlavní scéna: closing sekvence Porovnání/Okluze je záměrně svižnější
    // než BestFit / Odchylka uvnitř režimu Zarovnání.
    await new Promise((resolve) => window.setTimeout(resolve, 1350))
    setSurfaceAnalysisCompletion((current) => current ? { ...current, phase: "fade" } : current)
    await new Promise((resolve) => window.setTimeout(resolve, 280))
  }, [])

  const [pinnedNotes, setPinnedNotes] = useState([])
  const [pendingViewerState, setPendingViewerState] = useState(null)
  const restoredViewerStateRef = useRef(null)
  const pendingClipStateRef = useRef(null)

  const tooltipRef = useRef(null)

  const [photos, setPhotos] = useState([])
  const [lightbox, setLightbox] = useState({ open: false, src: null, alt: "" })

  const [photosOpen, setPhotosOpen] = useState(!isMobile)
  useEffect(() => { setPhotosOpen(!isMobile) }, [isMobile])
  const [slidersOpen, setSlidersOpen] = useState(!isMobile)
  useEffect(() => { setSlidersOpen(!isMobile) }, [isMobile])

  const trackballRef = useRef(null)
  const cameraInteractingRef = useRef(false)
  const rootGroupRef = useRef(null)
  const [cameraTarget, setCameraTarget] = useState([0, 0, 0])
  const [sliceOverlayInteracting, setSliceOverlayInteracting] = useState(false)
  const handleSliceOverlayInteraction = useCallback((active) => {
    setSliceOverlayInteracting(active)
    if (trackballRef.current) trackballRef.current.enabled = !active
  }, [])
  const handleCameraInteraction = useCallback((active) => {
    cameraInteractingRef.current = active
    if (!active) return
    ;[transformRotateRef.current, transformTranslateRef.current].forEach((control) => {
      if (!control || control.dragging) return
      control.enabled = false
      control.axis = null
    })
  }, [])
  const [didInitialFrame, setDidInitialFrame] = useState(false)
  const [initialCameraState, setInitialCameraState] = useState(null)
  
  const [loadedUrls, setLoadedUrls] = useState(new Set())
  const handleModelLoaded = (url) => setLoadedUrls((prev) => { const n = new Set(prev); n.add(url); return n; })

  useEffect(() => {
    if (!isAutoRotating) return
    let frameA = 0, frameB = 0
    const restartSpinIcon = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return
      frameA = requestAnimationFrame(() => {
        frameB = requestAnimationFrame(() => setSpinIconNonce((value) => value + 1))
      })
    }
    restartSpinIcon()
    document.addEventListener("visibilitychange", restartSpinIcon)
    return () => {
      cancelAnimationFrame(frameA)
      cancelAnimationFrame(frameB)
      document.removeEventListener("visibilitychange", restartSpinIcon)
    }
  }, [isAutoRotating, files.length, loadedUrls.size])

  const [hasTexMap, setHasTexMap] = useState({})
  const meshesRef = useRef({})
  const modelObjectsRef = useRef({})
  const analysisFilesKey = files.map((file) => file.url).join("|")

  useEffect(() => {
    setHeatmapSelection([])
    setComparisonSelection([])
    setHasComputedHeatmap(false)
    setHasComputedComparison(false)
    setShowHeatmap(false)
    setShowComparison(false)
    setComparisonStats(null)
    setComparisonSnapshot(null)
    setPinnedNotes([])
    setAlignmentMode(false)
    setAlignmentTransition("idle")
    setSurfaceAnalysisCompletion(null)
    setSurfaceAnalysisStartedAt(null)
    setSurfaceAnalysisElapsed(0)
    setAlignmentSelection([])
    setAlignmentPointsA([])
    setAlignmentPointsB([])
    setAlignmentStats(null)
    setAlignmentProgress(null)
    setAlignmentCompletion(null)
    setAlignmentOperation(null)
    setAlignmentMessage("")
    setAlignmentWorkflowStage("points")
    setAlignmentStep("models")
    setAlignmentPrealignMatrix(null)
    setModelTransforms({})
    setAlignedExportsByUrl({})
    setAlignedExportBusyUrl("")
    setTrimMode(false)
    setTrimStage("model")
    setTrimSelection("")
    setTrimContext(null)
    setTrimControlNodes([])
    setTrimSegments([])
    setTrimClosed(false)
    setTrimHoverComponent(null)
    
    setTrimKeepComponent(null)
    setTrimDraggingPoint(null)
    setTrimBusy(false)
    setTrimMessage("")
    setTrimmedExportsByUrl({})
    setTrimExportBusyUrl("")
    trimHistoryByUrlRef.current = {}
    meshesRef.current = {}
    modelObjectsRef.current = {}
  }, [analysisFilesKey])
  
  const detectObjectTextureData = useCallback((object) => {
    if (!object) return false
    if (object.userData?._hasVisualTexture === true) return true
    let hasTextureData = false
    object.traverse((child) => {
      if (hasTextureData || !child?.isMesh) return
      const geometry = child.geometry
      if (geometry?.getAttribute?.("color")) {
        hasTextureData = true
        return
      }
      const materials = Array.isArray(child.material) ? child.material : [child.material]
      hasTextureData = materials.filter(Boolean).some((material) => !!material.map)
    })
    return hasTextureData
  }, [])

  const handleMeshReady = useCallback((mesh, url) => {
    meshesRef.current[url] = mesh
  }, [])

  const handleObjectReady = useCallback((object, url) => {
    modelObjectsRef.current[url] = object
    const matrix = modelTransforms[url]
    object.matrixAutoUpdate = false
    if (Array.isArray(matrix) && matrix.length === 16) object.matrix.fromArray(matrix)
    else object.matrix.identity()
    object.updateMatrixWorld(true)

    const hasTextureData = detectObjectTextureData(object)
    setHasTexMap((previous) => ({ ...previous, [url]: hasTextureData }))

    const fileIndex = files.findIndex((file) => file.url === url)
    if (fileIndex >= 0) {
      const requestedTextureState = files[fileIndex]?.vc
      setVertexColors((previous) => previous.map((value, index) =>
        index === fileIndex
          ? (hasTextureData && requestedTextureState !== false)
          : value
      ))
    }
  }, [modelTransforms, files, detectObjectTextureData])

  // Report the *real* texture capability/state back to embedding editors.
  // This keeps LabCaseDetail / New Case controls in sync with what the loaded
  // geometry actually contains instead of relying on manifest defaults.
  useEffect(() => {
    if (typeof window === "undefined") return
    const targetWindow = window.top || window.parent
    if (!targetWindow) return

    files.forEach((file, index) => {
      if (!file?.url || !Object.prototype.hasOwnProperty.call(hasTexMap, file.url)) return
      const hasTextureData = !!hasTexMap[file.url]
      targetWindow.postMessage({
        type: "SHADE3D_MODEL_TEXTURE_STATE",
        payload: {
          url: file.url,
          name: file.rawName || file.name || `Model ${index + 1}`,
          hasTextureData,
          enabled: hasTextureData && !!vertexColors[index],
        },
      }, "*")
    })
  }, [files, hasTexMap, vertexColors])

  const comparisonModelFingerprint = useCallback((url) => {
    const file = files.find((item) => item.url === url)
    const mesh = meshesRef.current[url]
    const object = modelObjectsRef.current[url]
    const vertexCount = mesh?.geometry?.getAttribute?.("position")?.count || 0
    return {
      file: file?.rawName || file?.name || url,
      vertexCount,
      matrix: object?.matrix?.toArray?.() || IDENTITY_MATRIX_ARRAY.slice(),
    }
  }, [files])

  const createComparisonSnapshotEnvelope = useCallback((snapshotData, aUrl, bUrl, tolerance, stats) => {
    if (!snapshotData || !aUrl || !bUrl) return null
    return {
      version: 1,
      kind: "surface-comparison",
      tolerance: Number(tolerance) || 0.25,
      a: comparisonModelFingerprint(aUrl),
      b: comparisonModelFingerprint(bUrl),
      stats: stats ? { ...stats } : null,
      data: snapshotData,
    }
  }, [comparisonModelFingerprint])

  const isComparisonSnapshotValid = useCallback((snapshot, aUrl, bUrl, tolerance) => {
    if (!snapshot || snapshot.version !== 1 || snapshot.kind !== "surface-comparison") return false
    if (Math.abs((Number(snapshot.tolerance) || 0) - (Number(tolerance) || 0)) > 1e-9) return false
    const currentA = comparisonModelFingerprint(aUrl)
    const currentB = comparisonModelFingerprint(bUrl)
    const sameModel = (saved, current) => !!saved && !!current &&
      saved.file === current.file &&
      Number(saved.vertexCount) === Number(current.vertexCount) &&
      matrixArraysAlmostEqual(saved.matrix, current.matrix)
    return sameModel(snapshot.a, currentA) && sameModel(snapshot.b, currentB) && !!snapshot.data
  }, [comparisonModelFingerprint])

  const invalidateComparisonResult = useCallback(() => {
    setHasComputedComparison(false)
    setShowComparison(false)
    setComparisonStats(null)
    setComparisonSnapshot(null)
    setPinnedNotes((previous) => previous.filter((note) => note.mode !== "comparison"))
    if (tooltipRef.current) tooltipRef.current.style.opacity = "0"
  }, [])

  const applyModelTransform = useCallback((url, matrixValue) => {
    const array = matrixArrayOrIdentity(matrixValue).slice()
    // Jakákoli další změna polohy modelu zneplatní předchozí export Best Fitu.
    setAlignedExportsByUrl((previous) => {
      if (!previous[url]) return previous
      const next = { ...previous }
      delete next[url]
      return next
    })
    // Jakákoli změna polohy modelu zneplatní dříve spočítanou deviation mapu.
    // Nikdy tak nezůstane heatmapa/metrika svázaná se starou transformací.
    invalidateComparisonResult()
    setModelTransforms((previous) => ({ ...previous, [url]: array }))
    const object = modelObjectsRef.current[url]
    if (object) {
      object.matrixAutoUpdate = false
      object.matrix.fromArray(array)
      object.matrixWorldNeedsUpdate = true
      object.updateMatrixWorld(true)
    }
    rootGroupRef.current?.updateMatrixWorld(true)
    // Alignment transform nesmí měnit kameru ani znovu spouštět AutoFrame.
  }, [invalidateComparisonResult])

  const createAlignedExport = useCallback(async (url) => {
    const info = alignedExportsByUrl[url]
    const file = files.find((item) => item.url === url)
    const sourceObject = modelObjectsRef.current[url]
    if (!info || !file || !sourceObject || !rootGroupRef.current) {
      throw new Error("Pro tento model zatím není dokončený Best Fit.")
    }

    const ext = inferExt(file.rawName || file.name || file.url)
    if (!["stl", "ply", "obj"].includes(ext)) throw new Error(`Export .${ext || "?"} není podporovaný.`)

    setAlignedExportBusyUrl(url)
    let exportObject = null
    try {
      exportObject = buildBakedAlignedExportObject(sourceObject, rootGroupRef.current)
      const blob = await alignedObjectToBlob(exportObject, ext)
      const referenceFile = files.find((item) => item.url === info.referenceUrl)
      return {
        blob,
        ext,
        mimeType: alignedExportMime(ext),
        name: makeAlignedExportName(file),
        derivedFrom: file.rawName || file.name || makeAlignedExportName(file),
        alignmentReference: referenceFile?.rawName || referenceFile?.name || "Reference A",
        alignmentMatrix: matrixArrayOrIdentity(info.matrix).slice(),
        alignmentRms: Number.isFinite(info.rms) ? info.rms : null,
        alignmentP95: Number.isFinite(info.p95) ? info.p95 : null,
      }
    } finally {
      disposeAlignedExportObject(exportObject)
      setAlignedExportBusyUrl("")
    }
  }, [alignedExportsByUrl, files])

  const downloadAlignedModel = useCallback(async (url) => {
    try {
      const result = await createAlignedExport(url)
      const objectUrl = URL.createObjectURL(result.blob)
      const anchor = document.createElement("a")
      anchor.href = objectUrl
      anchor.download = result.name
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1500)
    } catch (error) {
      console.error("Aligned export download error:", error)
      setAlignmentMessage(error?.message || "Zarovnaný model se nepodařilo exportovat.")
    }
  }, [createAlignedExport])

  const saveAlignedModelToCase = useCallback(async (url) => {
    if (!editorCapabilities.canSaveAlignedToCase || !window.parent || window.parent === window) return
    try {
      const result = await createAlignedExport(url)
      const buffer = await result.blob.arrayBuffer()
      window.parent.postMessage({
        type: "ARTHETIC_SAVE_ALIGNED_MODEL",
        payload: {
          name: result.name,
          ext: result.ext,
          mimeType: result.mimeType,
          buffer,
          derivedFrom: result.derivedFrom,
          alignmentReference: result.alignmentReference,
          alignmentMatrix: result.alignmentMatrix,
          alignmentRms: result.alignmentRms,
          alignmentP95: result.alignmentP95,
          createdAt: new Date().toISOString(),
        },
      }, "*", [buffer])
      setAlignedExportsByUrl((previous) => previous[url]
        ? { ...previous, [url]: { ...previous[url], saveRequested: true } }
        : previous)
      setAlignmentMessage("Zarovnaný model byl předán k uložení do zakázky.")
    } catch (error) {
      console.error("Aligned export save error:", error)
      setAlignmentMessage(error?.message || "Zarovnaný model se nepodařilo připravit k uložení.")
    }
  }, [createAlignedExport, editorCapabilities.canSaveAlignedToCase])


  const clearTrimWorkingState = useCallback(() => {
    setTrimStage("model")
    setTrimSelection("")
    setTrimContext(null)
    setTrimControlNodes([])
    setTrimSegments([])
    setTrimClosed(false)
    setTrimKeepComponent(null)
    setTrimHoverComponent(null)
    setTrimDraggingPoint(null)
    setTrimBusy(false)
    setTrimMessage("")
    if (trackballRef.current) trackballRef.current.enabled = !sliceOverlayInteracting && !alignmentBusy
  }, [sliceOverlayInteracting, alignmentBusy])

  const closeTrimMode = useCallback(() => {
    clearTrimWorkingState()
    setTrimMode(false)
  }, [clearTrimWorkingState])

  const openTrimMode = useCallback(() => {
    const eligible = files.filter((file) => ["stl", "ply", "obj"].includes(inferExt(file.rawName || file.name || file.url)))
    if (!eligible.length) {
      setTrimMessage("Pro Ořez je potřeba alespoň jeden STL, PLY nebo OBJ model.")
      return
    }
    setHeatmapMenuOpen(false)
    setComparisonMenuOpen(false)
    setShowHeatmap(false)
    setShowComparison(false)
    setIsAutoRotating(false)
    clearTrimWorkingState()
    setTrimMode(true)
    setTrimMessage("Vyberte model, který chcete oříznout.")
  }, [files, clearTrimWorkingState])

  const selectTrimModel = useCallback((url) => {
    if (!trimMode || trimBusy || !url) return
    const object = modelObjectsRef.current[url]
    if (!object) {
      setTrimMessage("Model ještě není načtený. Zkuste to za okamžik.")
      return
    }
    setTrimBusy(true)
    setTrimMessage("Připravuji povrchovou síť pro Ořez…")
    window.setTimeout(() => {
      try {
        const context = buildTrimMeshContext(object)
        setTrimSelection(url)
        setTrimContext(context)
        setTrimControlNodes([])
        setTrimSegments([])
        setTrimClosed(false)
        setTrimKeepComponent(null)
        setTrimHoverComponent(null)
        setTrimStage("boundary")
        setTrimMessage("Klikáním umístěte body hranice. Kuličku můžete kdykoliv přetáhnout po povrchu; první žlutou kuličku dvojklikem uzavřete.")
      } catch (error) {
        console.error("Trim context error:", error)
        setTrimMessage(error?.message || "Povrch modelu se nepodařilo připravit pro Ořez.")
      } finally {
        setTrimBusy(false)
      }
    }, 30)
  }, [trimMode, trimBusy])

  const closeTrimLoop = useCallback(() => {
    if (!trimContext || trimClosed || trimControlNodes.length < 3) return
    const last = trimControlNodes[trimControlNodes.length - 1]
    const first = trimControlNodes[0]
    const closingPath = trimTriangleSurfacePath(trimContext, last, first)
    if (!closingPath?.pieces?.length) {
      setTrimMessage("Poslední úsek hranice se nepodařilo propojit po povrchu.")
      return
    }
    setTrimSegments((previous) => [...previous, closingPath])
    setTrimClosed(true)
    setTrimKeepComponent(null)
    setTrimHoverComponent(null)
    setTrimStage("boundary")
    setTrimMessage("Hranice je uzavřená. Body můžete dál posouvat. Najeďte na část modelu pro náhled a kliknutím potvrďte oblast, kterou chcete zachovat.")
  }, [trimContext, trimClosed, trimControlNodes])

  const addTrimControlNode = useCallback((hit) => {
    if (!trimContext || trimClosed || !hit?.point || !Number.isInteger(hit.triangleIndex)) return
    const points = trimControlNodes
    if (!points.length) {
      setTrimControlNodes([hit])
      return
    }
    const last = points[points.length - 1]
    if (trimVec(last.point).distanceTo(trimVec(hit.point)) < trimContext.diagonal * 1e-5) return
    const path = trimTriangleSurfacePath(trimContext, last, hit)
    if (!path?.pieces?.length) {
      setTrimMessage("Tento úsek se nepodařilo vést po povrchu modelu. Zkuste bod umístit o něco blíž.")
      return
    }
    setTrimControlNodes([...points, hit])
    setTrimSegments((previous) => [...previous, path])
  }, [trimContext, trimClosed, trimControlNodes])

  const moveTrimControlNode = useCallback((index, hit) => {
    if (!trimContext || index == null || !hit?.point || !Number.isInteger(hit.triangleIndex) || !trimControlNodes[index]) return
    if (trimVec(trimControlNodes[index].point).distanceToSquared(trimVec(hit.point)) < 1e-12) return
    const points = trimControlNodes.slice()
    const segments = trimSegments.slice()
    points[index] = hit

    if (index > 0) {
      const path = trimTriangleSurfacePath(trimContext, points[index - 1], hit)
      if (path?.pieces?.length) segments[index - 1] = path
    } else if (trimClosed && points.length > 2) {
      const path = trimTriangleSurfacePath(trimContext, points[points.length - 1], hit)
      if (path?.pieces?.length) segments[points.length - 1] = path
    }
    if (index < points.length - 1) {
      const path = trimTriangleSurfacePath(trimContext, hit, points[index + 1])
      if (path?.pieces?.length) segments[index] = path
    } else if (trimClosed && points.length > 2) {
      const path = trimTriangleSurfacePath(trimContext, hit, points[0])
      if (path?.pieces?.length) segments[points.length - 1] = path
    }

    setTrimControlNodes(points)
    setTrimSegments(segments)
    setTrimKeepComponent(null)
    setTrimHoverComponent(null)
    setTrimStage("boundary")
    if (trimClosed) setTrimMessage("Hranice byla upravena. Najeďte na požadovanou část pro nový náhled a kliknutím ji potvrďte.")
  }, [trimContext, trimControlNodes, trimSegments, trimClosed])

  const handleTrimSurfaceClick = useCallback((url, event) => {
    if (!trimMode || !trimContext || url !== trimSelection || trimBusy || trimDraggingPoint != null) return
    const hit = resolveTrimHit(trimContext, modelObjectsRef.current[url], event)
    if (!hit) return
    if (!trimClosed) {
      addTrimControlNode(hit)
      return
    }
    if (!trimBoundaryPlan || trimBoundaryPlan.components.length < 2) {
      setTrimMessage("Tato hranice zatím nerozdělila povrch na dvě oblasti. Upravte některý bod a zkuste to znovu.")
      return
    }
    const component = resolveTrimComponentFromHit(trimContext, trimBoundaryPlan, hit)
    if (component == null) return
    const kept = trimBoundaryPlan.components[component]?.length || 0
    setTrimKeepComponent(component)
    setTrimHoverComponent(null)
    setTrimStage("region")
    setTrimMessage(`Oblast potvrzena · přibližně ${kept.toLocaleString("cs-CZ")} původních faces zůstane. Body můžete stále posunout, nebo potvrďte Oříznout.`)
  }, [trimMode, trimContext, trimSelection, trimBusy, trimDraggingPoint, trimClosed, trimBoundaryPlan, addTrimControlNode])

  const handleTrimSurfaceMove = useCallback((url, event) => {
    if (!trimMode || !trimContext || url !== trimSelection || trimBusy) return
    if (trimDraggingPoint == null && cameraInteractingRef.current) return
    const hit = resolveTrimHit(trimContext, modelObjectsRef.current[url], event)
    if (!hit) return

    if (trimDraggingPoint != null) {
      event.stopPropagation?.()
      trimPendingDragHitRef.current = hit
      const now = typeof performance !== "undefined" ? performance.now() : Date.now()
      if (now - trimLastDragUpdateRef.current >= 75) {
        trimLastDragUpdateRef.current = now
        trimPendingDragHitRef.current = null
        moveTrimControlNode(trimDraggingPoint, hit)
      }
      return
    }

    if (trimClosed && trimBoundaryPlan && trimKeepComponent == null) {
      const component = resolveTrimComponentFromHit(trimContext, trimBoundaryPlan, hit)
      if (component !== trimHoverComponent) setTrimHoverComponent(component)
    }
  }, [trimMode, trimContext, trimSelection, trimBusy, trimDraggingPoint, trimClosed, trimBoundaryPlan, trimKeepComponent, trimHoverComponent, moveTrimControlNode])

  const handleTrimSurfaceOut = useCallback(() => {
    if (trimKeepComponent == null && trimDraggingPoint == null) setTrimHoverComponent(null)
  }, [trimKeepComponent, trimDraggingPoint])

  const beginTrimPointDrag = useCallback((index) => {
    if (!trimMode || trimBusy) return
    trimLastDragUpdateRef.current = 0
    trimPendingDragHitRef.current = null
    setTrimDraggingPoint(index)
    setTrimKeepComponent(null)
    setTrimHoverComponent(null)
    if (trackballRef.current) trackballRef.current.enabled = false
  }, [trimMode, trimBusy])

  useEffect(() => {
    if (trimDraggingPoint == null) return
    const finish = () => {
      const pendingHit = trimPendingDragHitRef.current
      trimPendingDragHitRef.current = null
      if (pendingHit) moveTrimControlNode(trimDraggingPoint, pendingHit)
      setTrimDraggingPoint(null)
      if (trackballRef.current) trackballRef.current.enabled = !sliceOverlayInteracting && !alignmentBusy
    }
    window.addEventListener("pointerup", finish)
    window.addEventListener("pointercancel", finish)
    window.addEventListener("blur", finish)
    return () => {
      window.removeEventListener("pointerup", finish)
      window.removeEventListener("pointercancel", finish)
      window.removeEventListener("blur", finish)
    }
  }, [trimDraggingPoint, sliceOverlayInteracting, alignmentBusy, moveTrimControlNode])

  const removeLastTrimPoint = useCallback(() => {
    if (trimClosed || trimControlNodes.length === 0) return
    setTrimControlNodes((previous) => previous.slice(0, -1))
    setTrimSegments((previous) => previous.slice(0, -1))
    setTrimKeepComponent(null)
    setTrimHoverComponent(null)
  }, [trimClosed, trimControlNodes.length])

  const resetTrimBoundary = useCallback(() => {
    setTrimControlNodes([])
    setTrimSegments([])
    setTrimClosed(false)
    setTrimKeepComponent(null)
    setTrimHoverComponent(null)
    setTrimStage("boundary")
    setTrimMessage("Klikáním umístěte novou hranici Ořezu.")
  }, [])

  const applyTrimResult = useCallback(() => {
    if (!trimContext || !trimBoundaryPlan || trimKeepComponent == null || !trimSelection || trimBusy) return
    setTrimBusy(true)
    setTrimMessage("Ořezávám geometrii skrz jednotlivé faces…")
    window.setTimeout(() => {
      try {
        const backup = applyTrimRegionToObject(trimContext, trimBoundaryPlan, trimKeepComponent)
        const stack = trimHistoryByUrlRef.current[trimSelection] || []
        trimHistoryByUrlRef.current[trimSelection] = [...stack, backup]
        setTrimmedExportsByUrl((previous) => ({
          ...previous,
          [trimSelection]: {
            createdAt: new Date().toISOString(),
            pointCount: trimControlNodes.length,
            saveRequested: false,
          },
        }))
        invalidateComparisonResult()
        setHasComputedHeatmap(false); setShowHeatmap(false)
        setTrimStage("result")
        setTrimKeepComponent(null)
        setTrimHoverComponent(null)
        setTrimMessage("Ořez je hotový. Hrana je vytvořená skrz faces modelu; výsledek můžete stáhnout, uložit do zakázky nebo vrátit.")
      } catch (error) {
        console.error("Trim apply error:", error)
        setTrimMessage(error?.message || "Ořez se nepodařilo aplikovat.")
      } finally {
        setTrimBusy(false)
      }
    }, 30)
  }, [trimContext, trimBoundaryPlan, trimKeepComponent, trimSelection, trimBusy, trimControlNodes.length, invalidateComparisonResult])

  const undoLastTrim = useCallback((url = trimSelection) => {
    if (!url) return
    const stack = trimHistoryByUrlRef.current[url] || []
    const backup = stack[stack.length - 1]
    if (!backup) {
      setTrimMessage("Pro tento model není v aktuální session žádný Ořez k vrácení.")
      return
    }
    restoreTrimBackup(backup)
    const nextStack = stack.slice(0, -1)
    trimHistoryByUrlRef.current[url] = nextStack
    if (!nextStack.length) {
      setTrimmedExportsByUrl((previous) => {
        const next = { ...previous }; delete next[url]; return next
      })
    } else {
      setTrimmedExportsByUrl((previous) => previous[url]
        ? { ...previous, [url]: { ...previous[url], saveRequested: false } }
        : previous)
    }
    setTrimContext(null)
    setTrimControlNodes([]); setTrimSegments([]); setTrimClosed(false); setTrimKeepComponent(null); setTrimHoverComponent(null)
    setTrimStage("model")
    setTrimSelection("")
    setTrimMessage("Poslední Ořez byl vrácen. Vyberte model pro další úpravu.")
  }, [trimSelection])

  const createTrimmedExport = useCallback(async (url) => {
    const info = trimmedExportsByUrl[url]
    const file = files.find((item) => item.url === url)
    const sourceObject = modelObjectsRef.current[url]
    if (!info || !file || !sourceObject || !rootGroupRef.current) throw new Error("Pro tento model zatím není dokončený Ořez.")
    const ext = inferExt(file.rawName || file.name || file.url)
    if (!["stl", "ply", "obj"].includes(ext)) throw new Error(`Export .${ext || "?"} není podporovaný.`)
    setTrimExportBusyUrl(url)
    let exportObject = null
    try {
      exportObject = buildBakedAlignedExportObject(sourceObject, rootGroupRef.current)
      const blob = await alignedObjectToBlob(exportObject, ext)
      return {
        blob,
        ext,
        mimeType: alignedExportMime(ext),
        name: makeTrimmedExportName(file, !!alignedExportsByUrl[url]),
        derivedFrom: file.rawName || file.name || makeTrimmedExportName(file),
        pointCount: Number(info.pointCount) || null,
      }
    } finally {
      disposeAlignedExportObject(exportObject)
      setTrimExportBusyUrl("")
    }
  }, [trimmedExportsByUrl, files, alignedExportsByUrl])

  const downloadTrimmedModel = useCallback(async (url) => {
    try {
      const result = await createTrimmedExport(url)
      const objectUrl = URL.createObjectURL(result.blob)
      const anchor = document.createElement("a")
      anchor.href = objectUrl; anchor.download = result.name
      document.body.appendChild(anchor); anchor.click(); anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1500)
    } catch (error) {
      console.error("Trim export download error:", error)
      setTrimMessage(error?.message || "Ořezaný model se nepodařilo exportovat.")
    }
  }, [createTrimmedExport])

  const saveTrimmedModelToCase = useCallback(async (url) => {
    if (!editorCapabilities.canSaveTrimmedToCase || !window.parent || window.parent === window) return
    try {
      const result = await createTrimmedExport(url)
      const buffer = await result.blob.arrayBuffer()
      window.parent.postMessage({
        type: "ARTHETIC_SAVE_TRIMMED_MODEL",
        payload: {
          name: result.name,
          ext: result.ext,
          mimeType: result.mimeType,
          buffer,
          derivedFrom: result.derivedFrom,
          trimPointCount: result.pointCount,
          createdAt: new Date().toISOString(),
        },
      }, "*", [buffer])
      setTrimmedExportsByUrl((previous) => previous[url]
        ? { ...previous, [url]: { ...previous[url], saveRequested: true } }
        : previous)
      setTrimMessage("Ořezaný model byl předán k uložení do zakázky.")
    } catch (error) {
      console.error("Trim export save error:", error)
      setTrimMessage(error?.message || "Ořezaný model se nepodařilo připravit k uložení.")
    }
  }, [createTrimmedExport, editorCapabilities.canSaveTrimmedToCase])

  const getAlignmentPair = useCallback(() => {
    if (alignmentSelection.length !== 2) return { aUrl: null, bUrl: null, fileA: null, fileB: null }
    const [aUrl, bUrl] = alignmentSelection
    return {
      aUrl,
      bUrl,
      fileA: files.find((file) => file.url === aUrl) || null,
      fileB: files.find((file) => file.url === bUrl) || null,
    }
  }, [alignmentSelection, files])

  const openAlignmentMode = useCallback(() => {
    const eligible = files.filter((file) => ["stl", "ply", "obj"].includes(inferExt(file.rawName || file.name || file.url)))
    if (eligible.length < 2) {
      setAlignmentMessage("Pro zarovnání jsou potřeba alespoň dva 3D modely.")
      return
    }
    // Pracovní viewporty A/B se při vstupu záměrně otevřou prázdné.
    // Hlavní scéna zůstává beze změny a uživatel si oba modely vybere přímo dole.
    setAlignmentSelection(["", ""])
    setAlignmentPointsA([])
    setAlignmentPointsB([])
    setAlignmentTransition("entering")
    setAlignmentMode(true)
    requestAnimationFrame(() => requestAnimationFrame(() => setAlignmentTransition("active")))
    setAlignmentMessage("Vyberte model Reference A a model Moving B v pracovních oknech dole.")
    setAlignmentProgress(null)
    setAlignmentStats(null)
    setAlignmentWorkflowStage("points")
    setAlignmentStep("models")
    setAlignmentPrealignMatrix(null)
    setAlignmentPreviewBusy({ A: false, B: false })
    setIsAutoRotating(false)
    setHeatmapMenuOpen(false)
    setComparisonMenuOpen(false)
    setShowHeatmap(false)
    setShowComparison(false)
  }, [files])

  const closeAlignmentMode = useCallback(() => {
    if (alignmentBusy || !alignmentMode || alignmentTransition === "exiting") return
    setAlignmentTransition("exiting")
    window.setTimeout(() => {
      setAlignmentMode(false)
      setAlignmentTransition("idle")
      setAlignmentMessage("")
    }, 480)
  }, [alignmentBusy, alignmentMode, alignmentTransition])

  const changeAlignmentSelection = useCallback(async (side, url) => {
    const index = side === "A" ? 0 : 1
    const otherIndex = index === 0 ? 1 : 0

    if (!url) {
      setAlignmentSelection((previous) => {
        const next = previous.length === 2 ? [...previous] : ["", ""]
        next[index] = ""
        return next
      })
      setAlignmentPreviewBusy((previous) => ({ ...previous, [side]: false }))
      setAlignmentPointsA([])
      setAlignmentPointsB([])
      setAlignmentStats(null)
      setAlignmentProgress(null)
      setAlignmentWorkflowStage("points")
      setAlignmentStep("models")
      setAlignmentPrealignMatrix(null)
      setAlignmentMessage(side === "A" ? "Vyberte model Reference A." : "Vyberte model Moving B.")
      return
    }

    // Po kliknutí model okamžitě přestane být hover kandidátem pro další krok.
    alignmentSceneHoveredUrlRef.current = ""
    if (alignmentPointerHintRef.current) {
      alignmentPointerHintRef.current.style.borderColor = "rgba(255,255,255,.12)"
      alignmentPointerHintRef.current.style.background = "rgba(12,12,12,.92)"
      alignmentPointerHintRef.current.style.color = "#eeeeee"
      const dot = alignmentPointerHintRef.current.querySelector?.("[data-align-pointer-dot]")
      if (dot) dot.style.background = "#9a9a9a"
    }

    // Loader zapneme ještě PŘED změnou modelu a necháme ho jeden frame vykreslit.
    setAlignmentPreviewBusy((previous) => ({ ...previous, [side]: true }))
    await alignmentPaintYield()

    setAlignmentSelection((previous) => {
      const next = previous.length === 2 ? [...previous] : ["", ""]
      // Jeden model nesmí být současně Reference i Moving.
      if (next[otherIndex] === url) next[otherIndex] = ""
      next[index] = url
      return next
    })
    setAlignmentPointsA([])
    setAlignmentPointsB([])
    setAlignmentStats(null)
    setAlignmentProgress(null)
    setAlignmentWorkflowStage("points")
    setAlignmentStep("models")
    setAlignmentPrealignMatrix(null)
    setAlignmentMessage(side === "A" ? "Načítám model Reference A…" : "Načítám model Moving B…")
  }, [])

  useEffect(() => {
    if (!alignmentMode || alignmentStep !== "models") return
    const aUrl = alignmentSelection?.[0] || ""
    const bUrl = alignmentSelection?.[1] || ""
    if (aUrl && bUrl && !alignmentPreviewBusy.A && !alignmentPreviewBusy.B) {
      setAlignmentStep("points")
      setAlignmentMessage("Modely jsou připravené. Umístěte bod 1 na Reference A.")
    }
  }, [alignmentMode, alignmentStep, alignmentSelection, alignmentPreviewBusy.A, alignmentPreviewBusy.B])

  const selectAlignmentModelFromScene = useCallback((url) => {
    if (!alignmentMode || alignmentBusy || alignmentStep !== "models" || !url) return
    const aUrl = alignmentSelection?.[0] || ""
    const bUrl = alignmentSelection?.[1] || ""
    if (!aUrl) {
      changeAlignmentSelection("A", url)
      return
    }
    if (!bUrl && url !== aUrl) {
      changeAlignmentSelection("B", url)
    }
  }, [alignmentMode, alignmentBusy, alignmentStep, alignmentSelection, changeAlignmentSelection])

  const handleAlignmentSceneHover = useCallback((url, hovering) => {
    const hint = alignmentPointerHintRef.current
    if (hovering) alignmentSceneHoveredUrlRef.current = url || ""
    else if (!url || alignmentSceneHoveredUrlRef.current === url) alignmentSceneHoveredUrlRef.current = ""
    if (!hint) return
    const hasHover = !!alignmentSceneHoveredUrlRef.current
    const hoveredFile = hasHover ? files.find((item) => item.url === alignmentSceneHoveredUrlRef.current) : null
    const hoveredName = hoveredFile ? stripExt(hoveredFile.name || hoveredFile.rawName || "Model") : ""
    hint.style.borderColor = hasHover ? "rgba(34,197,94,.34)" : "rgba(255,255,255,.12)"
    hint.style.background = hasHover ? "rgba(15,34,22,.94)" : "rgba(12,12,12,.92)"
    hint.style.color = hasHover ? "#bbf7d0" : "#eeeeee"
    const dot = hint.querySelector?.("[data-align-pointer-dot]")
    if (dot) dot.style.background = hasHover ? "#4ade80" : "#9a9a9a"
    const modelLabel = hint.querySelector?.("[data-align-pointer-model]")
    if (modelLabel) {
      modelLabel.textContent = hoveredName
      modelLabel.style.display = hasHover ? "block" : "none"
    }
  }, [files])

  useEffect(() => {
    if (!alignmentMode || alignmentStep !== "models" || alignmentBusy) {
      if (alignmentPointerHintRef.current) alignmentPointerHintRef.current.style.opacity = "0"
      alignmentSceneHoveredUrlRef.current = ""
      return
    }
    let frame = 0
    let pointerX = -9999
    let pointerY = -9999
    let pointerVisible = false
    const paint = () => {
      frame = 0
      const hint = alignmentPointerHintRef.current
      if (!hint) return
      if (!pointerVisible) {
        hint.style.opacity = "0"
        return
      }
      hint.style.transform = `translate3d(${pointerX + 15}px, ${pointerY + 15}px, 0)`
      hint.style.opacity = "1"
    }
    const onMove = (event) => {
      pointerVisible = event.target?.dataset?.artheticMainScene === "1"
      pointerX = event.clientX
      pointerY = event.clientY
      if (!frame) frame = requestAnimationFrame(paint)
    }
    const onLeave = () => {
      pointerVisible = false
      if (alignmentPointerHintRef.current) alignmentPointerHintRef.current.style.opacity = "0"
      alignmentSceneHoveredUrlRef.current = ""
    }
    window.addEventListener("pointermove", onMove, true)
    window.addEventListener("blur", onLeave)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener("pointermove", onMove, true)
      window.removeEventListener("blur", onLeave)
    }
  }, [alignmentMode, alignmentStep, alignmentBusy])


  const handleAlignmentPickA = useCallback((point) => {
    if (alignmentStep !== "points") return
    if (alignmentPointsA.length >= 3) return
    if (alignmentPointsA.length > alignmentPointsB.length) {
      setAlignmentMessage("Nejdřív doplňte bod na Moving B.")
      return
    }
    const nextA = alignmentPointsA.length + 1
    const nextB = alignmentPointsB.length
    setAlignmentPointsA((previous) => [...previous, point])
    setAlignmentWorkflowStage("points")
    const complete = nextA >= 3 && nextB >= 3
    if (complete) {
      setAlignmentStep("prealign")
      setAlignmentMessage("Tři korespondenční body jsou připravené. Spusťte Předzarovnat.")
      return
    }
    const nextSide = nextA <= nextB ? "A" : "B"
    const nextNumber = nextSide === "A" ? nextA + 1 : nextB + 1
    setAlignmentMessage(`Teď označte bod ${nextNumber} na ${nextSide === "A" ? "Reference A" : "Moving B"}.`)
  }, [alignmentStep, alignmentPointsA.length, alignmentPointsB.length])

  const handleAlignmentPickB = useCallback((point) => {
    if (alignmentStep !== "points") return
    if (alignmentPointsB.length >= 3) return
    if (alignmentPointsB.length >= alignmentPointsA.length) {
      setAlignmentMessage("Nejdřív doplňte bod na Reference A.")
      return
    }
    const nextA = alignmentPointsA.length
    const nextB = alignmentPointsB.length + 1
    setAlignmentPointsB((previous) => [...previous, point])
    setAlignmentWorkflowStage("points")
    const complete = nextA >= 3 && nextB >= 3
    if (complete) {
      setAlignmentStep("prealign")
      setAlignmentMessage("Tři korespondenční body jsou připravené. Spusťte Předzarovnat.")
      return
    }
    const nextSide = nextA <= nextB ? "A" : "B"
    const nextNumber = nextSide === "A" ? nextA + 1 : nextB + 1
    setAlignmentMessage(`Teď označte bod ${nextNumber} na ${nextSide === "A" ? "Reference A" : "Moving B"}.`)
  }, [alignmentStep, alignmentPointsA.length, alignmentPointsB.length])

  const clearAlignmentPointsForSide = useCallback((side) => {
    if (alignmentBusy) return
    const pair = getAlignmentPair()
    const modelsSelected = !!pair.aUrl && !!pair.bUrl
    if (pair.bUrl) applyModelTransform(pair.bUrl, IDENTITY_MATRIX_ARRAY)
    if (side === "A") setAlignmentPointsA([])
    else setAlignmentPointsB([])
    setAlignmentStats(null)
    setAlignmentProgress(null)
    setAlignmentPrealignMatrix(null)
    setAlignmentWorkflowStage("points")
    setAlignmentStep(modelsSelected ? "points" : "models")
    setShowComparison(false)
    setShowHeatmap(false)
    setAlignmentMessage(`Body v okně ${side} byly vymazány. Doplňte je znovu.`)
  }, [alignmentBusy, getAlignmentPair, applyModelTransform])

  const refreshAlignmentMetrics = useCallback(async (aUrl, bUrl, onProgress = null) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    rootGroupRef.current?.updateMatrixWorld(true)
    meshesRef.current[aUrl]?.updateMatrixWorld(true)
    meshesRef.current[bUrl]?.updateMatrixWorld(true)
    const stats = await computeAlignmentMetrics(meshesRef.current[aUrl], meshesRef.current[bUrl], 0.25, 8000, onProgress)
    setAlignmentStats(stats)
    return stats
  }, [])

  const goToAlignmentStep = useCallback(async (step) => {
    if (alignmentBusy || !alignmentMode) return
    const { aUrl, bUrl } = getAlignmentPair()

    if (step === "models") {
      if (bUrl) applyModelTransform(bUrl, IDENTITY_MATRIX_ARRAY)
      setAlignmentSelection(["", ""])
      setAlignmentPointsA([])
      setAlignmentPointsB([])
      setAlignmentStats(null)
      setAlignmentProgress(null)
      setAlignmentPrealignMatrix(null)
      setAlignmentWorkflowStage("points")
      setAlignmentStep("models")
      setShowComparison(false)
      setShowHeatmap(false)
      setAlignmentMessage("Vyberte nové modely dole nebo kliknutím přímo v hlavní scéně.")
      return
    }

    if (step === "points") {
      if (!aUrl || !bUrl) return
      applyModelTransform(bUrl, IDENTITY_MATRIX_ARRAY)
      setAlignmentPointsA([])
      setAlignmentPointsB([])
      setAlignmentStats(null)
      setAlignmentProgress(null)
      setAlignmentPrealignMatrix(null)
      setAlignmentWorkflowStage("points")
      setAlignmentStep("points")
      setShowComparison(false)
      setShowHeatmap(false)
      setAlignmentMessage("Umístěte bod 1 na Reference A.")
      return
    }

    if (step === "prealign") {
      if (!aUrl || !bUrl || Math.min(alignmentPointsA.length, alignmentPointsB.length) < 3) return
      if (alignmentPrealignMatrix) {
        applyModelTransform(bUrl, alignmentPrealignMatrix)
        setAlignmentWorkflowStage("prealigned")
        setAlignmentStats(null)
        setAlignmentStep("prealign")
        setAlignmentMessage("Vráceno k předzarovnání. Kliknutím na Předzarovnat jej můžete spočítat znovu.")
        await refreshAlignmentMetrics(aUrl, bUrl)
      } else {
        setAlignmentStep("prealign")
        setAlignmentMessage("Tři body jsou připravené. Klikněte na Předzarovnat.")
      }
    }
  }, [alignmentBusy, alignmentMode, getAlignmentPair, applyModelTransform, alignmentPointsA.length, alignmentPointsB.length, alignmentPrealignMatrix, refreshAlignmentMetrics])

  const handleAlignmentLandmarkFit = useCallback(async () => {
    const { aUrl, bUrl } = getAlignmentPair()
    const pairCount = Math.min(alignmentPointsA.length, alignmentPointsB.length)
    if (!aUrl || !bUrl || pairCount < 3) {
      setAlignmentMessage("Pro předzarovnání označte alespoň 3 páry bodů.")
      return
    }

    // Body ve spodních A/B oknech jsou uložené v lokálním prostoru rootu modelu.
    // B chceme převést přímo do společného parent-space. A proto převedeme jeho
    // landmarky aktuální skutečnou maticí reference (ne pouze případně opožděným state).
    const referenceRoot = modelObjectsRef.current[aUrl]
    referenceRoot?.updateMatrixWorld(true)
    const matrixA = referenceRoot?.matrix?.elements?.length === 16
      ? referenceRoot.matrix.clone()
      : new THREE.Matrix4().fromArray(matrixArrayOrIdentity(modelTransforms[aUrl]))

    const source = alignmentPointsB.slice(0, pairCount).map((point) => new THREE.Vector3(...point))
    const target = alignmentPointsA.slice(0, pairCount).map((point) => new THREE.Vector3(...point).applyMatrix4(matrixA))
    const matrix = rigidTransformHorn(source, target)
    if (!matrix) {
      setAlignmentMessage("Předzarovnání nelze jednoznačně spočítat. Rozmístěte 3 body více do trojúhelníku, ne téměř do jedné přímky.")
      return
    }

    const landmarkRms = landmarkFitRms(source, target, matrix)
    if (!Number.isFinite(landmarkRms)) {
      setAlignmentMessage("Předzarovnání se nepodařilo numericky ověřit.")
      return
    }

    const prealignArray = matrix.toArray()
    applyModelTransform(bUrl, prealignArray)
    setAlignmentPrealignMatrix(prealignArray)
    setAlignmentWorkflowStage("prealigned")
    setAlignmentStep("bestfit")
    setAlignmentMessage(`Předzarovnání z ${pairCount} párů dokončeno · Landmark RMS ${landmarkRms.toFixed(3)} mm. Teď spusťte Best Fit.`)
    setAlignmentProgress({ label: "Landmark fit", rms: landmarkRms })
    await refreshAlignmentMetrics(aUrl, bUrl)
  }, [getAlignmentPair, alignmentPointsA, alignmentPointsB, modelTransforms, applyModelTransform, refreshAlignmentMetrics])

  const handleAlignmentBestFit = useCallback(async () => {
    const { aUrl, bUrl } = getAlignmentPair()
    const sourceMesh = meshesRef.current[bUrl]
    const targetMesh = meshesRef.current[aUrl]
    const sourceRoot = modelObjectsRef.current[bUrl]
    const targetRoot = modelObjectsRef.current[aUrl]
    if (!aUrl || !bUrl || !sourceMesh || !targetMesh || !sourceRoot || !targetRoot) {
      setAlignmentMessage("Vybrané modely ještě nejsou připravené.")
      return
    }

    const bestFitStartedAt = performance.now()
    setAlignmentCompletion(null)
    setAlignmentOperation("bestfit")
    setAlignmentBusy(true)
    setAlignmentStartedAt(bestFitStartedAt)
    setAlignmentElapsed(0)
    setAlignmentProgress({ stage: 0, stages: 3, iteration: 0, iterations: 1, rms: null, correspondences: 0, mode: "prepare" })
    setAlignmentStats(null)
    setAlignmentMessage("Připravuji povrchy pro Best Fit…")
    setShowComparison(false)
    setShowHeatmap(false)

    const handleBestFitProgress = (progress) => {
      setAlignmentProgress(progress)
      if (progress?.mode === "prepare") setAlignmentMessage("Připravuji povrchy a kontroluji překryv…")
      else if (progress?.stage === 1) setAlignmentMessage("Hrubé zarovnání povrchů…")
      else if (progress?.stage === 2) setAlignmentMessage("Střední zpřesnění zarovnání…")
      else if (progress?.stage === 3) setAlignmentMessage("Jemné point-to-plane zpřesnění…")
    }

    // Loader necháme vykreslit ještě před kopírováním geometrie / spuštěním výpočtu.
    await alignmentPaintYield()

    let completedWithUiSequence = false
    try {
      const initialMatrix = sourceRoot.matrix?.toArray?.() || modelTransforms[bUrl]
      const landmarkSeeded = Math.min(alignmentPointsA.length, alignmentPointsB.length) >= 3
      let result = null
      let workerUsed = false

      if (USE_ALIGNMENT_WORKER && alignmentWorkerRef.current && !alignmentWorkerFailedRef.current) {
        const prepareStartedAt = performance.now()
        try {
          setAlignmentMessage("Připravuji data pro výpočet na samostatném vlákně…")
          const { payload, transferables } = buildAlignmentWorkerPayload({
            sourceMesh,
            sourceRoot,
            targetMesh,
            targetRoot,
            initialMatrix,
            landmarkSeeded,
          })
          const preparedAt = performance.now()

          const workerResponse = await runAlignmentWorkerBestFit(payload, transferables, handleBestFitProgress)
          result = workerResponse.result
          workerUsed = true

          const timings = workerResponse.timings || {}
          console.info("[ARTHETIC Align Worker] Best Fit timing", {
            mainPrepareMs: +(preparedAt - prepareStartedAt).toFixed(1),
            reconstructMs: Number.isFinite(timings.reconstructMs) ? +timings.reconstructMs.toFixed(1) : null,
            bvhMs: Number.isFinite(timings.bvhMs) ? +timings.bvhMs.toFixed(1) : null,
            icpMs: Number.isFinite(timings.icpMs) ? +timings.icpMs.toFixed(1) : null,
            workerTotalMs: Number.isFinite(timings.totalMs) ? +timings.totalMs.toFixed(1) : null,
            optimization: result?.optimization || null,
          })
        } catch (workerError) {
          if (workerError?.alignmentWorkerKind === "algorithm") throw workerError

          // Pokud selže samotná Worker infrastruktura/bundling, bezpečně použijeme
          // původní ověřený engine. Matematické chyby z Workeru na legacy neopakujeme.
          alignmentWorkerFailedRef.current = true
          console.warn("[ARTHETIC Align Worker] přepínám na legacy Best Fit:", workerError)
          setAlignmentMessage("Samostatné výpočetní vlákno není dostupné · pokračuji kompatibilním režimem…")
          await alignmentPaintYield()
        }
      }

      if (!workerUsed) {
        result = await robustPointToPlaneICP({
          sourceMesh,
          sourceRoot,
          targetMesh,
          targetRoot,
          initialMatrix,
          landmarkSeeded,
          onProgress: handleBestFitProgress,
        })
      }

      applyModelTransform(bUrl, result.matrix)
      setAlignmentProgress({ mode: "metrics", stage: 4, stages: 4, iteration: 0, iterations: 1, rms: result.rms, correspondences: result.correspondences, percent: 94 })
      setAlignmentMessage("Kontroluji výsledek a počítám metrologii…")
      const stats = await refreshAlignmentMetrics(aUrl, bUrl, (fraction) => {
        setAlignmentProgress({ mode: "metrics", stage: 4, stages: 4, iteration: fraction, iterations: 1, rms: result.rms, correspondences: result.correspondences, percent: 94 + Math.min(1, fraction) * 5.5 })
      })
      setAlignmentProgress({ mode: "metrics", stage: 4, stages: 4, iteration: 1, iterations: 1, rms: stats?.rms ?? result.rms, correspondences: result.correspondences, percent: 100 })
      const exportMatrix = modelObjectsRef.current[bUrl]?.matrix?.toArray?.() || result.matrix
      setAlignedExportsByUrl((previous) => ({
        ...previous,
        [bUrl]: {
          referenceUrl: aUrl,
          matrix: matrixArrayOrIdentity(exportMatrix).slice(),
          rms: stats?.rms ?? result.rms ?? null,
          p95: stats?.percentile95 ?? null,
          createdAt: Date.now(),
          saveRequested: false,
        },
      }))
      setAlignmentWorkflowStage("bestfit")
      setAlignmentMessage(result.improved
        ? (stats
          ? `Best Fit dokončen · RMS ${stats.rms.toFixed(3)} mm · 95 % ${stats.percentile95.toFixed(3)} mm`
          : "Best Fit dokončen.")
        : "Best Fit nenašel bezpečně lepší polohu. Předzarovnání bylo zachováno beze změny.")

      // Výpočet už skončil, ale loader ještě krátce zůstane jako potvrzení úspěšného
      // dokončení. Čas zmrazíme na skutečné délce Best Fitu a terminál přepneme do
      // krátké shutdown sekvence, následované jemným fade-outem celé karty.
      completedWithUiSequence = true
      const completedElapsed = Math.max(0, (performance.now() - bestFitStartedAt) / 1000)
      setAlignmentElapsed(completedElapsed)
      setAlignmentStartedAt(null)
      setAlignmentCompletion({ kind: "alignment", phase: "show", elapsed: completedElapsed, improved: !!result.improved })
      await new Promise((resolve) => window.setTimeout(resolve, 2600))
      setAlignmentCompletion((current) => current ? { ...current, phase: "fade" } : current)
      await new Promise((resolve) => window.setTimeout(resolve, 620))
      setAlignmentCompletion(null)
    } catch (error) {
      console.error("Alignment Best Fit error:", error)
      setAlignmentMessage(error?.message || "Best Fit se nepodařilo dokončit.")
    } finally {
      // Při úspěchu se stav shodí až po dokončovací animaci výše. Při chybě
      // loader zmizí standardně bez falešné success fajfky.
      if (!completedWithUiSequence) setAlignmentCompletion(null)
      setAlignmentBusy(false)
      setAlignmentStartedAt(null)
      setAlignmentProgress(null)
      setAlignmentOperation(null)
    }
  }, [getAlignmentPair, modelTransforms, alignmentPointsA.length, alignmentPointsB.length, applyModelTransform, refreshAlignmentMetrics, runAlignmentWorkerBestFit])

  const resetAlignmentTransform = useCallback(async () => {
    const { aUrl, bUrl } = getAlignmentPair()
    if (!bUrl) return
    applyModelTransform(bUrl, IDENTITY_MATRIX_ARRAY)
    setAlignmentStats(null)
    setAlignmentProgress(null)
    setAlignmentWorkflowStage("points")
    setAlignmentStep(Math.min(alignmentPointsA.length, alignmentPointsB.length) >= 3 ? "prealign" : "points")
    setAlignmentPrealignMatrix(null)
    setShowComparison(false)
    setAlignmentMessage("Poloha Moving B byla vrácena do původního stavu.")
    if (aUrl) await refreshAlignmentMetrics(aUrl, bUrl)
  }, [getAlignmentPair, applyModelTransform, refreshAlignmentMetrics, alignmentPointsA.length, alignmentPointsB.length])

  const showAlignmentDeviation = useCallback(async () => {
    const { aUrl, bUrl } = getAlignmentPair()
    const meshA = meshesRef.current[aUrl]
    const meshB = meshesRef.current[bUrl]
    if (!meshA || !meshB) return

    // Odchylka po Alignu se VŽDY počítá znovu. Nepřebíráme žádnou předchozí
    // heatmapu ani cached metrics, protože uživatel mohl změnit polohu modelu.
    const deviationStartedAt = performance.now()
    setComparisonSnapshot(null)
    setHasComputedComparison(false)
    setShowComparison(false)
    setAlignmentCompletion(null)
    setAlignmentOperation("deviation")
    setAlignmentBusy(true)
    setAlignmentStartedAt(deviationStartedAt)
    setAlignmentElapsed(0)
    setAlignmentProgress({ mode: "deviation", percent: 2, phase: "prepare", processed: 0, total: 0 })
    setAlignmentMessage("Počítám mapu odchylek…")

    let completedWithUiSequence = false
    try {
      rootGroupRef.current?.updateMatrixWorld(true)
      const tolerance = 0.25
      const { stats, snapshotData } = await runComparisonAnalysis(meshA, meshB, tolerance, (progress) => {
        setAlignmentProgress({
          mode: "deviation",
          percent: Math.max(2, Number(progress?.percent) || 2),
          phase: progress?.phase || "prepare",
          processed: Number(progress?.processed) || 0,
          total: Number(progress?.total) || 0,
        })
      })

      setComparisonSelection([aUrl, bUrl])
      setComparisonTolerance(tolerance)
      setComparisonStats(stats)
      setComparisonSnapshot(createComparisonSnapshotEnvelope(snapshotData, aUrl, bUrl, tolerance, stats))
      setHasComputedComparison(true)
      setShowComparison(true)
      setShowHeatmap(false)

      // Porovnání po návratu z Align workspace zůstane rovnou rozbalené.
      // Uživatel tak okamžitě vidí, že deviation mapa je stále aktivní,
      // a má po ruce přepínač pro její vypnutí / možnost panel sbalit.
      setComparisonMenuOpen(true)

      setAlignmentStats(stats)
      setAlignmentProgress({ mode: "deviation", percent: 100, phase: "done", processed: 1, total: 1 })
      setAlignmentMessage("Mapa odchylek je zobrazena v hlavní scéně.")

      // Stejná dokončovací sekvence jako u Best Fitu: výpočet neskončí náhlým
      // zmizením overlaye. Terminál se vyčistí, zobrazí se fajfka, vypíše se
      // krátké ukončení surface-analysis session a karta následně jemně zmizí.
      completedWithUiSequence = true
      const completedElapsed = Math.max(0, (performance.now() - deviationStartedAt) / 1000)
      setAlignmentElapsed(completedElapsed)
      setAlignmentStartedAt(null)
      setAlignmentCompletion({ kind: "deviation", phase: "show", elapsed: completedElapsed })
      await new Promise((resolve) => window.setTimeout(resolve, 2600))
      setAlignmentCompletion((current) => current ? { ...current, phase: "fade" } : current)
      await new Promise((resolve) => window.setTimeout(resolve, 620))
      setAlignmentCompletion(null)
    } catch (error) {
      console.error("Alignment deviation error:", error)
      setAlignmentMessage(error?.message || "Mapu odchylek se nepodařilo vypočítat.")
    } finally {
      if (!completedWithUiSequence) setAlignmentCompletion(null)
      setAlignmentBusy(false)
      setAlignmentStartedAt(null)
      setAlignmentProgress(null)
      setAlignmentOperation(null)
    }
  }, [getAlignmentPair, runComparisonAnalysis, createComparisonSnapshotEnvelope])

  const toggleHeatmapModel = (url) => {
    setHeatmapSelection((prev) => {
      const newSel = prev.includes(url) ? prev.filter(u => u !== url) : (prev.length >= 2 ? prev : [...prev, url])
      return newSel;
    })
    setHasComputedHeatmap(false)
    setShowHeatmap(false)
    setPinnedNotes([]) 
    if (tooltipRef.current) tooltipRef.current.style.opacity = "0";
  }

  const toggleComparisonModel = (url) => {
    setComparisonSelection((prev) => prev.includes(url)
      ? prev.filter((item) => item !== url)
      : (prev.length >= 2 ? prev : [...prev, url]))
    setHasComputedComparison(false)
    setShowComparison(false)
    setComparisonStats(null)
    setComparisonSnapshot(null)
    setPinnedNotes([])
    if (tooltipRef.current) tooltipRef.current.style.opacity = "0"
  }

  const setHeatmapSelectionSlot = (slot, url) => {
    setHeatmapSelection((prev) => {
      const a = prev[0] || ""
      const b = prev[1] || ""
      if (slot === 0) {
        if (!url) return []
        return b && b !== url ? [url, b] : [url]
      }
      if (!a) return prev
      if (!url) return [a]
      if (url === a) return prev
      return [a, url]
    })
    setHasComputedHeatmap(false)
    setShowHeatmap(false)
    setPinnedNotes([])
    if (tooltipRef.current) tooltipRef.current.style.opacity = "0"
  }

  const setComparisonSelectionSlot = (slot, url) => {
    setComparisonSelection((prev) => {
      const a = prev[0] || ""
      const b = prev[1] || ""
      if (slot === 0) {
        if (!url) return []
        return b && b !== url ? [url, b] : [url]
      }
      if (!a) return prev
      if (!url) return [a]
      if (url === a) return prev
      return [a, url]
    })
    setHasComputedComparison(false)
    setShowComparison(false)
    setComparisonStats(null)
    setComparisonSnapshot(null)
    setPinnedNotes([])
    if (tooltipRef.current) tooltipRef.current.style.opacity = "0"
  }

  const handleComparisonDirectionChange = (direction) => {
    if (direction !== "A_TO_B" && direction !== "B_TO_A") return
    setComparisonDirection(direction)

    // Směr porovnání mění pouze analyzovaný povrch. Opacity modelů necháváme beze změny.

    setPinnedNotes([])
    if (tooltipRef.current) tooltipRef.current.style.opacity = "0"
  }

  const handleApplyHeatmap = async () => {
    if (heatmapSelection.length !== 2) return
    const analysisStartedAt = performance.now()
    setSurfaceAnalysisCompletion(null)
    setSurfaceAnalysisStartedAt(analysisStartedAt)
    setSurfaceAnalysisElapsed(0)
    setIsCalculatingHeatmap(true)
    setSurfaceAnalysisProgress({ type: "occlusion", percent: 1, phase: "prepare" })
    setPinnedNotes([])

    try {
      await new Promise((resolve) => requestAnimationFrame(() => resolve()))
      rootGroupRef.current?.updateMatrixWorld(true)
      const meshA = meshesRef.current[heatmapSelection[0]]
      const meshB = meshesRef.current[heatmapSelection[1]]

      if (meshA && meshB) {
        await runOcclusionAnalysis(meshA, meshB, 2.0, false, (progress) => {
          setSurfaceAnalysisProgress({ type: "occlusion", ...progress })
        })
        setHasComputedHeatmap(true)
        setShowHeatmap(true)
        setShowComparison(false)
        setSurfaceAnalysisProgress({ type: "occlusion", percent: 100, phase: "done" })

        await runSurfaceCompletionSequence("occlusion", analysisStartedAt)
      }
    } catch (e) {
      console.error("Heatmap chyba:", e)
    } finally {
      setSurfaceAnalysisProgress(null)
      setSurfaceAnalysisStartedAt(null)
      setIsCalculatingHeatmap(false)
      setSurfaceAnalysisCompletion(null)
    }
  }

  const handleApplyComparison = async () => {
    if (comparisonSelection.length !== 2) return
    // Explicitní kliknutí na Vypočítat znamená vždy čerstvý výpočet pro aktuální
    // polohu modelů. Starý snapshot se před startem zahodí.
    const analysisStartedAt = performance.now()
    setComparisonSnapshot(null)
    setHasComputedComparison(false)
    setShowComparison(false)
    setSurfaceAnalysisCompletion(null)
    setSurfaceAnalysisStartedAt(analysisStartedAt)
    setSurfaceAnalysisElapsed(0)
    setIsCalculatingComparison(true)
    setSurfaceAnalysisProgress({ type: "comparison", percent: 1, phase: "prepare" })
    setPinnedNotes([])

    try {
      await new Promise((resolve) => requestAnimationFrame(() => resolve()))
      rootGroupRef.current?.updateMatrixWorld(true)
      const meshA = meshesRef.current[comparisonSelection[0]]
      const meshB = meshesRef.current[comparisonSelection[1]]
      if (meshA && meshB) {
        const { stats, snapshotData } = await runComparisonAnalysis(meshA, meshB, comparisonTolerance, (progress) => {
          setSurfaceAnalysisProgress({ type: "comparison", ...progress })
        })
        setComparisonStats(stats)
        setComparisonSnapshot(createComparisonSnapshotEnvelope(
          snapshotData,
          comparisonSelection[0],
          comparisonSelection[1],
          comparisonTolerance,
          stats,
        ))

        // Porovnání už opacity žádného modelu automaticky nemění.
        // Reference tak zůstává ve své aktuální (výchozí 100%) opacitě.

        setHasComputedComparison(true)
        setShowComparison(true)
        setShowHeatmap(false)
        setSurfaceAnalysisProgress({ type: "comparison", percent: 100, phase: "done" })

        await runSurfaceCompletionSequence("comparison", analysisStartedAt)
      }
    } catch (e) {
      console.error("Chyba porovnání povrchů:", e)
    } finally {
      setSurfaceAnalysisProgress(null)
      setSurfaceAnalysisStartedAt(null)
      setIsCalculatingComparison(false)
      setSurfaceAnalysisCompletion(null)
    }
  }

  const activeAnalysisMode = showHeatmap ? "occlusion" : showComparison ? "comparison" : null

  const buildViewerState = useCallback(() => {
    const selectionNames = (selection) => selection.map((url) => {
      const file = files.find((item) => item.url === url)
      return file?.rawName || file?.name || url
    })
    if (sliceRigGroup) sliceRigGroup.updateMatrix()
    if (planeGroup) planeGroup.updateMatrix()
    if (horizontalPlaneGroup) horizontalPlaneGroup.updateMatrix()

    return {
      version: 1,
      activeAnalysisMode,
      occlusion: {
        files: selectionNames(heatmapSelection),
        visible: showHeatmap && hasComputedHeatmap,
      },
      comparison: {
        files: selectionNames(comparisonSelection),
        tolerance: comparisonTolerance,
        direction: comparisonDirection,
        visible: showComparison && hasComputedComparison,
        // Snapshot se ukládá pouze pokud je právě zobrazený výsledek stále validní.
        // Díky tomu může doktor dostat hotovou heatmapu bez nového BVH výpočtu.
        snapshot: showComparison && hasComputedComparison ? comparisonSnapshot : null,
      },
      alignment: {
        reference: selectionNames(alignmentSelection)[0] || null,
        moving: selectionNames(alignmentSelection)[1] || null,
        transforms: files.map((file) => ({
          file: file.rawName || file.name || file.url,
          matrix: matrixArrayOrIdentity(modelTransforms[file.url]).slice(),
        })),
      },
      display: {
        models: files.map((file, index) => ({
          file: file.rawName || file.name || file.url,
          ghost: !!ghostModes[index],
        })),
      },
      pinnedNotes: pinnedNotes.map((note) => ({
        id: note.id,
        mode: note.mode,
        value: note.value,
        pos: Array.isArray(note.pos) ? note.pos.slice(0, 3) : note.pos,
      })),
      clipping: {
        enabled: clippingEnabled,
        rigVersion: 1,
        controlVersion: 2,
        activeSlice,
        rigMatrix: clippingEnabled && sliceRigGroup ? sliceRigGroup.matrix.toArray() : null,
        matrix: clippingEnabled && planeGroup ? planeGroup.matrix.toArray() : null,
        horizontalMatrix: clippingEnabled && horizontalPlaneGroup ? horizontalPlaneGroup.matrix.toArray() : null,
        horizontalOrientation: "axial-z",
        measurement: measureState?.p1 ? {
          active: false,
          p1: measureState.p1,
          p2: measureState.p2,
          snappedP2: measureState.snappedP2,
        } : null,
        horizontalMeasurement: horizontalMeasureState?.p1 ? {
          active: false,
          p1: horizontalMeasureState.p1,
          p2: horizontalMeasureState.p2,
          snappedP2: horizontalMeasureState.snappedP2,
        } : null,
      },
      dicom: dicomSource ? {
        visible: dicomSettings.visible !== false,
        settings: dicomSettings,
      } : null,
    }
  }, [
    activeAnalysisMode, files, heatmapSelection, showHeatmap, hasComputedHeatmap,
    comparisonSelection, comparisonTolerance, comparisonDirection, showComparison, hasComputedComparison, comparisonSnapshot, modelTransforms, alignmentSelection, ghostModes,
    pinnedNotes, clippingEnabled, activeSlice, sliceRigGroup, planeGroup, horizontalPlaneGroup, measureState, horizontalMeasureState,
    dicomSource, dicomSettings,
  ])

  const handleHeatmapHover = useCallback((dist, x, y) => {
    if (!tooltipRef.current || !activeAnalysisMode) return;
    if (dist === null) {
      tooltipRef.current.style.opacity = "0";
    } else {
      tooltipRef.current.style.opacity = "1";
      tooltipRef.current.style.transform = `translate(${x + 15}px, ${y + 15}px)`;
      if (activeAnalysisMode === "occlusion") {
        const kind = dist < -0.01 ? "Průnik" : dist > 0.01 ? "Mezera" : "Kontakt"
        tooltipRef.current.innerText = `${kind}: ${dist > 0 ? "+" : ""}${dist.toFixed(2)} mm`
      } else {
        tooltipRef.current.innerText = `Odchylka povrchu: ${dist.toFixed(2)} mm`
      }
    }
  }, [activeAnalysisMode])

  // Three.js/R3F přestane během pravého dragování kamery posílat hover
  // onPointerMove z modelu, protože pointer převezmou TrackballControls.
  // Samotný browserový pointermove ale běží dál. Držíme proto pozici už
  // zobrazeného analysis tooltipu u kurzoru i během pan/orbit gesta, aniž
  // bychom při každém pohybu spouštěli nový raycast nebo výpočet odchylky.
  useEffect(() => {
    if (!activeAnalysisMode) return

    const followPointer = (event) => {
      const tooltip = tooltipRef.current
      if (!tooltip || tooltip.style.opacity !== "1") return
      tooltip.style.transform = `translate(${event.clientX + 15}px, ${event.clientY + 15}px)`
    }

    window.addEventListener("pointermove", followPointer, true)
    return () => window.removeEventListener("pointermove", followPointer, true)
  }, [activeAnalysisMode])

  const handlePinNote = useCallback((dist, point) => {
    setPinnedNotes(prev => [...prev, { 
      id: Date.now() + Math.random(), 
      value: dist, 
      mode: activeAnalysisMode,
      pos: [point.x, point.y, point.z] 
    }]);
  }, [activeAnalysisMode]);

  const removeNote = useCallback((id) => {
    setPinnedNotes(prev => prev.filter(n => n.id !== id));
  }, []);

  const centerParam = (getParam("center") || "combined").toLowerCase()
  const centerMode = ["per", "combined", "none"].includes(centerParam) ? centerParam : "combined"

  const getSliceSceneBounds = useCallback(() => {
    const bounds = new THREE.Box3()
    if (rootGroupRef.current) bounds.setFromObject(rootGroupRef.current)

    if (dicomVolume) {
      const position = new THREE.Vector3(...(dicomSettings.position || [0, 0, 0]))
      const rotationValues = dicomSettings.rotation || [0, 0, 0]
      const rotation = new THREE.Euler(
        THREE.MathUtils.degToRad(rotationValues[0] || 0),
        THREE.MathUtils.degToRad(rotationValues[1] || 0),
        THREE.MathUtils.degToRad(rotationValues[2] || 0)
      )
      const scale = Number(dicomSettings.scale) || 1
      const matrix = new THREE.Matrix4().compose(
        position,
        new THREE.Quaternion().setFromEuler(rotation),
        new THREE.Vector3(scale, scale, scale)
      )
      const half = new THREE.Vector3(...dicomVolume.size).multiplyScalar(0.5)
      for (let z = -1; z <= 1; z += 2) {
        for (let y = -1; y <= 1; y += 2) {
          for (let x = -1; x <= 1; x += 2) {
            bounds.expandByPoint(new THREE.Vector3(x * half.x, y * half.y, z * half.z).applyMatrix4(matrix))
          }
        }
      }
    }
    return bounds
  }, [dicomVolume, dicomSettings.position, dicomSettings.rotation, dicomSettings.scale])

  const calculateSliceData = useCallback((targetPlaneGroup, dicomResolution = DICOM_SLICE_DETAIL_RESOLUTION) => {
    if (!targetPlaneGroup || !rootGroupRef.current) return null

    targetPlaneGroup.updateMatrixWorld(true)
    const normal = new THREE.Vector3(0, 0, 1).transformDirection(targetPlaneGroup.matrixWorld).normalize()
    const planePosition = new THREE.Vector3().setFromMatrixPosition(targetPlaneGroup.matrixWorld)
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, planePosition)
    const segments2D = []
    const invMat = targetPlaneGroup.matrixWorld.clone().invert()

    const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3()
    const edgePt = new THREE.Vector3(), locPt = new THREE.Vector3()

    rootGroupRef.current.children.forEach(modelRoot => {
      if (!modelRoot.visible) return
      modelRoot.traverse(child => {
       if (!child.isMesh || !child.visible) return
       child.updateMatrixWorld(true)
       const matrix = child.matrixWorld
       const geom = child.geometry
       const posAttr = geom.attributes.position
       const index = geom.index
       const outlineColor = child.userData._viewerColor || modelRoot.userData._viewerColor || "#ffffff"
       const modelIndex = Number.isInteger(child.renderOrder) ? child.renderOrder : -1

       const checkEdge = (v1, v2, d1, d2) => {
           if (d1 * d2 < 0) {
               const t = d1 / (d1 - d2)
               edgePt.copy(v1).lerp(v2, t)
               return true
           }
           if (d1 === 0) {
               edgePt.copy(v1)
               return true
           }
           return false
       }

       const processTri = (iA, iB, iC) => {
           vA.fromBufferAttribute(posAttr, iA).applyMatrix4(matrix)
           vB.fromBufferAttribute(posAttr, iB).applyMatrix4(matrix)
           vC.fromBufferAttribute(posAttr, iC).applyMatrix4(matrix)

           const dA = plane.distanceToPoint(vA)
           const dB = plane.distanceToPoint(vB)
           const dC = plane.distanceToPoint(vC)

           if ((dA > 0 && dB > 0 && dC > 0) || (dA < 0 && dB < 0 && dC < 0)) return

           const pts = []

           if (checkEdge(vA, vB, dA, dB)) {
               locPt.copy(edgePt).applyMatrix4(invMat)
               pts.push(locPt.x, locPt.y)
           }
           if (checkEdge(vB, vC, dB, dC)) {
               locPt.copy(edgePt).applyMatrix4(invMat)
               if (pts.length < 2 || Math.abs(pts[0] - locPt.x) > 1e-5 || Math.abs(pts[1] - locPt.y) > 1e-5) {
                   pts.push(locPt.x, locPt.y)
               }
           }
           if (pts.length < 4 && checkEdge(vC, vA, dC, dA)) {
               locPt.copy(edgePt).applyMatrix4(invMat)
               if (pts.length < 2 || Math.abs(pts[0] - locPt.x) > 1e-5 || Math.abs(pts[1] - locPt.y) > 1e-5) {
                   if (pts.length < 4 || Math.abs(pts[2] - locPt.x) > 1e-5 || Math.abs(pts[3] - locPt.y) > 1e-5) {
                      pts.push(locPt.x, locPt.y)
                   }
               }
           }

           if (pts.length >= 4) {
               segments2D.push({
                 a: { x: pts[0], y: pts[1] },
                 b: { x: pts[2], y: pts[3] },
                 color: outlineColor,
                 modelIndex,
               })
           }
       }

       if (index) {
           for(let i=0; i<index.count; i+=3) processTri(index.getX(i), index.getX(i+1), index.getX(i+2))
       } else {
           for(let i=0; i<posAttr.count; i+=3) processTri(i, i+1, i+2)
       }
      })
    })

    let combinedBounds = null
    if (segments2D.length > 0) {
       let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
       for(let i=0; i<segments2D.length; i++){
           const s = segments2D[i]
           const start = segmentStart(s), end = segmentEnd(s)
           if(start.x < minX) minX = start.x; if(start.x > maxX) maxX = start.x;
           if(start.y < minY) minY = start.y; if(start.y > maxY) maxY = start.y;
           if(end.x < minX) minX = end.x; if(end.x > maxX) maxX = end.x;
           if(end.y < minY) minY = end.y; if(end.y > maxY) maxY = end.y;
       }
       combinedBounds = { minX, minY, width: maxX - minX, height: maxY - minY }
    }

    const dicomSlice = dicomVolume && dicomSettings.visible !== false
      ? buildDicomSliceImage(dicomVolume, dicomSettings, targetPlaneGroup.matrixWorld, dicomResolution)
      : null

    if (dicomSlice?.bounds) {
      const bounds = dicomSlice.bounds
      if (!combinedBounds) combinedBounds = { ...bounds }
      else {
        const minX = Math.min(combinedBounds.minX, bounds.minX)
        const minY = Math.min(combinedBounds.minY, bounds.minY)
        const maxX = Math.max(combinedBounds.minX + combinedBounds.width, bounds.minX + bounds.width)
        const maxY = Math.max(combinedBounds.minY + combinedBounds.height, bounds.minY + bounds.height)
        combinedBounds = { minX, minY, width: maxX - minX, height: maxY - minY }
      }
    }
    return { segments: segments2D, boundingBox: combinedBounds, dicomSlice }
  }, [visibles, dicomVolume, dicomSettings])

  const updateClippingLogic = useCallback((dicomResolution = DICOM_SLICE_DETAIL_RESOLUTION) => {
    const result = calculateSliceData(planeGroup, dicomResolution)
    if (!result) return
    setSliceSegments(result.segments)
    setSliceBBox(result.boundingBox)
    setDicomSlice2D(result.dicomSlice)
  }, [planeGroup, calculateSliceData])

  const updateHorizontalClippingLogic = useCallback((dicomResolution = DICOM_SLICE_DETAIL_RESOLUTION) => {
    const result = calculateSliceData(horizontalPlaneGroup, dicomResolution)
    if (!result) return
    setHorizontalSliceSegments(result.segments)
    setHorizontalSliceBBox(result.boundingBox)
    setHorizontalDicomSlice2D(result.dicomSlice)
  }, [horizontalPlaneGroup, calculateSliceData])

  const lastClipTime = useRef(0)
  const clipTimeout = useRef(null)
  const clipDetailTimeout = useRef(null)
  const lastHorizontalClipTime = useRef(0)
  const horizontalClipTimeout = useRef(null)
  const horizontalClipDetailTimeout = useRef(null)

  const requestClipUpdate = useCallback(() => {
    const now = performance.now()
    if (now - lastClipTime.current > 60) {
      updateClippingLogic(DICOM_SLICE_INTERACTIVE_RESOLUTION)
      lastClipTime.current = now
    } else {
      clearTimeout(clipTimeout.current)
      clipTimeout.current = setTimeout(() => {
        updateClippingLogic(DICOM_SLICE_INTERACTIVE_RESOLUTION)
        lastClipTime.current = performance.now()
      }, 60)
    }
    clearTimeout(clipDetailTimeout.current)
    clipDetailTimeout.current = setTimeout(() => {
      updateClippingLogic(DICOM_SLICE_DETAIL_RESOLUTION)
      lastClipTime.current = performance.now()
    }, 180)
  }, [updateClippingLogic])

  const requestHorizontalClipUpdate = useCallback(() => {
    const now = performance.now()
    if (now - lastHorizontalClipTime.current > 60) {
      updateHorizontalClippingLogic(DICOM_SLICE_INTERACTIVE_RESOLUTION)
      lastHorizontalClipTime.current = now
    } else {
      clearTimeout(horizontalClipTimeout.current)
      horizontalClipTimeout.current = setTimeout(() => {
        updateHorizontalClippingLogic(DICOM_SLICE_INTERACTIVE_RESOLUTION)
        lastHorizontalClipTime.current = performance.now()
      }, 60)
    }
    clearTimeout(horizontalClipDetailTimeout.current)
    horizontalClipDetailTimeout.current = setTimeout(() => {
      updateHorizontalClippingLogic(DICOM_SLICE_DETAIL_RESOLUTION)
      lastHorizontalClipTime.current = performance.now()
    }, 180)
  }, [updateHorizontalClippingLogic])

  useEffect(() => () => {
    clearTimeout(clipTimeout.current)
    clearTimeout(clipDetailTimeout.current)
    clearTimeout(horizontalClipTimeout.current)
    clearTimeout(horizontalClipDetailTimeout.current)
  }, [])

  useEffect(() => {
    if (!pendingViewerState || restoredViewerStateRef.current === pendingViewerState) return
    if (!files.length || !files.every((file) => loadedUrls.has(file.url))) return

    const resolveSelection = (savedFiles) => (Array.isArray(savedFiles) ? savedFiles : [])
      .map((saved) => files.find((file) =>
        file.url === saved || file.rawName === saved || file.name === stripExt(saved)
      )?.url)
      .filter(Boolean)
      .slice(0, 2)

    restoredViewerStateRef.current = pendingViewerState
    const occlusionSelection = resolveSelection(pendingViewerState.occlusion?.files)
    const savedComparisonSelection = resolveSelection(pendingViewerState.comparison?.files)
    const savedAlignmentSelection = resolveSelection([pendingViewerState.alignment?.reference, pendingViewerState.alignment?.moving].filter(Boolean))
    const savedTolerance = Math.max(0.05, Math.min(1, Number(pendingViewerState.comparison?.tolerance) || 0.25))
    const savedComparisonDirection = pendingViewerState.comparison?.direction === "B_TO_A" ? "B_TO_A" : "A_TO_B"
    const mode = pendingViewerState.activeAnalysisMode

    const restoredTransforms = {}
    const savedTransforms = Array.isArray(pendingViewerState.alignment?.transforms) ? pendingViewerState.alignment.transforms : []
    savedTransforms.forEach((entry) => {
      if (!Array.isArray(entry?.matrix) || entry.matrix.length !== 16) return
      const file = files.find((item) => item.url === entry.file || item.rawName === entry.file || item.name === stripExt(entry.file) || item.name === entry.file)
      if (!file) return
      restoredTransforms[file.url] = entry.matrix.slice()
      const object = modelObjectsRef.current[file.url]
      if (object) {
        object.matrixAutoUpdate = false
        object.matrix.fromArray(entry.matrix)
        object.matrixWorldNeedsUpdate = true
        object.updateMatrixWorld(true)
      }
    })
    if (Object.keys(restoredTransforms).length) {
      setModelTransforms((previous) => ({ ...previous, ...restoredTransforms }))
      rootGroupRef.current?.updateMatrixWorld(true)
    }

    const savedDisplayModels = Array.isArray(pendingViewerState.display?.models)
      ? pendingViewerState.display.models
      : []
    if (savedDisplayModels.length) {
      setGhostModes(files.map((file) => {
        const saved = savedDisplayModels.find((entry) =>
          entry?.file === file.url || entry?.file === file.rawName || entry?.file === file.name || stripExt(entry?.file || '') === file.name
        )
        return !!saved?.ghost
      }))
    }

    setHeatmapSelection(occlusionSelection)
    setComparisonSelection(savedComparisonSelection)
    if (savedAlignmentSelection.length === 2) setAlignmentSelection(savedAlignmentSelection)
    setComparisonTolerance(savedTolerance)
    setComparisonDirection(savedComparisonDirection)
    setShowHeatmap(false)
    setShowComparison(false)
    setHasComputedHeatmap(false)
    setHasComputedComparison(false)
    setComparisonSnapshot(null)
    setPinnedNotes(Array.isArray(pendingViewerState.pinnedNotes) ? pendingViewerState.pinnedNotes : [])

    if (pendingViewerState.dicom?.settings) {
      setDicomSettings((previous) => ({
        ...previous,
        ...pendingViewerState.dicom.settings,
        quality: DICOM_DETAIL_QUALITY,
        visible: pendingViewerState.dicom.visible !== false,
      }))
    }

    if (pendingViewerState.clipping?.enabled || pendingViewerState.dicom || dicomSource) {
      if (pendingViewerState.clipping) pendingClipStateRef.current = pendingViewerState.clipping
      setClippingEnabled(true)
    } else {
      setClippingEnabled(false)
    }

    const restoringOcclusion = mode === "occlusion" && occlusionSelection.length === 2
    const restoringComparison = mode === "comparison" && savedComparisonSelection.length === 2
    if (!restoringOcclusion && !restoringComparison) return

    setRestoringAnalysisMode(mode)
    setSurfaceAnalysisCompletion(null)
    setSurfaceAnalysisStartedAt(performance.now())
    setSurfaceAnalysisElapsed(0)
    setIsCalculatingHeatmap(restoringOcclusion)
    setIsCalculatingComparison(restoringComparison)

    setSurfaceAnalysisProgress({ type: mode, percent: 1, phase: "prepare" })
    setTimeout(async () => {
      try {
        rootGroupRef.current?.updateMatrixWorld(true)
        if (restoringOcclusion) {
          const meshA = meshesRef.current[occlusionSelection[0]]
          const meshB = meshesRef.current[occlusionSelection[1]]
          if (meshA && meshB) {
            await runOcclusionAnalysis(meshA, meshB, 2.0, false, (progress) => {
              setSurfaceAnalysisProgress({ type: "occlusion", ...progress })
            })
            setHasComputedHeatmap(true)
            setShowHeatmap(pendingViewerState.occlusion?.visible !== false)
          }
        } else if (restoringComparison) {
          const aUrl = savedComparisonSelection[0]
          const bUrl = savedComparisonSelection[1]
          const meshA = meshesRef.current[aUrl]
          const meshB = meshesRef.current[bUrl]
          if (meshA && meshB) {
            const savedSnapshot = pendingViewerState.comparison?.snapshot || null
            let stats = null
            let restoredFromSnapshot = false

            // Pokud fingerprint sedí na stejné soubory, vertex count i transformace,
            // obnovíme jen uložené distances. Žádný nearest-surface/BVH výpočet.
            if (isComparisonSnapshotValid(savedSnapshot, aUrl, bUrl, savedTolerance)) {
              try {
                setSurfaceAnalysisProgress({ type: "comparison", percent: 4, phase: "snapshot" })
                stats = await restoreComparisonAnalysisSnapshot(meshA, meshB, savedSnapshot, savedTolerance, (progress) => {
                  setSurfaceAnalysisProgress({ type: "comparison", ...progress })
                })
                setComparisonSnapshot(savedSnapshot)
                restoredFromSnapshot = true
              } catch (snapshotError) {
                console.warn("Uloženou odchylku se nepodařilo rychle obnovit, počítám ji znovu:", snapshotError)
              }
            }

            // Starší scény bez snapshotu nebo snapshot s neplatným fingerprintem
            // bezpečně přepočítáme z aktuální geometrie.
            if (!restoredFromSnapshot) {
              const fresh = await runComparisonAnalysis(meshA, meshB, savedTolerance, (progress) => {
                setSurfaceAnalysisProgress({ type: "comparison", ...progress })
              })
              stats = fresh.stats
              setComparisonSnapshot(createComparisonSnapshotEnvelope(fresh.snapshotData, aUrl, bUrl, savedTolerance, stats))
            }

            setComparisonStats(stats)

            // Při obnovení uloženého porovnání opacity modelů neměníme.

            setHasComputedComparison(true)
            setShowComparison(pendingViewerState.comparison?.visible !== false)
          }
        }
      } catch (error) {
        console.error("Obnovení analýzy selhalo:", error)
      } finally {
        setSurfaceAnalysisProgress(null)
        setSurfaceAnalysisStartedAt(null)
        setSurfaceAnalysisCompletion(null)
        setIsCalculatingHeatmap(false)
        setIsCalculatingComparison(false)
        setRestoringAnalysisMode(null)
      }
    }, 100)
  }, [pendingViewerState, files, loadedUrls, dicomSource, runOcclusionAnalysis, runComparisonAnalysis, restoreComparisonAnalysisSnapshot, isComparisonSnapshotValid, createComparisonSnapshotEnvelope])

  useEffect(() => {
    const savedClip = pendingClipStateRef.current
    if (!savedClip || !clippingEnabled || !sliceRigGroup || !planeGroup || (dicomSource && !isMobile && !horizontalPlaneGroup)) return

    const compatibleRig = savedClip.rigVersion === 1 && Array.isArray(savedClip.rigMatrix) && savedClip.rigMatrix.length === 16
    if (compatibleRig) {
      sliceRigGroup.matrix.fromArray(savedClip.rigMatrix)
      sliceRigGroup.matrix.decompose(sliceRigGroup.position, sliceRigGroup.quaternion, sliceRigGroup.scale)
      sliceRigGroup.updateMatrixWorld(true)
      sliceRigMatrixRef.current.copy(sliceRigGroup.matrix)
      isSliceRigInitialized.current = true
    }
    if (compatibleRig && Array.isArray(savedClip.matrix) && savedClip.matrix.length === 16) {
      planeGroup.matrix.fromArray(savedClip.matrix)
      planeGroup.matrix.decompose(planeGroup.position, planeGroup.quaternion, planeGroup.scale)
      planeGroup.updateMatrixWorld(true)
      planeMatrixRef.current.copy(planeGroup.matrix)
      isPlaneInitialized.current = true
    }
    if (compatibleRig && horizontalPlaneGroup && savedClip.horizontalOrientation === "axial-z" && Array.isArray(savedClip.horizontalMatrix) && savedClip.horizontalMatrix.length === 16) {
      horizontalPlaneGroup.matrix.fromArray(savedClip.horizontalMatrix)
      horizontalPlaneGroup.matrix.decompose(horizontalPlaneGroup.position, horizontalPlaneGroup.quaternion, horizontalPlaneGroup.scale)
      horizontalPlaneGroup.updateMatrixWorld(true)
      horizontalPlaneMatrixRef.current.copy(horizontalPlaneGroup.matrix)
      isHorizontalPlaneInitialized.current = true
    }
    if (compatibleRig && savedClip.measurement?.p1) {
      setMeasureState({
        active: false,
        p1: savedClip.measurement.p1,
        p2: savedClip.measurement.p2 || savedClip.measurement.snappedP2,
        snappedP2: savedClip.measurement.snappedP2 || savedClip.measurement.p2,
      })
    }
    if (compatibleRig && savedClip.horizontalMeasurement?.p1) {
      setHorizontalMeasureState({
        active: false,
        p1: savedClip.horizontalMeasurement.p1,
        p2: savedClip.horizontalMeasurement.p2 || savedClip.horizontalMeasurement.snappedP2,
        snappedP2: savedClip.horizontalMeasurement.snappedP2 || savedClip.horizontalMeasurement.p2,
      })
    }
    if (savedClip.activeSlice === "horizontal" || savedClip.activeSlice === "vertical") {
      setActiveSlice(savedClip.activeSlice)
    }
    pendingClipStateRef.current = null
    requestClipUpdate()
    if (horizontalPlaneGroup) requestHorizontalClipUpdate()
  }, [clippingEnabled, sliceRigGroup, planeGroup, horizontalPlaneGroup, dicomSource, isMobile, requestClipUpdate, requestHorizontalClipUpdate])

  const moveSliceBy = useCallback((step) => {
    const kind = activeSlice === "horizontal" ? "horizontal" : "vertical"
    const group = kind === "horizontal" ? horizontalPlaneGroup : planeGroup
    if (!clippingEnabled || !group) return
    group.translateZ(step)
    group.updateMatrixWorld(true)

    if (kind === "horizontal") {
      setHorizontalMeasureState(prev => (prev.active || prev.p1) ? { active: false, p1: null, p2: null, snappedP2: null } : prev)
      horizontalPlaneMatrixRef.current.copy(group.matrix)
      requestHorizontalClipUpdate()
    } else {
      setMeasureState(prev => (prev.active || prev.p1) ? { active: false, p1: null, p2: null, snappedP2: null } : prev)
      planeMatrixRef.current.copy(group.matrix)
      const normal = new THREE.Vector3(0, 0, 1).transformDirection(group.matrixWorld).normalize()
      const pos = new THREE.Vector3().setFromMatrixPosition(group.matrixWorld)
      clipPlaneRef.current.setFromNormalAndCoplanarPoint(normal, pos)
      requestClipUpdate()
    }
  }, [activeSlice, clippingEnabled, planeGroup, horizontalPlaneGroup, requestClipUpdate, requestHorizontalClipUpdate])

  const syncActiveSliceFromGizmo = useCallback(() => {
    const kind = activeSlice === "horizontal" ? "horizontal" : "vertical"
    const group = kind === "horizontal" ? horizontalPlaneGroup : planeGroup
    if (!clippingEnabled || !group) return
    group.updateMatrixWorld(true)

    if (kind === "horizontal") {
      horizontalPlaneMatrixRef.current.copy(group.matrix)
      setHorizontalMeasureState(prev => (prev.active || prev.p1) ? { active: false, p1: null, p2: null, snappedP2: null } : prev)
      requestHorizontalClipUpdate()
    } else {
      planeMatrixRef.current.copy(group.matrix)
      const normal = new THREE.Vector3(0, 0, 1).transformDirection(group.matrixWorld).normalize()
      const pos = new THREE.Vector3().setFromMatrixPosition(group.matrixWorld)
      clipPlaneRef.current.setFromNormalAndCoplanarPoint(normal, pos)
      setMeasureState(prev => (prev.active || prev.p1) ? { active: false, p1: null, p2: null, snappedP2: null } : prev)
      requestClipUpdate()
    }
  }, [activeSlice, clippingEnabled, planeGroup, horizontalPlaneGroup, requestClipUpdate, requestHorizontalClipUpdate])

  useEffect(() => {
    const handleKeyDown = (e) => {
      const activeGroup = activeSlice === "horizontal" ? horizontalPlaneGroup : planeGroup
      if (!clippingEnabled || !activeGroup) return
      const step = 0.5 
      if (e.key === "ArrowUp" || e.key === "ArrowRight") {
         moveSliceBy(step)
      } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
         moveSliceBy(-step)
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [clippingEnabled, activeSlice, moveSliceBy, planeGroup, horizontalPlaneGroup])

  const handleResetPlane = useCallback(() => {
    if (!rootGroupRef.current || !sliceRigGroup || !planeGroup) {
       isPlaneInitialized.current = false;
       isHorizontalPlaneInitialized.current = false;
       isSliceRigInitialized.current = false;
       return;
    }
    const box = getSliceSceneBounds()
    if (!box.isEmpty()) {
       const center = new THREE.Vector3()
       box.getCenter(center)

       sliceRigGroup.position.copy(center)
       sliceRigGroup.rotation.set(0, 0, 0)
       sliceRigGroup.scale.set(1, 1, 1)

       planeGroup.position.set(0, 0, 0)
       planeGroup.rotation.set(0, Math.PI / 2, 0)
       planeGroup.scale.set(1, 1, 1)

       if (horizontalPlaneGroup) {
         horizontalPlaneGroup.position.set(0, 0, 0)
         horizontalPlaneGroup.rotation.set(0, 0, 0)
         horizontalPlaneGroup.scale.set(1, 1, 1)
       }

       sliceRigGroup.updateMatrixWorld(true)
       sliceRigMatrixRef.current.copy(sliceRigGroup.matrix)
       planeMatrixRef.current.copy(planeGroup.matrix)
       if (horizontalPlaneGroup) horizontalPlaneMatrixRef.current.copy(horizontalPlaneGroup.matrix)
       isSliceRigInitialized.current = true
       isPlaneInitialized.current = true
       isHorizontalPlaneInitialized.current = !!horizontalPlaneGroup
       updateClippingLogic()
       if (horizontalPlaneGroup) updateHorizontalClippingLogic()

       setMeasureState({ active: false, p1: null, p2: null, snappedP2: null })
       setHorizontalMeasureState({ active: false, p1: null, p2: null, snappedP2: null })
    }
  }, [sliceRigGroup, planeGroup, horizontalPlaneGroup, getSliceSceneBounds, updateClippingLogic, updateHorizontalClippingLogic])

  useEffect(() => {
    const ready = clippingEnabled && rootGroupRef.current && sliceRigGroup && planeGroup && (!dicomSource || isMobile || horizontalPlaneGroup)
    if (ready) {
      const box = getSliceSceneBounds()
      if (box.isEmpty()) return

      const center = new THREE.Vector3()
      const size = new THREE.Vector3()
      box.getCenter(center)
      box.getSize(size)
      setPlaneRadius(Math.max(size.x, size.y, size.z) * 0.6)

      if (!isSliceRigInitialized.current) {
        sliceRigGroup.position.copy(center)
        sliceRigGroup.rotation.set(0, 0, 0)
        sliceRigGroup.scale.set(1, 1, 1)
        sliceRigGroup.updateMatrix()
        sliceRigMatrixRef.current.copy(sliceRigGroup.matrix)
        isSliceRigInitialized.current = true
      } else {
        sliceRigGroup.matrix.copy(sliceRigMatrixRef.current)
        sliceRigGroup.matrix.decompose(sliceRigGroup.position, sliceRigGroup.quaternion, sliceRigGroup.scale)
      }

      if (!isPlaneInitialized.current) {
        planeGroup.position.set(0, 0, 0)
        planeGroup.rotation.set(0, Math.PI / 2, 0)
        planeGroup.scale.set(1, 1, 1)
        planeGroup.updateMatrix()
        planeMatrixRef.current.copy(planeGroup.matrix)
        isPlaneInitialized.current = true
      } else {
        planeGroup.matrix.copy(planeMatrixRef.current)
        planeGroup.matrix.decompose(planeGroup.position, planeGroup.quaternion, planeGroup.scale)
      }

      if (horizontalPlaneGroup) {
        if (!isHorizontalPlaneInitialized.current) {
          horizontalPlaneGroup.position.set(0, 0, 0)
          horizontalPlaneGroup.rotation.set(0, 0, 0)
          horizontalPlaneGroup.scale.set(1, 1, 1)
          horizontalPlaneGroup.updateMatrix()
          horizontalPlaneMatrixRef.current.copy(horizontalPlaneGroup.matrix)
          isHorizontalPlaneInitialized.current = true
        } else {
          horizontalPlaneGroup.matrix.copy(horizontalPlaneMatrixRef.current)
          horizontalPlaneGroup.matrix.decompose(horizontalPlaneGroup.position, horizontalPlaneGroup.quaternion, horizontalPlaneGroup.scale)
        }
      }

      sliceRigGroup.updateMatrixWorld(true)
      updateClippingLogic()
      if (horizontalPlaneGroup) updateHorizontalClippingLogic()
    } else if (!clippingEnabled) {
      setSliceSegments([])
      setSliceBBox(null)
      setDicomSlice2D(null)
      setMeasureState({ active: false, p1: null, p2: null, snappedP2: null })
      setHorizontalSliceSegments([])
      setHorizontalSliceBBox(null)
      setHorizontalDicomSlice2D(null)
      setHorizontalMeasureState({ active: false, p1: null, p2: null, snappedP2: null })
    }
  }, [clippingEnabled, dicomSource, isMobile, sliceRigGroup, planeGroup, horizontalPlaneGroup, getSliceSceneBounds, updateClippingLogic, updateHorizontalClippingLogic])

  useEffect(() => {
    ;(async () => {
      try {
        const mId = getParam("m")
        const manifestUrlParam = getParam("manifest")
        const filesParam = getParam("files")

        const applyFiles = (Fs, titleStr, logoUrl, headlight, camState, viewerState = null) => {
          setFiles(Fs)
          const palette = ["#f5f5dc", "#8e8e8e", "#ffffff", "#ffd7a8", "#c0c0c0", "#e6f0ff", "#ffeedd"]
          setColors(Fs.map((f, i) => f.c || palette[i % palette.length]))
          setOpacities(Fs.map((f) => (typeof f.o === "number" ? clamp01(f.o) : 1)))
          setVisibles(Fs.map((f) => (typeof f.v === "boolean" ? f.v : true)))
          setRoughnesses(Fs.map((f) => (typeof f.r === "number" ? clamp01(f.r) : 0.5)))
          setMetalnesses(Fs.map((f) => (typeof f.m === "number" ? clamp01(f.m) : 0.5)))
          setVertexColors(Fs.map(() => false))
          setWireframes(Fs.map((f) => !!f.wf))
          setGhostModes(Fs.map((f) => !!f.gh))
          
          setTitle(titleStr ?? (getParam("title") ?? null))
          setLogoCfg({
            url: logoUrl ?? (getParam("logo") === "none" ? null : getParam("logo") || DEFAULT_LOGO),
            opacity: clamp01(parseFloat(getParam("logoOpacity") ?? "0.9")),
            width: parseInt(getParam("logoWidth") ?? (typeof window !== "undefined" && window.innerWidth < 768 ? "120" : "160"), 10),
            pos: getParam("logoPos") || "bc",
          })
          if (headlight) {
            setHeadlightCfg({
              enabled: typeof headlight.enabled === "boolean" ? headlight.enabled : true,
              intensity: typeof headlight.intensity === "number" ? headlight.intensity : 2.0,
            })
          }
          if (camState) setInitialCameraState(camState)
          restoredViewerStateRef.current = null
          setPendingViewerState(viewerState)
          setDidInitialFrame(false)
          isPlaneInitialized.current = false 
          isHorizontalPlaneInitialized.current = false
          isSliceRigInitialized.current = false
        }

        if (mId) {
          // Veřejný link používá permanentní scene ID. Databáze ukazuje na právě
          // jednu aktuální immutable revizi. Staré přímé revision linky zůstávají
          // kompatibilní: z jejich suffixu odvodíme base scene ID a pokud již má
          // záznam v DB, také je přesměrujeme na nejnovější revision.
          const resolvedScene = await resolveCaseCloudManifestKey(mId)
          setCaseCloudContext({
            sceneId: resolvedScene.sceneId || getBaseCaseCloudSceneId(mId),
            labCaseId: resolvedScene.labCaseId || null,
            patientName: resolvedScene.patientName || null,
          })
          const manifestKey = resolvedScene.manifestKey || mId
          const requestBust = getParam("v") || `${Date.now()}`
          const manifestUrl = `${SUPABASE_URL}/storage/v1/object/public/${PUBLIC_BUCKET}/manifests/${encodeURIComponent(manifestKey)}.json?v=${encodeURIComponent(requestBust)}`
          const m = await fetchJSON(manifestUrl)
          const Fs = (m?.files || []).map((x, i) => ({
            url: x.u, name: stripExt(x.n) || `Model ${i + 1}`, rawName: x.n,
            c: x.c, o: typeof x.o === "number" ? clamp01(x.o) : 1,
            v: typeof x.v === "boolean" ? x.v : true,
            r: typeof x.r === "number" ? clamp01(x.r) : 0.5,
            m: typeof x.m === "number" ? clamp01(x.m) : 0.5,
            vc: x.vc !== undefined ? !!x.vc : undefined, km: !!x.km, wf: !!x.wf, gh: x.gh !== undefined ? !!x.gh : undefined
          }))
          applyFiles(Fs, m?.title, m?.logo?.url, m?.lights?.headlight, m?.camera, m?.viewer_state)
          applyDicomSource(m?.dicom || null)
          if (typeof m?.lights?.intensity === "number") setSceneIntensity(clamp01(m.lights.intensity))
          if (Array.isArray(m?.photos)) setPhotos(m.photos.map((p) => ({ u: p.u, n: p.n })))
          return
        }

        if (manifestUrlParam) {
          const m = await fetchJSON(manifestUrlParam)
          const Fs = (m?.files || []).map((x, i) => ({
            url: x.u, name: stripExt(x.n) || `Model ${i + 1}`, rawName: x.n,
            c: x.c, o: typeof x.o === "number" ? clamp01(x.o) : 1,
            v: typeof x.v === "boolean" ? x.v : true,
            r: typeof x.r === "number" ? clamp01(x.r) : 0.5,
            m: typeof x.m === "number" ? clamp01(x.m) : 0.5,
            vc: x.vc !== undefined ? !!x.vc : undefined, km: !!x.km, wf: !!x.wf, gh: x.gh !== undefined ? !!x.gh : undefined
          }))
          applyFiles(Fs, m?.title, m?.logo?.url, null, m?.camera, m?.viewer_state)
          applyDicomSource(m?.dicom || null)
          if (typeof m?.lights?.intensity === "number") setSceneIntensity(clamp01(m.lights.intensity))
          if (Array.isArray(m?.photos)) setPhotos(m.photos.map((p) => ({ u: p.u, n: p.n })))
          return
        }

        // ÚPRAVA 4: Bezpečné dekódování z parametrů přes try/catch
        if (filesParam) {
          let arr = null; 
          try { 
              arr = JSON.parse(decodeURIComponent(filesParam)) 
          } catch {
              try { arr = JSON.parse(filesParam) } catch {}
          }
          if (!Array.isArray(arr)) throw new Error("Neplatný formát parametru ?files=")
          const Fs = arr.filter((x) => x && x.u).map((x, i) => ({
            url: x.u, name: stripExt(x.n) || `Model ${i + 1}`, rawName: x.n,
            c: x.c, o: typeof x.o === "number" ? clamp01(x.o) : 1,
            v: typeof x.v === "boolean" ? x.v : true,
            r: typeof x.r === "number" ? clamp01(x.r) : 0.5,
            m: typeof x.m === "number" ? clamp01(x.m) : 0.5,
            vc: x.vc !== undefined ? !!x.vc : undefined, km: !!x.km, wf: !!x.wf, gh: x.gh !== undefined ? !!x.gh : undefined
          }))
          applyFiles(Fs, getParam("title") ?? null, null, null, null)
          const li = parseFloat(getParam("li") || getParam("light") || "")
          if (!Number.isNaN(li)) setSceneIntensity(clamp01(li))
          const headI = parseFloat(getParam("headlightI") || "")
          if (!Number.isNaN(headI)) setHeadlightCfg((o) => ({ ...o, intensity: headI }))
          return
        }

        setFiles([]); setColors([]); setOpacities([]); setVisibles([]); setRoughnesses([]); setMetalnesses([]); setVertexColors([]); setWireframes([])
      } catch (e) {
        console.error(e)
        setFatal("Tento náhled není dostupný (chyba při načtení dat).")
      }
    })()
  }, [applyDicomSource])

  useEffect(() => {
    const applyLivePayload = (p) => {
      if (!p) return

      if (p.onlyLights && p.lights) {
        if (typeof p.lights.intensity === "number") setSceneIntensity(clamp01(p.lights.intensity))
        if (p.lights.headlight) {
          setHeadlightCfg((old) => ({
            enabled: typeof p.lights.headlight.enabled === "boolean" ? p.lights.headlight.enabled : old.enabled,
            intensity: typeof p.lights.headlight.intensity === "number" ? p.lights.headlight.intensity : old.intensity,
          }))
        }
        return
      }

      if (typeof p.title === "string" || p.title === null) setTitle(p.title ?? null)
      if (Object.prototype.hasOwnProperty.call(p, "dicom")) applyDicomSource(p.dicom)
      if (p.viewer_state) {
        restoredViewerStateRef.current = null
        setPendingViewerState(p.viewer_state)
      }
      if (p.logo) {
        setLogoCfg((old) => ({
          url: p.logo?.url ?? old.url,
          opacity: typeof p.logo?.opacity === "number" ? clamp01(p.logo.opacity) : old.opacity,
          width: typeof p.logo?.width === "number" ? p.logo.width : old.width,
          pos: p.logo?.pos || old.pos,
        }))
      }

      if (Array.isArray(p.files)) {
        // ÚPRAVA 5: Odstranění prázdných položek, aby to nespadlo
        const newFiles = p.files.filter(x => x && x.u).map((x, i) => ({
          url: x.u, name: stripExt(x.n || `Model ${i + 1}`), rawName: x.n || `Model${i + 1}`,
          c: x.c, o: typeof x.o === "number" ? clamp01(x.o) : 1,
          v: typeof x.v === "boolean" ? x.v : true,
          r: typeof x.r === "number" ? clamp01(x.r) : 0.5,
          m: typeof x.m === "number" ? clamp01(x.m) : 0.5,
          vc: x.vc !== undefined ? !!x.vc : undefined, km: !!x.km, wf: !!x.wf, gh: x.gh !== undefined ? !!x.gh : undefined
        }))

        const urlsChanged = filesChanged(files, newFiles)

        setFiles(newFiles)
        const palette = ["#f5f5dc", "#8e8e8e", "#ffffff", "#ffd7a8", "#c0c0c0", "#e6f0ff", "#ffeedd"]
        setColors(newFiles.map((f, i) => f.c || palette[i % palette.length]))
        setOpacities(newFiles.map((f) => (typeof f.o === "number" ? clamp01(f.o) : 1)))
        setVisibles(newFiles.map((f) => (typeof f.v === "boolean" ? f.v : true)))
        setRoughnesses(newFiles.map((f) => (typeof f.r === "number" ? clamp01(f.r) : 0.5)))
        setMetalnesses(newFiles.map((f) => (typeof f.m === "number" ? clamp01(f.m) : 0.5)))
        
        // ÚPRAVA 6: Správné načítání textur a wireframe místo fixní hodnoty
        setVertexColors(newFiles.map((f) => !!hasTexMap[f.url] && f.vc !== false))
        setWireframes(newFiles.map((f) => !!f.wf))
        setGhostModes((previous) => newFiles.map((f) => {
          if (typeof f.gh === "boolean") return f.gh
          const oldIndex = files.findIndex((oldFile) => oldFile.url === f.url)
          return oldIndex >= 0 ? !!previous[oldIndex] : false
        }))

        // ÚPRAVA 7: Zachování kamery, pokud posíláme keepCamera: true
        if (urlsChanged && !p.keepCamera) { 
            setDidInitialFrame(false); 
            setInitialCameraState(null); 
            isPlaneInitialized.current = false;
            isHorizontalPlaneInitialized.current = false;
            isSliceRigInitialized.current = false;
        }
      }

      if (p.lights) {
        if (typeof p.lights.intensity === "number") setSceneIntensity(clamp01(p.lights.intensity))
        if (p.lights.headlight) {
          setHeadlightCfg((old) => ({
            enabled: typeof p.lights.headlight.enabled === "boolean" ? p.lights.headlight.enabled : old.enabled,
            intensity: typeof p.lights.headlight.intensity === "number" ? p.lights.headlight.intensity : old.intensity,
          }))
        }
      }
    }
    const onMsg = (e) => { const d = e.data; if (d && LIVE_MSG_TYPES.has(d.type) && d.payload) applyLivePayload(d.payload) }
    window.addEventListener("message", onMsg)
    return () => window.removeEventListener("message", onMsg)
  }, [files, applyDicomSource, hasTexMap])

  useEffect(() => {
    const onDicomCommand = (event) => {
      if (event.data?.type !== "SHADE3D_DICOM_LOAD") return
      const source = event.data?.payload?.dicom
      if (!source?.u) return
      applyDicomSource(source)
      startDicomLoad(source)
    }
    window.addEventListener("message", onDicomCommand)
    return () => window.removeEventListener("message", onDicomCommand)
  }, [applyDicomSource, startDicomLoad])

  const logoEl = logoCfg.url && (
    <img src={logoCfg.url} alt="" style={{
      position: "absolute",
      bottom: logoCfg.pos === "bc" || logoCfg.pos === "bl" || logoCfg.pos === "br" ? 12 : "auto",
      left: logoCfg.pos === "bl" ? 12 : logoCfg.pos === "bc" ? "50%" : "auto",
      right: logoCfg.pos === "br" ? 12 : "auto",
      transform: logoCfg.pos === "bc" ? "translateX(-50%)" : "none",
      width: logoCfg.width, opacity: logoCfg.opacity, zIndex: 0,
      pointerEvents: "none", userSelect: "none", filter: "drop-shadow(0 0 1px rgba(0,0,0,.25))",
    }}/>
  )

  const setDicomPreset = (preset) => {
    const presets = {
      teeth: { densityMin: 350, densityMax: 2200, opacity: 0.82 },
      bone: { densityMin: 180, densityMax: 1700, opacity: 0.72 },
      soft: { densityMin: -150, densityMax: 450, opacity: 0.5 },
    }
    setDicomSettings((previous) => ({
      ...previous,
      preset,
      ...(presets[preset] || presets.teeth),
    }))
  }

  const dicomControls = dicomSource && (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,.16)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 9 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 12 }}>DICOM / CT</div>
          <div title={dicomSource.n} style={{ fontSize: 10, color: "#9ca3af", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {dicomSource.n || "DICOM série"}
          </div>
        </div>
        {dicomStatus === "ready" && (
          <Switch
            checked={dicomSettings.visible !== false}
            onChange={(visible) => setDicomSettings((previous) => ({ ...previous, visible }))}
          />
        )}
      </div>

      {dicomStatus !== "ready" ? (
        <div>
          <div style={{ padding: "8px 9px", borderRadius: 7, background: "rgba(96,165,250,.1)", color: "#dbeafe", fontSize: 11, lineHeight: 1.4 }}>
            {dicomStatus === "downloading"
              ? `Stahuji DICOM data - ${Math.round(dicomProgress)}%`
              : dicomStatus === "processing"
                ? "Zpracovávám DICOM data..."
                : dicomStatus === "error"
                  ? "DICOM data se nepodařilo načíst."
                  : "DICOM data se automaticky připraví po načtení scény."}
          </div>
          {(dicomStatus === "downloading" || dicomStatus === "processing") && (
            <div style={{ height: 4, marginTop: 7, borderRadius: 999, overflow: "hidden", background: "rgba(255,255,255,.12)" }}>
              <div style={{ width: `${Math.max(2, dicomProgress)}%`, height: "100%", background: "#60a5fa", transition: "width .2s" }} />
            </div>
          )}
          {dicomError && <div style={{ marginTop: 7, color: "#fca5a5", fontSize: 11, lineHeight: 1.35 }}>{dicomError}</div>}
          {dicomStatus === "error" && (
            <button onClick={() => startDicomLoad(null, true)} style={{ width: "100%", marginTop: 8, border: 0, borderRadius: 7, padding: "8px 10px", background: "#2563eb", color: "white", fontWeight: 800, cursor: "pointer" }}>
              Zkusit znovu
            </button>
          )}
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6, marginBottom: 10 }}>
            {[
              ["teeth", "Zuby"],
              ["bone", "Kost"],
              ["soft", "Měkké tkáně"],
            ].map(([preset, label]) => (
              <button
                key={preset}
                onClick={() => setDicomPreset(preset)}
                style={{
                  minHeight: 34,
                  padding: "6px 4px",
                  borderRadius: 6,
                  border: dicomSettings.preset === preset ? "1px solid #60a5fa" : "1px solid #444",
                  background: dicomSettings.preset === preset ? "rgba(37,99,235,.4)" : "#151515",
                  color: "white",
                  fontSize: 10,
                  lineHeight: 1.15,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                {label}
              </button>
            ))}
          </div>

          <div style={{ marginBottom: 10 }}>
            <div style={{ marginBottom: 5, color: "#9ca3af", fontSize: 9, fontWeight: 800, letterSpacing: ".08em" }}>VIEWING MODE</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6 }}>
              {[
                ["light", "Light"],
                ["solid", "Solid"],
                ["only2d", "Only 2D"],
              ].map(([mode, label]) => (
                <button
                  key={mode}
                  onClick={() => {
                    setDicomSettings((previous) => ({ ...previous, viewMode: mode }))
                    if (mode === "only2d") setClippingEnabled(true)
                  }}
                  style={{
                    minHeight: 32,
                    padding: "6px 8px",
                    borderRadius: 6,
                    border: dicomSettings.viewMode === mode ? "1px solid #60a5fa" : "1px solid #444",
                    background: dicomSettings.viewMode === mode ? "rgba(37,99,235,.4)" : "#151515",
                    color: "white",
                    fontSize: 10,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {[
            ["Krytí", "opacity", 0.05, 1, 0.01, `${Math.round(dicomSettings.opacity * 100)} %`],
            ["Hustota od", "densityMin", -1000, 2500, 10, `${dicomSettings.densityMin} HU`],
            ["Hustota do", "densityMax", 0, 3500, 10, `${dicomSettings.densityMax} HU`],
            ["Ořez od", "cropMin", 0, 1, 0.01, `${Math.round(dicomSettings.cropMin * 100)} %`],
            ["Ořez do", "cropMax", 0, 1, 0.01, `${Math.round(dicomSettings.cropMax * 100)} %`],
          ].map(([label, key, min, max, step, value]) => (
            <label key={key} style={{ display: "block", marginTop: 7, fontSize: 10, color: "#bbb" }}>
              <span style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}><span>{label}</span><b style={{ color: "white" }}>{value}</b></span>
              <input type="range" min={min} max={max} step={step} value={dicomSettings[key]} onChange={(e) => setDicomSettings((previous) => ({ ...previous, preset: "custom", [key]: Number(e.target.value) }))} style={{ width: "100%" }} />
            </label>
          ))}

        </>
      )}
    </div>
  )

  const slidersContent = fatal ? (
    <div style={{ color: "#ff8b8b" }}>{fatal}</div>
  ) : (
    <>
      {files.map((f, i) => {
        const isTexAvailable = !!hasTexMap[f.url]
        const alignedInfo = alignedExportsByUrl[f.url] || null
        const alignedReferenceFile = alignedInfo ? files.find((item) => item.url === alignedInfo.referenceUrl) : null
        const trimmedInfo = trimmedExportsByUrl[f.url] || null
        const isExpanded = openColorPickerUrl === f.url
        const toggleExpanded = () =>
          setOpenColorPickerUrl((previous) => previous === f.url ? null : f.url)

        return (
          <div key={`${f.url}-${i}`} className="control-row" style={{
            display: "grid", gridTemplateColumns: "32px minmax(0,1fr) 30px 30px 30px 32px", alignItems: "center", columnGap: 7, rowGap: 8,
            margin: "7px 0", padding: "9px 10px", borderRadius: isExpanded ? 14 : 11, boxSizing: "border-box",
            background: isExpanded ? "rgba(12,12,12,.96)" : "rgba(255,255,255,.025)",
            border: isExpanded ? "1px solid rgba(255,255,255,.10)" : "1px solid rgba(255,255,255,.065)",
            boxShadow: isExpanded ? "0 18px 46px rgba(0,0,0,.30)" : "none", position: "relative",
            transition: "border-radius .32s ease, background .28s ease, border-color .28s ease, box-shadow .32s ease",
          }}>
            <div
              role="button"
              tabIndex={0}
              onClick={toggleExpanded}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault()
                  toggleExpanded()
                }
              }}
              aria-label={`${f.name} advanced material settings`}
              aria-expanded={isExpanded}
              title="Kliknutím otevřít barvu, Roughness a Metalness"
              style={{
                gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: 7, minWidth: 0,
                margin: "-4px -4px 0", padding: "4px 4px 3px", borderRadius: 8, cursor: "pointer",
                outline: "none", transition: "background .16s ease",
              }}
              onMouseEnter={(event) => { event.currentTarget.style.background = "rgba(255,255,255,.025)" }}
              onMouseLeave={(event) => { event.currentTarget.style.background = "transparent" }}
            >
              <div className="row-label" style={{
                flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                color: "#d7d7d7", fontSize: 10.5, fontWeight: 680, letterSpacing: "-.01em",
              }} title={f.rawName || f.name}>{stripExt(f.name)}</div>
              <span
                aria-hidden
                style={{
                  width: 24, height: 24, flex: "0 0 24px", padding: 0, display: "grid", placeItems: "center",
                  borderRadius: 7, border: isExpanded ? "1px solid rgba(255,255,255,.18)" : "1px solid rgba(255,255,255,.075)",
                  background: isExpanded ? "rgba(255,255,255,.06)" : "rgba(255,255,255,.02)",
                  color: isExpanded ? "#ededed" : "#858585",
                  transition: "background .16s ease, border-color .16s ease, color .16s ease",
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden style={{ transform: isExpanded ? "rotate(180deg)" : "rotate(0deg)", transition: "transform .22s cubic-bezier(.2,.75,.25,1)" }}>
                  <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            </div>
            
            <button
              type="button"
              onClick={toggleExpanded}
              aria-label={`${f.name} color`}
              aria-expanded={isExpanded}
              title="Barva a materiál modelu"
              style={{
                width: 32, height: 24, border: isExpanded ? "1px solid rgba(255,255,255,.24)" : "1px solid rgba(255,255,255,.12)",
                borderRadius: 7, padding: 3, cursor: "pointer", background: "rgba(255,255,255,.025)", boxSizing: "border-box",
                display: "grid", placeItems: "stretch", transition: "border-color .16s ease, background .16s ease, transform .16s ease",
              }}
            >
              <span style={{ width: "100%", height: "100%", borderRadius: 4, background: colors[i] ?? "#ffffff", border: "1px solid rgba(255,255,255,.14)", boxShadow: "inset 0 0 0 1px rgba(0,0,0,.12)" }} />
            </button>
            
            <input className="slider" type="range" min={0} max={1} step={0.01} value={opacities[i] ?? 1} onChange={(e) => { const v = parseFloat(e.target.value); setOpacities((prev) => prev.map((x, idx) => (idx === i ? v : x))) }} style={{ width: "100%", minWidth: 0, accentColor: "#bdbdbd" }} aria-label={`${f.name} opacity`} />
            
            <button 
              onClick={() => { if (isTexAvailable) setVertexColors(prev => prev.map((v, idx) => idx === i ? !v : v)) }}
              disabled={!isTexAvailable}
              title={isTexAvailable ? "Přepnout texturu / barevná data" : "Sken neobsahuje barevná data"}
              style={{
                  width: 30, height: 24, fontSize: 8.5, fontWeight: 720,
                  background: vertexColors[i] && isTexAvailable ? "rgba(34,197,94,.10)" : "rgba(255,255,255,.025)",
                  border: vertexColors[i] && isTexAvailable ? "1px solid rgba(74,222,128,.22)" : "1px solid rgba(255,255,255,.09)", borderRadius: 7, 
                  color: isTexAvailable ? (vertexColors[i] ? "#b7f7ca" : "#bdbdbd") : "rgba(255,255,255,0.22)", 
                  cursor: isTexAvailable ? "pointer" : "not-allowed", padding: 0,
                  textDecoration: isTexAvailable ? "none" : "line-through"
              }}
            >TEX</button>

            <button 
              onClick={() => {
                const next = !wireframes[i]
                setWireframes(prev => prev.map((v, idx) => idx === i ? next : v))
                if (next) setGhostModes(prev => prev.map((v, idx) => idx === i ? false : v))
              }}
              title="Přepnout drátěný model (Wireframe)"
              style={{
                  width: 30, height: 24, fontSize: 8.5, fontWeight: 720,
                  background: wireframes[i] ? "rgba(34,197,94,.10)" : "rgba(255,255,255,.025)",
                  border: wireframes[i] ? "1px solid rgba(74,222,128,.22)" : "1px solid rgba(255,255,255,.09)", borderRadius: 7, 
                  color: wireframes[i] ? "#b7f7ca" : "#bdbdbd", cursor: "pointer", padding: 0
              }}
            >WF</button>

            <button
              onClick={() => {
                const next = !ghostModes[i]
                setGhostModes((prev) => prev.map((value, idx) => idx === i ? next : value))
                if (next) setWireframes((prev) => prev.map((value, idx) => idx === i ? false : value))
              }}
              title={ghostModes[i] ? "Vypnout Ghost zobrazení" : "Ghost – transparentní diagnostická skořepina"}
              aria-pressed={!!ghostModes[i]}
              style={{
                width: 30, height: 24, fontSize: 8.2, fontWeight: 760, letterSpacing: "-.02em",
                background: ghostModes[i] ? "rgba(34,197,94,.10)" : "rgba(255,255,255,.025)",
                border: ghostModes[i] ? "1px solid rgba(74,222,128,.22)" : "1px solid rgba(255,255,255,.09)",
                borderRadius: 7, color: ghostModes[i] ? "#b7f7ca" : "#bdbdbd", cursor: "pointer", padding: 0,
                transition: "background .16s ease, border-color .16s ease, color .16s ease, transform .16s ease",
              }}
            >GH</button>

            <button className={`toggle icon-btn ${visibles[i] ? "is-on" : "is-off"}`} onClick={() => setVisibles((prev) => prev.map((v, idx) => (idx === i ? !v : v)))} aria-label={visibles[i] ? `Hide ${f.name}` : `Show ${f.name}`} title={visibles[i] ? "Skrýt" : "Zobrazit"} style={{ width: 32, height: 24, display: "inline-flex", alignItems: "center", justifyContent: "center", padding: 0, margin: 0, background: visibles[i] ? "rgba(255,255,255,.025)" : "rgba(255,255,255,.012)", border: "1px solid rgba(255,255,255,.09)", borderRadius: 7, cursor: "pointer", opacity: visibles[i] ? 1 : .56 }}>
              <img src={(visibles[i] ?? true) ? ICONS.eye : ICONS.eyeOff} alt="" width={14} height={14} style={{ display: "block", pointerEvents: "none", userSelect: "none" }}/>
            </button>

            {alignedInfo && (
              <div style={{
                gridColumn: "1 / -1", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
                marginTop: 1, padding: "7px 8px", borderRadius: 8,
                background: "rgba(34,197,94,.045)", border: "1px solid rgba(74,222,128,.12)",
              }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: "#b7f7ca", fontSize: 8.6, fontWeight: 760, letterSpacing: ".02em" }}>BEST FIT · ZAROVNÁNO</div>
                  <div style={{ marginTop: 2, color: "#707070", fontSize: 8.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    vůči {stripExt(alignedReferenceFile?.rawName || alignedReferenceFile?.name || "Reference A")}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 5, flex: "0 0 auto" }}>
                  <button
                    type="button"
                    onClick={() => downloadAlignedModel(f.url)}
                    disabled={alignedExportBusyUrl === f.url}
                    style={{ height: 25, padding: "0 8px", borderRadius: 7, border: "1px solid rgba(255,255,255,.09)", background: "rgba(255,255,255,.035)", color: "#d5d5d5", fontSize: 8.3, fontWeight: 680, cursor: alignedExportBusyUrl === f.url ? "wait" : "pointer" }}
                  >
                    {alignedExportBusyUrl === f.url ? "Připravuji…" : "Stáhnout"}
                  </button>
                  {editorCapabilities.canSaveAlignedToCase && (
                    <button
                      type="button"
                      onClick={() => saveAlignedModelToCase(f.url)}
                      disabled={alignedExportBusyUrl === f.url || !!alignedInfo.saveRequested}
                      style={{ height: 25, padding: "0 8px", borderRadius: 7, border: "1px solid rgba(74,222,128,.16)", background: "rgba(34,197,94,.065)", color: alignedInfo.saveRequested ? "#7b9c84" : "#b7f7ca", fontSize: 8.3, fontWeight: 700, cursor: alignedInfo.saveRequested ? "default" : "pointer" }}
                    >
                      {alignedInfo.saveRequested ? "Předáno" : "Uložit do zakázky"}
                    </button>
                  )}
                </div>
              </div>
            )}


            {trimmedInfo && (
              <div style={{
                gridColumn: "1 / -1", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
                marginTop: 1, padding: "7px 8px", borderRadius: 8,
                background: "rgba(245,158,11,.045)", border: "1px solid rgba(251,191,36,.13)",
              }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: "#fde68a", fontSize: 8.6, fontWeight: 760, letterSpacing: ".02em" }}>TRIMMED · OŘEZÁNO</div>
                  <div style={{ marginTop: 2, color: "#707070", fontSize: 8.2 }}>
                    {trimmedInfo.pointCount ? `${trimmedInfo.pointCount} řídicích bodů` : "upravená geometrie"}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 5, flex: "0 0 auto" }}>
                  <button type="button" onClick={() => downloadTrimmedModel(f.url)} disabled={trimExportBusyUrl === f.url}
                    style={{ height: 25, padding: "0 8px", borderRadius: 7, border: "1px solid rgba(255,255,255,.09)", background: "rgba(255,255,255,.035)", color: "#d5d5d5", fontSize: 8.3, fontWeight: 680, cursor: trimExportBusyUrl === f.url ? "wait" : "pointer" }}>
                    {trimExportBusyUrl === f.url ? "Připravuji…" : "Stáhnout"}
                  </button>
                  {editorCapabilities.canSaveTrimmedToCase && (
                    <button type="button" onClick={() => saveTrimmedModelToCase(f.url)} disabled={trimExportBusyUrl === f.url || !!trimmedInfo.saveRequested}
                      style={{ height: 25, padding: "0 8px", borderRadius: 7, border: "1px solid rgba(251,191,36,.17)", background: "rgba(245,158,11,.06)", color: trimmedInfo.saveRequested ? "#978764" : "#fde68a", fontSize: 8.3, fontWeight: 700, cursor: trimmedInfo.saveRequested ? "default" : "pointer" }}>
                      {trimmedInfo.saveRequested ? "Předáno" : "Uložit do zakázky"}
                    </button>
                  )}
                </div>
              </div>
            )}

            <div style={{
              gridColumn: "1 / -1", display: "grid",
              gridTemplateRows: isExpanded ? "1fr" : "0fr",
              opacity: isExpanded ? 1 : 0,
              transform: isExpanded ? "translateY(0) scale(1)" : "translateY(-7px) scale(.988)",
              filter: isExpanded ? "blur(0)" : "blur(2.5px)",
              pointerEvents: isExpanded ? "auto" : "none",
              overflow: "hidden",
              transition: "grid-template-rows .40s cubic-bezier(.2,.75,.25,1), opacity .22s .06s ease, transform .36s cubic-bezier(.2,.75,.25,1), filter .25s ease",
            }}>
              <div style={{ minHeight: 0, overflow: "hidden" }}>
                <ArtheticInlineColorPicker
                  value={colors[i] ?? "#ffffff"}
                  onChange={(nextColor) => setColors((prev) => prev.map((current, idx) => idx === i ? nextColor : current))}
                />
                <div style={{
                  display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12,
                  marginTop: 10, padding: "11px 3px 2px", borderTop: "1px solid rgba(255,255,255,.07)",
                }}>
                  <label style={{ display: "block", minWidth: 0 }}>
                    <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 7, marginBottom: 5, color: "#969696", fontSize: 9.5, fontWeight: 650 }}>
                      <span>Roughness</span><span style={{ color: "#d7d7d7", fontVariantNumeric: "tabular-nums" }}>{Math.round((roughnesses[i] ?? 0.25) * 100)}%</span>
                    </span>
                    <input type="range" min={0} max={1} step={0.01} value={roughnesses[i] ?? 0.25} onChange={(e) => { const v = parseFloat(e.target.value); setRoughnesses((prev) => prev.map((x, idx) => idx === i ? v : x)) }} style={{ width: "100%", accentColor: "#a3a3a3" }} aria-label={`${f.name} roughness`} />
                  </label>
                  <label style={{ display: "block", minWidth: 0 }}>
                    <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 7, marginBottom: 5, color: "#969696", fontSize: 9.5, fontWeight: 650 }}>
                      <span>Metalness</span><span style={{ color: "#d7d7d7", fontVariantNumeric: "tabular-nums" }}>{Math.round((metalnesses[i] ?? 0.12) * 100)}%</span>
                    </span>
                    <input type="range" min={0} max={1} step={0.01} value={metalnesses[i] ?? 0.12} onChange={(e) => { const v = parseFloat(e.target.value); setMetalnesses((prev) => prev.map((x, idx) => idx === i ? v : x)) }} style={{ width: "100%", accentColor: "#a3a3a3" }} aria-label={`${f.name} metalness`} />
                  </label>
                </div>
              </div>
            </div>
          </div>
        )
      })}
      {dicomControls}
    </>
  )

  const dicomLayoutActive = !!dicomSource && dicomStatus === "ready" && !isMobile && !alignmentMode
  const dicomPanelWidth = "clamp(360px, 34vw, 560px)"
  const activePlaneGroup = activeSlice === "horizontal" ? horizontalPlaneGroup : planeGroup

  useEffect(() => {
    if (!activePlaneGroup) return
    const frame = requestAnimationFrame(() => {
      ;[transformRotateRef.current, transformTranslateRef.current].forEach((control) => {
        if (!control) return
        control.attach(activePlaneGroup)
        control.axis = null
        control.enabled = true
      })
      if (trackballRef.current) trackballRef.current.enabled = !sliceOverlayInteracting
    })
    return () => cancelAnimationFrame(frame)
  }, [activePlaneGroup, sliceOverlayInteracting])

  useEffect(() => {
    if (dicomLayoutActive) setDidInitialFrame(false)
  }, [dicomLayoutActive])

  const analysisEligibleFiles = files.filter((file) => ["stl", "ply", "obj"].includes(inferExt(file.rawName || file.name || file.url)))

  const sidebar = (
    <div className="sidebar" style={{
      position: "absolute", top: 10, left: 10, zIndex: isMobile ? 5 : 2, width: "clamp(270px, 27vw, 400px)", maxWidth: "calc(100vw - 20px)",
      color: "#ededed", fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif", fontSize: 12,
      backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)", background: "rgba(12,12,12,.78)",
      border: "1px solid rgba(255,255,255,.09)", borderRadius: 14, padding: 8, boxSizing: "border-box",
      boxShadow: "0 18px 50px rgba(0,0,0,.24)", maxHeight: "calc(100vh - 20px)", overflowY: "auto"
    }}>
      {caseCloudContext.patientName ? (
        <div
          title={caseCloudContext.patientName}
          style={{
            marginBottom: 8, padding: "9px 10px", borderRadius: 10,
            border: "1px solid rgba(255,255,255,.065)", background: "rgba(255,255,255,.025)",
            color: "#ededed", fontSize: 13, lineHeight: 1.25, fontWeight: 720,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", letterSpacing: "-.015em"
          }}
        >
          {caseCloudContext.patientName}
        </div>
      ) : title ? (
        <div title={title} style={{ marginBottom: 8, padding: "9px 10px", borderRadius: 10, border: "1px solid rgba(255,255,255,.065)", background: "rgba(255,255,255,.025)", color: "#d7d7d7", fontSize: 10.5, fontWeight: 680, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
      ) : null}
      
      {isMobile ? (
        <>
          <button onClick={() => setSlidersOpen((o) => !o)} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 12px", background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.075)", borderRadius: 10, color: "#ededed", cursor: "pointer", fontWeight: 680, fontSize: 11 }}>
            <span>Nastavení modelů</span>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ transform: slidersOpen ? "rotate(90deg)" : "rotate(0deg)", transition: "transform .15s ease" }} aria-hidden><path d="M8 5l8 7-8 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
          {slidersOpen && <div style={{ marginTop: 8, border: "1px solid rgba(255,255,255,.055)", borderRadius: 11, padding: 6, background: "rgba(255,255,255,.012)" }}>{slidersContent}</div>}
        </>
      ) : (
        <div style={{ border: "1px solid rgba(255,255,255,.055)", borderRadius: 11, padding: 6, background: "rgba(255,255,255,.012)" }}>{slidersContent}</div>
      )}

      <div style={{
        display: isMobile ? "grid" : "flex",
        gridTemplateColumns: isMobile
          ? (caseCloudContext.labCaseId && getParam("mode") !== "live" ? "repeat(3, minmax(0, 1fr))" : "repeat(2, minmax(0, 1fr))")
          : undefined,
        alignItems: "center", justifyContent: "space-between", gap: isMobile ? 6 : 12, marginTop: 10,
      }}>
        <div style={{ minWidth: 0, width: isMobile ? "100%" : "auto", flex: isMobile ? "initial" : "0 0 auto" }}>
          {caseCloudContext.labCaseId && getParam("mode") !== "live" && (
            <button
              type="button"
              onClick={() => window.open(`https://www.arthetic.cz/lab-case?caseId=${encodeURIComponent(caseCloudContext.labCaseId)}`, "_blank", "noopener,noreferrer")}
              style={{
                background: "rgba(255,255,255,.035)", border: "1px solid rgba(255,255,255,.085)",
                borderRadius: 8, color: "#bdbdbd", padding: isMobile ? "6px 7px" : "6px 10px", fontSize: isMobile ? 9 : 9.5, cursor: "pointer",
                transition: "background .16s ease, color .16s ease, border-color .16s ease", fontWeight: 680,
                fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif", display: "inline-flex", alignItems: "center", gap: isMobile ? 4 : 6,
                width: isMobile ? "100%" : "auto", justifyContent: "center", whiteSpace: "nowrap", boxSizing: "border-box",
              }}
              title="Otevřít aktuální zakázku v LabCaseDetail"
            >
              <span>Otevřít zakázku</span>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M9 18l6-6-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
        {isMobile && (
          <button
            type="button"
            onClick={() => { setHeatmapMenuOpen(false); setComparisonMenuOpen(false); setMobileFunctionsOpen(true) }}
            style={{
              width: "100%", minWidth: 0,
              background: showHeatmap || showComparison || heatmapMenuOpen || comparisonMenuOpen || isAutoRotating || clippingEnabled ? "rgba(34,197,94,.075)" : "rgba(255,255,255,.035)",
              border: showHeatmap || showComparison || heatmapMenuOpen || comparisonMenuOpen || isAutoRotating || clippingEnabled ? "1px solid rgba(74,222,128,.19)" : "1px solid rgba(255,255,255,.085)",
              borderRadius: 8, color: showHeatmap || showComparison || isAutoRotating || clippingEnabled ? "#c8f8d5" : "#bdbdbd",
              padding: "6px 7px", fontSize: 9, cursor: "pointer",
              transition: "background .16s ease, color .16s ease, border-color .16s ease", fontWeight: 680,
              fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
            }}
            title="Otevřít analytické funkce"
          >
            <span>Funkce</span>
            {(showHeatmap || showComparison || isAutoRotating || clippingEnabled) && <span aria-hidden="true" style={{ width: 5, height: 5, borderRadius: "50%", background: "#86efac", boxShadow: "0 0 8px rgba(74,222,128,.38)" }} />}
          </button>
        )}
        <button
          onClick={() => setDidInitialFrame(false)}
          style={{
            background: "rgba(255,255,255,.035)", border: "1px solid rgba(255,255,255,.085)",
            borderRadius: 8, color: "#bdbdbd", padding: isMobile ? "6px 7px" : "6px 10px", fontSize: isMobile ? 9 : 9.5, cursor: "pointer",
            transition: "background .16s ease, color .16s ease, border-color .16s ease", fontWeight: 680,
            fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif", whiteSpace: "nowrap", width: isMobile ? "100%" : "auto", minWidth: 0, flex: isMobile ? "initial" : "initial"
          }}
          title="Vrátí kameru do výchozí polohy"
        >
          Reset view
        </button>
      </div>

      {isMobile && !heatmapMenuOpen && !comparisonMenuOpen && showHeatmap && hasComputedHeatmap && (
        <div style={{ marginTop: 8, padding: "8px 10px 7px", borderRadius: 10, background: "rgba(255,255,255,.022)", border: "1px solid rgba(255,255,255,.065)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
            <span style={{ color: "#cfcfcf", fontSize: 9.2, fontWeight: 720 }}>Okluze</span>
            <span style={{ color: "#626262", fontSize: 7.8, fontWeight: 620 }}>průnik · mezera · mm</span>
          </div>
          <div style={{ height: 5, borderRadius: 999, background: "linear-gradient(to right, #7e22ce 0%, #ef4444 25%, #facc15 37.5%, #22c55e 62.5%, #ffffff 100%)", boxShadow: "inset 0 1px 2px rgba(0,0,0,.35)" }} />
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, color: "#686868", fontSize: 7.3, fontWeight: 650, fontVariantNumeric: "tabular-nums" }}>
            <span>-1.0−</span><span>-0.5</span><span>0</span><span>1.0</span><span>2.0+</span>
          </div>
        </div>
      )}

      {isMobile && !heatmapMenuOpen && !comparisonMenuOpen && showComparison && hasComputedComparison && (
        <div style={{ marginTop: 8, padding: "8px 10px 7px", borderRadius: 10, background: "rgba(255,255,255,.022)", border: "1px solid rgba(255,255,255,.065)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
            <span style={{ color: "#cfcfcf", fontSize: 9.2, fontWeight: 720 }}>Porovnání · {comparisonDirection === "A_TO_B" ? "A → B" : "B → A"}</span>
            <span style={{ color: "#626262", fontSize: 7.8, fontWeight: 620 }}>odchylka · mm</span>
          </div>
          <div style={{ height: 5, borderRadius: 999, background: "linear-gradient(to right, #2563eb 0%, #22c55e 25%, #facc15 50%, #ef4444 75%, #a21caf 100%)" }} />
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, color: "#686868", fontSize: 7.3, fontWeight: 650, fontVariantNumeric: "tabular-nums" }}>
            <span>0</span><span>{comparisonTolerance.toFixed(2)}</span><span>{(comparisonTolerance * 2).toFixed(2)}</span><span>{(comparisonTolerance * 4).toFixed(2)}</span><span>více</span>
          </div>
        </div>
      )}

      {photos && photos.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <button onClick={() => setLightbox({ open: true, src: photos[0].u, alt: photos[0].n || "" })} style={{ width: "100%", padding: "8px 10px", background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.075)", borderRadius: 10, color: "#d7d7d7", cursor: "pointer", fontWeight: 680, fontSize: 10.5 }}>Fotky ({photos.length})</button>
        </div>
      )}
    </div>
  )

  const occlusionModelsReady = heatmapSelection.length === 2
  const comparisonModelsReady = comparisonSelection.length === 2
  const comparisonAnalyzedUrl = comparisonDirection === "B_TO_A" ? comparisonSelection[1] : comparisonSelection[0]
  const comparisonReferenceUrl = comparisonDirection === "B_TO_A" ? comparisonSelection[0] : comparisonSelection[1]

  const viewerToolbarButtonStyle = (disabled = false, active = false) => ({
    display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
    height: 40, padding: "0 14px", width: "100%", boxSizing: "border-box",
    background: "rgba(12,12,12,.72)",
    backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)",
    border: active ? "1px solid rgba(74,222,128,.24)" : "1px solid rgba(255,255,255,.10)",
    borderRadius: 11, color: disabled ? "#666" : active ? "#c8f8d5" : "#ededed",
    cursor: disabled ? "not-allowed" : "pointer", fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
    fontWeight: 680, fontSize: 12, letterSpacing: "-.01em",
    boxShadow: active ? "inset 0 0 0 1px rgba(34,197,94,.035)" : "none",
    transition: "background .16s ease, border-color .16s ease, box-shadow .16s ease, color .16s ease, transform .16s ease",
  })

  const analysisCloseButtonStyle = {
    position: "absolute", top: 10, right: 10, zIndex: 8, width: 30, height: 30, padding: 0,
    display: "grid", placeItems: "center", borderRadius: 9,
    border: "1px solid rgba(255,255,255,.09)", background: "rgba(255,255,255,.035)",
    color: "#bdbdbd", cursor: "pointer", transition: "background .16s ease, color .16s ease, border-color .16s ease, transform .16s ease",
  }

  const analysisStepChipStyle = (active, completed) => ({
    height: 27, padding: "0 9px", borderRadius: 8,
    display: "inline-flex", alignItems: "center", gap: 5, boxSizing: "border-box",
    background: active ? "rgba(34,197,94,.09)" : "rgba(255,255,255,.035)",
    border: active ? "1px solid rgba(74,222,128,.25)" : "1px solid rgba(255,255,255,.07)",
    color: active ? "#b7f7ca" : completed ? "#a8d9b5" : "#777",
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif", fontSize: 9, fontWeight: 680, whiteSpace: "nowrap",
  })

  const topBarRight = (!isMobile || heatmapMenuOpen || comparisonMenuOpen) && (
    <div style={{
      position: "absolute",
      top: isMobile ? "auto" : 10,
      bottom: isMobile ? 10 : "auto",
      right: isMobile ? 10 : (dicomLayoutActive ? "auto" : 10),
      left: isMobile ? 10 : (dicomLayoutActive ? `calc((100vw - ${dicomPanelWidth} + clamp(260px, 28vw, 420px) + 20px) / 2)` : "auto"),
      transform: isMobile ? "none" : (dicomLayoutActive ? "translateX(-50%)" : "none"),
      zIndex: isMobile ? 460 : 10,
      display: "flex",
      flexDirection: isMobile ? "column" : (dicomLayoutActive ? "row" : "column"),
      alignItems: isMobile ? "stretch" : "flex-start",
      gap: isMobile ? 0 : (dicomLayoutActive ? 8 : 10),
      fontFamily: "sans-serif",
      color: "white",
      width: isMobile ? "calc(100vw - 20px)" : "auto",
      maxWidth: "calc(100vw - 20px)",
    }}>
      
      <div style={{ width: dicomLayoutActive ? 120 : 270, display: isMobile ? "none" : "block" }}>
        <button
          onClick={openAlignmentMode}
          disabled={files.filter((file) => ["stl", "ply", "obj"].includes(inferExt(file.rawName || file.name || file.url))).length < 2}
          style={{
            ...viewerToolbarButtonStyle(files.filter((file) => ["stl", "ply", "obj"].includes(inferExt(file.rawName || file.name || file.url))).length < 2),
            opacity: files.filter((file) => ["stl", "ply", "obj"].includes(inferExt(file.rawName || file.name || file.url))).length < 2 ? 0.45 : 1,
          }}
          title="Zarovnání dvou 3D modelů pomocí bodů a robustního Best Fit"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="8" cy="8" r="3"/><circle cx="16" cy="16" r="3"/><path d="M10.5 10.5l3 3"/><path d="M14 5h5v5"/><path d="M10 19H5v-5"/>
          </svg>
          Zarovnání
        </button>
      </div>

      <div style={{ width: dicomLayoutActive ? 120 : 270, display: isMobile ? "none" : "block" }}>
        <button
          onClick={openTrimMode}
          disabled={analysisEligibleFiles.length < 1}
          style={{ ...viewerToolbarButtonStyle(analysisEligibleFiles.length < 1), opacity: analysisEligibleFiles.length < 1 ? 0.45 : 1 }}
          title="Ořezat jeden 3D scan pomocí uzavřené křivky vedené po povrchu"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 6.5c3.5-2 10.5-2 14 0M5 17.5c3.5 2 10.5 2 14 0"/>
            <path d="M7 5l-2 1.5L7 8M17 16l2 1.5-2 1.5"/>
            <path d="M8.5 10.5l7 3M15.5 10.5l-7 3"/>
          </svg>
          Ořez
        </button>
      </div>

      <style>{`
        @keyframes artheticAnalysisMenuIn { from { opacity:0; transform:translateY(-5px) scale(.985); } to { opacity:1; transform:translateY(0) scale(1); } }
        @keyframes artheticAlignMenuIn { from { opacity:0; transform:translateY(-4px) scale(.985); } to { opacity:1; transform:translateY(0) scale(1); } }
        @keyframes artheticAnalysisSpin { to { transform:rotate(360deg); } }
        @keyframes artheticColorPickerReveal { from { opacity:0; transform:translateY(-5px) scale(.985); filter:blur(3px); } to { opacity:1; transform:translateY(0) scale(1); filter:blur(0); } }
        @property --artheticAnalysisBeamAngle { syntax:"<angle>"; inherits:false; initial-value:0deg; }
        @keyframes artheticAnalysisReadyBeam { to { --artheticAnalysisBeamAngle:360deg; } }
        .artheticAnalysisReadyAction { position:relative; isolation:isolate; overflow:visible; border:1px solid transparent !important; background:transparent !important; }
        .artheticAnalysisReadyAction::before {
          content:""; position:absolute; inset:-2px; padding:2px; border-radius:12px; pointer-events:none; z-index:0;
          background:conic-gradient(from var(--artheticAnalysisBeamAngle), rgba(74,222,128,0) 0deg 287deg, rgba(74,222,128,.06) 302deg, rgba(74,222,128,.46) 318deg, rgba(240,253,244,1) 332deg, rgba(134,239,172,.7) 343deg, rgba(74,222,128,.08) 354deg, rgba(74,222,128,0) 360deg);
          -webkit-mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite:xor; mask-composite:exclude;
          filter:drop-shadow(0 0 2px rgba(134,239,172,.68)) drop-shadow(0 0 6px rgba(34,197,94,.26)); animation:artheticAnalysisReadyBeam 1.9s linear infinite;
        }
        .artheticAnalysisReadyAction::after { content:""; position:absolute; inset:1px; border-radius:8px; z-index:1; pointer-events:none; background:rgba(18,42,27,.97); box-shadow:inset 0 0 0 1px rgba(34,197,94,.12); }
        .artheticAnalysisReadyAction > * { position:relative; z-index:3; }
        .artheticAnalysisRange { accent-color:#4ade80; cursor:pointer; }
        .sidebar input[type="range"] { accent-color:#a3a3a3; }
        .sidebar::-webkit-scrollbar { width:6px; }
        .sidebar::-webkit-scrollbar-thumb { background:rgba(255,255,255,.10); border-radius:999px; }
      `}</style>

      <div style={{
        width: isMobile ? "100%" : (dicomLayoutActive ? 120 : 270),
        display: isMobile && !heatmapMenuOpen ? "none" : "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        position: "relative",
        zIndex: heatmapMenuOpen ? 420 : 2,
        overflow: "visible",
      }}>
        <div style={{
          width: isMobile ? "100%" : (heatmapMenuOpen ? (dicomLayoutActive ? 320 : 310) : "100%"),
          maxWidth: "calc(100vw - 20px)",
          maxHeight: isMobile ? "calc(100vh - 24px)" : "none",
          boxSizing: "border-box",
          borderRadius: heatmapMenuOpen ? 15 : 11,
          border: heatmapMenuOpen ? "1px solid rgba(255,255,255,.095)" : "1px solid rgba(255,255,255,.10)",
          background: heatmapMenuOpen ? "rgba(12,12,12,.96)" : "rgba(12,12,12,.72)",
          backdropFilter: heatmapMenuOpen ? "blur(20px)" : "blur(14px)",
          WebkitBackdropFilter: heatmapMenuOpen ? "blur(20px)" : "blur(14px)",
          boxShadow: heatmapMenuOpen ? "0 24px 64px rgba(0,0,0,.42)" : "none",
          color: "#f2f2f2",
          fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
          overflow: "visible",
          transition: "width .36s cubic-bezier(.2,.75,.25,1), border-radius .32s ease, background .28s ease, border-color .28s ease, box-shadow .32s ease, backdrop-filter .32s ease",
          position: "relative",
        }}>
          {heatmapMenuOpen && (
            <button
              onClick={(event) => { event.stopPropagation(); setHeatmapMenuOpen(false) }}
              style={analysisCloseButtonStyle}
              title="Sbalit Okluzi"
              aria-label="Sbalit Okluzi"
              onMouseEnter={(event) => { event.currentTarget.style.background = "rgba(255,255,255,.075)"; event.currentTarget.style.color = "#fff"; event.currentTarget.style.borderColor = "rgba(255,255,255,.15)" }}
              onMouseLeave={(event) => { event.currentTarget.style.background = "rgba(255,255,255,.035)"; event.currentTarget.style.color = "#bdbdbd"; event.currentTarget.style.borderColor = "rgba(255,255,255,.09)" }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
          )}
          <button
            onClick={() => { setHeatmapMenuOpen((prev) => !prev); setComparisonMenuOpen(false) }}
            disabled={analysisEligibleFiles.length < 2}
            title="Změřit mezeru a průnik mezi dvěma modely"
            style={{
              position: "relative", width: "100%", height: heatmapMenuOpen ? 54 : 38, padding: 0,
              border: 0, borderRadius: "inherit", background: "transparent", color: analysisEligibleFiles.length < 2 ? "#666" : "#ededed",
              cursor: analysisEligibleFiles.length < 2 ? "not-allowed" : "pointer", fontFamily: "inherit", overflow: "hidden",
              transition: "height .32s cubic-bezier(.2,.75,.25,1), color .18s ease",
            }}
          >
            <span style={{
              position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              opacity: heatmapMenuOpen ? 0 : 1, transform: heatmapMenuOpen ? "translateY(-7px) scale(.98)" : "translateY(0) scale(1)",
              transition: "opacity .16s ease, transform .28s cubic-bezier(.2,.75,.25,1)", pointerEvents: "none",
              fontWeight: 680, fontSize: 12, letterSpacing: "-.01em",
            }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 8.5c3.2-2.5 6.4-3.7 9.5-3.2 2.2.3 4.3 1.5 6.5 3.2"/><path d="M4 15.5c3.2 2.5 6.4 3.7 9.5 3.2 2.2-.3 4.3-1.5 6.5-3.2"/><path d="M7 11.7h10"/><path d="M9.2 9.8L7 12l2.2 2.2"/><path d="M14.8 9.8L17 12l-2.2 2.2"/>
              </svg>
              <span>Okluze</span>
            </span>

            <span style={{
              position: "absolute", inset: 0, display: "flex", alignItems: "center", padding: "0 50px 0 14px", boxSizing: "border-box",
              opacity: heatmapMenuOpen ? 1 : 0, transform: heatmapMenuOpen ? "translateY(0) scale(1)" : "translateY(7px) scale(.985)",
              transition: "opacity .2s .08s ease, transform .32s cubic-bezier(.2,.75,.25,1)", pointerEvents: "none", textAlign: "left",
            }}>
              <span>
                <span style={{ display: "block", lineHeight: 1.05 }}><span style={{ fontSize: 14, fontWeight: 850 }}>ART</span><span style={{ fontSize: 14, fontWeight: 300 }}>HETIC</span><span style={{ marginLeft: 6, fontSize: 14, fontWeight: 300, color: "#d7d7d7" }}>Okluze</span></span>
                <span style={{ display: "block", marginTop: 4, color: "#666", fontSize: 9.5, fontWeight: 590 }}>Průnik a mezera mezi dvěma povrchy · mm</span>
              </span>
            </span>
          </button>

          <div style={{
            display: "grid",
            gridTemplateRows: heatmapMenuOpen ? "1fr" : "0fr",
            opacity: heatmapMenuOpen ? 1 : 0,
            transform: heatmapMenuOpen ? "translateY(0)" : "translateY(-8px)",
            pointerEvents: heatmapMenuOpen ? "auto" : "none",
            overflow: heatmapMenuOpen ? "visible" : "hidden",
            transition: "grid-template-rows .38s cubic-bezier(.2,.75,.25,1), opacity .2s .08s ease, transform .34s cubic-bezier(.2,.75,.25,1)",
          }}>
            <div style={{ minHeight: 0, overflow: heatmapMenuOpen ? "visible" : "hidden" }}>
              <div style={{ padding: "0 14px 14px", boxSizing: "border-box" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={analysisStepChipStyle(!occlusionModelsReady, occlusionModelsReady)}>
                    {occlusionModelsReady && <span style={{ color: "#86efac" }}>✓</span>}<span>Vybrat modely</span>
                  </div>
                  <div style={{ width: 13, height: 1, background: "rgba(255,255,255,.07)" }} />
                  <div style={analysisStepChipStyle(occlusionModelsReady && !hasComputedHeatmap, hasComputedHeatmap)}>
                    {hasComputedHeatmap && <span style={{ color: "#86efac" }}>✓</span>}<span>Vypočítat</span>
                  </div>
                </div>

                <div style={{ height: 1, background: "rgba(255,255,255,.07)", margin: "13px 0" }} />

                <div style={{ display: "grid", gap: 11 }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                      <span style={{ color: "#bdbdbd", fontSize: 9.5, fontWeight: 700 }}>A · Barevná mapa</span>
                      <span style={{ color: "#5d5d5d", fontSize: 8.5 }}>zobrazí průnik / mezeru</span>
                    </div>
                    <AlignmentModelDropdown badge="A" value={heatmapSelection[0] || ""} files={analysisEligibleFiles} otherValue={heatmapSelection[1] || ""} onChange={(url) => setHeatmapSelectionSlot(0, url)} />
                  </div>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                      <span style={{ color: "#bdbdbd", fontSize: 9.5, fontWeight: 700 }}>B · Referenční model</span>
                      <span style={{ color: "#5d5d5d", fontSize: 8.5 }}>vzdálenost vůči B</span>
                    </div>
                    <AlignmentModelDropdown badge="B" value={heatmapSelection[1] || ""} files={analysisEligibleFiles} otherValue={heatmapSelection[0] || ""} disabled={!heatmapSelection[0]} onChange={(url) => setHeatmapSelectionSlot(1, url)} />
                  </div>
                </div>

                <button
                  onClick={handleApplyHeatmap}
                  disabled={!occlusionModelsReady || isCalculatingHeatmap}
                  className={occlusionModelsReady && !hasComputedHeatmap && !isCalculatingHeatmap ? "artheticAnalysisReadyAction" : undefined}
                  style={{
                    marginTop: 14, width: "100%", height: 36, borderRadius: 10, boxSizing: "border-box",
                    border: "1px solid rgba(255,255,255,.09)",
                    background: hasComputedHeatmap ? "rgba(255,255,255,.055)" : occlusionModelsReady ? "rgba(18,42,27,.97)" : "rgba(255,255,255,.03)",
                    color: !occlusionModelsReady ? "#555" : hasComputedHeatmap ? "#c9c9c9" : "#dffbea",
                    cursor: !occlusionModelsReady || isCalculatingHeatmap ? "not-allowed" : "pointer",
                    fontFamily: "inherit", fontSize: 10, fontWeight: 720,
                  }}
                ><span>{hasComputedHeatmap ? "Přepočítat okluzi" : "Vypočítat okluzi"}</span></button>

                {hasComputedHeatmap && (
                  <div style={{ marginTop: 13, padding: 11, borderRadius: 11, background: "rgba(255,255,255,.035)", border: "1px solid rgba(255,255,255,.065)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 10 }}>
                      <span style={{ width: 16, height: 16, borderRadius: "50%", display: "grid", placeItems: "center", color: "#86efac", background: "rgba(34,197,94,.1)", border: "1px solid rgba(74,222,128,.2)", fontSize: 10 }}>✓</span>
                      <span style={{ fontSize: 10, fontWeight: 720, color: "#d8d8d8" }}>Výpočet dokončen</span>
                    </div>
                    <Switch checked={showHeatmap} onChange={(checked) => { setShowHeatmap(checked); if (checked) setShowComparison(false) }} label="Zobrazit mapu okluze" />
                    <div style={{ marginTop: 8, color: "#666", fontSize: 8.8, lineHeight: 1.45 }}>Záporná hodnota = průnik. Dvojklikem připnete hodnotu do scény.</div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div style={{
        width: isMobile ? "100%" : (dicomLayoutActive ? 120 : 270),
        display: isMobile && !comparisonMenuOpen ? "none" : "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        position: "relative",
        zIndex: comparisonMenuOpen ? 420 : 2,
        overflow: "visible",
      }}>
        <div style={{
          width: isMobile ? "100%" : (comparisonMenuOpen ? (dicomLayoutActive ? 330 : 320) : "100%"),
          maxWidth: "calc(100vw - 20px)",
          maxHeight: isMobile ? "calc(100vh - 24px)" : "none",
          boxSizing: "border-box",
          borderRadius: comparisonMenuOpen ? 15 : 11,
          border: comparisonMenuOpen ? "1px solid rgba(255,255,255,.095)" : "1px solid rgba(255,255,255,.10)",
          background: comparisonMenuOpen ? "rgba(12,12,12,.96)" : "rgba(12,12,12,.72)",
          backdropFilter: comparisonMenuOpen ? "blur(20px)" : "blur(14px)",
          WebkitBackdropFilter: comparisonMenuOpen ? "blur(20px)" : "blur(14px)",
          boxShadow: comparisonMenuOpen ? "0 24px 64px rgba(0,0,0,.42)" : "none",
          color: "#f2f2f2",
          fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
          overflow: "visible",
          transition: "width .36s cubic-bezier(.2,.75,.25,1), border-radius .32s ease, background .28s ease, border-color .28s ease, box-shadow .32s ease, backdrop-filter .32s ease",
          position: "relative",
        }}>
          {comparisonMenuOpen && (
            <button
              onClick={(event) => { event.stopPropagation(); setComparisonMenuOpen(false) }}
              style={analysisCloseButtonStyle}
              title="Sbalit Porovnání"
              aria-label="Sbalit Porovnání"
              onMouseEnter={(event) => { event.currentTarget.style.background = "rgba(255,255,255,.075)"; event.currentTarget.style.color = "#fff"; event.currentTarget.style.borderColor = "rgba(255,255,255,.15)" }}
              onMouseLeave={(event) => { event.currentTarget.style.background = "rgba(255,255,255,.035)"; event.currentTarget.style.color = "#bdbdbd"; event.currentTarget.style.borderColor = "rgba(255,255,255,.09)" }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
          )}
          <button
            onClick={() => { setComparisonMenuOpen((prev) => !prev); setHeatmapMenuOpen(false) }}
            disabled={analysisEligibleFiles.length < 2}
            title="Oboustranně porovnat podobnost povrchů dvou modelů"
            style={{
              position: "relative", width: "100%", height: comparisonMenuOpen ? 54 : 38, padding: 0,
              border: 0, borderRadius: "inherit", background: "transparent", color: analysisEligibleFiles.length < 2 ? "#666" : "#ededed",
              cursor: analysisEligibleFiles.length < 2 ? "not-allowed" : "pointer", fontFamily: "inherit", overflow: "hidden",
              transition: "height .32s cubic-bezier(.2,.75,.25,1), color .18s ease",
            }}
          >
            <span style={{
              position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              opacity: comparisonMenuOpen ? 0 : 1, transform: comparisonMenuOpen ? "translateY(-7px) scale(.98)" : "translateY(0) scale(1)",
              transition: "opacity .16s ease, transform .28s cubic-bezier(.2,.75,.25,1)", pointerEvents: "none",
              fontWeight: 680, fontSize: 12, letterSpacing: "-.01em",
            }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 7h9"/><path d="M10.5 3.5L14 7l-3.5 3.5"/><path d="M19 17h-9"/><path d="M13.5 13.5L10 17l3.5 3.5"/>
              </svg>
              <span>Porovnání</span>
            </span>

            <span style={{
              position: "absolute", inset: 0, display: "flex", alignItems: "center", padding: "0 50px 0 14px", boxSizing: "border-box",
              opacity: comparisonMenuOpen ? 1 : 0, transform: comparisonMenuOpen ? "translateY(0) scale(1)" : "translateY(7px) scale(.985)",
              transition: "opacity .2s .08s ease, transform .32s cubic-bezier(.2,.75,.25,1)", pointerEvents: "none", textAlign: "left",
            }}>
              <span>
                <span style={{ display: "block", lineHeight: 1.05 }}><span style={{ fontSize: 14, fontWeight: 850 }}>ART</span><span style={{ fontSize: 14, fontWeight: 300 }}>HETIC</span><span style={{ marginLeft: 6, fontSize: 14, fontWeight: 300, color: "#d7d7d7" }}>Porovnání</span></span>
                <span style={{ display: "block", marginTop: 4, color: "#666", fontSize: 9.5, fontWeight: 590 }}>Oboustranná povrchová odchylka · mm</span>
              </span>
            </span>
          </button>

          <div style={{
            display: "grid",
            gridTemplateRows: comparisonMenuOpen ? "1fr" : "0fr",
            opacity: comparisonMenuOpen ? 1 : 0,
            transform: comparisonMenuOpen ? "translateY(0)" : "translateY(-8px)",
            pointerEvents: comparisonMenuOpen ? "auto" : "none",
            overflow: comparisonMenuOpen ? "visible" : "hidden",
            transition: "grid-template-rows .38s cubic-bezier(.2,.75,.25,1), opacity .2s .08s ease, transform .34s cubic-bezier(.2,.75,.25,1)",
          }}>
            <div style={{ minHeight: 0, overflow: comparisonMenuOpen ? "visible" : "hidden" }}>
              <div style={{ padding: "0 14px 14px", boxSizing: "border-box" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={analysisStepChipStyle(!comparisonModelsReady, comparisonModelsReady)}>
                    {comparisonModelsReady && <span style={{ color: "#86efac" }}>✓</span>}<span>Vybrat modely</span>
                  </div>
                  <div style={{ width: 13, height: 1, background: "rgba(255,255,255,.07)" }} />
                  <div style={analysisStepChipStyle(comparisonModelsReady && !hasComputedComparison, hasComputedComparison)}>
                    {hasComputedComparison && <span style={{ color: "#86efac" }}>✓</span>}<span>Vypočítat</span>
                  </div>
                </div>

                <div style={{ height: 1, background: "rgba(255,255,255,.07)", margin: "13px 0" }} />

                <div style={{ display: "grid", gap: 11 }}>
                  <div>
                    <div style={{ marginBottom: 6, color: "#bdbdbd", fontSize: 9.5, fontWeight: 700 }}>
                      A · {comparisonDirection === "A_TO_B" ? "Analyzovaný model" : "Referenční model"}
                    </div>
                    <AlignmentModelDropdown badge="A" value={comparisonSelection[0] || ""} files={analysisEligibleFiles} otherValue={comparisonSelection[1] || ""} onChange={(url) => setComparisonSelectionSlot(0, url)} />
                  </div>
                  <div>
                    <div style={{ marginBottom: 6, color: "#bdbdbd", fontSize: 9.5, fontWeight: 700 }}>
                      B · {comparisonDirection === "A_TO_B" ? "Referenční model" : "Analyzovaný model"}
                    </div>
                    <AlignmentModelDropdown badge="B" value={comparisonSelection[1] || ""} files={analysisEligibleFiles} otherValue={comparisonSelection[0] || ""} disabled={!comparisonSelection[0]} onChange={(url) => setComparisonSelectionSlot(1, url)} />
                  </div>
                </div>

                <div style={{ marginTop: 13, padding: "9px 10px", borderRadius: 11, background: "rgba(255,255,255,.025)", border: "1px solid rgba(255,255,255,.065)" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
                    <span style={{ color: "#8a8a8a", fontSize: 9.3, fontWeight: 650 }}>Mapa odchylek</span>
                    <span style={{ color: "#707070", fontSize: 8.7 }}>Reference zůstává v původní opacitě</span>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, padding: 3, borderRadius: 9, background: "rgba(0,0,0,.28)", border: "1px solid rgba(255,255,255,.055)" }}>
                    {[
                      ["A_TO_B", "A → B"],
                      ["B_TO_A", "B → A"],
                    ].map(([direction, label]) => {
                      const active = comparisonDirection === direction
                      return (
                        <button
                          key={direction}
                          type="button"
                          onClick={() => handleComparisonDirectionChange(direction)}
                          disabled={!comparisonModelsReady}
                          style={{
                            height: 28, borderRadius: 7, border: active ? "1px solid rgba(74,222,128,.20)" : "1px solid transparent",
                            background: active ? "rgba(22,54,34,.78)" : "transparent",
                            color: !comparisonModelsReady ? "#555" : active ? "#c8f8d5" : "#858585",
                            cursor: comparisonModelsReady ? "pointer" : "not-allowed", fontFamily: "inherit", fontSize: 9.5, fontWeight: 720,
                            transition: "background .18s ease, border-color .18s ease, color .18s ease, transform .18s ease",
                          }}
                        >{label}</button>
                      )
                    })}
                  </div>
                </div>

                <div style={{ marginTop: 13, padding: "10px 11px", borderRadius: 11, background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.065)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 7 }}>
                    <span style={{ color: "#8a8a8a", fontSize: 9.3, fontWeight: 650 }}>Tolerance shody</span>
                    <span style={{ color: "#d7d7d7", fontSize: 9.5, fontWeight: 730, fontVariantNumeric: "tabular-nums" }}>{comparisonTolerance.toFixed(2)} mm</span>
                  </div>
                  <input className="artheticAnalysisRange" type="range" min={0.05} max={1} step={0.05} value={comparisonTolerance} onChange={(e) => { setComparisonTolerance(Number(e.target.value)); setHasComputedComparison(false); setShowComparison(false); setComparisonStats(null); setComparisonSnapshot(null) }} style={{ width: "100%", margin: 0 }} />
                </div>

                <button
                  onClick={handleApplyComparison}
                  disabled={!comparisonModelsReady || isCalculatingComparison}
                  className={comparisonModelsReady && !hasComputedComparison && !isCalculatingComparison ? "artheticAnalysisReadyAction" : undefined}
                  style={{
                    marginTop: 14, width: "100%", height: 36, borderRadius: 10, boxSizing: "border-box",
                    border: "1px solid rgba(255,255,255,.09)",
                    background: hasComputedComparison ? "rgba(255,255,255,.055)" : comparisonModelsReady ? "rgba(18,42,27,.97)" : "rgba(255,255,255,.03)",
                    color: !comparisonModelsReady ? "#555" : hasComputedComparison ? "#c9c9c9" : "#dffbea",
                    cursor: !comparisonModelsReady || isCalculatingComparison ? "not-allowed" : "pointer",
                    fontFamily: "inherit", fontSize: 10, fontWeight: 720,
                  }}
                ><span>{hasComputedComparison ? "Přepočítat porovnání" : "Vypočítat porovnání"}</span></button>

                {hasComputedComparison && comparisonStats && (
                  <div style={{ marginTop: 13, padding: 11, borderRadius: 11, background: "rgba(255,255,255,.035)", border: "1px solid rgba(255,255,255,.065)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 10 }}>
                      <span style={{ width: 16, height: 16, borderRadius: "50%", display: "grid", placeItems: "center", color: "#86efac", background: "rgba(34,197,94,.1)", border: "1px solid rgba(74,222,128,.2)", fontSize: 10 }}>✓</span>
                      <span style={{ fontSize: 10, fontWeight: 720, color: "#d8d8d8" }}>Výpočet dokončen</span>
                    </div>
                    <Switch checked={showComparison} onChange={(checked) => { setShowComparison(checked); if (checked) setShowHeatmap(false) }} label="Zobrazit mapu odchylek" />
                    <div style={{ marginTop: 8, padding: "7px 8px", borderRadius: 8, background: "rgba(0,0,0,.18)", color: "#777", fontSize: 8.7, lineHeight: 1.45 }}>
                      {comparisonDirection === "A_TO_B" ? "A" : "B"} zobrazuje heatmapu · {comparisonDirection === "A_TO_B" ? "B" : "A"} zůstává jako reference v původní opacitě.
                    </div>
                    <div style={{ marginTop: 11, display: "grid", gridTemplateColumns: "1fr auto", gap: "5px 12px", color: "#8b8b8b", fontSize: 9 }}>
                      <span>Průměrná odchylka</span><b style={{ color: "#d4d4d4" }}>{comparisonStats.mean.toFixed(3)} mm</b>
                      <span>RMS</span><b style={{ color: "#d4d4d4" }}>{comparisonStats.rms.toFixed(3)} mm</b>
                      <span>95. percentil</span><b style={{ color: "#d4d4d4" }}>{comparisonStats.percentile95.toFixed(3)} mm</b>
                      <span>Maximum</span><b style={{ color: "#d4d4d4" }}>{comparisonStats.max.toFixed(3)} mm</b>
                      <span>V toleranci</span><b style={{ color: "#a7e6b8" }}>{comparisonStats.withinTolerance.toFixed(1)} %</b>
                    </div>
                    <div style={{ marginTop: 9, color: "#626262", fontSize: 8.7, lineHeight: 1.45 }}>Oboustranná povrchová odchylka v aktuální poloze modelů.</div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div style={{ width: dicomLayoutActive ? 120 : 270, display: isMobile ? "none" : "block" }}>
        <button 
          onClick={() => setIsAutoRotating(p => !p)}
          style={viewerToolbarButtonStyle(false, isAutoRotating)}
        >
          <svg 
            key={`spin-icon-${isAutoRotating}-${spinIconNonce}`}
            width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" 
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" 
            style={{
              animation: isAutoRotating ? "shade3dSpin360 4s linear infinite" : "none",
              transformOrigin: "50% 50%",
              transformBox: "fill-box",
              willChange: "transform",
            }}
          >
            <g transform="translate(24 0) scale(-1 1)">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </g>
          </svg>
          360° Spin
        </button>

        <div style={{
          width: dicomLayoutActive ? 266 : "auto",
          maxHeight: isAutoRotating ? "100px" : "0px",
          opacity: isAutoRotating ? 1 : 0,
          overflow: "hidden",
          transition: "max-height 0.4s ease-in-out, opacity 0.3s ease",
          pointerEvents: isAutoRotating ? "auto" : "none"
        }}>
          <div style={{
            marginTop: 8,
            background: "rgba(0,0,0,.85)", backdropFilter: "blur(8px)",
            border: "1px solid rgba(255,255,255,.2)", borderRadius: 10,
            padding: 12, width: 240, color: "white", boxShadow: "0 10px 30px rgba(0,0,0,0.5)"
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, fontSize: 12, fontWeight: "bold", color: "#ccc" }}>
              <span>Rychlost rotace</span>
              <span>{Math.round(spinSpeed * 100)}%</span>
            </div>
            <input 
              className="slider" 
              type="range" 
              min={0.05} max={1} step={0.05} 
              value={spinSpeed} 
              onChange={(e) => setSpinSpeed(parseFloat(e.target.value))} 
              style={{ width: "100%" }} 
            />
          </div>
        </div>
      </div>

      <div
        data-slice-window-anchor="true"
        style={{
        width: dicomLayoutActive ? 190 : 270, boxSizing: "border-box", display: isMobile ? "none" : "block",
        background: "rgba(12,12,12,.72)", backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)",
        border: clippingEnabled ? "1px solid rgba(74,222,128,.20)" : "1px solid rgba(255,255,255,.10)",
        borderRadius: 11, padding: clippingEnabled ? (dicomLayoutActive ? 8 : "8px 12px") : (dicomLayoutActive ? 8 : "8px 12px"),
        color: clippingEnabled ? "#c8f8d5" : "#ededed",
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
        transition: "background .16s ease, border-color .16s ease, color .16s ease",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: dicomLayoutActive ? "space-between" : "center", gap: 7, position: "relative", minHeight: 22, fontSize: 12, fontWeight: 680, letterSpacing: "-.01em" }}>
          <Switch
            checked={clippingEnabled}
            onChange={(checked) => {
              if (!checked && dicomSettings.viewMode === "only2d") {
                setDicomSettings((previous) => ({ ...previous, viewMode: "solid" }))
              }
              setClippingEnabled(checked)
            }}
            label="Průřez"
          />
          {clippingEnabled && (
            <button 
              onClick={handleResetPlane}
              style={{
                position: dicomLayoutActive ? "static" : "absolute", right: dicomLayoutActive ? "auto" : 0,
                background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.09)",
                borderRadius: 8, color: "#bdbdbd", padding: "4px 8px", fontSize: 9.5, fontWeight: 650, cursor: "pointer",
                transition: "background .16s ease, color .16s ease, border-color .16s ease"
              }}
              title="Vrátí průřez do výchozí pozice uprostřed modelu"
            >
              Reset
            </button>
          )}
        </div>
        {clippingEnabled && !dicomLayoutActive && (
          <div style={{ marginTop: 12, fontSize: 12, width: 220 }}>
            <p style={{ margin: 0, color: "#ccc", lineHeight: 1.4 }}>
              Táhněte za <b>modrou osu</b> pro posun nebo za barevný kruh pro natočení roviny řezu.
            </p>
          </div>
        )}
      </div>
    </div>
  )

  const allLoaded = files.length > 0 && files.every(f => loadedUrls.has(f.url))
  const frameKey = allLoaded && !didInitialFrame ? `frame-${files.length}` : ""
  const sceneReadyForDicom = (files.length === 0 || (allLoaded && didInitialFrame)) &&
    !isCalculatingHeatmap && !isCalculatingComparison && !restoringAnalysisMode

  useEffect(() => {
    if (!sceneReadyForDicom || !dicomSource || dicomStatus !== "idle") return
    startDicomLoad()
  }, [sceneReadyForDicom, dicomSource, dicomStatus, startDicomLoad])

  const alignmentBottomHeight = "38vh"
  const alignmentSceneInsetActive = alignmentMode && alignmentTransition !== "exiting"
  const mobileSliceSplitActive = isMobile && clippingEnabled && !dicomLayoutActive && !dicomSource && !alignmentMode
  const mobileSlicePaneHeight = "min(40dvh, 390px)"
  const alignmentEligibleFiles = files.filter((file) => ["stl", "ply", "obj"].includes(inferExt(file.rawName || file.name || file.url)))
  const alignmentPair = getAlignmentPair()
  const alignmentPairCount = Math.min(alignmentPointsA.length, alignmentPointsB.length)
  const alignmentPointsComplete = alignmentPointsA.length >= 3 && alignmentPointsB.length >= 3
  // Po smazání bodů jen v jednom viewportu dovolíme danou stranu znovu doplnit
  // bez nutnosti mazat správně umístěné body v druhém okně.
  const alignmentNextSide = alignmentPointsComplete ? null : (alignmentPointsA.length <= alignmentPointsB.length ? "A" : "B")
  const alignmentNextPointNumber = alignmentPointsComplete ? 3 : (alignmentNextSide === "A" ? alignmentPointsA.length + 1 : alignmentPointsB.length + 1)
  const alignmentHasA = !!alignmentPair.aUrl
  const alignmentHasB = !!alignmentPair.bUrl
  const alignmentModelsSelected = alignmentHasA && alignmentHasB
  const alignmentTopInstruction = alignmentPreviewBusy.A
    ? "Načítám Reference A…"
    : alignmentPreviewBusy.B
      ? "Načítám Moving B…"
      : alignmentStep === "models"
        ? (!alignmentHasA ? "Vyberte Reference A dole nebo klikněte na model v hlavní scéně" : !alignmentHasB ? "Vyberte Moving B dole nebo klikněte na jiný model v hlavní scéně" : "Připravuji pracovní okna…")
        : alignmentStep === "points"
          ? (alignmentPointsComplete ? "3 body připraveny" : `Další bod ${alignmentNextSide}${alignmentNextPointNumber}`)
          : alignmentStep === "prealign"
            ? "3 body připraveny · spusťte Předzarovnat"
            : alignmentWorkflowStage === "bestfit"
              ? "Best Fit dokončen"
              : "Předzarovnání dokončeno · spusťte Best Fit"

  const alignmentProgressUi = (() => {
    if (alignmentCompletion) {
      if (alignmentCompletion.kind === "deviation") return {
        code: "COMPLETE",
        label: "Odchylka dokončena",
        detail: "Mapa odchylek byla ověřena a je připravena v hlavní scéně",
        percent: 100,
      }
      return {
        code: "COMPLETE",
        label: "Zarovnání dokončeno",
        detail: alignmentCompletion.improved ? "Finální poloha byla ověřena a uložena" : "Výpočet dokončen · bezpečná výchozí poloha zachována",
        percent: 100,
      }
    }
    if (!alignmentBusy) return null
    const progress = alignmentProgress || {}
    if (progress.mode === "deviation") {
      const phase = String(progress.phase || "prepare")
      const phaseUi = {
        A_TO_B: ["A_TO_B", "Výpočet odchylky", "Analyzuji povrch A vůči referenci B"],
        B_TO_A: ["B_TO_A", "Výpočet odchylky", "Analyzuji povrch B vůči referenci A"],
        snapshot: ["SNAPSHOT", "Ukládám mapu odchylek", "Připravuji výsledek pro okamžité zobrazení"],
        done: ["COMPLETE", "Odchylka dokončena", "Finální mapa povrchových odchylek je připravena"],
        prepare: ["PREPARE", "Příprava odchylky", "Připravuji geometrii a prostorové vyhledávání"],
      }
      const current = phaseUi[phase] || phaseUi.prepare
      return { code: current[0], label: current[1], detail: current[2], percent: Number.isFinite(progress.percent) ? progress.percent : 2 }
    }
    if (progress.mode === "metrics") return { code: "METROLOGY", label: "Kontrola výsledku", detail: "Počítám odchylky a metrologické hodnoty", percent: Number.isFinite(progress.percent) ? progress.percent : 94 }
    if (progress.mode === "validation") return { code: "VALIDATE", label: "Kontrola výsledku", detail: "Ověřuji, že Best Fit skutečně zlepšil překryv", percent: Number.isFinite(progress.percent) ? progress.percent : 90 }
    if (progress.mode === "prepare" || !progress.stage) return { code: "PREPARE", label: "Příprava povrchů", detail: "Vzorkuji geometrii a kontroluji překryv", percent: Number.isFinite(progress.percent) ? progress.percent : 3 }
    const stage = Math.max(1, Math.min(3, Number(progress.stage) || 1))
    const iterations = Math.max(1, Number(progress.iterations) || 1)
    const iteration = Math.max(0, Number(progress.iteration) || 0)
    const withinStage = Math.min(1, iteration / iterations)
    const percent = Number.isFinite(progress.percent) ? progress.percent : 10 + (((stage - 1) + withinStage) / 3) * 78
    const labels = {
      1: ["PASS_01", "Hrubý Best Fit", "Stabilizuji překryv obou povrchů"],
      2: ["PASS_02", "Střední Best Fit", "Zpřesňuji rigidní polohu modelu"],
      3: ["PASS_03", "Jemný Best Fit", "Point-to-plane finální zpřesnění"],
    }
    return { code: labels[stage][0], label: labels[stage][1], detail: labels[stage][2], percent }
  })()

  // Živý terminál v Best Fit loaderu. Nehraje si na skutečný shell log; kombinuje
  // reálný stav enginu (pass / iteration / RMS / correspondences) s jemným heartbeat
  // textem odvozeným od právě běžící fáze, aby bylo i během dlouhého výpočtu vidět,
  // že aplikace aktivně pracuje.
  const alignmentTerminalLines = (() => {
    if ((!alignmentBusy && !alignmentCompletion) || !alignmentProgressUi) return []

    if (alignmentCompletion) {
      // Po dokončení smažeme pracovní log a vypíšeme čistou closing sekvenci.
      // Delay je kumulativní, takže řádky působí jako skutečný terminál.
      if (alignmentCompletion.kind === "deviation") {
        return [
          { id: "deviation-complete-1", stamp: "", text: "DEVIATION ANALYSIS FINISHED", tone: "complete", typewriter: true, delay: 70 },
          { id: "deviation-complete-2", stamp: "", text: "surface map validated", tone: "data", typewriter: true, delay: 520 },
          { id: "deviation-complete-3", stamp: "", text: "comparison result stored", tone: "normal", typewriter: true, delay: 980 },
          { id: "deviation-complete-4", stamp: "", text: "ending analysis session", tone: "normal", typewriter: true, delay: 1450 },
          { id: "deviation-complete-5", stamp: "", text: "session closed", tone: "muted", typewriter: true, delay: 2010 },
        ]
      }
      return [
        { id: "complete-1", stamp: "", text: "ALIGNMENT FINISHED", tone: "complete", typewriter: true, delay: 70 },
        { id: "complete-2", stamp: "", text: "final transform validated", tone: "data", typewriter: true, delay: 510 },
        { id: "complete-3", stamp: "", text: "ending registration session", tone: "normal", typewriter: true, delay: 980 },
        { id: "complete-4", stamp: "", text: "releasing analysis instance", tone: "normal", typewriter: true, delay: 1480 },
        { id: "complete-5", stamp: "", text: "session closed", tone: "muted", typewriter: true, delay: 2040 },
      ]
    }

    const progress = alignmentProgress || {}

    if (alignmentOperation === "deviation") {
      const phase = String(progress.phase || "prepare")
      const tickSeconds = 1.16
      const tick = Math.max(0, Math.floor(alignmentElapsed / tickSeconds))
      const activityByPhase = {
        prepare: [
          "reading aligned geometry buffers",
          "building bidirectional surface queries",
          "preparing deviation sample sets",
          "checking model transforms",
        ],
        A_TO_B: [
          "querying surface A against reference B",
          "measuring closest-point distances",
          "accumulating deviation samples",
          "updating A → B surface map",
        ],
        B_TO_A: [
          "querying surface B against reference A",
          "measuring reverse surface distances",
          "accumulating reverse deviation samples",
          "updating B → A validation pass",
        ],
        snapshot: [
          "quantizing deviation distances",
          "packing comparison snapshot",
          "writing reusable surface result",
          "finalizing analysis payload",
        ],
        done: [
          "validating final deviation map",
          "preparing comparison display",
        ],
      }
      const activity = activityByPhase[phase] || activityByPhase.prepare
      const lines = []
      const stamp = (seconds) => String(Math.max(0, seconds).toFixed(1)).padStart(6, "0")
      const push = (id, seconds, value, tone = "normal", typewriter = false, delay = 28) => lines.push({ id, stamp: stamp(seconds), text: value, tone, typewriter, delay })

      push("deviation-header", 0, "ARTHETIC SURFACE ANALYSIS / DEVIATION", "muted", false)
      push(`deviation-phase-${alignmentProgressUi.code}`, Math.min(alignmentElapsed, .2), `phase ${alignmentProgressUi.code}`, "accent", true)

      const visibleHeartbeat = 4
      const firstTick = Math.max(0, tick - visibleHeartbeat + 1)
      for (let t = firstTick; t <= tick; t += 1) {
        const message = activity[t % activity.length]
        push(`deviation-heartbeat-${phase}-${t}`, t * tickSeconds, message, t === tick ? "active" : "normal", true)
      }

      const processed = Number(progress.processed) || 0
      const total = Number(progress.total) || 0
      if (processed > 0 && total > 0) {
        push(`deviation-samples-${Math.round(processed / 250)}`, alignmentElapsed, `${processed.toLocaleString("cs-CZ")} / ${total.toLocaleString("cs-CZ")} surface samples`, "data", false)
      }

      return lines.slice(-7)
    }

    const stage = Math.max(0, Math.min(3, Number(progress.stage) || 0))
    const iteration = Math.max(0, Number(progress.iteration) || 0)
    const iterations = Math.max(1, Number(progress.iterations) || 1)
    const rms = Number.isFinite(progress.rms) ? progress.rms : null
    const pairs = Number.isFinite(progress.correspondences) ? Math.max(0, Math.round(progress.correspondences)) : null
    const tickSeconds = 1.28
    const tick = Math.max(0, Math.floor(alignmentElapsed / tickSeconds))

    const activityByStage = {
      0: [
        "reading geometry buffers",
        "building spatial search data",
        "sampling overlapping surfaces",
        "checking initial overlap",
        "preparing correspondence search",
      ],
      1: [
        "querying closest surface points",
        "filtering distant correspondences",
        "estimating rigid transform",
        "re-evaluating overlap",
        "stabilizing coarse solution",
      ],
      2: [
        "refining correspondence set",
        "rejecting residual outliers",
        "solving rigid update",
        "measuring surface residuals",
        "checking convergence trend",
      ],
      3: [
        "sampling target normals",
        "building point-to-plane system",
        "rejecting unstable residuals",
        "solving final rigid update",
        "verifying fine convergence",
      ],
    }
    const validationActivity = [
      "comparing candidate with seeded pose",
      "verifying overlap improvement",
      "checking transform safety",
      "validating final registration",
    ]
    const metricsActivity = [
      "sampling final surface distances",
      "accumulating RMS statistics",
      "computing percentile metrics",
      "finalizing metrology result",
    ]

    const workerPhaseActivity = {
      correspondences: [
        "querying closest surface points",
        "collecting surface correspondences",
        "trimming distant surface pairs",
        "updating overlap sample",
      ],
      verify: [
        "verifying rigid candidate",
        "re-measuring candidate residuals",
        "checking candidate improvement",
        "accepting stable transform step",
      ],
      validation: validationActivity,
    }

    const activity = progress.mode === "metrics"
      ? metricsActivity
      : progress.mode === "validation"
        ? validationActivity
        : workerPhaseActivity[progress.phase] || activityByStage[stage] || activityByStage[0]

    const lines = []
    const stamp = (seconds) => String(Math.max(0, seconds).toFixed(1)).padStart(6, "0")
    const push = (id, seconds, text, tone = "normal", typewriter = false, delay = 28) => lines.push({ id, stamp: stamp(seconds), text, tone, typewriter, delay })

    push("header", 0, "ARTHETIC REGISTRATION ENGINE / BEST_FIT", "muted", false)
    push(`phase-${alignmentProgressUi.code}`, Math.min(alignmentElapsed, .2), `phase ${alignmentProgressUi.code}`, "accent", true)

    // Poslední čtyři heartbeat záznamy se posouvají jako terminál. Díky tomu se
    // něco děje i ve chvíli, kdy jeden náročný ICP krok několik sekund nehlásí progress.
    const visibleHeartbeat = 4
    const firstTick = Math.max(0, tick - visibleHeartbeat + 1)
    for (let t = firstTick; t <= tick; t += 1) {
      const message = activity[t % activity.length]
      push(`heartbeat-${t}`, t * tickSeconds, message, t === tick ? "active" : "normal", true)
    }

    if (stage > 0) push(`pass-${stage}-${Math.floor(iteration * 10)}`, alignmentElapsed, `pass ${stage}/3 · iteration ${Math.min(iteration, iterations).toFixed(1)}/${iterations}`, "data", false)
    if (pairs != null && pairs > 0) push(`pairs-${Math.round(pairs / 25)}`, alignmentElapsed, `${pairs.toLocaleString("cs-CZ")} surface pairs accepted`, "data", false)
    if (rms != null) push(`rms-${rms.toFixed(3)}`, alignmentElapsed, `RMS ${rms.toFixed(4)} mm`, "data", false)

    return lines.slice(-7)
  })()

  const surfaceAnalysisProgressUi = (() => {
    if (surfaceAnalysisCompletion) {
      if (surfaceAnalysisCompletion.kind === "comparison") {
        return {
          code: "COMPLETE",
          label: "Porovnání dokončeno",
          detail: "Oboustranná mapa odchylek je připravena",
          percent: 100,
        }
      }
      return {
        code: "COMPLETE",
        label: "Okluze dokončena",
        detail: "Mapa kontaktu, průniku a mezery je připravena",
        percent: 100,
      }
    }

    if (!isCalculatingHeatmap && !isCalculatingComparison) return null
    const progress = surfaceAnalysisProgress || {}
    const percent = Number.isFinite(progress.percent) ? progress.percent : 2
    const phase = String(progress.phase || "prepare")

    if (isCalculatingComparison) {
      const phases = {
        prepare: ["PREPARE", "Příprava porovnání", "Připravuji geometrii a oboustranné surface queries"],
        A_TO_B: ["A_TO_B", "Porovnávám povrchy", "Analyzuji povrch A vůči referenci B"],
        B_TO_A: ["B_TO_A", "Porovnávám povrchy", "Analyzuji povrch B vůči referenci A"],
        snapshot: ["SNAPSHOT", "Ukládám výsledek", "Připravuji mapu pro okamžité obnovení"],
        "snapshot-decode": ["RESTORE", "Načítám porovnání", "Dekóduji uloženou mapu odchylek"],
        "snapshot-colors-A": ["RESTORE_A", "Načítám porovnání", "Obnovuji barvy povrchu A"],
        "snapshot-colors-B": ["RESTORE_B", "Načítám porovnání", "Obnovuji barvy povrchu B"],
        metrics: ["METRICS", "Dokončuji porovnání", "Počítám souhrnné metriky"],
        done: ["COMPLETE", "Porovnání dokončeno", "Mapa odchylek je připravena"],
      }
      const current = phases[phase] || phases.prepare
      return { code: current[0], label: current[1], detail: current[2], percent }
    }

    const phases = {
      prepare: ["PREPARE", "Příprava okluze", "Připravuji geometrii a signed-distance dotazy"],
      distances: ["DISTANCE", "Vypočítávám okluzi", "Měřím průnik, kontakt a mezeru mezi povrchy"],
      done: ["COMPLETE", "Okluze dokončena", "Kontaktní mapa je připravena"],
    }
    const current = phases[phase] || phases.prepare
    return { code: current[0], label: current[1], detail: current[2], percent }
  })()

  const surfaceAnalysisTerminalLines = (() => {
    if ((!isCalculatingHeatmap && !isCalculatingComparison && !surfaceAnalysisCompletion) || !surfaceAnalysisProgressUi) return []

    if (surfaceAnalysisCompletion) {
      if (surfaceAnalysisCompletion.kind === "comparison") {
        return [
          { id: "comparison-complete-1", stamp: "", text: "COMPARISON FINISHED", tone: "complete", typewriter: true, delay: 30 },
          { id: "comparison-complete-2", stamp: "", text: "bidirectional surface map validated", tone: "data", typewriter: true, delay: 180 },
          { id: "comparison-complete-3", stamp: "", text: "analysis result stored", tone: "normal", typewriter: true, delay: 380 },
          { id: "comparison-complete-4", stamp: "", text: "ending comparison session", tone: "normal", typewriter: true, delay: 590 },
          { id: "comparison-complete-5", stamp: "", text: "session closed", tone: "muted", typewriter: true, delay: 800 },
        ]
      }
      return [
        { id: "occlusion-complete-1", stamp: "", text: "OCCLUSION ANALYSIS FINISHED", tone: "complete", typewriter: true, delay: 30 },
        { id: "occlusion-complete-2", stamp: "", text: "contact surface map validated", tone: "data", typewriter: true, delay: 180 },
        { id: "occlusion-complete-3", stamp: "", text: "penetration / clearance result ready", tone: "normal", typewriter: true, delay: 380 },
        { id: "occlusion-complete-4", stamp: "", text: "ending analysis session", tone: "normal", typewriter: true, delay: 590 },
        { id: "occlusion-complete-5", stamp: "", text: "session closed", tone: "muted", typewriter: true, delay: 800 },
      ]
    }

    const progress = surfaceAnalysisProgress || {}
    const phase = String(progress.phase || "prepare")
    const type = isCalculatingComparison ? "comparison" : "occlusion"
    const tickSeconds = 1.12
    const tick = Math.max(0, Math.floor(surfaceAnalysisElapsed / tickSeconds))
    const activityByPhase = {
      comparison: {
        prepare: [
          "reading geometry buffers",
          "building bidirectional surface queries",
          "checking model transforms",
          "preparing comparison sample sets",
        ],
        A_TO_B: [
          "querying surface A against reference B",
          "measuring closest-point distances",
          "accumulating A → B deviation samples",
          "updating forward surface map",
        ],
        B_TO_A: [
          "querying surface B against reference A",
          "measuring reverse surface distances",
          "accumulating B → A deviation samples",
          "updating reverse validation map",
        ],
        snapshot: [
          "quantizing deviation distances",
          "compressing reusable result",
          "packing comparison snapshot",
          "finalizing analysis payload",
        ],
        "snapshot-decode": [
          "decoding stored deviation distances",
          "verifying snapshot geometry",
          "restoring analysis payload",
        ],
        "snapshot-colors-A": [
          "rebuilding A surface colors",
          "mapping stored deviation values",
          "restoring forward analysis layer",
        ],
        "snapshot-colors-B": [
          "rebuilding B surface colors",
          "mapping reverse deviation values",
          "restoring comparison result",
        ],
        metrics: [
          "accumulating comparison statistics",
          "computing surface metrics",
          "finalizing deviation summary",
        ],
        done: ["validating final comparison map"],
      },
      occlusion: {
        prepare: [
          "reading model transforms",
          "building signed surface query",
          "preparing contact analysis",
          "checking reference geometry",
        ],
        distances: [
          "querying closest surface points",
          "evaluating signed distances",
          "classifying penetration / clearance",
          "updating occlusion surface colors",
        ],
        done: ["validating final contact map"],
      },
    }

    const activity = activityByPhase[type][phase] || activityByPhase[type].prepare
    const lines = []
    const stamp = (seconds) => String(Math.max(0, seconds).toFixed(1)).padStart(6, "0")
    const push = (id, seconds, value, tone = "normal", typewriter = false, delay = 28) => lines.push({ id, stamp: stamp(seconds), text: value, tone, typewriter, delay })

    push(`${type}-header`, 0, type === "comparison" ? "ARTHETIC SURFACE ANALYSIS / COMPARISON" : "ARTHETIC SURFACE ANALYSIS / OCCLUSION", "muted", false)
    push(`${type}-phase-${surfaceAnalysisProgressUi.code}`, Math.min(surfaceAnalysisElapsed, .2), `phase ${surfaceAnalysisProgressUi.code}`, "accent", true)

    const visibleHeartbeat = 4
    const firstTick = Math.max(0, tick - visibleHeartbeat + 1)
    for (let t = firstTick; t <= tick; t += 1) {
      const message = activity[t % activity.length]
      push(`${type}-heartbeat-${phase}-${t}`, t * tickSeconds, message, t === tick ? "active" : "normal", true)
    }

    const processed = Number(progress.processed) || 0
    const total = Number(progress.total) || 0
    if (processed > 0 && total > 0) {
      push(`${type}-samples-${Math.round(processed / 250)}`, surfaceAnalysisElapsed, `${processed.toLocaleString("cs-CZ")} / ${total.toLocaleString("cs-CZ")} surface samples`, "data", false)
    }

    return lines.slice(-7)
  })()

  const alignmentButtonStyle = (variant = "secondary", disabled = false) => {
    const variants = {
      secondary: { background: "rgba(255,255,255,.055)", border: "rgba(255,255,255,.10)", color: "#f4f4f4", shadow: "none" },
      primary: { background: "#f2f2f2", border: "#f2f2f2", color: "#0C0C0C", shadow: "0 8px 24px rgba(255,255,255,.08)" },
      success: { background: "rgba(34,197,94,.12)", border: "rgba(34,197,94,.28)", color: "#86efac", shadow: "0 8px 24px rgba(34,197,94,.06)" },
      danger: { background: "rgba(255,255,255,.045)", border: "rgba(255,255,255,.08)", color: "#a3a3a3", shadow: "none" },
    }
    const v = variants[variant] || variants.secondary
    return {
      height: 36, padding: "0 13px", borderRadius: 10,
      border: `1px solid ${v.border}`, background: disabled ? "rgba(255,255,255,.035)" : v.background,
      color: disabled ? "#5f5f5f" : v.color, boxShadow: disabled ? "none" : v.shadow,
      fontSize: 11, fontWeight: 760, cursor: disabled ? "not-allowed" : "pointer",
      whiteSpace: "nowrap", opacity: disabled ? 0.72 : 1,
      transition: "transform .16s ease, background .16s ease, border-color .16s ease, opacity .16s ease",
    }
  }

  const alignmentSelectStyle = {
    height: 36, minWidth: 150, maxWidth: 210, borderRadius: 10,
    border: "1px solid rgba(255,255,255,.10)", background: "#151515", color: "#f3f3f3",
    padding: "0 30px 0 10px", fontSize: 11, fontWeight: 650, outline: "none",
  }

  const alignmentStepOrder = ["models", "points", "prealign", "bestfit"]
  const alignmentStepLabels = {
    models: "Vybrat modely",
    points: "Body",
    prealign: "Předzarovnat",
    bestfit: "Best Fit",
  }
  const alignmentStepAvailable = (step) => {
    if (step === "models") return true
    if (step === "points") return alignmentModelsSelected
    if (step === "prealign") return alignmentModelsSelected && alignmentPointsComplete
    if (step === "bestfit") return alignmentModelsSelected && alignmentPointsComplete && !!alignmentPrealignMatrix
    return false
  }
  const alignmentStepStyle = (step) => {
    const current = alignmentStep === step
    const enabled = alignmentStepAvailable(step) && !alignmentBusy
    return {
      height: 32, padding: "0 12px", borderRadius: 9,
      border: current ? "1px solid rgba(34,197,94,.34)" : "1px solid rgba(255,255,255,.08)",
      background: current ? "rgba(34,197,94,.13)" : "rgba(255,255,255,.045)",
      color: current ? "#86efac" : enabled ? "#a6a6a6" : "#555",
      boxShadow: current ? "0 0 0 1px rgba(34,197,94,.025), 0 7px 24px rgba(34,197,94,.055)" : "none",
      fontSize: 10.5, fontWeight: current ? 760 : 680, whiteSpace: "nowrap",
      cursor: enabled ? "pointer" : "not-allowed", opacity: enabled || current ? 1 : .66,
      transition: "background .18s ease, border-color .18s ease, color .18s ease, box-shadow .18s ease, transform .16s ease",
    }
  }

  const alignmentStepNeedsAttention = (step) => {
    if (alignmentBusy) return false
    if (step === "prealign") return alignmentStep === "prealign" && alignmentModelsSelected && alignmentPointsComplete
    if (step === "bestfit") return alignmentStep === "bestfit" && alignmentModelsSelected && alignmentPointsComplete && !!alignmentPrealignMatrix && alignmentWorkflowStage !== "bestfit"
    return false
  }

  const alignmentStepCompleted = (step) => {
    if (step === "models") return alignmentModelsSelected
    if (step === "points") return alignmentPointsComplete
    if (step === "prealign") return !!alignmentPrealignMatrix && (alignmentWorkflowStage === "prealigned" || alignmentWorkflowStage === "bestfit")
    if (step === "bestfit") return alignmentWorkflowStage === "bestfit"
    return false
  }

  const handleAlignmentStepClick = async (step) => {
    if (!alignmentStepAvailable(step) || alignmentBusy) return
    if (step === "models") {
      if (alignmentStep !== "models") await goToAlignmentStep("models")
      return
    }
    if (step === "points") {
      if (alignmentStep !== "points") await goToAlignmentStep("points")
      return
    }
    if (step === "prealign") {
      if (alignmentStep === "prealign") await handleAlignmentLandmarkFit()
      else await goToAlignmentStep("prealign")
      return
    }
    if (step === "bestfit") {
      if (alignmentStep !== "bestfit") setAlignmentStep("bestfit")
      else await handleAlignmentBestFit()
    }
  }


  const trimSelectedFile = trimSelection ? files.find((file) => file.url === trimSelection) : null
  const trimStepDone = {
    model: !!trimSelection,
    boundary: !!trimClosed,
    region: trimKeepComponent != null || trimStage === "result",
    result: trimStage === "result",
  }
  const trimWorkspace = trimMode && (
    <div style={{
      position: "absolute", top: 10, left: "50%", transform: "translateX(-50%)", zIndex: 72,
      width: "min(760px, calc(100vw - 32px))", boxSizing: "border-box", padding: "11px 12px",
      borderRadius: 15, background: "rgba(11,11,11,.955)", border: "1px solid rgba(255,255,255,.10)",
      boxShadow: "0 22px 70px rgba(0,0,0,.46)", backdropFilter: "blur(22px)", WebkitBackdropFilter: "blur(22px)",
      color: "#f3f3f3", fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      animation: "artheticAlignMenuIn .24s ease-out both",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <div style={{ minWidth: 0, flex: "1 1 auto" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
            <span style={{ display: "inline-flex", alignItems: "baseline", gap: 0, fontSize: 13 }}><span style={{ fontWeight: 850 }}>ART</span><span style={{ fontWeight: 300 }}>HETIC</span></span>
            <span style={{ color: "#d7d7d7", fontSize: 13, fontWeight: 340 }}>Ořez</span>
            {trimSelectedFile && <span style={{ marginLeft: 4, color: "#777", fontSize: 9.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{stripExt(trimSelectedFile.rawName || trimSelectedFile.name)}</span>}
          </div>
          <div style={{ marginTop: 7, display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
            {[
              ["model", "Model"], ["boundary", "Hranice"], ["region", "Oblast"], ["result", "Výsledek"],
            ].map(([key, label], index) => {
              const done = trimStepDone[key]
              const active = (key === "model" && trimStage === "model") || (key === "boundary" && trimStage === "boundary") || (key === "region" && trimStage === "region") || (key === "result" && trimStage === "result")
              return <React.Fragment key={key}>
                <div style={analysisStepChipStyle(active, done)}>{done && <span style={{ color: "#86efac" }}>✓</span>}<span>{label}</span></div>
                {index < 3 && <div style={{ width: 12, height: 1, background: "rgba(255,255,255,.07)" }} />}
              </React.Fragment>
            })}
          </div>
        </div>
        <button type="button" onClick={closeTrimMode} disabled={trimBusy}
          style={{ height: 34, padding: "0 11px", borderRadius: 9, border: "1px solid rgba(255,255,255,.09)", background: "rgba(255,255,255,.035)", color: "#c8c8c8", cursor: trimBusy ? "wait" : "pointer", fontFamily: "inherit", fontSize: 9.5, fontWeight: 690 }}>
          Hotovo / Zavřít
        </button>
      </div>

      <div style={{ height: 1, margin: "10px 0", background: "rgba(255,255,255,.065)" }} />

      {trimStage === "model" && (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(220px,1fr) auto", gap: 10, alignItems: "center" }}>
          <AlignmentModelDropdown badge="T" value={trimSelection || ""} files={analysisEligibleFiles} otherValue="" onChange={selectTrimModel} />
          <span style={{ color: "#777", fontSize: 9.2 }}>Vyberte v menu nebo klikněte přímo na model ve scéně.</span>
        </div>
      )}

      {trimStage !== "model" && trimSelectedFile && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <div style={{ minWidth: 0, color: "#8b8b8b", fontSize: 9.3, lineHeight: 1.45 }}>
            {trimStage === "boundary" && !trimClosed && <>LMB klik = nový bod · přetažení kuličky = oprava bodu · dvojklik na první žlutý bod = uzavřít.</>}
            {trimStage === "boundary" && trimClosed && <>Smyčka je uzavřená. Body můžete dál přetahovat. Najeďte myší na jednu stranu pro náhled a kliknutím ji potvrďte.</>}
            {trimStage === "region" && <>Zelená oblast zůstane, červená se odstraní. Řez vede skrz faces; body lze stále přetahovat a hranici jemně doladit.</>}
            {trimStage === "result" && <>Ořez je aplikovaný na geometrii v této session. Výsledek lze stáhnout nebo interně uložit k zakázce.</>}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            {trimStage === "boundary" && !trimClosed && trimControlNodes.length > 0 && (
              <button type="button" onClick={removeLastTrimPoint} style={{ height: 31, padding: "0 9px", borderRadius: 8, border: "1px solid rgba(255,255,255,.08)", background: "rgba(255,255,255,.03)", color: "#aaa", fontSize: 9, fontWeight: 680, cursor: "pointer" }}>Smazat poslední</button>
            )}
            {(trimStage === "boundary" || trimStage === "region") && (
              <button type="button" onClick={resetTrimBoundary} style={{ height: 31, padding: "0 9px", borderRadius: 8, border: "1px solid rgba(255,255,255,.08)", background: "rgba(255,255,255,.03)", color: "#aaa", fontSize: 9, fontWeight: 680, cursor: "pointer" }}>Reset hranice</button>
            )}
            {trimStage === "boundary" && !trimClosed && trimControlNodes.length >= 3 && (
              <button type="button" onClick={closeTrimLoop} style={{ height: 31, padding: "0 10px", borderRadius: 8, border: "1px solid rgba(251,191,36,.18)", background: "rgba(245,158,11,.065)", color: "#fde68a", fontSize: 9, fontWeight: 710, cursor: "pointer" }}>Uzavřít hranici</button>
            )}
            {trimStage === "region" && trimKeepComponent != null && (
              <button type="button" onClick={applyTrimResult} disabled={trimBusy} className={!trimBusy ? "artheticAnalysisReadyAction" : undefined}
                style={{ height: 32, padding: "0 12px", borderRadius: 9, border: "1px solid rgba(74,222,128,.18)", background: "rgba(18,42,27,.97)", color: "#dffbea", fontSize: 9.5, fontWeight: 730, cursor: trimBusy ? "wait" : "pointer" }}><span>Oříznout</span></button>
            )}
            {trimStage === "result" && (
              <>
                <button type="button" onClick={() => undoLastTrim(trimSelection)} style={{ height: 31, padding: "0 9px", borderRadius: 8, border: "1px solid rgba(255,255,255,.08)", background: "rgba(255,255,255,.03)", color: "#aaa", fontSize: 9, fontWeight: 680, cursor: "pointer" }}>Vrátit ořez</button>
                <button type="button" onClick={() => downloadTrimmedModel(trimSelection)} disabled={trimExportBusyUrl === trimSelection}
                  style={{ height: 31, padding: "0 10px", borderRadius: 8, border: "1px solid rgba(255,255,255,.10)", background: "rgba(255,255,255,.04)", color: "#e1e1e1", fontSize: 9, fontWeight: 700, cursor: trimExportBusyUrl === trimSelection ? "wait" : "pointer" }}>{trimExportBusyUrl === trimSelection ? "Připravuji…" : "Stáhnout"}</button>
                {editorCapabilities.canSaveTrimmedToCase && (
                  <button type="button" onClick={() => saveTrimmedModelToCase(trimSelection)} disabled={trimExportBusyUrl === trimSelection || !!trimmedExportsByUrl[trimSelection]?.saveRequested}
                    style={{ height: 31, padding: "0 10px", borderRadius: 8, border: "1px solid rgba(251,191,36,.17)", background: "rgba(245,158,11,.06)", color: trimmedExportsByUrl[trimSelection]?.saveRequested ? "#978764" : "#fde68a", fontSize: 9, fontWeight: 710, cursor: trimmedExportsByUrl[trimSelection]?.saveRequested ? "default" : "pointer" }}>{trimmedExportsByUrl[trimSelection]?.saveRequested ? "Předáno" : "Uložit do zakázky"}</button>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {(trimMessage || trimBusy) && (
        <div style={{ marginTop: 9, padding: "7px 9px", borderRadius: 9, background: "rgba(255,255,255,.025)", border: "1px solid rgba(255,255,255,.055)", color: trimBusy ? "#cfcfcf" : "#787878", fontSize: 8.8, lineHeight: 1.45 }}>
          {trimBusy && <span style={{ display: "inline-block", width: 9, height: 9, marginRight: 7, border: "1.5px solid rgba(255,255,255,.18)", borderTopColor: "#d7d7d7", borderRadius: "50%", animation: "artheticAnalysisSpin .8s linear infinite", verticalAlign: "-1px" }} />}
          {trimMessage}
        </div>
      )}
    </div>
  )

  const alignmentWorkspace = alignmentMode && (
    <>
      <style>{`
        @keyframes artheticAlignSpin { to { transform: rotate(360deg); } }
        @keyframes artheticAlignPulse { 0%,100% { opacity:.55; transform:scale(.9); } 50% { opacity:1; transform:scale(1.12); } }
        @keyframes artheticAlignAttention { 0%,100% { box-shadow:0 0 0 0 rgba(255,255,255,.04); border-color:rgba(255,255,255,.10); } 50% { box-shadow:0 0 0 5px rgba(255,255,255,.055), 0 0 22px rgba(255,255,255,.08); border-color:rgba(255,255,255,.24); } }
        @keyframes artheticAlignCardIn { from { opacity:0; transform:translate(-50%,-46%) scale(.97); } to { opacity:1; transform:translate(-50%,-50%) scale(1); } }
        @keyframes artheticAlignCardOut { from { opacity:1; transform:translate(-50%,-50%) scale(1); filter:blur(0); } to { opacity:0; transform:translate(-50%,-51%) scale(.985); filter:blur(3px); } }
        @keyframes artheticAlignWorkspaceTopIn { from { opacity:0; transform:translateY(-18px) scale(.985); filter:blur(7px); } to { opacity:1; transform:translateY(0) scale(1); filter:blur(0); } }
        @keyframes artheticAlignWorkspaceTopOut { from { opacity:1; transform:translateY(0) scale(1); filter:blur(0); } to { opacity:0; transform:translateY(-14px) scale(.988); filter:blur(5px); } }
        @keyframes artheticAlignWorkspaceBottomIn { from { opacity:0; transform:translateY(30px) scale(.985); filter:blur(7px); } to { opacity:1; transform:translateY(0) scale(1); filter:blur(0); } }
        @keyframes artheticAlignWorkspaceBottomOut { from { opacity:1; transform:translateY(0) scale(1); filter:blur(0); } to { opacity:0; transform:translateY(26px) scale(.99); filter:blur(5px); } }
        @keyframes artheticAlignWorkspaceWashIn { from { opacity:0; } to { opacity:1; } }
        @keyframes artheticAlignWorkspaceWashOut { from { opacity:1; } to { opacity:0; } }
        @keyframes artheticAlignMenuIn { from { opacity:0; transform:translateY(-4px) scale(.985); } to { opacity:1; transform:translateY(0) scale(1); } }
        @keyframes artheticAlignTerminalCursor { 0%,46% { opacity:1; } 47%,100% { opacity:.16; } }
        @keyframes artheticAlignCheckPop { 0% { opacity:0; transform:scale(.55); } 55% { opacity:1; transform:scale(1.08); } 100% { opacity:1; transform:scale(1); } }
        @keyframes artheticAlignCheckDraw { from { stroke-dashoffset:24; } to { stroke-dashoffset:0; } }
        .artheticAlignTerminal {
          position:relative;
          overflow:hidden;
          isolation:isolate;
        }
        .artheticAlignTerminal::after {
          content:"";
          position:absolute;
          inset:0;
          background:repeating-linear-gradient(180deg, transparent 0, transparent 3px, rgba(255,255,255,.012) 4px);
          pointer-events:none;
          z-index:1;
        }
        @property --artheticAlignBeamAngle {
          syntax: "<angle>";
          inherits: false;
          initial-value: 0deg;
        }
        @keyframes artheticAlignReadyBeam {
          to { --artheticAlignBeamAngle:360deg; }
        }
        @keyframes artheticAlignReadyParticle {
          0%   { offset-distance:0%; opacity:0; transform:scale(.45) translateY(0); }
          7%   { opacity:.92; transform:scale(1) translateY(-1px); }
          44%  { opacity:.58; transform:scale(.78) translateY(-2px); }
          72%  { opacity:.16; transform:scale(.55) translateY(-4px); }
          100% { offset-distance:100%; opacity:0; transform:scale(.35) translateY(-6px); }
        }
        @keyframes artheticAlignPostFitReveal {
          0% { opacity:0; transform:translateY(8px) scale(.94); filter:blur(5px); }
          58% { opacity:1; transform:translateY(-1px) scale(1.018); filter:blur(0); }
          78% { transform:translateY(.5px) scale(.995); }
          100% { opacity:1; transform:translateY(0) scale(1); filter:blur(0); }
        }
        .artheticAlignPostFitAction {
          opacity:0;
          animation:artheticAlignPostFitReveal .52s cubic-bezier(.2,.85,.25,1) forwards;
          will-change:transform, opacity, filter;
        }
        .artheticAlignPostFitAction:hover:not(:disabled) {
          transform:translateY(-1px) !important;
          background:rgba(255,255,255,.08) !important;
          border-color:rgba(255,255,255,.15) !important;
        }
        .artheticAlignReadyAction {
          position:relative;
          isolation:isolate;
          overflow:visible;
          border:1px solid transparent !important;
          background:transparent !important;
          box-shadow:none !important;
        }
        /* Vnější glow + ostrý světelný hotspot. Vnitřek se následně překryje ::after. */
        .artheticAlignReadyAction::before {
          content:"";
          position:absolute;
          inset:-2px;
          padding:2px;
          border-radius:12px;
          pointer-events:none;
          z-index:0;
          background:conic-gradient(
            from var(--artheticAlignBeamAngle),
            rgba(74,222,128,0) 0deg 286deg,
            rgba(74,222,128,.05) 301deg,
            rgba(74,222,128,.42) 316deg,
            rgba(187,247,208,.96) 328deg,
            rgba(240,253,244,1) 334deg,
            rgba(134,239,172,.72) 342deg,
            rgba(74,222,128,.08) 353deg,
            rgba(74,222,128,0) 360deg
          );
          -webkit-mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
          -webkit-mask-composite:xor;
          mask-composite:exclude;
          filter:drop-shadow(0 0 2px rgba(134,239,172,.75)) drop-shadow(0 0 6px rgba(34,197,94,.35));
          animation:artheticAlignReadyBeam 1.9s linear infinite;
        }
        /* Tohle je krycí vrstva: drží glow mimo vnitřek tlačítka. */
        .artheticAlignReadyAction::after {
          content:"";
          position:absolute;
          inset:1px;
          border-radius:8px;
          z-index:1;
          pointer-events:none;
          background:rgba(18,42,27,.96);
          box-shadow:inset 0 0 0 1px rgba(34,197,94,.12);
        }
        .artheticAlignReadyAction > * { position:relative; z-index:3; }
        .artheticAlignReadyParticles {
          position:absolute !important;
          inset:-7px;
          z-index:2 !important;
          pointer-events:none;
          overflow:visible;
        }
        .artheticAlignReadyParticle {
          position:absolute !important;
          left:0;
          top:0;
          width:3px;
          height:3px;
          border-radius:50%;
          background:rgba(187,247,208,.95);
          box-shadow:0 0 3px rgba(134,239,172,.9), 0 0 7px rgba(34,197,94,.45);
          offset-path:inset(7px round 10px);
          offset-rotate:0deg;
          opacity:0;
          animation:artheticAlignReadyParticle 2.35s linear infinite;
        }
        .artheticAlignReadyParticle:nth-child(2) {
          width:2px; height:2px; animation-delay:-.42s; animation-duration:2.7s; opacity:.72;
        }
        .artheticAlignReadyParticle:nth-child(3) {
          width:2.5px; height:2.5px; animation-delay:-.96s; animation-duration:3.05s; opacity:.58;
        }
        .artheticAlignReadyParticle:nth-child(4) {
          width:1.5px; height:1.5px; animation-delay:-1.48s; animation-duration:2.55s; opacity:.5;
        }
        .artheticAlignReadyParticle:nth-child(5) {
          width:2px; height:2px; animation-delay:-1.82s; animation-duration:3.25s; opacity:.42;
        }
      `}</style>

      <div
        aria-hidden="true"
        style={{
          position: "absolute", inset: 0, zIndex: 18, pointerEvents: "none",
          background: "radial-gradient(circle at 50% 44%, rgba(255,255,255,.018), rgba(0,0,0,.045) 58%, rgba(0,0,0,.10) 100%)",
          animation: alignmentTransition === "exiting"
            ? "artheticAlignWorkspaceWashOut .40s ease both"
            : "artheticAlignWorkspaceWashIn .42s ease both",
        }}
      />

      <div style={{
        position: "absolute", top: 10, left: 10, right: 10, zIndex: 32,
        minHeight: 58, padding: "10px 12px", boxSizing: "border-box",
        background: "rgba(12,12,12,.92)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 14,
        boxShadow: "0 14px 42px rgba(0,0,0,.32)", backdropFilter: "blur(18px)",
        display: "flex", alignItems: "center", gap: 10, color: "white",
        fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        animation: alignmentTransition === "exiting"
          ? "artheticAlignWorkspaceTopOut .36s cubic-bezier(.4,0,.2,1) both"
          : "artheticAlignWorkspaceTopIn .44s cubic-bezier(.2,.8,.2,1) both",
        willChange: "transform, opacity, filter",
      }}>
        <div style={{ minWidth: 148, padding: "0 7px 0 2px" }}>
          <div style={{ fontSize: 15, letterSpacing: "-.02em", whiteSpace: "nowrap", lineHeight: 1 }}>
            <span style={{ fontWeight: 850 }}>ART</span><span style={{ fontWeight: 300 }}>HETIC</span><span style={{ fontWeight: 300, marginLeft: 6, color: "#dddddd" }}>Align</span>
          </div>
          <div style={{ fontSize: 9, color: "#737373", marginTop: 5, fontWeight: 560 }}>Rigid registration · mm</div>
        </div>

        <div style={{ width: 1, height: 34, background: "rgba(255,255,255,.07)", flex: "0 0 auto" }} />

        <div style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 5, padding: "0 12px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, minWidth: 0 }}>
            {alignmentStepOrder.map((step, index) => (
              <React.Fragment key={step}>
                {index > 0 && <div style={{ width: 18, height: 1, background: "rgba(255,255,255,.08)", flex: "0 0 auto" }} />}
                <button
                  className={alignmentStepNeedsAttention(step) ? "artheticAlignReadyAction" : undefined}
                  onClick={() => handleAlignmentStepClick(step)}
                  disabled={!alignmentStepAvailable(step) || alignmentBusy}
                  style={alignmentStepStyle(step)}
                >
                  {alignmentStepNeedsAttention(step) && (
                    <span className="artheticAlignReadyParticles" aria-hidden="true">
                      <i className="artheticAlignReadyParticle" />
                      <i className="artheticAlignReadyParticle" />
                      <i className="artheticAlignReadyParticle" />
                      <i className="artheticAlignReadyParticle" />
                      <i className="artheticAlignReadyParticle" />
                    </span>
                  )}
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    {alignmentStepCompleted(step) && (
                      <span aria-hidden="true" style={{
                        width: 14, height: 14, borderRadius: "50%", display: "inline-grid", placeItems: "center",
                        background: alignmentStep === step ? "rgba(134,239,172,.16)" : "rgba(34,197,94,.12)",
                        border: "1px solid rgba(74,222,128,.24)", color: "#86efac", flex: "0 0 auto",
                      }}>
                        <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
                          <path d="M2.2 6.2L4.8 8.6L9.8 3.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </span>
                    )}
                    <span>{alignmentStepLabels[step]}</span>
                  </span>
                </button>
              </React.Fragment>
            ))}
            {alignmentWorkflowStage === "bestfit" && !alignmentBusy && (
              <>
                <div style={{ width: 18, height: 1, background: "rgba(255,255,255,.08)", flex: "0 0 auto" }} />
                {[
                  { label: "Odchylka", onClick: showAlignmentDeviation, disabled: !alignmentStats, delay: ".06s" },
                  { label: alignedExportBusyUrl === alignmentPair.bUrl ? "Připravuji…" : "Stáhnout B", onClick: () => downloadAlignedModel(alignmentPair.bUrl), disabled: !alignedExportsByUrl[alignmentPair.bUrl] || alignedExportBusyUrl === alignmentPair.bUrl, delay: ".14s" },
                  ...(editorCapabilities.canSaveAlignedToCase ? [{
                    label: alignedExportsByUrl[alignmentPair.bUrl]?.saveRequested ? "B předáno" : "Uložit B",
                    onClick: () => saveAlignedModelToCase(alignmentPair.bUrl),
                    disabled: !alignedExportsByUrl[alignmentPair.bUrl] || alignedExportBusyUrl === alignmentPair.bUrl || !!alignedExportsByUrl[alignmentPair.bUrl]?.saveRequested,
                    delay: ".21s",
                  }] : []),
                  { label: "Reset polohy", onClick: resetAlignmentTransform, disabled: false, delay: ".29s" },
                  { label: "Hotovo", onClick: closeAlignmentMode, disabled: false, delay: ".37s" },
                ].map((action) => (
                  <button
                    key={action.label}
                    className="artheticAlignPostFitAction"
                    onClick={action.onClick}
                    disabled={action.disabled}
                    style={{
                      ...alignmentButtonStyle("secondary", action.disabled),
                      height: 32,
                      fontSize: 10,
                      fontWeight: 670,
                      color: action.disabled ? "#5f5f5f" : "#eeeeee",
                      padding: "0 12px",
                      animationDelay: action.delay,
                    }}
                  >
                    {action.label}
                  </button>
                ))}
              </>
            )}
          </div>
          <div style={{ maxWidth: 720, color: "#777", fontSize: 8.8, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textAlign: "center" }}>
            {alignmentTopInstruction}{alignmentWorkflowStage !== "points" && alignmentMessage ? ` · ${alignmentMessage}` : ""}
          </div>
        </div>

        <div style={{ width: 1, height: 34, background: "rgba(255,255,255,.07)", flex: "0 0 auto" }} />

        <div style={{ display: "flex", alignItems: "center", flex: "0 0 auto" }}>
          <button
            type="button"
            onClick={closeAlignmentMode}
            disabled={alignmentBusy}
            title="Vrátit se zpět na hlavní scénu"
            style={{ ...alignmentButtonStyle("secondary", alignmentBusy), height: 36, display: "inline-flex", alignItems: "center", gap: 8, padding: "0 12px" }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M15 6L9 12L15 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M9.5 12H20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            <span>Vrátit se zpět na hlavní scénu</span>
          </button>
        </div>
      </div>

      {alignmentStep === "models" && !alignmentModelsSelected && (
        <div
          ref={alignmentPointerHintRef}
          style={{
            position: "fixed", left: 0, top: 0, zIndex: 80, opacity: 0, pointerEvents: "none",
            display: "flex", alignItems: "flex-start", gap: 8, minHeight: 30, padding: "7px 10px", borderRadius: 10,
            background: "rgba(12,12,12,.92)", border: "1px solid rgba(255,255,255,.12)",
            color: "#eeeeee", boxShadow: "0 8px 28px rgba(0,0,0,.34)", backdropFilter: "blur(12px)",
            fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif", whiteSpace: "nowrap",
            transform: "translate3d(-9999px,-9999px,0)", willChange: "transform, opacity",
            transition: "opacity .10s ease, background .12s ease, border-color .12s ease, color .12s ease",
          }}
        >
          <span data-align-pointer-dot style={{ width: 6, height: 6, marginTop: 4, borderRadius: "50%", background: "#9a9a9a", transition: "background .12s ease", flex: "0 0 auto" }} />
          <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontSize: 9.5, fontWeight: 720 }}>{!alignmentHasA ? "Vyberte model Reference A" : "Vyberte model Moving B"}</span>
            <span data-align-pointer-model style={{ display: "none", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", color: "rgba(255,255,255,.58)", fontSize: 8.5, fontWeight: 580 }} />
          </span>
        </div>
      )}

      {(alignmentBusy || alignmentCompletion) && alignmentProgressUi && (
        <div style={{
          position: "absolute", top: 0, left: 0, right: 0, bottom: alignmentBottomHeight, zIndex: 31,
          background: "rgba(0,0,0,.22)", backdropFilter: "blur(2px)", pointerEvents: "all",
          opacity: alignmentCompletion?.phase === "fade" ? 0 : 1,
          transition: "opacity .34s ease",
        }}>
          <div style={{
            position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-50%)",
            width: 454, maxWidth: "calc(100vw - 36px)", padding: "17px 17px 15px", borderRadius: 17,
            background: "rgba(11,11,11,.965)", border: "1px solid rgba(255,255,255,.10)",
            boxShadow: "0 28px 90px rgba(0,0,0,.56)", backdropFilter: "blur(22px)",
            color: "#f5f5f5", fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
            animation: alignmentCompletion?.phase === "fade"
              ? "artheticAlignCardOut .58s cubic-bezier(.4,0,.2,1) both"
              : "artheticAlignCardIn .22s ease-out both",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
              <div style={{
                position: "relative", width: 34, height: 34, borderRadius: 10, flex: "0 0 auto",
                background: "rgba(255,255,255,.035)", border: "1px solid rgba(255,255,255,.085)",
                display: "grid", placeItems: "center", overflow: "hidden",
              }}>
                {alignmentCompletion ? (
                  <svg
                    width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"
                    style={{ animation: "artheticAlignCheckPop .34s cubic-bezier(.2,.9,.24,1.2) both" }}
                  >
                    <path
                      d="M4.2 10.3 8.2 14.1 15.9 5.9"
                      stroke="#f4f4f4" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
                      style={{ strokeDasharray: 24, strokeDashoffset: 24, animation: "artheticAlignCheckDraw .48s .10s ease-out forwards" }}
                    />
                  </svg>
                ) : (
                  <div style={{
                    width: 18, height: 18, borderRadius: "50%", boxSizing: "border-box",
                    border: "1.5px solid rgba(255,255,255,.10)", borderTopColor: "#e8e8e8",
                    animation: "artheticAlignSpin .78s linear infinite",
                  }} />
                )}
              </div>

              <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <div style={{ fontSize: 13, fontWeight: 790, letterSpacing: "-.012em" }}>{alignmentProgressUi.label}</div>
                </div>
                <div style={{ marginTop: 3, color: "#777", fontSize: 9.7, fontWeight: 620 }}>{alignmentProgressUi.detail}</div>
              </div>

              <div style={{ textAlign: "right", flex: "0 0 auto" }}>
                <div ref={alignmentElapsedDisplayRef} style={{ color: "#b7b7b7", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 10.5, fontVariantNumeric: "tabular-nums", fontWeight: 720 }}>0.00 s</div>
                <div style={{ marginTop: 2, color: "#555", fontSize: 7.6, fontWeight: 720, letterSpacing: ".055em" }}>{alignmentProgressUi.code}</div>
              </div>
            </div>

            <div
              className="artheticAlignTerminal"
              style={{
                marginTop: 14, height: 126, borderRadius: 11,
                background: "rgba(2,2,2,.985)",
                border: "1px solid rgba(255,255,255,.065)", boxShadow: "inset 0 1px 0 rgba(255,255,255,.018)",
                padding: "10px 11px", boxSizing: "border-box",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
              }}
            >
              <div style={{ position: "relative", zIndex: 3, display: "flex", flexDirection: "column", justifyContent: "flex-end", height: "100%", gap: 3 }}>
                {alignmentTerminalLines.map((line, index) => {
                  const isLast = index === alignmentTerminalLines.length - 1
                  const toneColor = line.tone === "accent" || line.tone === "complete"
                    ? "#f1f1f1"
                    : line.tone === "data"
                      ? "#c8c8c8"
                      : line.tone === "muted"
                        ? "#555"
                        : line.tone === "active"
                          ? "#a9a9a9"
                          : "#777"
                  return (
                    <div key={line.id || `${line.stamp}-${index}-${line.text}`} style={{
                      display: "grid", gridTemplateColumns: alignmentCompletion ? "1fr" : "43px 8px 1fr", alignItems: "baseline", gap: alignmentCompletion ? 0 : 4,
                      minHeight: 11, color: toneColor, fontSize: 8.2, lineHeight: 1.16, letterSpacing: ".005em",
                      opacity: line.tone === "muted" ? .72 : 1,
                    }}>
                      {!alignmentCompletion && <span style={{ color: "#3f3f3f", fontVariantNumeric: "tabular-nums" }}>{line.stamp}</span>}
                      {!alignmentCompletion && <span style={{ color: line.tone === "accent" || line.tone === "complete" ? "#d8d8d8" : "#555" }}>{line.tone === "accent" || line.tone === "complete" ? "◆" : "›"}</span>}
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <AlignmentTerminalTypedText text={line.text} enabled={!!line.typewriter} speed={14} delay={line.delay ?? 28} />
                        {isLast && !alignmentCompletion && <i aria-hidden="true" style={{ display: "inline-block", width: 4, height: 8, marginLeft: 4, verticalAlign: "-1px", background: "#f2f2f2", animation: "artheticAlignTerminalCursor .92s steps(1,end) infinite" }} />}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>

            <div style={{ marginTop: 13, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
              <div style={{ color: "#666", fontSize: 8.4, fontWeight: 620 }}>
                {alignmentCompletion
                  ? (alignmentCompletion.kind === "deviation"
                    ? "Mapa odchylek je připravena · uzavírám analytickou relaci."
                    : "Registrace byla dokončena · uzavírám výpočetní relaci.")
                  : "Výpočet stále probíhá · stránku neobnovujte ani nezavírejte."}
              </div>
              <div style={{ color: "#8a8a8a", fontSize: 9, fontVariantNumeric: "tabular-nums", fontWeight: 730, whiteSpace: "nowrap" }}>
                {Math.round(alignmentProgressUi.percent)} %
              </div>
            </div>

            <div style={{ marginTop: 7, height: 5, borderRadius: 999, background: "rgba(255,255,255,.06)", overflow: "hidden", position: "relative" }}>
              <div style={{
                height: "100%", width: `${Math.max(2, Math.min(100, alignmentProgressUi.percent))}%`, borderRadius: 999,
                background: "linear-gradient(90deg, rgba(255,255,255,.62), rgba(255,255,255,.96))",
                transition: "width .28s cubic-bezier(.22,.61,.36,1)",
              }} />
            </div>

            <div style={{ marginTop: 9, display: "flex", alignItems: "center", gap: 8, color: "#626262", fontSize: 8.4, fontWeight: 650, minHeight: 11 }}>
              {!alignmentCompletion && alignmentProgress?.rms != null && Number.isFinite(alignmentProgress.rms) && <><span>RMS {alignmentProgress.rms.toFixed(4)} mm</span></>}
              {!alignmentCompletion && alignmentProgress?.rms != null && Number.isFinite(alignmentProgress.rms) && alignmentProgress?.stage > 0 && alignmentProgress?.stage <= 3 && <span>·</span>}
              {!alignmentCompletion && alignmentProgress?.stage > 0 && alignmentProgress?.stage <= 3 && <span>Pass {alignmentProgress.stage} / 3</span>}
              {!alignmentCompletion && Number.isFinite(alignmentProgress?.correspondences) && alignmentProgress.correspondences > 0 && <><span>·</span><span>{Math.round(alignmentProgress.correspondences).toLocaleString("cs-CZ")} párů</span></>}
              {alignmentCompletion && (
                <span>
                  {alignmentCompletion.kind === "deviation"
                    ? "Deviation map ready"
                    : alignmentCompletion.improved
                      ? "Alignment stored successfully"
                      : "Best Fit session completed safely"}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      <div style={{
        position: "absolute", left: 10, right: 10, bottom: 10, height: `calc(${alignmentBottomHeight} - 20px)`, zIndex: 25,
        display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8,
        background: "transparent", borderRadius: 14, overflow: "hidden",
        boxShadow: "0 -10px 36px rgba(0,0,0,.26)",
        animation: alignmentTransition === "exiting"
          ? "artheticAlignWorkspaceBottomOut .38s cubic-bezier(.4,0,.2,1) both"
          : "artheticAlignWorkspaceBottomIn .46s cubic-bezier(.2,.8,.2,1) both",
        willChange: "transform, opacity, filter",
      }}>
        <AlignmentPreviewViewport
          badge="A"
          file={alignmentPair.fileA}
          sourceObject={alignmentPair.aUrl ? modelObjectsRef.current[alignmentPair.aUrl] : null}
          color="#60a5fa"
          points={alignmentPointsA}
          active={(alignmentStep === "models" && !alignmentHasA && !alignmentBusy) || (alignmentStep === "points" && !!alignmentPair.aUrl && alignmentModelsSelected && !alignmentBusy && !alignmentPreviewBusy.A && !alignmentPreviewBusy.B && alignmentNextSide === "A")}
          dimmed={alignmentStep === "points" && alignmentModelsSelected && alignmentNextSide !== "A" && !alignmentBusy}
          selectionDisabled={false}
          inactivePointHint={alignmentStep === "points" && alignmentModelsSelected && alignmentNextSide === "B" && !alignmentBusy ? "Nejdříve umístěte bod v okně B" : ""}
          onPickPoint={handleAlignmentPickA}
          onClearPoints={() => clearAlignmentPointsForSide("A")}
          forceLoading={alignmentPreviewBusy.A}
          locked={alignmentBusy && !!alignmentProgress}
          eligibleFiles={alignmentEligibleFiles}
          selectedUrl={alignmentPair.aUrl || ""}
          otherSelectedUrl={alignmentPair.bUrl || ""}
          onSelectModel={(url) => changeAlignmentSelection("A", url)}
          selectStyle={alignmentSelectStyle}
          onPreviewLoaded={() => {
            setAlignmentPreviewBusy((previous) => ({ ...previous, A: false }))
            setAlignmentWorkflowStage("points")
            setAlignmentMessage("Reference A je připravena.")
          }}
          sceneIntensity={sceneIntensity}
          highlightIntensity={highlightIntensity}
          headlightCfg={headlightCfg}
        />
        <AlignmentPreviewViewport
          badge="B"
          file={alignmentPair.fileB}
          sourceObject={alignmentPair.bUrl ? modelObjectsRef.current[alignmentPair.bUrl] : null}
          color="#f472b6"
          points={alignmentPointsB}
          active={(alignmentStep === "models" && alignmentHasA && !alignmentHasB && !alignmentBusy) || (alignmentStep === "points" && !!alignmentPair.bUrl && alignmentModelsSelected && !alignmentBusy && !alignmentPreviewBusy.A && !alignmentPreviewBusy.B && alignmentNextSide === "B")}
          dimmed={alignmentStep === "points" && alignmentModelsSelected && alignmentNextSide !== "B" && !alignmentBusy}
          selectionDisabled={alignmentStep === "models" && !alignmentHasA}
          inactivePointHint={alignmentStep === "points" && alignmentModelsSelected && alignmentNextSide === "A" && !alignmentBusy ? "Nejdříve umístěte bod v okně A" : ""}
          onPickPoint={handleAlignmentPickB}
          onClearPoints={() => clearAlignmentPointsForSide("B")}
          forceLoading={alignmentPreviewBusy.B}
          locked={alignmentBusy && !!alignmentProgress}
          eligibleFiles={alignmentEligibleFiles}
          selectedUrl={alignmentPair.bUrl || ""}
          otherSelectedUrl={alignmentPair.aUrl || ""}
          onSelectModel={(url) => changeAlignmentSelection("B", url)}
          selectStyle={alignmentSelectStyle}
          onPreviewLoaded={() => {
            setAlignmentPreviewBusy((previous) => ({ ...previous, B: false }))
            setAlignmentWorkflowStage("points")
            setAlignmentMessage("Moving B je připraven.")
          }}
          sceneIntensity={sceneIntensity}
          highlightIntensity={highlightIntensity}
          headlightCfg={headlightCfg}
        />
      </div>
    </>
  )

  return (
    <div className="stage" style={{ position: "relative", width: "100vw", height: "100vh", background: "black", overflow: "hidden" }}>
      <PreloadIcons />
      {!alignmentMode && !trimMode && !mobileSliceSplitActive && logoEl}
      {!hideSidebar && !alignmentMode && !trimMode && sidebar}
      {!alignmentMode && !trimMode && topBarRight}

      {isMobile && mobileFunctionsOpen && !alignmentMode && (
        <>
          <div
            onClick={() => { setMobileFunctionsOpen(false); setMobileFunctionsSheetHeight(null) }}
            style={{
              position: "absolute", inset: 0, zIndex: 448,
              background: "rgba(0,0,0,.36)", backdropFilter: "blur(3px)", WebkitBackdropFilter: "blur(3px)",
              animation: "artheticMobileFunctionsBackdropIn .18s ease-out both",
            }}
          />
          <style>{`
            @keyframes artheticMobileFunctionsBackdropIn { from { opacity:0; } to { opacity:1; } }
            @keyframes artheticMobileFunctionsSheetIn { from { opacity:0; transform:translateY(18px) scale(.985); } to { opacity:1; transform:translateY(0) scale(1); } }
          `}</style>
          <div style={{
            position: "absolute", left: 10, right: 10, bottom: 10, zIndex: 449,
            height: Number.isFinite(mobileFunctionsSheetHeight) ? `${Math.round(mobileFunctionsSheetHeight)}px` : "min(56dvh, 500px)",
            maxHeight: "calc(100dvh - 20px)",
            padding: "8px 10px 12px", borderRadius: 18, overflowY: "auto", overscrollBehavior: "contain",
            background: "rgba(12,12,12,.97)", border: "1px solid rgba(255,255,255,.10)",
            boxShadow: "0 28px 80px rgba(0,0,0,.58)", backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)",
            color: "#ededed", fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
            animation: "artheticMobileFunctionsSheetIn .25s cubic-bezier(.2,.75,.25,1) both",
            transition: mobileFunctionsSheetDragging ? "none" : "height .30s cubic-bezier(.2,.78,.24,1)",
            willChange: "height",
          }}>
            <div
              onPointerDown={beginMobileFunctionsSheetDrag}
              onPointerMove={moveMobileFunctionsSheetDrag}
              onPointerUp={endMobileFunctionsSheetDrag}
              onPointerCancel={endMobileFunctionsSheetDrag}
              style={{ height: 20, margin: "-3px -2px 2px", display: "grid", placeItems: "center", touchAction: "none", cursor: mobileFunctionsSheetDragging ? "grabbing" : "grab" }}
              aria-label="Táhnout panel funkcí"
            >
              <div style={{ width: 38, height: 4, borderRadius: 999, background: mobileFunctionsSheetDragging ? "rgba(255,255,255,.30)" : "rgba(255,255,255,.14)", transition: "background .15s ease" }} />
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "2px 4px 10px" }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 780, letterSpacing: "-.015em" }}>Funkce</div>
                <div style={{ marginTop: 3, color: "#686868", fontSize: 9.2, fontWeight: 610 }}>Nástroje hlavní 3D scény</div>
              </div>
              <button
                type="button"
                onClick={() => { setMobileFunctionsOpen(false); setMobileFunctionsSheetHeight(null) }}
                aria-label="Zavřít funkce"
                style={{ width: 30, height: 30, padding: 0, display: "grid", placeItems: "center", borderRadius: 9, border: "1px solid rgba(255,255,255,.08)", background: "rgba(255,255,255,.035)", color: "#aaa", cursor: "pointer" }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
              </button>
            </div>

            <div style={{ display: "grid", gap: 8 }}>
              <button
                type="button"
                disabled={analysisEligibleFiles.length < 2}
                onClick={() => { setMobileFunctionsOpen(false); setHeatmapMenuOpen(true); setComparisonMenuOpen(false) }}
                style={{
                  width: "100%", minHeight: 64, padding: "10px 12px", borderRadius: 13, textAlign: "left",
                  display: "flex", alignItems: "center", gap: 11, boxSizing: "border-box",
                  border: showHeatmap ? "1px solid rgba(74,222,128,.19)" : "1px solid rgba(255,255,255,.075)",
                  background: showHeatmap ? "rgba(34,197,94,.065)" : "rgba(255,255,255,.026)",
                  color: analysisEligibleFiles.length < 2 ? "#555" : "#e8e8e8", cursor: analysisEligibleFiles.length < 2 ? "not-allowed" : "pointer",
                  fontFamily: "inherit",
                }}
              >
                <span style={{ width: 34, height: 34, flex: "0 0 auto", display: "grid", placeItems: "center", borderRadius: 10, background: "rgba(255,255,255,.035)", border: "1px solid rgba(255,255,255,.07)" }}>
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 8.5c3.2-2.5 6.4-3.7 9.5-3.2 2.2.3 4.3 1.5 6.5 3.2"/><path d="M4 15.5c3.2 2.5 6.4 3.7 9.5 3.2 2.2-.3 4.3-1.5 6.5-3.2"/><path d="M7 11.7h10"/><path d="M9.2 9.8L7 12l2.2 2.2"/><path d="M14.8 9.8L17 12l-2.2 2.2"/></svg>
                </span>
                <span style={{ minWidth: 0, flex: "1 1 auto" }}>
                  <span style={{ display: "block", fontSize: 11.5, fontWeight: 740 }}>Okluze</span>
                  <span style={{ display: "block", marginTop: 3, color: "#6f6f6f", fontSize: 9, lineHeight: 1.35 }}>Průnik, kontakt a mezera mezi dvěma modely</span>
                </span>
                {showHeatmap && <span style={{ color: "#86efac", fontSize: 9, fontWeight: 720 }}>Aktivní</span>}
              </button>

              <button
                type="button"
                disabled={analysisEligibleFiles.length < 2}
                onClick={() => { setMobileFunctionsOpen(false); setComparisonMenuOpen(true); setHeatmapMenuOpen(false) }}
                style={{
                  width: "100%", minHeight: 64, padding: "10px 12px", borderRadius: 13, textAlign: "left",
                  display: "flex", alignItems: "center", gap: 11, boxSizing: "border-box",
                  border: showComparison ? "1px solid rgba(74,222,128,.19)" : "1px solid rgba(255,255,255,.075)",
                  background: showComparison ? "rgba(34,197,94,.065)" : "rgba(255,255,255,.026)",
                  color: analysisEligibleFiles.length < 2 ? "#555" : "#e8e8e8", cursor: analysisEligibleFiles.length < 2 ? "not-allowed" : "pointer",
                  fontFamily: "inherit",
                }}
              >
                <span style={{ width: 34, height: 34, flex: "0 0 auto", display: "grid", placeItems: "center", borderRadius: 10, background: "rgba(255,255,255,.035)", border: "1px solid rgba(255,255,255,.07)" }}>
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 7h9"/><path d="M10.5 3.5L14 7l-3.5 3.5"/><path d="M19 17h-9"/><path d="M13.5 13.5L10 17l3.5 3.5"/></svg>
                </span>
                <span style={{ minWidth: 0, flex: "1 1 auto" }}>
                  <span style={{ display: "block", fontSize: 11.5, fontWeight: 740 }}>Porovnání</span>
                  <span style={{ display: "block", marginTop: 3, color: "#6f6f6f", fontSize: 9, lineHeight: 1.35 }}>Mapa odchylek mezi dvěma povrchy</span>
                </span>
                {showComparison && <span style={{ color: "#86efac", fontSize: 9, fontWeight: 720 }}>Aktivní</span>}
              </button>

              <button
                type="button"
                onClick={() => setIsAutoRotating((previous) => !previous)}
                style={{
                  width: "100%", minHeight: 58, padding: "10px 12px", borderRadius: 13, textAlign: "left",
                  display: "flex", alignItems: "center", gap: 11, boxSizing: "border-box",
                  border: isAutoRotating ? "1px solid rgba(74,222,128,.19)" : "1px solid rgba(255,255,255,.075)",
                  background: isAutoRotating ? "rgba(34,197,94,.065)" : "rgba(255,255,255,.026)",
                  color: "#e8e8e8", cursor: "pointer", fontFamily: "inherit",
                }}
              >
                <span style={{ width: 34, height: 34, flex: "0 0 auto", display: "grid", placeItems: "center", borderRadius: 10, background: "rgba(255,255,255,.035)", border: "1px solid rgba(255,255,255,.07)" }}>
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>
                </span>
                <span style={{ minWidth: 0, flex: "1 1 auto" }}>
                  <span style={{ display: "block", fontSize: 11.5, fontWeight: 740 }}>360° Spin</span>
                  <span style={{ display: "block", marginTop: 3, color: "#6f6f6f", fontSize: 9, lineHeight: 1.35 }}>Automatická rotace modelu v hlavní scéně</span>
                </span>
                <span style={{ color: isAutoRotating ? "#86efac" : "#737373", fontSize: 9, fontWeight: 720 }}>{isAutoRotating ? "Zapnuto" : "Vypnuto"}</span>
              </button>

              {isAutoRotating && (
                <div style={{ margin: "-1px 4px 1px", padding: "9px 10px", borderRadius: 11, background: "rgba(255,255,255,.018)", border: "1px solid rgba(255,255,255,.055)" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 7, color: "#858585", fontSize: 8.8, fontWeight: 680 }}>
                    <span>Rychlost rotace</span><span style={{ color: "#cfcfcf", fontVariantNumeric: "tabular-nums" }}>{Math.round(spinSpeed * 100)}%</span>
                  </div>
                  <input className="slider" type="range" min={0.05} max={1} step={0.05} value={spinSpeed} onChange={(e) => setSpinSpeed(parseFloat(e.target.value))} style={{ width: "100%", margin: 0 }} />
                </div>
              )}

              <button
                type="button"
                onClick={() => {
                  const next = !clippingEnabled
                  if (!next && dicomSettings.viewMode === "only2d") setDicomSettings((previous) => ({ ...previous, viewMode: "solid" }))
                  setClippingEnabled(next)
                }}
                style={{
                  width: "100%", minHeight: 58, padding: "10px 12px", borderRadius: 13, textAlign: "left",
                  display: "flex", alignItems: "center", gap: 11, boxSizing: "border-box",
                  border: clippingEnabled ? "1px solid rgba(74,222,128,.19)" : "1px solid rgba(255,255,255,.075)",
                  background: clippingEnabled ? "rgba(34,197,94,.065)" : "rgba(255,255,255,.026)",
                  color: "#e8e8e8", cursor: "pointer", fontFamily: "inherit",
                }}
              >
                <span style={{ width: 34, height: 34, flex: "0 0 auto", display: "grid", placeItems: "center", borderRadius: 10, background: "rgba(255,255,255,.035)", border: "1px solid rgba(255,255,255,.07)" }}>
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 6h16M4 18h16"/><path d="M7 3v6M17 15v6"/><path d="M4 12h16"/></svg>
                </span>
                <span style={{ minWidth: 0, flex: "1 1 auto" }}>
                  <span style={{ display: "block", fontSize: 11.5, fontWeight: 740 }}>Průřez</span>
                  <span style={{ display: "block", marginTop: 3, color: "#6f6f6f", fontSize: 9, lineHeight: 1.35 }}>Zobrazit řez modely ve scéně</span>
                </span>
                <span style={{ color: clippingEnabled ? "#86efac" : "#737373", fontSize: 9, fontWeight: 720 }}>{clippingEnabled ? "Zapnuto" : "Vypnuto"}</span>
              </button>

              {clippingEnabled && (
                <button
                  type="button"
                  onClick={handleResetPlane}
                  style={{ margin: "-1px 4px 1px", height: 34, borderRadius: 10, border: "1px solid rgba(255,255,255,.065)", background: "rgba(255,255,255,.025)", color: "#9a9a9a", fontFamily: "inherit", fontSize: 9, fontWeight: 690, cursor: "pointer" }}
                >
                  Resetovat polohu průřezu
                </button>
              )}
            </div>

            {analysisEligibleFiles.length < 2 && (
              <div style={{ marginTop: 9, padding: "8px 9px", borderRadius: 10, background: "rgba(255,255,255,.022)", border: "1px solid rgba(255,255,255,.055)", color: "#626262", fontSize: 8.7, lineHeight: 1.4 }}>
                Pro analýzu jsou potřeba alespoň dva STL, PLY nebo OBJ modely.
              </div>
            )}
          </div>
        </>
      )}

      {trimWorkspace}
      {alignmentWorkspace}

      {dicomLayoutActive && (
        <div style={{
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          width: dicomPanelWidth,
          zIndex: 6,
          display: "grid",
          gridTemplateRows: "minmax(0, 1fr) minmax(0, 1fr)",
          gap: 6,
          padding: 6,
          boxSizing: "border-box",
          background: "rgba(8,8,8,.96)",
          borderLeft: "1px solid rgba(255,255,255,.2)",
          boxShadow: "-12px 0 32px rgba(0,0,0,.42)",
        }}>
          {clippingEnabled ? (
            <>
              <div style={{ minWidth: 0, minHeight: 0, position: "relative" }}>
                <Overlay2D
                  embedded
                  title="Vertikální řez"
                  segments={sliceSegments}
                  modelColors={colors}
                  boundingBox={sliceBBox}
                  measureState={measureState}
                  setMeasureState={setMeasureState}
                  dicomSlice={dicomSlice2D}
                  onInteractionChange={handleSliceOverlayInteraction}
                  active={activeSlice === "vertical"}
                  onActivate={() => setActiveSlice("vertical")}
                  accent="#f59e9e"
                />
              </div>
              <div style={{ minWidth: 0, minHeight: 0, position: "relative" }}>
                <Overlay2D
                  embedded
                  title="Horizontální řez"
                  segments={horizontalSliceSegments}
                  modelColors={colors}
                  boundingBox={horizontalSliceBBox}
                  measureState={horizontalMeasureState}
                  setMeasureState={setHorizontalMeasureState}
                  dicomSlice={horizontalDicomSlice2D}
                  onInteractionChange={handleSliceOverlayInteraction}
                  active={activeSlice === "horizontal"}
                  onActivate={() => setActiveSlice("horizontal")}
                  accent="#38bdf8"
                />
              </div>
            </>
          ) : (
            <div style={{ gridRow: "1 / -1", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, color: "#9ca3af", fontFamily: "sans-serif", textAlign: "center", fontSize: 13 }}>
              Zapněte funkci Průřez pro zobrazení vertikálního a horizontálního DICOM řezu.
            </div>
          )}
        </div>
      )}

      {/* OVERLAY BĚHEM NAČÍTÁNÍ MODELŮ */}
      {!allLoaded && files.length > 0 && (() => {
        const loadedCount = files.filter((file) => loadedUrls.has(file.url)).length
        const totalCount = files.length
        const loadPercent = Math.max(4, Math.min(100, Math.round((loadedCount / Math.max(1, totalCount)) * 100)))
        return (
          <div style={{
            position: "absolute", inset: 0, zIndex: 9999, background: "rgba(0,0,0,.42)",
            backdropFilter: "blur(2px)", WebkitBackdropFilter: "blur(2px)",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "white", fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
          }}>
            <div style={{
              width: 350, maxWidth: "calc(100vw - 40px)", padding: "20px 20px 18px", borderRadius: 16,
              background: "rgba(12,12,12,.96)", border: "1px solid rgba(255,255,255,.09)",
              boxShadow: "0 24px 70px rgba(0,0,0,.52)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)"
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{
                  width: 34, height: 34, borderRadius: "50%", boxSizing: "border-box",
                  border: "2px solid rgba(255,255,255,.10)", borderTopColor: "#f3f3f3",
                  animation: "artheticAnalysisSpin .85s linear infinite", flex: "0 0 auto"
                }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 790, letterSpacing: "-.01em" }}>Načítám 3D scénu</div>
                  <div style={{ marginTop: 3, color: "#777", fontSize: 9.5, fontWeight: 610 }}>
                    Připravuji modely a jejich geometrii · {loadedCount} / {totalCount}
                  </div>
                </div>
                <div style={{ color: "#a3a3a3", fontSize: 10, fontWeight: 760, fontVariantNumeric: "tabular-nums" }}>
                  {Math.round((loadedCount / Math.max(1, totalCount)) * 100)} %
                </div>
              </div>
              <div style={{ marginTop: 17, height: 4, borderRadius: 999, overflow: "hidden", background: "rgba(255,255,255,.06)" }}>
                <div style={{
                  width: `${loadPercent}%`, height: "100%", borderRadius: 999,
                  background: "linear-gradient(90deg, rgba(255,255,255,.42), rgba(255,255,255,.96))",
                  boxShadow: "0 0 14px rgba(255,255,255,.12)", transition: "width .28s cubic-bezier(.22,.8,.22,1)"
                }} />
              </div>
              <div style={{ marginTop: 10, color: "#595959", fontSize: 8.5, fontWeight: 620 }}>
                Viewer se otevře automaticky, jakmile budou všechny modely připravené.
              </div>
            </div>
          </div>
        )
      })()}

      {/* SJEDNOCENÝ TERMINÁL PRO POROVNÁNÍ / OKLUZI NA HLAVNÍ SCÉNĚ */}
      {(isCalculatingHeatmap || isCalculatingComparison || surfaceAnalysisCompletion) && surfaceAnalysisProgressUi && (
        <>
          <style>{`
            @keyframes artheticSurfaceSpin { to { transform:rotate(360deg); } }
            @keyframes artheticSurfaceCardIn { from { opacity:0; transform:translate(-50%,-46%) scale(.97); } to { opacity:1; transform:translate(-50%,-50%) scale(1); } }
            @keyframes artheticSurfaceCardOut { from { opacity:1; transform:translate(-50%,-50%) scale(1); filter:blur(0); } to { opacity:0; transform:translate(-50%,-51%) scale(.985); filter:blur(3px); } }
            @keyframes artheticSurfaceCursor { 0%,46% { opacity:1; } 47%,100% { opacity:.16; } }
            @keyframes artheticSurfaceCheckPop { 0% { opacity:0; transform:scale(.55); } 55% { opacity:1; transform:scale(1.08); } 100% { opacity:1; transform:scale(1); } }
            @keyframes artheticSurfaceCheckDraw { from { stroke-dashoffset:24; } to { stroke-dashoffset:0; } }
            .artheticSurfaceTerminal { position:relative; overflow:hidden; isolation:isolate; }
            .artheticSurfaceTerminal::after {
              content:""; position:absolute; inset:0;
              background:repeating-linear-gradient(180deg, transparent 0, transparent 3px, rgba(255,255,255,.012) 4px);
              pointer-events:none; z-index:1;
            }
          `}</style>

          <div style={{
            position: "absolute", inset: 0, zIndex: 9999,
            background: "rgba(0,0,0,.22)", backdropFilter: "blur(2px)", WebkitBackdropFilter: "blur(2px)",
            pointerEvents: "all",
            opacity: surfaceAnalysisCompletion?.phase === "fade" ? 0 : 1,
            transition: "opacity .26s ease",
            fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
          }}>
            <div style={{
              position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-50%)",
              width: 454, maxWidth: "calc(100vw - 36px)", padding: "17px 17px 15px", borderRadius: 17,
              background: "rgba(11,11,11,.965)", border: "1px solid rgba(255,255,255,.10)",
              boxShadow: "0 28px 90px rgba(0,0,0,.56)", backdropFilter: "blur(22px)", WebkitBackdropFilter: "blur(22px)",
              color: "#f5f5f5",
              animation: surfaceAnalysisCompletion?.phase === "fade"
                ? "artheticSurfaceCardOut .26s cubic-bezier(.4,0,.2,1) both"
                : "artheticSurfaceCardIn .22s ease-out both",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                <div style={{
                  position: "relative", width: 34, height: 34, borderRadius: 10, flex: "0 0 auto",
                  background: "rgba(255,255,255,.035)", border: "1px solid rgba(255,255,255,.085)",
                  display: "grid", placeItems: "center", overflow: "hidden",
                }}>
                  {surfaceAnalysisCompletion ? (
                    <svg
                      width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"
                      style={{ animation: "artheticSurfaceCheckPop .34s cubic-bezier(.2,.9,.24,1.2) both" }}
                    >
                      <path
                        d="M4.2 10.3 8.2 14.1 15.9 5.9"
                        stroke="#f4f4f4" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
                        style={{ strokeDasharray: 24, strokeDashoffset: 24, animation: "artheticSurfaceCheckDraw .48s .10s ease-out forwards" }}
                      />
                    </svg>
                  ) : (
                    <div style={{
                      width: 18, height: 18, borderRadius: "50%", boxSizing: "border-box",
                      border: "1.5px solid rgba(255,255,255,.10)", borderTopColor: "#e8e8e8",
                      animation: "artheticSurfaceSpin .78s linear infinite",
                    }} />
                  )}
                </div>

                <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                  <div style={{ fontSize: 13, fontWeight: 790, letterSpacing: "-.012em" }}>{surfaceAnalysisProgressUi.label}</div>
                  <div style={{ marginTop: 3, color: "#777", fontSize: 9.7, fontWeight: 620 }}>{surfaceAnalysisProgressUi.detail}</div>
                </div>

                <div style={{ textAlign: "right", flex: "0 0 auto" }}>
                  <div ref={surfaceAnalysisElapsedDisplayRef} style={{
                    color: "#b7b7b7", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                    fontSize: 10.5, fontVariantNumeric: "tabular-nums", fontWeight: 720
                  }}>0.00 s</div>
                  <div style={{ marginTop: 2, color: "#555", fontSize: 7.6, fontWeight: 720, letterSpacing: ".055em" }}>
                    {surfaceAnalysisProgressUi.code}
                  </div>
                </div>
              </div>

              <div
                className="artheticSurfaceTerminal"
                style={{
                  marginTop: 14, height: 126, borderRadius: 11,
                  background: "rgba(2,2,2,.985)",
                  border: "1px solid rgba(255,255,255,.065)", boxShadow: "inset 0 1px 0 rgba(255,255,255,.018)",
                  padding: "10px 11px", boxSizing: "border-box",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
                }}
              >
                <div style={{ position: "relative", zIndex: 3, display: "flex", flexDirection: "column", justifyContent: "flex-end", height: "100%", gap: 3 }}>
                  {surfaceAnalysisTerminalLines.map((line, index) => {
                    const isLast = index === surfaceAnalysisTerminalLines.length - 1
                    const toneColor = line.tone === "accent" || line.tone === "complete"
                      ? "#f1f1f1"
                      : line.tone === "data"
                        ? "#c8c8c8"
                        : line.tone === "muted"
                          ? "#555"
                          : line.tone === "active"
                            ? "#a9a9a9"
                            : "#777"
                    return (
                      <div key={line.id || `${line.stamp}-${index}-${line.text}`} style={{
                        display: "grid",
                        gridTemplateColumns: surfaceAnalysisCompletion ? "1fr" : "43px 8px 1fr",
                        alignItems: "baseline", gap: surfaceAnalysisCompletion ? 0 : 4,
                        minHeight: 11, color: toneColor, fontSize: 8.2, lineHeight: 1.16, letterSpacing: ".005em",
                        opacity: line.tone === "muted" ? .72 : 1,
                      }}>
                        {!surfaceAnalysisCompletion && <span style={{ color: "#3f3f3f", fontVariantNumeric: "tabular-nums" }}>{line.stamp}</span>}
                        {!surfaceAnalysisCompletion && <span style={{ color: line.tone === "accent" || line.tone === "complete" ? "#d8d8d8" : "#555" }}>{line.tone === "accent" || line.tone === "complete" ? "◆" : "›"}</span>}
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          <AlignmentTerminalTypedText text={line.text} enabled={!!line.typewriter} speed={8} delay={line.delay ?? 24} />
                          {isLast && !surfaceAnalysisCompletion && (
                            <i aria-hidden="true" style={{
                              display: "inline-block", width: 4, height: 8, marginLeft: 4, verticalAlign: "-1px",
                              background: "#f2f2f2", animation: "artheticSurfaceCursor .92s steps(1,end) infinite"
                            }} />
                          )}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>

              <div style={{ marginTop: 13, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                <div style={{ color: "#666", fontSize: 8.4, fontWeight: 620 }}>
                  {surfaceAnalysisCompletion
                    ? (surfaceAnalysisCompletion.kind === "comparison"
                      ? "Porovnání povrchů bylo dokončeno · uzavírám analytickou relaci."
                      : "Okluzní analýza byla dokončena · uzavírám analytickou relaci.")
                    : restoringAnalysisMode
                      ? "Obnovuji uloženou analýzu · stránku neobnovujte ani nezavírejte."
                      : "Výpočet stále probíhá · stránku neobnovujte ani nezavírejte."}
                </div>
                <div style={{ color: "#8a8a8a", fontSize: 9, fontVariantNumeric: "tabular-nums", fontWeight: 730, whiteSpace: "nowrap" }}>
                  {Math.round(Math.max(0, Math.min(100, surfaceAnalysisProgressUi.percent)))} %
                </div>
              </div>

              <div style={{ marginTop: 7, height: 5, borderRadius: 999, background: "rgba(255,255,255,.06)", overflow: "hidden", position: "relative" }}>
                <div style={{
                  height: "100%",
                  width: `${Math.max(2, Math.min(100, surfaceAnalysisProgressUi.percent))}%`,
                  borderRadius: 999,
                  background: "linear-gradient(90deg, rgba(255,255,255,.62), rgba(255,255,255,.96))",
                  transition: "width .24s cubic-bezier(.22,.61,.36,1)",
                }} />
              </div>

              <div style={{ marginTop: 9, display: "flex", alignItems: "center", gap: 8, color: "#626262", fontSize: 8.4, fontWeight: 650, minHeight: 11 }}>
                {surfaceAnalysisCompletion ? (
                  <span>{surfaceAnalysisCompletion.kind === "comparison" ? "Comparison map ready" : "Occlusion map ready"}</span>
                ) : Number(surfaceAnalysisProgress?.processed) > 0 && Number(surfaceAnalysisProgress?.total) > 0 ? (
                  <span>{Number(surfaceAnalysisProgress.processed).toLocaleString("cs-CZ")} / {Number(surfaceAnalysisProgress.total).toLocaleString("cs-CZ")} vzorků</span>
                ) : (
                  <span>{isCalculatingComparison ? "Bidirectional closest-surface analysis" : "Signed closest-surface analysis"}</span>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      <div 
        ref={tooltipRef}
        style={{
          position: "fixed", top: 0, left: 0, opacity: 0,
          background: "rgba(0,0,0,0.85)", color: "#fff",
          padding: "6px 10px", borderRadius: 6, fontSize: 13,
          fontWeight: "bold", pointerEvents: "none", zIndex: 9998,
          border: "1px solid rgba(255,255,255,0.2)",
          boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
          transition: "opacity 0.15s ease",
          transformOrigin: "top left",
          display: activeAnalysisMode ? "block" : "none" 
        }}
      />

      {!isMobile && showHeatmap && hasComputedHeatmap && (
        <div style={{
          position: "absolute", top: alignmentMode ? 106 : 20, left: "50%", transform: "translateX(-50%)", zIndex: 100,
          minWidth: 330, padding: "11px 14px 10px", borderRadius: 13,
          background: "rgba(12,12,12,.88)", border: "1px solid rgba(255,255,255,.09)",
          color: "#ededed", fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
          backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)", boxShadow: "0 16px 42px rgba(0,0,0,.3)"
        }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, marginBottom: 8 }}>
            <span style={{ fontWeight: 720, fontSize: 10.5 }}>Okluze</span>
            <span style={{ color: "#696969", fontWeight: 600, fontSize: 8.5 }}>průnik · mezera · mm</span>
          </div>
          <div style={{ height: 7, borderRadius: 999, background: "linear-gradient(to right, #7e22ce 0%, #ef4444 25%, #facc15 37.5%, #22c55e 62.5%, #ffffff 100%)", boxShadow: "inset 0 1px 2px rgba(0,0,0,.35)" }} />
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 5, color: "#777", fontSize: 8, fontWeight: 650, fontVariantNumeric: "tabular-nums" }}>
            <span>-1.0−</span><span>-0.5</span><span>0</span><span>1.0</span><span>2.0+</span>
          </div>
        </div>
      )}

      {(dicomStatus === "downloading" || dicomStatus === "processing") && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 10000, background: "rgba(0,0,0,.76)",
          display: "flex", alignItems: "center", justifyContent: "center", color: "white", fontFamily: "sans-serif"
        }}>
          <div style={{ width: "min(430px, calc(100vw - 32px))", textAlign: "center" }}>
            <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: "shade3dSpin360 1s linear infinite", transformOrigin: "50% 50%", marginBottom: 14 }}>
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            <div style={{ fontSize: 18, fontWeight: 800 }}>
              {dicomStatus === "downloading"
                ? `Stahuji DICOM data - ${Math.round(dicomProgress)}%`
                : "Zpracovávám DICOM data..."}
            </div>
            <div style={{ height: 6, marginTop: 14, borderRadius: 999, overflow: "hidden", background: "rgba(255,255,255,.15)" }}>
              <div style={{ width: `${Math.max(2, dicomProgress)}%`, height: "100%", background: "#60a5fa", transition: "width .2s" }} />
            </div>
            {dicomStatus === "processing" && (
              <div style={{ marginTop: 9, fontSize: 11, color: "#cbd5e1" }}>
                Sestavuji 3D objem z jednotlivých řezů.
              </div>
            )}
          </div>
        </div>
      )}

      {!isMobile && showComparison && hasComputedComparison && (
        <div style={{
          position: "absolute", top: alignmentMode ? 106 : 20, left: "50%", transform: "translateX(-50%)", zIndex: 100,
          minWidth: 330, padding: "11px 14px 10px", borderRadius: 13,
          background: "rgba(12,12,12,.88)", border: "1px solid rgba(255,255,255,.09)",
          color: "#ededed", fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
          backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)", boxShadow: "0 16px 42px rgba(0,0,0,.3)"
        }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, marginBottom: 8 }}>
            <span style={{ fontWeight: 720, fontSize: 10.5 }}>Porovnání povrchů · {comparisonDirection === "A_TO_B" ? "A → B" : "B → A"}</span>
            <span style={{ color: "#696969", fontWeight: 600, fontSize: 8.5 }}>absolutní odchylka · mm</span>
          </div>
          <div style={{ height: 7, borderRadius: 999, background: "linear-gradient(to right, #2563eb 0%, #22c55e 25%, #facc15 50%, #ef4444 75%, #a21caf 100%)" }} />
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 5, color: "#777", fontSize: 8, fontWeight: 650, fontVariantNumeric: "tabular-nums" }}>
            <span>0</span><span>{comparisonTolerance.toFixed(2)}</span><span>{(comparisonTolerance * 2).toFixed(2)}</span><span>{(comparisonTolerance * 4).toFixed(2)}</span><span>více</span>
          </div>
        </div>
      )}

      {!alignmentMode && !dicomLayoutActive && clippingEnabled && !isMobile && (
        <Overlay2D segments={sliceSegments} modelColors={colors} boundingBox={sliceBBox} measureState={measureState} setMeasureState={setMeasureState} dicomSlice={dicomSlice2D} onInteractionChange={handleSliceOverlayInteraction} />
      )}

      {mobileSliceSplitActive && (
        <div style={{
          position: "absolute",
          left: "50%",
          bottom: `calc(${mobileSlicePaneHeight} + 18px)`,
          transform: "translateX(-50%)",
          zIndex: 4,
          pointerEvents: "none",
          padding: "6px 10px",
          borderRadius: 999,
          background: "rgba(12,12,12,.78)",
          border: "1px solid rgba(255,255,255,.10)",
          boxShadow: "0 8px 24px rgba(0,0,0,.28)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          color: "#bdbdbd",
          fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
          fontSize: 9.5,
          fontWeight: 680,
          whiteSpace: "nowrap",
          letterSpacing: "-.01em",
        }}>
          Rovina řezu · 1 prst = posun · 2 prsty = natočení
        </div>
      )}

      {mobileSliceSplitActive && (
        <div style={{
          position: "absolute", left: 10, right: 10, bottom: 10, height: mobileSlicePaneHeight, zIndex: 2,
          borderRadius: 12, overflow: "hidden", background: "#141414",
          border: "1px solid rgba(255,255,255,.12)", boxShadow: "0 -12px 36px rgba(0,0,0,.34)",
          touchAction: "none", overscrollBehavior: "contain",
        }}>
          <Overlay2D
            embedded mobile title="Průřez · 2D"
            segments={sliceSegments}
            modelColors={colors}
            boundingBox={sliceBBox}
            measureState={measureState}
            setMeasureState={setMeasureState}
            dicomSlice={dicomSlice2D}
            onInteractionChange={handleSliceOverlayInteraction}
          />
        </div>
      )}

      {!alignmentMode && !dicomLayoutActive && clippingEnabled && isMobile && !!dicomSource && dicomSettings.viewMode === "only2d" && (
        <Overlay2D mobile segments={sliceSegments} modelColors={colors} boundingBox={sliceBBox} measureState={measureState} setMeasureState={setMeasureState} dicomSlice={dicomSlice2D} onInteractionChange={handleSliceOverlayInteraction} />
      )}

      <Canvas
        orthographic
        camera={{ position: [0, 0, 300], near: 0.01, far: 100000, zoom: 0.9 }}
        gl={{ preserveDrawingBuffer: true }}
        onCreated={({ gl }) => {
            gl.setClearAlpha(0)
            gl.localClippingEnabled = false
            gl.domElement.dataset.artheticMainScene = "1"
        }}
        style={{ position: "absolute", top: 0, bottom: alignmentSceneInsetActive ? alignmentBottomHeight : (mobileSliceSplitActive ? `calc(${mobileSlicePaneHeight} + 18px)` : 0), left: 0, right: dicomLayoutActive ? dicomPanelWidth : 0, zIndex: 1, background: "transparent", transition: "bottom .44s cubic-bezier(.2,.8,.2,1), right .34s ease", willChange: "bottom" }}
      >
        <ambientLight intensity={0.35 * sceneIntensity} />
        <directionalLight position={[0, 5, 5]} intensity={1.2 * sceneIntensity} />
        <directionalLight position={[-10, 0, 0]} intensity={0.9 * sceneIntensity} />
        <directionalLight position={[10, 0, 0]} intensity={1.0 * sceneIntensity} />
        <directionalLight position={[0, -5, -5]} intensity={0.7 * sceneIntensity} />

        <Headlight enabled={headlightCfg.enabled} intensity={headlightCfg.intensity * highlightIntensity} />
        <AlignmentFastRaycast enabled={(alignmentMode && alignmentStep === "models" && !alignmentModelsSelected && !alignmentBusy) || (trimMode && !!trimSelection)} />

        <AutoRotateScene enabled={!alignmentMode && !trimMode && isAutoRotating} target={cameraTarget} speedFactor={spinSpeed} />

        <group ref={rootGroupRef}>
          <Suspense fallback={null}>
            {files.map((f, i) => (
              <AnyModel
                key={`${f.url}-${i}`}
                name={f.rawName || f.name}
                url={f.url}
                color={colors[i] ?? "#ffffff"}
                opacity={opacities[i] ?? 1}
                visible={trimMode && trimSelection
                  ? f.url === trimSelection
                  : alignmentMode && alignmentModelsSelected
                    ? (f.url === alignmentPair.aUrl || f.url === alignmentPair.bUrl)
                    : (visibles[i] ?? true)}
                onLoaded={handleModelLoaded}
                onMeshReady={handleMeshReady}
                onObjectReady={handleObjectReady}
                modelMatrix={modelTransforms[f.url]}
                autoSmooth={true}
                smoothAngle={DEFAULT_SMOOTH_ANGLE}
                wireframe={wireframes[i] || false}
                ghost={!!ghostModes[i]}
                roughness={roughnesses[i] ?? (typeof f.r === "number" ? f.r : 0.25)}
                metalness={metalnesses[i] ?? (typeof f.m === "number" ? f.m : 0.12)}
                useVertexColors={vertexColors[i]}
                keepMaterials={!!f.km}
                renderOrder={i}
                analysisMode={
                  showHeatmap && heatmapSelection[0] === f.url
                    ? "occlusion"
                    : showComparison && hasComputedComparison && f.url === comparisonAnalyzedUrl
                      ? "comparison"
                      : null
                }
                onHoverDist={handleHeatmapHover} 
                onPinNote={handlePinNote}
                onAlignmentSelect={alignmentMode && alignmentStep === "models" && !alignmentModelsSelected && !alignmentBusy && (!alignmentHasA || f.url !== alignmentPair.aUrl)
                  ? selectAlignmentModelFromScene
                  : trimMode && trimStage === "model" && !trimBusy
                    ? selectTrimModel
                    : null}
                onAlignmentHover={alignmentMode && alignmentStep === "models" && !alignmentModelsSelected && !alignmentBusy
                  ? handleAlignmentSceneHover
                  : null}
                onTrimSurfaceClick={trimMode && trimSelection === f.url && trimStage !== "result" ? handleTrimSurfaceClick : null}
                onTrimSurfaceMove={trimMode && trimSelection === f.url && trimStage !== "result" ? handleTrimSurfaceMove : null}
                onTrimSurfaceOut={trimMode && trimSelection === f.url && trimStage !== "result" ? handleTrimSurfaceOut : null}
              />
            ))}
          </Suspense>

          {trimMode && trimContext && trimSelection && trimStage !== "result" && (
            <TrimSurfaceOverlay
              context={trimContext}
              modelMatrix={modelTransforms[trimSelection]}
              controlNodes={trimControlNodes}
              segments={trimSegments}
              boundaryPlan={trimBoundaryPlan}
              keepComponent={trimKeepComponent}
              hoverComponent={trimHoverComponent}
              draggingPoint={trimDraggingPoint}
              onBeginPointDrag={beginTrimPointDrag}
              onCloseLoop={closeTrimLoop}
            />
          )}
          
          {activeAnalysisMode && pinnedNotes.filter((note) => note.mode === activeAnalysisMode).map(note => (
            <Html key={note.id} position={note.pos} zIndexRange={[100, 0]}>
              <div style={{ position: 'relative' }}>
                <div style={{
                  position: 'absolute', left: -4, top: -4, width: 8, height: 8,
                  backgroundColor: '#fbbf24', borderRadius: '50%', border: '1.5px solid #000',
                  pointerEvents: 'none'
                }} />
                
                <svg style={{
                  position: 'absolute', left: 0, top: -30, width: 30, height: 30,
                  pointerEvents: 'none', overflow: 'visible'
                }}>
                  <line x1="0" y1="30" x2="30" y2="0" stroke="#fbbf24" strokeWidth="2" />
                </svg>
                
                <div style={{
                  position: 'absolute', left: 30, top: -45,
                  background: "rgba(0,0,0,0.85)", color: "#fbbf24", padding: "4px 8px",
                  borderRadius: 6, fontSize: 13, fontWeight: "bold", border: "1px solid rgba(251, 191, 36, 0.5)",
                  display: "flex", alignItems: "center", gap: 8, pointerEvents: "auto",
                  boxShadow: "0 4px 12px rgba(0,0,0,0.5)", userSelect: "none",
                  whiteSpace: "nowrap"
                }}>
                  {note.mode === "occlusion" && note.value > 0 ? "+" : ""}{note.value.toFixed(2)} mm
                  <button 
                    onClick={(e) => { e.stopPropagation(); removeNote(note.id); }} 
                    style={{
                      background: "none", border: "none", color: "#ccc", cursor: "pointer", 
                      padding: 0, fontSize: 16, lineHeight: 1, display: "flex", alignItems: "center"
                    }}
                    title="Smazat poznámku"
                  >&times;</button>
                </div>
              </div>
            </Html>
          ))}
        </group>

        {!alignmentMode && !trimMode && dicomVolume && dicomSettings.viewMode !== "only2d" && (
          <DicomVolume
            volume={dicomVolume}
            settings={dicomSettings}
            interactive={false}
          />
        )}

        {!alignmentMode && !trimMode && clippingEnabled && (!isMobile || dicomSettings.viewMode === "only2d") && (
          <group ref={setSliceRigGroup}>
            <group ref={setPlaneGroup} visible={!dicomLayoutActive || activeSlice === "vertical"}>
              <mesh>
                <circleGeometry args={[planeRadius, 64]} />
                <meshBasicMaterial color="#b88f8f" transparent opacity={0.25} side={THREE.DoubleSide} depthWrite={false} />
              </mesh>
              {mobileSliceSplitActive && (
                <MobileSlicePlaneTouchController
                  radius={planeRadius}
                  enabled={mobileSliceSplitActive}
                  onChange={syncActiveSliceFromGizmo}
                  onInteractionChange={handleSliceOverlayInteraction}
                />
              )}
              {dicomSlice2D && <DicomSlicePlane3D slice={dicomSlice2D} />}
              <SliceOutline3D segments={sliceSegments} modelColors={colors} color="#eab308" />
              <Measurement3D measureState={measureState} boundingBox={sliceBBox} />
            </group>

            {dicomLayoutActive && (
              <group ref={setHorizontalPlaneGroup} visible={activeSlice === "horizontal"}>
                <mesh>
                  <circleGeometry args={[planeRadius, 64]} />
                  <meshBasicMaterial color="#5b9bb8" transparent opacity={0.23} side={THREE.DoubleSide} depthWrite={false} />
                </mesh>
                {horizontalDicomSlice2D && <DicomSlicePlane3D slice={horizontalDicomSlice2D} />}
                <SliceOutline3D segments={horizontalSliceSegments} modelColors={colors} color="#38bdf8" />
                <Measurement3D measureState={horizontalMeasureState} boundingBox={horizontalSliceBBox} />
              </group>
            )}
          </group>
        )}

        {!alignmentMode && !trimMode && clippingEnabled && !isMobile && activePlaneGroup && (
          <>
            <TransformControls
              ref={transformRotateRef}
              object={activePlaneGroup}
              mode="rotate"
              space="local"
              size={0.72}
              showX={true}
              showY={true}
              showZ={false}
              onObjectChange={syncActiveSliceFromGizmo}
            />
            <TransformControls
              ref={transformTranslateRef}
              object={activePlaneGroup}
              mode="translate"
              space="local"
              size={1.18}
              showX={false}
              showY={false}
              showZ={true}
              onObjectChange={syncActiveSliceFromGizmo}
            />
            <ThickRotationGizmo controlRef={transformRotateRef} />
            <GizmoManager
              rotateRef={transformRotateRef}
              translateRef={transformTranslateRef}
              trackballRef={trackballRef}
              cameraInteractingRef={cameraInteractingRef}
              interactionBlocked={sliceOverlayInteracting}
            />
          </>
        )}

        <ViewStateSync trackballRef={trackballRef} getViewerState={buildViewerState} />

        {frameKey && (!initialCameraState || alignmentMode) && (
          <AutoCenterAndFrame
            rootRef={rootGroupRef}
            triggerKey={frameKey}
            onFramed={() => setDidInitialFrame(true)}
            margin={1.12}
            isMobile={isMobile}
            desktopScale={1.0}
            mobileScale={1.0}
            centerMode={centerMode}
            setTarget={setCameraTarget}
          />
        )}

        {frameKey && initialCameraState && !alignmentMode && (
          <CustomCameraSetter
            camState={initialCameraState}
            triggerKey={frameKey}
            onFramed={() => setDidInitialFrame(true)}
            setTarget={setCameraTarget}
          />
        )}

        <TouchTrackballControls ref={trackballRef} target={cameraTarget} enabled={!sliceOverlayInteracting && !alignmentBusy && trimDraggingPoint == null && !trimBusy} onInteractionChange={handleCameraInteraction} />
        <RightButtonPan setTarget={setCameraTarget} trackballRef={trackballRef} />
      </Canvas>

      <Lightbox open={lightbox.open} onClose={() => setLightbox({ open: false, src: null, alt: "" })} src={lightbox.src} alt={lightbox.alt} />

      <style jsx global>{`
        @keyframes shade3dSpin360 { 
          100% { transform: rotate(360deg); } 
        }

        .slider { appearance: none; height: 14px; background: transparent; margin: 5px 0; display: inline-block; }
        .slider::-webkit-slider-runnable-track { height: 4px; background: white; border-radius: 2px; }
        .slider::-webkit-slider-thumb { appearance: none; width: 14px; height: 14px; border-radius: 50%; background: white; cursor: pointer; box-shadow: 0 0 2px black; margin-top: -5px; }
        .slider::-moz-range-track { height: 4px; background: white; border-radius: 2px; }
        .slider::-moz-range-thumb { width: 14px; height: 14px; border-radius: 50%; background: white; cursor: pointer; box-shadow: 0 0 2px black; border: none; }
        .color-input { -webkit-appearance: none; appearance: none; }
        .color-input::-webkit-color-swatch-wrapper { padding: 0; }
        .color-input::-webkit-color-swatch, .color-input::-moz-color-swatch { border: none; border-radius: 2px; }
        @media (max-width: 720px) {
          .sidebar { left: 8px !important; width: calc(100vw - 16px) !important; max-width: calc(100vw - 16px) !important; }
        }
      `}</style>
    </div>
  )
}
