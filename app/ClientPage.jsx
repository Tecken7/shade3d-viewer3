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
    let contextResponse = await rpcFetch("get_case_cloud_scene_context_v2")
    if (!contextResponse.ok) {
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

function projectTrimPointToSurface(context, point, maxDistance = Infinity) {
  if (!context || !point) return null
  const sourcePoint = trimVec(point)
  let best = null

  for (const [childUuid, meta] of context.childMeta || []) {
    const mesh = meta?.mesh
    const geometry = mesh?.geometry
    if (!mesh?.isMesh || !geometry?.getAttribute?.("position")) continue
    try {
      if (!geometry.boundsTree) geometry.computeBoundsTree?.(ALIGNMENT_BVH_OPTIONS)
    } catch {}
    const boundsTree = geometry.boundsTree
    if (!boundsTree?.closestPointToPoint) continue

    const localPoint = sourcePoint.clone().applyMatrix4(meta.sourceToChild)
    const result = { point: new THREE.Vector3(), distance: Infinity, faceIndex: -1 }
    const hit = boundsTree.closestPointToPoint(localPoint, result, 0, Infinity)
    if (!hit || !Number.isInteger(result.faceIndex)) continue

    const triangleIndex = context.triangleLookup.get(`${childUuid}:${result.faceIndex}`)
    if (triangleIndex === undefined) continue
    const sourceClosest = result.point.clone().applyMatrix4(meta.childToSource)
    const distance = sourceClosest.distanceTo(sourcePoint)
    if (Number.isFinite(maxDistance) && distance > maxDistance) continue
    if (!best || distance < best.distance) {
      best = {
        point: trimArr(sourceClosest),
        triangleIndex,
        distance,
      }
    }
  }

  if (best || !Number.isFinite(maxDistance)) return best
  return projectTrimPointToSurface(context, point, Infinity)
}

function buildTrimSurfaceSplineSamples(context, controlNodes, closed = false, samplesPerSpan = 10) {
  if (!context || !Array.isArray(controlNodes) || controlNodes.length < 2) return []
  const controls = controlNodes.map((node) => trimVec(node.point))
  const spanCount = closed ? controls.length : controls.length - 1
  if (spanCount <= 0) return []

  const curve = controls.length === 2 && !closed
    ? new THREE.LineCurve3(controls[0], controls[1])
    : new THREE.CatmullRomCurve3(controls, !!closed, "centripetal", 0.28)
  const perSpan = Math.max(2, Math.min(18, Math.round(samplesPerSpan)))
  const result = []
  const maxProjectionDistance = Math.max(context.diagonal * 0.06, 0.8)

  const append = (hit) => {
    if (!hit?.point || !Number.isInteger(hit.triangleIndex)) return
    const previous = result[result.length - 1]
    if (previous && trimVec(previous.point).distanceToSquared(trimVec(hit.point)) <= 1e-14) return
    result.push(hit)
  }

  for (let span = 0; span < spanCount; span++) {
    for (let step = 0; step < perSpan; step++) {
      if (step === 0) {
        append({
          point: [...controlNodes[span].point],
          triangleIndex: controlNodes[span].triangleIndex,
          distance: 0,
        })
        continue
      }
      const t = (span + step / perSpan) / spanCount
      const sample = curve.getPoint(THREE.MathUtils.clamp(t, 0, 1))
      append(projectTrimPointToSurface(context, sample, maxProjectionDistance))
    }
  }

  if (!closed) {
    const last = controlNodes[controlNodes.length - 1]
    append({ point: [...last.point], triangleIndex: last.triangleIndex, distance: 0 })
  }
  return result
}

function buildTrimSurfaceSplineSegments(context, controlNodes, closed = false, samplesPerSpan = 4) {
  const samples = buildTrimSurfaceSplineSamples(context, controlNodes, closed, samplesPerSpan)
  if (samples.length < 2) return []
  const segments = []
  const count = closed ? samples.length : samples.length - 1
  for (let i = 0; i < count; i++) {
    const a = samples[i]
    const b = samples[(i + 1) % samples.length]
    if (!a || !b || trimVec(a.point).distanceToSquared(trimVec(b.point)) <= 1e-14) continue
    const path = trimTriangleSurfacePath(context, a, b)
    if (!path?.pieces?.length) continue
    path.visualPoints = [a.point, b.point]
    segments.push(path)
  }
  return segments
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
  return best
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

function makeTrimPolylineCurve(points, closed = false) {
  const vectors = []
  for (const point of points || []) {
    const vector = trimVec(point)
    if (!vectors.length || vectors[vectors.length - 1].distanceToSquared(vector) > 1e-14) vectors.push(vector)
  }
  if (closed && vectors.length > 2 && vectors[0].distanceToSquared(vectors[vectors.length - 1]) <= 1e-12) vectors.pop()
  if (vectors.length < 2) return null
  if (vectors.length === 2) return new THREE.LineCurve3(vectors[0], vectors[1])
  return new THREE.CatmullRomCurve3(vectors, !!closed, "centripetal", 0.24)
}

function TrimBoundaryTube({ points, radius, closed = false }) {
  const geometry = useMemo(() => {
    const curve = makeTrimPolylineCurve(points, closed)
    if (!curve) return null
    const tubularSegments = Math.max(28, Math.min(1800, Math.max(points.length * 5, closed ? 120 : 48)))
    return new THREE.TubeGeometry(curve, tubularSegments, radius, 12, !!closed)
  }, [points, radius, closed])
  useEffect(() => () => geometry?.dispose?.(), [geometry])
  if (!geometry) return null
  return (
    <mesh geometry={geometry} renderOrder={1500} raycast={() => null}>
      <meshStandardMaterial
        color="#72acd6"
        roughness={0.32}
        metalness={0.06}
        transparent
        opacity={0.80}
        depthTest
        depthWrite={false}
        polygonOffset
        polygonOffsetFactor={-2.2}
        polygonOffsetUnits={-2.2}
      />
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
  closed,
  onBeginPointDrag,
  onCloseLoop,
}) {
  const groupRef = useRef(null)
  const firstPointClickAtRef = useRef(0)
  useEffect(() => {
    const group = groupRef.current
    if (!group) return
    group.matrixAutoUpdate = false
    if (Array.isArray(modelMatrix) && modelMatrix.length === 16) group.matrix.fromArray(modelMatrix)
    else group.matrix.identity()
    group.matrixWorldNeedsUpdate = true
    group.updateMatrixWorld(true)
  }, [modelMatrix])

  const visualBoundaryPoints = useMemo(() => {
    if (!context || !Array.isArray(controlNodes) || controlNodes.length < 2) return []
    return buildTrimSurfaceSplineSamples(context, controlNodes, !!closed, closed ? 12 : 10).map((hit) => hit.point)
  }, [context, controlNodes, closed])

  if (!context) return null
  const pointRadius = Math.max(0.10, Math.min(1.15, context.diagonal * 0.0067))
  const lineRadius = Math.max(0.035, Math.min(0.32, context.diagonal * 0.00145))
  const previewComponent = keepComponent ?? hoverComponent

  return (
    <group ref={groupRef} matrixAutoUpdate={false}>
      {boundaryPlan && previewComponent != null && (
        <TrimRegionPreview context={context} plan={boundaryPlan} componentId={previewComponent} />
      )}
      {visualBoundaryPoints.length >= 2 && (
        <TrimBoundaryTube points={visualBoundaryPoints} radius={lineRadius} closed={!!closed} />
      )}
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
            onPointerDown={(event) => {
              event.stopPropagation()
              event.nativeEvent?.preventDefault?.()
              event.nativeEvent?.stopImmediatePropagation?.()
              onBeginPointDrag?.(index, event)
            }}
            onClick={isFirst ? (event) => {
              event.stopPropagation()
              if (event.delta != null && event.delta > 5) {
                firstPointClickAtRef.current = 0
                return
              }
              const now = typeof performance !== "undefined" ? performance.now() : Date.now()
              const previous = firstPointClickAtRef.current
              firstPointClickAtRef.current = now
              if (controlNodes.length >= 3 && previous > 0 && now - previous <= 420) {
                firstPointClickAtRef.current = 0
                onCloseLoop?.()
              }
            } : (event) => {
              event.stopPropagation()
            }}
            onDoubleClick={isFirst && controlNodes.length >= 3 ? (event) => {
              event.stopPropagation()
              firstPointClickAtRef.current = 0
              onCloseLoop?.()
            } : undefined}
          >
            <sphereGeometry args={[pointRadius * (active ? 1.16 : 1), 20, 16]} />
            <meshPhysicalMaterial
              color={active ? "#6fa9d1" : isFirst ? "#f3bd32" : "#4f82aa"}
              roughness={isFirst ? 0.24 : 0.20}
              metalness={isFirst ? 0.16 : 0.22}
              clearcoat={0.72}
              clearcoatRoughness={0.16}
              ior={1.46}
              iridescence={isFirst ? 0.22 : active ? 0.92 : 0.78}
              iridescenceIOR={1.34}
              iridescenceThicknessRange={[120, 460]}
              depthTest
              depthWrite={false}
              transparent
              opacity={isFirst ? 0.94 : 0.88}
            />
          </mesh>
        )
      })}
    </group>
  )
}

/* ---------- Oprava sítě: Deterministické biharmonické záplatování ---------- */
function makeRepairedExportName(file, aligned = false, trimmed = false) {
  const raw = file?.rawName || file?.name || "repaired-model.stl"
  const ext = inferExt(raw) || inferExt(file?.url) || "stl"
  const base = stripExt(String(raw).split("/").pop() || "model")
  return `${base}${aligned ? "_aligned" : ""}${trimmed ? "_trimmed" : ""}_repaired.${ext}`
}

function repairAverage(values, length, fallback = null) {
  const valid = (values || []).filter((value) => Array.isArray(value) && value.length >= length)
  if (!valid.length) return fallback
  const out = new Array(length).fill(0)
  valid.forEach((value) => { for (let i = 0; i < length; i++) out[i] += Number(value[i]) || 0 })
  for (let i = 0; i < length; i++) out[i] /= valid.length
  return out
}

function repairLoopBasis(points, normals) {
  const center = new THREE.Vector3()
  points.forEach((point) => center.add(point))
  center.multiplyScalar(1 / Math.max(1, points.length))
  const n = new THREE.Vector3()
  ;(normals || []).forEach((normal) => { if (normal) n.add(normal) })
  if (n.lengthSq() < 1e-10 && points.length >= 3) {
    for (let i = 0; i < points.length; i++) {
      const a = points[i].clone().sub(center)
      const b = points[(i + 1) % points.length].clone().sub(center)
      n.add(a.cross(b))
    }
  }
  if (n.lengthSq() < 1e-10) n.set(0, 0, 1)
  n.normalize()
  let u = points[0]?.clone().sub(center) || new THREE.Vector3(1, 0, 0)
  u.addScaledVector(n, -u.dot(n))
  if (u.lengthSq() < 1e-10) u = Math.abs(n.x) < 0.8 ? new THREE.Vector3(1,0,0).cross(n) : new THREE.Vector3(0,1,0).cross(n)
  u.normalize()
  const v = n.clone().cross(u).normalize()
  let radius = 0
  points.forEach((point) => {
    const q = point.clone().sub(center)
    radius = Math.max(radius, Math.hypot(q.dot(u), q.dot(v)))
  })
  return { center, n, u, v, radius: Math.max(radius, 1e-5) }
}

function repairMedian(values, fallback = 0) {
  const sorted = (values || []).filter((value) => Number.isFinite(value)).slice().sort((a, b) => a - b)
  if (!sorted.length) return fallback
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) * 0.5
}

function repairAverageBoundaryNormal(boundary) {
  const normal = new THREE.Vector3()
  ;(boundary || []).forEach((sample) => {
    if (sample?.normal?.isVector3) normal.add(sample.normal)
  })
  if (normal.lengthSq() < 1e-12) normal.set(0, 0, 1)
  return normal.normalize()
}

function findRepairBoundaryLoops(context) {
  if (!context) return []
  const boundaryEdges = []
  const adjacency = new Map()
  const nodeSamples = new Map()
  const addAdj = (a, b, edge) => {
    const list = adjacency.get(a) || []
    list.push({ node: b, edge })
    adjacency.set(a, list)
  }
  for (let triIndex = 0; triIndex < context.triangles.length; triIndex++) {
    const triangle = context.triangles[triIndex]
    const pa = trimVec(triangle.corners[0].sourcePos), pb = trimVec(triangle.corners[1].sourcePos), pc = trimVec(triangle.corners[2].sourcePos)
    const faceNormal = pb.clone().sub(pa).cross(pc.clone().sub(pa)).normalize()
    triangle.corners.forEach((corner) => {
      const list = nodeSamples.get(corner.nodeId) || []
      list.push({
        normal: corner.sourceNormal ? trimVec(corner.sourceNormal) : faceNormal.clone(),
        color: corner.color,
        uv: corner.uv,
        centroid: triangle.centroid.clone(),
      })
      nodeSamples.set(corner.nodeId, list)
    })
  }
  for (const [edgeKey, list] of context.edgeTriangles) {
    if (!Array.isArray(list) || list.length !== 1) continue
    const parts = edgeKey.split(":").map(Number)
    if (parts.length !== 2) continue
    const edge = { key: edgeKey, a: parts[0], b: parts[1], triangleIndex: list[0] }
    boundaryEdges.push(edge)
    addAdj(edge.a, edge.b, edge)
    addAdj(edge.b, edge.a, edge)
  }
  const visited = new Set()
  const loops = []
  const sampleNode = (nodeId) => {
    const samples = nodeSamples.get(nodeId) || []
    const normalValues = samples.map((sample) => sample.normal ? trimArr(sample.normal) : null)
    const nArr = repairAverage(normalValues, 3, [0,0,1])
    const normal = new THREE.Vector3(...nArr).normalize()
    const healthyHint = new THREE.Vector3()
    let healthyCount = 0
    samples.forEach((sample) => {
      if (!sample.centroid?.isVector3) return
      healthyHint.add(sample.centroid)
      healthyCount++
    })
    if (healthyCount) healthyHint.multiplyScalar(1 / healthyCount)
    else healthyHint.copy(context.nodes[nodeId])
    return {
      position: context.nodes[nodeId].clone(),
      normal,
      healthyHint,
      color: repairAverage(samples.map((sample) => sample.color), 3, null),
      uv: repairAverage(samples.map((sample) => sample.uv), 2, null),
    }
  }

  for (const seed of boundaryEdges) {
    if (visited.has(seed.key)) continue
    const componentEdges = []
    const stack = [seed]
    visited.add(seed.key)
    while (stack.length) {
      const edge = stack.pop()
      componentEdges.push(edge)
      for (const nodeId of [edge.a, edge.b]) {
        for (const next of adjacency.get(nodeId) || []) {
          if (!visited.has(next.edge.key)) {
            visited.add(next.edge.key)
            stack.push(next.edge)
          }
        }
      }
    }
    const componentNodes = new Set()
    componentEdges.forEach((edge) => { componentNodes.add(edge.a); componentNodes.add(edge.b) })
    const componentEdgeKeys = new Set(componentEdges.map((edge) => edge.key))
    const closed = [...componentNodes].every((nodeId) =>
      (adjacency.get(nodeId) || []).filter((entry) => componentEdgeKeys.has(entry.edge.key)).length === 2
    )
    if (!closed || componentNodes.size < 3) continue

    const edgeMap = new Map(componentEdges.map((edge) => [edge.key, edge]))
    const start = componentEdges[0].a
    const ordered = [start]
    const orderedEdges = []
    let previous = null
    let current = start
    let guard = 0
    while (guard++ < componentEdges.length + 4) {
      const candidates = (adjacency.get(current) || []).filter((entry) => edgeMap.has(entry.edge.key) && entry.node !== previous)
      if (!candidates.length) break
      let next = candidates[0]
      if (next.node === start && ordered.length < componentNodes.size && candidates.length > 1) next = candidates[1]
      orderedEdges.push(next.edge)
      previous = current
      current = next.node
      if (current === start) break
      ordered.push(current)
    }
    if (current !== start || ordered.length < 3) continue
    const childUuids = new Set(orderedEdges.map((edge) => context.triangles[edge.triangleIndex]?.childUuid).filter(Boolean))
    if (childUuids.size !== 1) continue

    let boundary = ordered.map((nodeId) => ({ nodeId, ...sampleNode(nodeId) }))
    let points = boundary.map((sample) => sample.position)
    let normals = boundary.map((sample) => sample.normal)
    let basis = repairLoopBasis(points, normals)
    const projected = points.map((point) => {
      const q = point.clone().sub(basis.center)
      return { x: q.dot(basis.u), y: q.dot(basis.v) }
    })
    let signedArea = 0
    for (let i = 0; i < projected.length; i++) {
      const a = projected[i], b = projected[(i+1)%projected.length]
      signedArea += a.x*b.y - b.x*a.y
    }
    if (signedArea < 0) {
      boundary = boundary.slice().reverse()
      points = boundary.map((sample) => sample.position)
      normals = boundary.map((sample) => sample.normal)
      basis = repairLoopBasis(points, normals)
      signedArea = -signedArea
    }
    points = boundary.map((sample) => sample.position)

    let perimeter = 0
    for (let i = 0; i < points.length; i++) perimeter += points[i].distanceTo(points[(i+1)%points.length])

    const area = Math.abs(signedArea) * 0.5
    const equivalentRadius = Math.sqrt(Math.max(0, area) / Math.PI)
    const triangleIndices = [...new Set(orderedEdges.map((edge) => edge.triangleIndex))]
    const materialCounts = new Map()
    triangleIndices.forEach((triIndex) => {
      const materialIndex = context.triangles[triIndex]?.materialIndex || 0
      materialCounts.set(materialIndex, (materialCounts.get(materialIndex) || 0) + 1)
    })
    const materialIndex = [...materialCounts.entries()].sort((a,b) => b[1]-a[1])[0]?.[0] || 0
    loops.push({
      id: `hole-${loops.length + 1}`,
      nodeIds: boundary.map((sample) => sample.nodeId),
      boundary,
      points,
      triangleIndices,
      childUuid: [...childUuids][0],
      materialIndex,
      perimeter,
      area,
      equivalentRadius,
      likely: equivalentRadius <= context.diagonal * 0.20 && perimeter <= context.diagonal * 1.15,
    })
  }
  return loops.sort((a,b) => a.area - b.area)
}

function repairConnectClosedRings(triangles, outer, inner) {
  const outerCount = outer?.length || 0
  const innerCount = inner?.length || 0
  if (outerCount < 3 || innerCount < 3) return
  let outerIndex = 0
  let innerIndex = 0
  while (outerIndex < outerCount || innerIndex < innerCount) {
    const nextOuter = outerIndex < outerCount ? (outerIndex + 1) / outerCount : Infinity
    const nextInner = innerIndex < innerCount ? (innerIndex + 1) / innerCount : Infinity
    const o0 = outer[outerIndex % outerCount]
    const i0 = inner[innerIndex % innerCount]
    if (Math.abs(nextOuter - nextInner) < 1e-10) {
      const o1 = outer[(outerIndex + 1) % outerCount]
      const i1 = inner[(innerIndex + 1) % innerCount]
      triangles.push([o0, o1, i1], [o0, i1, i0])
      outerIndex++
      innerIndex++
    } else if (nextOuter < nextInner) {
      const o1 = outer[(outerIndex + 1) % outerCount]
      triangles.push([o0, o1, i0])
      outerIndex++
    } else {
      const i1 = inner[(innerIndex + 1) % innerCount]
      triangles.push([o0, i1, i0])
      innerIndex++
    }
  }
}

function repairTriangulateDisk(boundary, targetEdgeLen) {
  const boundaryCount = boundary.length
  const center = new THREE.Vector3()
  boundary.forEach((p) => center.add(p.position))
  center.multiplyScalar(1 / boundaryCount)

  const avgRadius = boundary.reduce((acc, p) => acc + p.position.distanceTo(center), 0) / boundaryCount
  const numRings = Math.max(3, Math.ceil(avgRadius / targetEdgeLen))

  const vertices = []
  const fixed = []
  const normals = []
  const colors = []
  const uvs = []

  for (let i = 0; i < boundaryCount; i++) {
    vertices.push(boundary[i].position.clone())
    fixed.push(true)
    normals.push(boundary[i].normal.clone())
    colors.push(boundary[i].color ? [...boundary[i].color] : [0.9, 0.9, 0.9])
    uvs.push(boundary[i].uv ? [...boundary[i].uv] : [0, 0])
  }

  const ringVertexIndices = []
  for (let r = 1; r <= numRings; r++) {
    const fraction = 1 - r / (numRings + 1)
    const ringCount = Math.max(3, Math.round(boundaryCount * fraction))
    const currentRing = []

    for (let j = 0; j < ringCount; j++) {
      const angleIdx = (j / ringCount) * boundaryCount
      const idxA = Math.floor(angleIdx) % boundaryCount
      const idxB = (idxA + 1) % boundaryCount
      const t = angleIdx - Math.floor(angleIdx)

      const bPos = boundary[idxA].position.clone().lerp(boundary[idxB].position, t)
      const bNorm = boundary[idxA].normal.clone().lerp(boundary[idxB].normal, t).normalize()
      
      const pos = bPos.clone().lerp(center, 1 - fraction)
      const tangentPush = bNorm.clone().multiplyScalar(avgRadius * (1 - fraction) * 0.15)
      pos.add(tangentPush)

      const vIdx = vertices.length
      vertices.push(pos)
      fixed.push(false)
      normals.push(bNorm)
      
      const cA = boundary[idxA].color || [0.9, 0.9, 0.9]
      const cB = boundary[idxB].color || [0.9, 0.9, 0.9]
      colors.push([
        cA[0] * (1 - t) + cB[0] * t,
        cA[1] * (1 - t) + cB[1] * t,
        cA[2] * (1 - t) + cB[2] * t
      ])
      uvs.push([0, 0])
      currentRing.push(vIdx)
    }
    ringVertexIndices.push(currentRing)
  }

  const centerIdx = vertices.length
  vertices.push(center.clone())
  fixed.push(false)
  normals.push(boundary[0].normal.clone())
  colors.push([0.9, 0.9, 0.9])
  uvs.push([0, 0])

  const triangles = []
  const outerRing = Array.from({ length: boundaryCount }, (_, i) => i)
  repairConnectClosedRings(triangles, outerRing, ringVertexIndices[0])

  for (let r = 0; r < ringVertexIndices.length - 1; r++) {
    repairConnectClosedRings(triangles, ringVertexIndices[r], ringVertexIndices[r + 1])
  }

  const innerRing = ringVertexIndices[ringVertexIndices.length - 1]
  for (let j = 0; j < innerRing.length; j++) {
    triangles.push([
      innerRing[j],
      innerRing[(j + 1) % innerRing.length],
      centerIdx
    ])
  }

  return { vertices, fixed, triangles, normals, colors, uvs }
}

function repairSolveBiharmonicPositions(meshData, iterations = 140, damping = 0.42) {
  const { vertices, fixed, triangles } = meshData
  const numVertices = vertices.length

  const neighbors = Array.from({ length: numVertices }, () => new Set())
  triangles.forEach(([a, b, c]) => {
    neighbors[a].add(b); neighbors[a].add(c)
    neighbors[b].add(a); neighbors[b].add(c)
    neighbors[c].add(a); neighbors[c].add(b)
  })

  const laplacians = Array.from({ length: numVertices }, () => new THREE.Vector3())
  const computeLaplacians = () => {
    for (let i = 0; i < numVertices; i++) {
      const p = vertices[i]
      const nList = neighbors[i]
      const lap = laplacians[i].set(0, 0, 0)
      if (!nList.size) continue
      nList.forEach((nIdx) => lap.add(vertices[nIdx]))
      lap.multiplyScalar(1 / nList.size).sub(p)
    }
  }

  for (let iter = 0; iter < iterations; iter++) {
    computeLaplacians()
    for (let i = 0; i < numVertices; i++) {
      if (fixed[i]) continue
      const nList = neighbors[i]
      if (!nList.size) continue
      const avgNeighborLap = new THREE.Vector3()
      nList.forEach((nIdx) => avgNeighborLap.add(laplacians[nIdx]))
      avgNeighborLap.multiplyScalar(1 / nList.size)
      const step = laplacians[i].clone().sub(avgNeighborLap).multiplyScalar(damping)
      vertices[i].add(step)
    }
  }
}

function buildRepairPatchData(context, hole) {
  if (!context || !hole?.boundary?.length) return null

  const boundary = hole.boundary
  const count = boundary.length
  
  const edgeLengths = []
  for (let i = 0; i < count; i++) {
    edgeLengths.push(boundary[i].position.distanceTo(boundary[(i + 1) % count].position))
  }
  const medianEdge = Math.max(1e-4, repairMedian(edgeLengths, 0.2))

  const patchMesh = repairTriangulateDisk(boundary, medianEdge * 1.3)
  repairSolveBiharmonicPositions(patchMesh, 140, 0.42)

  const cornerPositions = patchMesh.vertices.map((v) => trimArr(v))
  const cornerNormals = Array.from({ length: patchMesh.vertices.length }, () => new THREE.Vector3())

  patchMesh.triangles.forEach(([ia, ib, ic]) => {
    const a = patchMesh.vertices[ia]
    const b = patchMesh.vertices[ib]
    const c = patchMesh.vertices[ic]
    const fn = b.clone().sub(a).cross(c.clone().sub(a)).normalize()
    cornerNormals[ia].add(fn)
    cornerNormals[ib].add(fn)
    cornerNormals[ic].add(fn)
  })

  const avgBoundaryNormal = repairAverageBoundaryNormal(boundary)
  cornerNormals.forEach((n, idx) => {
    n.normalize()
    if (patchMesh.fixed[idx]) {
      n.copy(patchMesh.normals[idx])
    } else if (n.dot(avgBoundaryNormal) < 0) {
      n.negate()
    }
  })

  const corners = patchMesh.vertices.map((v, i) => ({
    sourcePos: cornerPositions[i],
    sourceNormal: trimArr(cornerNormals[i]),
    color: patchMesh.colors[i],
    uv: patchMesh.uvs[i],
  }))

  const finalTriangles = patchMesh.triangles.map(([ia, ib, ic]) => {
    const pa = patchMesh.vertices[ia]
    const pb = patchMesh.vertices[ib]
    const pc = patchMesh.vertices[ic]
    const rawN = pb.clone().sub(pa).cross(pc.clone().sub(pa))
    if (rawN.dot(avgBoundaryNormal) < 0) {
      return [corners[ia], corners[ic], corners[ib]]
    }
    return [corners[ia], corners[ib], corners[ic]]
  })

  return {
    holeId: hole.id,
    childUuid: hole.childUuid,
    materialIndex: hole.materialIndex || 0,
    triangles: finalTriangles,
    boundaryPoints: boundary.map((b) => trimArr(b.position)),
    reconstruction: {
      method: "biharmonic-disk-fairing",
      triangleCount: finalTriangles.length,
      medianEdge,
    },
  }
}

function createRepairPatchPreviewGeometry(patchData) {
  if (!patchData?.triangles?.length) return null
  const positions = []
  patchData.triangles.forEach((triangle) => triangle.forEach((corner) => positions.push(...corner.sourcePos)))
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3))
  geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere()
  return geometry
}

function applyRepairPatchesToObject(context, patches) {
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
    if (base.groups?.length) base.groups.forEach((group) => geometry.addGroup(group.start, group.count, group.materialIndex || 0))
    else geometry.addGroup(0, baseCount, 0)
    patchMaterialGroups.forEach((group) => geometry.addGroup(group.start, group.count, group.materialIndex))
    geometry.computeBoundingBox(); geometry.computeBoundingSphere()
    try { geometry.computeBoundsTree?.(ALIGNMENT_BVH_OPTIONS) } catch {}
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

function collectRepairBrushTriangles(context, hit, radius) {
  if (!context || !hit || !Number.isInteger(hit.triangleIndex)) return new Set()
  const center = trimVec(hit.point)
  const result = new Set()
  const seen = new Set([hit.triangleIndex])
  const queue = [hit.triangleIndex]
  const maxDistance = radius * 1.35
  while (queue.length && seen.size < 12000) {
    const triIndex = queue.shift()
    const triangle = context.triangles[triIndex]
    if (!triangle) continue
    const near = triangle.centroid.distanceTo(center) <= maxDistance || triangle.corners.some((corner) => trimVec(corner.sourcePos).distanceTo(center) <= radius)
    if (!near) continue
    result.add(triIndex)
    for (const neighbor of context.triangleNeighbors[triIndex] || []) {
      if (!seen.has(neighbor)) { seen.add(neighbor); queue.push(neighbor) }
    }
  }
  return result
}

function createRepairPaintGeometry(context, triangleSet) {
  if (!context || !triangleSet?.size) return null
  const positions = []
  triangleSet.forEach((triIndex) => {
    const triangle = context.triangles[triIndex]
    if (triangle) triangle.corners.forEach((corner) => positions.push(...corner.sourcePos))
  })
  if (!positions.length) return null
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3))
  geometry.computeBoundingBox(); geometry.computeBoundingSphere()
  return geometry
}

function RepairOverlay({ context, modelMatrix, holes, selectedHoleId, previewPatch, paintedTriangles, brushCursor, brushRadius }) {
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
  const previewGeometry = useMemo(() => createRepairPatchPreviewGeometry(previewPatch), [previewPatch])
  const paintGeometry = useMemo(() => createRepairPaintGeometry(context, paintedTriangles), [context, paintedTriangles])
  useEffect(() => () => { previewGeometry?.dispose?.(); paintGeometry?.dispose?.() }, [previewGeometry, paintGeometry])
  if (!context) return null
  const lineRadius = Math.max(0.025, Math.min(0.22, context.diagonal * 0.00105))
  return (
    <group ref={groupRef} matrixAutoUpdate={false}>
      {(holes || []).slice(0, 32).map((hole) => (
        <TrimBoundaryTube key={hole.id} points={hole.points.map(trimArr)} radius={hole.id === selectedHoleId ? lineRadius * 1.35 : lineRadius} closed />
      ))}
      {previewGeometry && (
        <mesh geometry={previewGeometry} renderOrder={1490} raycast={() => null}>
          <meshStandardMaterial color="#4ade80" roughness={0.34} metalness={0.04} transparent opacity={0.28} depthWrite={false} depthTest side={THREE.DoubleSide} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} />
        </mesh>
      )}
      {paintGeometry && (
        <mesh geometry={paintGeometry} renderOrder={1492} raycast={() => null}>
          <meshBasicMaterial color="#60a5fa" transparent opacity={0.22} depthWrite={false} depthTest side={THREE.DoubleSide} polygonOffset polygonOffsetFactor={-2.5} polygonOffsetUnits={-2.5} />
        </mesh>
      )}
      {brushCursor?.point && (
        <mesh position={brushCursor.point} quaternion={brushCursor.quaternion} renderOrder={1505} raycast={() => null}>
          <ringGeometry args={[brushRadius * 0.92, brushRadius, 64]} />
          <meshBasicMaterial color="#93c5fd" transparent opacity={0.72} depthTest depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      )}
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

    vec3 fillColor = mix(vec3(1.0), sourceColor, 0.30);
    vec3 rimColor = mix(vec3(0.93), sourceColor, 0.84);

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

    const localMaxDistance = Number.isFinite(maxWorldDistance)
      ? Math.max(0, maxWorldDistance) / minWorldScale
      : Infinity
    const hit = boundsTree.closestPointToPoint(localPoint, result, 0, localMaxDistance)
    if (!hit) return null

    closestWorld.copy(result.point).applyMatrix4(targetMesh.matrixWorld)
    output.pointWorld.copy(closestWorld)
    output.distance = deltaWorld.subVectors(worldPoint, closestWorld).length()
    output.faceIndex = result.faceIndex

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
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function alignmentPaintYield() {
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

  const sourceRootInverse = new THREE.Matrix4().copy(sourceRoot.matrixWorld).invert()
  const meshToRoot = new THREE.Matrix4().multiplyMatrices(sourceRootInverse, sourceMesh.matrixWorld)
  const parentWorld = sourceRoot.parent?.matrixWorld?.clone?.() || new THREE.Matrix4().identity()
  const parentWorldInverse = new THREE.Matrix4().copy(parentWorld).invert()
  const worldNormalToParent = new THREE.Matrix3().setFromMatrix4(parentWorldInverse)

  const query = makeClosestSurfaceQuery(targetMesh)
  const targetBox = new THREE.Box3().setFromObject(targetRoot)
  const targetSize = targetBox.getSize(new THREE.Vector3())
  const diagonal = Math.max(1, targetSize.length())

  const current = new THREE.Matrix4()
  if (sourceRoot.matrix && sourceRoot.matrix.elements?.length === 16) current.copy(sourceRoot.matrix)
  else current.fromArray(matrixArrayOrIdentity(initialMatrix))
  const initialCurrent = current.clone()

  const spatialSamplePool = buildSpatialSamplePool(sourcePosition, meshToRoot, 7200)
  if (spatialSamplePool.length < 30) throw new Error("Moving model nemá dostatek prostorově rozložených bodů pro Best Fit.")

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
        <meshPhysicalMaterial
          color={color}
          roughness={0.20}
          metalness={0.22}
          clearcoat={0.58}
          clearcoatRoughness={0.18}
          ior={1.46}
          transparent
          opacity={muted ? 0.62 : 0.94}
          depthTest={false}
          depthWrite={false}
        />
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
  const pickGestureRef = useRef(null)
  const suppressPickUntilRef = useRef(0)
  const ext = useMemo(() => inferExt(file?.rawName || file?.name || file?.url), [file])

  useEffect(() => {
    if (!active || typeof window === "undefined") return
    const onPointerDown = (event) => {
      pickGestureRef.current = {
        pointerId: event.pointerId,
        button: event.button,
        x: event.clientX,
        y: event.clientY,
        moved: false,
      }
    }
    const onPointerMove = (event) => {
      const gesture = pickGestureRef.current
      if (!gesture || gesture.pointerId !== event.pointerId || gesture.moved) return
      const dx = event.clientX - gesture.x
      const dy = event.clientY - gesture.y
      if (dx * dx + dy * dy > 16) gesture.moved = true
    }
    const finishPointer = (event) => {
      const gesture = pickGestureRef.current
      if (!gesture || (event?.pointerId != null && gesture.pointerId !== event.pointerId)) return
      if (gesture.button !== 0 || gesture.moved) {
        const now = typeof performance !== "undefined" ? performance.now() : Date.now()
        suppressPickUntilRef.current = now + 180
      }
      pickGestureRef.current = null
    }
    window.addEventListener("pointerdown", onPointerDown, true)
    window.addEventListener("pointermove", onPointerMove, true)
    window.addEventListener("pointerup", finishPointer, true)
    window.addEventListener("pointercancel", finishPointer, true)
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true)
      window.removeEventListener("pointermove", onPointerMove, true)
      window.removeEventListener("pointerup", finishPointer, true)
      window.removeEventListener("pointercancel", finishPointer, true)
      pickGestureRef.current = null
    }
  }, [active])

  useEffect(() => {
    if (!file?.url) { setObject3D(null); return }
    let cancelled = false
    setObject3D(null)
    ;(async () => {
      try {
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
          const now = typeof performance !== "undefined" ? performance.now() : Date.now()
          const nativeButton = event.nativeEvent?.button
          if ((nativeButton != null && nativeButton !== 0) || now < suppressPickUntilRef.current) return
          if (event.delta != null && event.delta > 5) return
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

/* ---------- 3D Auto Rotate ---------- */
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

/* ---------- 3D Měření ---------- */
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
  const dx = measureState.snappedP2.x - measureState.p1.x
  const dy = measureState.snappedP2.y - measureState.p1.y
  const midX = measureState.p1.x + dx / 2
  const midY = measureState.p1.y + dy / 2
  const distVal = Math.sqrt(dx * dx + dy * dy).toFixed(2)

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
  onRepairSurfaceDown,
  onRepairSurfaceMove,
  onRepairSurfaceOut,
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
            const materials = Array.isArray(ch.material) ? child.material : [ch.material]
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
          
          let foundMesh = null
          obj.traverse((child) => { if (child.isMesh && !foundMesh) foundMesh = child })
          if (foundMesh && onMeshReady) onMeshReady(foundMesh, url)
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
          child.userData._originalColors = child.geometry.attributes.color.clone()
        } else {
          child.userData._originalColors = null
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
        child.geometry.setAttribute('color', analysisColors)
        child.geometry.setAttribute('_analysisDist', analysisDistances)
      } else {
        if (child.userData._originalColors) {
          child.geometry.setAttribute('color', child.userData._originalColors)
        } else {
          child.geometry.deleteAttribute('color')
        }
        child.geometry.deleteAttribute('_analysisDist')
      }
      
      if (child.geometry.attributes.color) {
        child.geometry.attributes.color.needsUpdate = true
      }

      const isOriginalTexActive = useVertexColors && child.userData._originalColors
      const wantVertexColors = isHeatmapActive || isOriginalTexActive
      const ghostActive = !!ghost

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
        onTrimSurfaceClick(url, e)
      } : undefined}
      onPointerDown={onRepairSurfaceDown ? (e) => {
        onRepairSurfaceDown(url, e)
      } : undefined}
      onPointerOver={onAlignmentSelect ? (e) => {
        e.stopPropagation()
        setAlignmentHoverVisual(true)
        onAlignmentHover?.(url, true)
      } : undefined}
      onPointerMove={onTrimSurfaceMove || onRepairSurfaceMove || (analysisMode && onHoverDist) ? (e) => {
        if (onTrimSurfaceMove) onTrimSurfaceMove(url, e)
        if (onRepairSurfaceMove) onRepairSurfaceMove(url, e)
        if (analysisMode && onHoverDist) {
          e.stopPropagation()
          const distAttr = e.object.geometry.getAttribute('_analysisDist')
          if (distAttr && e.face) {
            const dA = distAttr.getX(e.face.a)
            const dB = distAttr.getX(e.face.b)
            const dC = distAttr.getX(e.face.c)
            const avgDist = (dA + dB + dC) / 3
            onHoverDist(avgDist, e.clientX, e.clientY)
          } else if (distAttr && e.index !== undefined) {
            onHoverDist(distAttr.getX(e.index), e.clientX, e.clientY)
          }
        }
      } : undefined}
      onPointerOut={(analysisMode && onHoverDist) || onAlignmentSelect || onTrimSurfaceMove || onTrimSurfaceOut || onRepairSurfaceMove || onRepairSurfaceOut ? () => {
        if (onAlignmentSelect) {
          setAlignmentHoverVisual(false)
          onAlignmentHover?.(url, false)
        }
        if (analysisMode && onHoverDist) onHoverDist(null)
        if (onTrimSurfaceOut) onTrimSurfaceOut(url)
        if (onRepairSurfaceOut) onRepairSurfaceOut(url)
      } : undefined}
      onDoubleClick={analysisMode && onPinNote ? (e) => {
        e.stopPropagation()
        const distAttr = e.object.geometry.getAttribute('_analysisDist')
        let dist = null
        if (distAttr && e.face) {
          const dA = distAttr.getX(e.face.a)
          const dB = distAttr.getX(e.face.b)
          const dC = distAttr.getX(e.face.c)
          dist = (dA + dB + dC) / 3
        } else if (distAttr && e.index !== undefined) {
          dist = distAttr.getX(e.index)
        }
        if (dist !== null) {
          onPinNote(dist, e.point)
        }
      } : undefined}
    />
  ) : null
}

/* ---------- Touch ovladač pro řez na mobilu ---------- */
function MobileSlicePlaneTouchController({ radius = 100, enabled = false, onChange, onInteractionChange }) {
  const { camera, size } = useThree()
  const pointersRef = useRef(new Map())
  const gestureRef = useRef({ singleY: null, twoCenter: null })
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
      <circleGeometry args={[radius * 0.72, 48]} />
      <meshBasicMaterial transparent opacity={0} depthTest={false} depthWrite={false} side={THREE.DoubleSide} />
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
      if (trackballRef && trackballRef.current && !trackballRef.current.enabled) return
      if ((e.button !== 2) && !(e.button === 0 && e.ctrlKey)) return
      e.preventDefault()
      e.stopPropagation()
      isPanning.current = true
      onInteractionChange?.(true)
      last.current = { x: e.clientX, y: e.clientY }
      try { 
        el.setPointerCapture?.(e.pointerId)
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

/* ---------- Sync stavu pohledu a snapshot ---------- */
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
      
      const targetWindow = window.top || window.parent
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
        
        const targetWindow = window.top || window.parent
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
  const [pan, setPan] = useStateJsem jenom jazykový model a s tímhle vám nemůžu pomoct.
