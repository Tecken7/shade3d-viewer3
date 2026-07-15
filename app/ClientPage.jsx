"use client"

import React, { Suspense, useEffect, useMemo, useRef, useState, useCallback } from "react"
import { Canvas, useThree, useFrame } from "@react-three/fiber"
import * as THREE from "three"
import { Html, TransformControls } from "@react-three/drei"
import { TrackballControls } from "three/examples/jsm/controls/TrackballControls"
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader"
import { STLLoader } from "three/examples/jsm/loaders/STLLoader"
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader"
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from "three-mesh-bvh"

/* ---------- Instalace BVH do Three.js ---------- */
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree
THREE.Mesh.prototype.raycast = acceleratedRaycast

/* ---------- Konst + konfigurace ---------- */
const LIVE_MSG_TYPES = new Set(["SHADE3D_LIVE", "SHADE3D_LIVE_V6", "SHADE3D_LIVE_V5"])
const SUPABASE_URL = "https://jqnkdjgmenerioodqcpa.supabase.co"
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

/* ---------- AnyModel ---------- */
function AnyModel({
  name, url,
  color, opacity, visible,
  onLoaded, onMeshReady, autoSmooth, smoothAngle = DEFAULT_SMOOTH_ANGLE,
  roughness = 0.5, metalness = 0.5,
  useVertexColors = false,
  keepMaterials = false,
  wireframe = false,
  analysisMode = null,
  renderOrder = 0,
  onHoverDist,
  onPinNote,
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
        } else {
          const loaded = await new OBJLoader().loadAsync(url)
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

          if (child.material && child.material !== newMat) child.material.dispose()
          child.material = newMat
      }
    })
  }, [object3D, color, opacity, roughness, metalness, useVertexColors, keepMaterials, wireframe, analysisMode, renderOrder])

  if (!object3D) return null

  return visible ? (
    <primitive 
      object={object3D} 
      renderOrder={renderOrder}
      onPointerMove={analysisMode && onHoverDist ? (e) => {
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
      } : undefined}
      onPointerOut={analysisMode && onHoverDist ? () => {
        onHoverDist(null);
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

/* ---------- Headlight ---------- */
function Headlight({ enabled = true, intensity = 2, color = "#ffffff" }) {
  const { camera } = useThree()
  const ref = useRef(null)
  useFrame(() => { if (ref.current) ref.current.position.copy(camera.position) })
  return <pointLight ref={ref} color={color} intensity={enabled ? intensity : 0} distance={0} decay={0} />
}

/* ---------- Trackball ---------- */
const TouchTrackballControls = React.forwardRef(({ target = [0, 0, 0] }, ref) => {
  const { camera, gl, size } = useThree()
  const controlsRef = useRef(null)
  
  React.useImperativeHandle(ref, () => controlsRef.current)

  useEffect(() => {
    const c = new TrackballControls(camera, gl.domElement)
    c.rotateSpeed = 5.0
    c.zoomSpeed = 1.2
    c.panSpeed = 1.0
    c.staticMoving = true
    c.dynamicDampingFactor = 0.15
    c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ZOOM, RIGHT: THREE.MOUSE.PAN }
    controlsRef.current = c
    return () => c.dispose()
  }, [camera, gl])

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
function RightButtonPan({ setTarget, trackballRef }) {
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
  }, [camera, gl, size.width, size.height, setTarget, trackballRef])

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
function ViewStateSync({ trackballRef }) {
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
        
        const targetWindow = window.top || window.parent;
        if (targetWindow) {
          targetWindow.postMessage({
            type: "SHADE3D_SNAPSHOT_RESPONSE",
            payload: { 
              camera: camData,
              snapshot: snapshotUrl
            }
          }, "*")
        }
      }
    }
    
    window.addEventListener("message", handleMessage)
    return () => window.removeEventListener("message", handleMessage)
  }, [gl, camera, trackballRef, size.width, size.height])

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
  const TRACK_W = 38, TRACK_H = 22, KNOB = 18
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {label && <span style={{ opacity: .85, fontWeight: "bold" }}>{label}</span>}
      <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} onKeyDown={onKey}
        style={{ position: "relative", width: TRACK_W, height: TRACK_H, borderRadius: 999, border: "1px solid rgba(255,255,255,.22)", background: checked ? "rgba(59,130,246,.45)" : "rgba(255,255,255,.10)", cursor: "pointer", transition: "background .15s ease, border-color .15s ease", outline: "none", padding: 0 }}>
        <span aria-hidden style={{ position: "absolute", top: "50%", transform: "translateY(-50%)", left: checked ? TRACK_W - KNOB - 3 : 3, width: KNOB, height: KNOB, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,.35)", transition: "left .15s ease" }}/>
      </button>
    </div>
  )
}

/* ---------- 2D OVERLAY ---------- */
function Overlay2D({ segments, modelColors, boundingBox, measureState, setMeasureState }) {
  const svgRef = useRef(null)

  const [winSize, setWinSize] = useState({ w: 550, h: 400 })
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)

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

  const handlePointerDown = (e) => {
    if (e.button !== 0 && e.button !== 1 && e.button !== 2) return
    isDragging.current = true
    hasMoved.current = false
    lastPos.current = { x: e.clientX, y: e.clientY }
    e.currentTarget.setPointerCapture(e.pointerId)
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
    isDragging.current = false
    e.currentTarget.releasePointerCapture(e.pointerId)
    if (!hasMoved.current && e.button === 0) {
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
      e.stopPropagation()
      const startW = winSize.w
      const startH = winSize.h
      const startX = e.clientX
      const startY = e.clientY
      const onMove = (me) => {
          let newW = startW
          let newH = startH
          if (dir.includes('left')) newW = startW + (startX - me.clientX)
          if (dir.includes('right')) newW = startW + (me.clientX - startX)
          if (dir.includes('top')) newH = startH + (startY - me.clientY)

          setWinSize({ w: Math.max(250, newW), h: Math.max(200, newH) })
      }
      const onUp = () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
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
      onWheel={(e) => {
         e.stopPropagation()
         const zoomFactor = e.deltaY < 0 ? 1.15 : 0.85
         setZoom(z => Math.max(0.1, Math.min(20, z * zoomFactor)))
      }}
      style={{
        position: 'absolute', bottom: 20, right: 20, width: winSize.w, height: winSize.h,
        background: '#1a1a1a', border: '1px solid #444', borderRadius: 8,
        zIndex: 100, overflow: 'visible', boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        cursor: measureState.active ? 'crosshair' : 'grab'
      }}
    >
      <div style={{ position: 'absolute', top: 8, left: 16, fontSize: 11, color: '#aaa', pointerEvents: 'none', zIndex: 11 }}>
        Levé tl. = posun, Kolečko = zoom<br/>Dvojklik = měření
      </div>

      <div 
        onPointerDown={(e) => startResize(e, 'top-left')}
        style={{ position: 'absolute', top: -5, left: -5, width: 16, height: 16, cursor: 'nwse-resize', zIndex: 12, background: 'rgba(255,255,255,0.15)', borderRadius: '50%' }}
        title="Zvětšit/Zmenšit"
      />

      <svg 
        ref={svgRef} 
        width="100%" height="100%" 
        viewBox={vBox}
        style={{ display: 'block', transform: 'scale(1, -1)', borderRadius: 8, overflow: 'hidden' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
      >
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

  useEffect(() => {
    const control = controlRef.current
    const root = control?.getHelper ? control.getHelper() : control
    if (!root?.traverse) return

    const helpers = []
    const orbitNames = new Set(["X", "Y", "Z", "E", "XYZE"])
    root.traverse((child) => {
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
      child.add(helper)
      helpers.push({ source: child, helper })
    })
    helpersRef.current = helpers

    return () => {
      helpers.forEach(({ source, helper }) => {
        source.remove(helper)
        helper.geometry.dispose()
        helper.material.dispose()
      })
      helpersRef.current = []
    }
  }, [controlRef])

  useFrame(() => {
    helpersRef.current.forEach(({ source, helper }) => {
      if (source.material?.color) helper.material.color.copy(source.material.color)
      helper.material.opacity = source.material?.opacity ?? 1
    })
  })

  return null
}

/* ---------- Manažer kolize gizma a ovládání kamery ---------- */
function GizmoManager({ rotateRef, translateRef, trackballRef }) {
  const isCamDragging = useRef(false)

  useEffect(() => {
    const ctrl = trackballRef.current
    if (!ctrl) return
    const onStart = () => { isCamDragging.current = true }
    const onEnd = () => { isCamDragging.current = false }
    ctrl.addEventListener('start', onStart)
    ctrl.addEventListener('end', onEnd)
    return () => {
      ctrl.removeEventListener('start', onStart)
      ctrl.removeEventListener('end', onEnd)
    }
  }, [trackballRef])

  useFrame(() => {
    const rotate = rotateRef?.current
    const translate = translateRef?.current
    const translateActive = !!translate && (translate.axis !== null || translate.dragging)
    const rotateActive = !!rotate && (rotate.axis !== null || rotate.dragging)

    // Při překryvu má modrá posuvná osa přednost před rotačním kruhem.
    if (rotate) rotate.enabled = !translateActive || !!rotate.dragging
    if (translate) translate.enabled = !rotate?.dragging
    const isHovered = translateActive || rotateActive
    const isDragging = !!translate?.dragging || !!rotate?.dragging

    if (trackballRef.current) {
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
export default function ClientPage() {
  const hideSidebar = getParam("hideSidebar") === "1"; // ÚPRAVA 1: Zjištění, jestli máme schovat levý panel
  const [sceneIntensity, setSceneIntensity] = useState(1)
  const [highlightIntensity, setHighlightIntensity] = useState(1)
  const [headlightCfg, setHeadlightCfg] = useState({ enabled: true, intensity: 2.0 })

  const [isMobile, setIsMobile] = useState(false)

  // ÚPRAVA 2: Zapnutý auto-spin ve výchozím stavu a rychlost nastavena na 0.25
  const [isAutoRotating, setIsAutoRotating] = useState(true)
  const [spinSpeed, setSpinSpeed] = useState(0.25)

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
  const [logoCfg, setLogoCfg] = useState({ url: DEFAULT_LOGO, opacity: 0.9, width: 160, pos: "bc" })

  const [files, setFiles] = useState([])
  const [colors, setColors] = useState([])
  const [opacities, setOpacities] = useState([])
  const [visibles, setVisibles] = useState([])
  const [roughnesses, setRoughnesses] = useState([])
  const [metalnesses, setMetalnesses] = useState([])
  const [vertexColors, setVertexColors] = useState([])
  const [wireframes, setWireframes] = useState([])
  const [fatal, setFatal] = useState(null)

  const [autoSmooth, setAutoSmooth] = useState(true)
  const [smoothAngle] = useState(30)

  // -- STAVY PRO ŘEZÁNÍ A ANIMACI --
  const [clippingEnabled, setClippingEnabled] = useState(false)
  const [planeGroup, setPlaneGroup] = useState(null) 
  const [planeRadius, setPlaneRadius] = useState(100) 
  const clipPlaneRef = useRef(new THREE.Plane(new THREE.Vector3(1, 0, 0), 0))
  
  const transformRotateRef = useRef(null) 
  const transformTranslateRef = useRef(null) 
  
  const isPlaneInitialized = useRef(false)
  const planeMatrixRef = useRef(new THREE.Matrix4())

  const [sliceSegments, setSliceSegments] = useState([])
  const [sliceBBox, setSliceBBox] = useState(null)
  const [measureState, setMeasureState] = useState({ active: false, p1: null, p2: null, snappedP2: null })

  const [heatmapMenuOpen, setHeatmapMenuOpen] = useState(false)
  const [heatmapSelection, setHeatmapSelection] = useState([])
  const [isCalculatingHeatmap, setIsCalculatingHeatmap] = useState(false)
  
  const [hasComputedHeatmap, setHasComputedHeatmap] = useState(false)
  const [showHeatmap, setShowHeatmap] = useState(false)
  const [invertOcclusionSign, setInvertOcclusionSign] = useState(false)

  const [comparisonMenuOpen, setComparisonMenuOpen] = useState(false)
  const [comparisonSelection, setComparisonSelection] = useState([])
  const [isCalculatingComparison, setIsCalculatingComparison] = useState(false)
  const [hasComputedComparison, setHasComputedComparison] = useState(false)
  const [showComparison, setShowComparison] = useState(false)
  const [comparisonTolerance, setComparisonTolerance] = useState(0.25)
  const [comparisonStats, setComparisonStats] = useState(null)
  
  const [pinnedNotes, setPinnedNotes] = useState([])

  const tooltipRef = useRef(null)

  const [photos, setPhotos] = useState([])
  const [lightbox, setLightbox] = useState({ open: false, src: null, alt: "" })

  const [photosOpen, setPhotosOpen] = useState(!isMobile)
  useEffect(() => { setPhotosOpen(!isMobile) }, [isMobile])
  const [slidersOpen, setSlidersOpen] = useState(!isMobile)
  useEffect(() => { setSlidersOpen(!isMobile) }, [isMobile])

  const trackballRef = useRef(null)
  const rootGroupRef = useRef(null)
  const [cameraTarget, setCameraTarget] = useState([0, 0, 0])
  const [didInitialFrame, setDidInitialFrame] = useState(false)
  const [initialCameraState, setInitialCameraState] = useState(null)
  
  const [loadedUrls, setLoadedUrls] = useState(new Set())
  const handleModelLoaded = (url) => setLoadedUrls((prev) => { const n = new Set(prev); n.add(url); return n; })

  const [hasTexMap, setHasTexMap] = useState({})
  const meshesRef = useRef({})
  const analysisFilesKey = files.map((file) => file.url).join("|")

  useEffect(() => {
    setHeatmapSelection([])
    setComparisonSelection([])
    setHasComputedHeatmap(false)
    setHasComputedComparison(false)
    setShowHeatmap(false)
    setShowComparison(false)
    setComparisonStats(null)
    setPinnedNotes([])
    meshesRef.current = {}
  }, [analysisFilesKey])
  
  const handleMeshReady = useCallback((mesh, url) => {
    meshesRef.current[url] = mesh
    const hasC = !!(mesh.geometry.attributes.color || mesh.geometry.attributes.uv);
    setHasTexMap(prev => ({ ...prev, [url]: hasC }))
  }, [])

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
    setPinnedNotes([])
    if (tooltipRef.current) tooltipRef.current.style.opacity = "0"
  }

  const handleApplyHeatmap = () => {
    if (heatmapSelection.length !== 2) return
    setIsCalculatingHeatmap(true);
    setPinnedNotes([]); 

    setTimeout(() => {
      try {
        const meshA = meshesRef.current[heatmapSelection[0]]
        const meshB = meshesRef.current[heatmapSelection[1]]

        if (meshA && meshB) {
          applyOcclusionHeatmap(meshA, meshB, 2.0, invertOcclusionSign)
          
          setHasComputedHeatmap(true)
          setShowHeatmap(true)
          setShowComparison(false)
        }
      } catch(e) {
        console.error("Heatmap chyba:", e)
      } finally {
        setIsCalculatingHeatmap(false);
      }
    }, 150) 
  }

  const handleApplyComparison = () => {
    if (comparisonSelection.length !== 2) return
    setIsCalculatingComparison(true)
    setPinnedNotes([])

    setTimeout(() => {
      try {
        const meshA = meshesRef.current[comparisonSelection[0]]
        const meshB = meshesRef.current[comparisonSelection[1]]
        if (meshA && meshB) {
          const stats = applySurfaceComparison(meshA, meshB, comparisonTolerance)
          setComparisonStats(stats)
          setHasComputedComparison(true)
          setShowComparison(true)
          setShowHeatmap(false)
        }
      } catch (e) {
        console.error("Chyba porovnání povrchů:", e)
      } finally {
        setIsCalculatingComparison(false)
      }
    }, 150)
  }

  const activeAnalysisMode = showHeatmap ? "occlusion" : showComparison ? "comparison" : null

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

  const updateClippingLogic = useCallback(() => {
    if (!planeGroup || !rootGroupRef.current) return

    planeGroup.updateMatrixWorld(true)
    const normal = new THREE.Vector3(0, 0, 1).transformDirection(planeGroup.matrixWorld).normalize()
    const pos = new THREE.Vector3().setFromMatrixPosition(planeGroup.matrixWorld)
    clipPlaneRef.current.setFromNormalAndCoplanarPoint(normal, pos)

    const segments2D = []
    const invMat = planeGroup.matrixWorld.clone().invert()
    const plane = clipPlaneRef.current

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

    setSliceSegments(segments2D)

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
       setSliceBBox({ minX, minY, width: maxX - minX, height: maxY - minY })
    } else {
       setSliceBBox(null)
    }
  }, [planeGroup, visibles])

  const lastClipTime = useRef(0)
  const clipTimeout = useRef(null)

  const requestClipUpdate = useCallback(() => {
    const now = performance.now()
    if (now - lastClipTime.current > 60) {
      updateClippingLogic()
      lastClipTime.current = now
    } else {
      clearTimeout(clipTimeout.current)
      clipTimeout.current = setTimeout(() => {
        updateClippingLogic()
        lastClipTime.current = performance.now()
      }, 60)
    }
  }, [updateClippingLogic])

  const moveSliceBy = useCallback((step) => {
    if (!clippingEnabled || !planeGroup) return
    setMeasureState(prev => (prev.active || prev.p1) ? { active: false, p1: null, p2: null, snappedP2: null } : prev)
    planeGroup.translateZ(step)
    planeGroup.updateMatrixWorld(true)
    planeMatrixRef.current.copy(planeGroup.matrix)
    const normal = new THREE.Vector3(0, 0, 1).transformDirection(planeGroup.matrixWorld).normalize()
    const pos = new THREE.Vector3().setFromMatrixPosition(planeGroup.matrixWorld)
    clipPlaneRef.current.setFromNormalAndCoplanarPoint(normal, pos)
    requestClipUpdate()
  }, [clippingEnabled, planeGroup, requestClipUpdate])

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (!clippingEnabled || !planeGroup) return
      const step = 0.5 
      if (e.key === "ArrowUp" || e.key === "ArrowRight") {
         moveSliceBy(step)
      } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
         moveSliceBy(-step)
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [clippingEnabled, moveSliceBy, planeGroup])

  const handleResetPlane = useCallback(() => {
    if (!rootGroupRef.current || !planeGroup) {
       isPlaneInitialized.current = false;
       return;
    }
    const box = new THREE.Box3().setFromObject(rootGroupRef.current)
    if (!box.isEmpty()) {
       const center = new THREE.Vector3()
       box.getCenter(center)
       
       planeGroup.position.copy(center)
       planeGroup.rotation.set(0, Math.PI / 2, 0)
       planeGroup.scale.set(1, 1, 1)
       planeGroup.updateMatrixWorld(true)
       
       planeMatrixRef.current.copy(planeGroup.matrix)
       isPlaneInitialized.current = true
       
       const normal = new THREE.Vector3(0, 0, 1).transformDirection(planeGroup.matrixWorld).normalize()
       const pos = new THREE.Vector3().setFromMatrixPosition(planeGroup.matrixWorld)
       clipPlaneRef.current.setFromNormalAndCoplanarPoint(normal, pos)
       
       updateClippingLogic() 
       setMeasureState({ active: false, p1: null, p2: null, snappedP2: null })
    }
  }, [planeGroup, updateClippingLogic])

  useEffect(() => {
     if (clippingEnabled && rootGroupRef.current && planeGroup) {
        if (!isPlaneInitialized.current) {
            const box = new THREE.Box3().setFromObject(rootGroupRef.current)
            if (!box.isEmpty()) {
               const center = new THREE.Vector3()
               box.getCenter(center)

               const size = new THREE.Vector3()
               box.getSize(size)
               const maxDim = Math.max(size.x, size.y, size.z)
               setPlaneRadius(maxDim * 0.6)
               
               planeGroup.position.copy(center)
               planeGroup.rotation.set(0, Math.PI / 2, 0)
               planeGroup.updateMatrixWorld(true)
               
               planeMatrixRef.current.copy(planeGroup.matrix)
               isPlaneInitialized.current = true
            }
        } else {
            planeGroup.matrix.copy(planeMatrixRef.current)
            planeGroup.matrix.decompose(planeGroup.position, planeGroup.quaternion, planeGroup.scale)
            planeGroup.updateMatrixWorld(true)
        }

        const normal = new THREE.Vector3(0, 0, 1).transformDirection(planeGroup.matrixWorld).normalize()
        const pos = new THREE.Vector3().setFromMatrixPosition(planeGroup.matrixWorld)
        clipPlaneRef.current.setFromNormalAndCoplanarPoint(normal, pos)
        
        updateClippingLogic()

        setTimeout(() => {
            const desaturateMaterials = (obj) => {
                obj.traverse((child) => {
                    if (child.isMesh || child.isLine) {
                        const mat = child.material;
                        if (!mat || !mat.color) return;
                        
                        const c = mat.color;
                        if (c.r > 0.9 && c.g < 0.1 && c.b < 0.1) {
                            c.set("#cc5555"); 
                        }
                        else if (c.g > 0.9 && c.r < 0.1 && c.b < 0.1) {
                            c.set("#55cc55");
                        }
                        else if (c.b > 0.9 && c.r < 0.1 && c.g < 0.1) {
                            c.set("#5555cc");
                        }
                        mat.needsUpdate = true;
                    }
                });
            };

            if (transformRotateRef.current) desaturateMaterials(planeGroup);
            if (transformTranslateRef.current) desaturateMaterials(planeGroup);
            
        }, 50);

     } else if (!clippingEnabled) {
        setSliceSegments([])
        setSliceBBox(null)
        setMeasureState({ active: false, p1: null, p2: null, snappedP2: null })
     }
  }, [clippingEnabled, planeGroup, updateClippingLogic]) 

  useEffect(() => {
    ;(async () => {
      try {
        const mId = getParam("m")
        const manifestUrlParam = getParam("manifest")
        const filesParam = getParam("files")
        const smoothParam = getParam("smooth")
        if (smoothParam === "0") setAutoSmooth(false)

        const applyFiles = (Fs, titleStr, logoUrl, headlight, camState) => {
          if (!Fs.length) throw new Error("Manifest je prázdný.")
          setFiles(Fs)
          const palette = ["#f5f5dc", "#8e8e8e", "#ffffff", "#ffd7a8", "#c0c0c0", "#e6f0ff", "#ffeedd"]
          setColors(Fs.map((f, i) => f.c || palette[i % palette.length]))
          setOpacities(Fs.map((f) => (typeof f.o === "number" ? clamp01(f.o) : 1)))
          setVisibles(Fs.map((f) => (typeof f.v === "boolean" ? f.v : true)))
          setRoughnesses(Fs.map((f) => (typeof f.r === "number" ? clamp01(f.r) : 0.5)))
          setMetalnesses(Fs.map((f) => (typeof f.m === "number" ? clamp01(f.m) : 0.5)))
          setVertexColors(Fs.map((f) => !!f.vc))
          setWireframes(Fs.map((f) => !!f.wf))
          
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
          setDidInitialFrame(false)
          isPlaneInitialized.current = false 
        }

        if (mId) {
          const m = await fetchJSON(`${SUPABASE_URL}/storage/v1/object/public/${PUBLIC_BUCKET}/manifests/${encodeURIComponent(mId)}.json`)
          const Fs = (m?.files || []).map((x, i) => ({
            url: x.u, name: stripExt(x.n) || `Model ${i + 1}`, rawName: x.n,
            c: x.c, o: typeof x.o === "number" ? clamp01(x.o) : 1,
            v: typeof x.v === "boolean" ? x.v : true,
            r: typeof x.r === "number" ? clamp01(x.r) : 0.5,
            m: typeof x.m === "number" ? clamp01(x.m) : 0.5,
            vc: x.vc !== undefined ? !!x.vc : true, km: !!x.km, wf: !!x.wf
          }))
          applyFiles(Fs, m?.title, m?.logo?.url, m?.lights?.headlight, m?.camera)
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
            vc: x.vc !== undefined ? !!x.vc : true, km: !!x.km, wf: !!x.wf
          }))
          applyFiles(Fs, m?.title, m?.logo?.url, null, m?.camera)
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
            vc: x.vc !== undefined ? !!x.vc : true, km: !!x.km, wf: !!x.wf
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
  }, [])

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
          vc: x.vc !== undefined ? !!x.vc : true, km: !!x.km, wf: !!x.wf
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
        setVertexColors(newFiles.map((f) => !!f.vc))
        setWireframes(newFiles.map((f) => !!f.wf)) 

        // ÚPRAVA 7: Zachování kamery, pokud posíláme keepCamera: true
        if (urlsChanged && !p.keepCamera) { 
            setDidInitialFrame(false); 
            setInitialCameraState(null); 
            isPlaneInitialized.current = false;
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
  }, [files])

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

  const slidersContent = fatal ? (
    <div style={{ color: "#ff8b8b" }}>{fatal}</div>
  ) : (
    <>
      {files.map((f, i) => {
        const isTexAvailable = f.vc || hasTexMap[f.url];

        return (
          <div key={`${f.url}-${i}`} className="control-row" style={{ display: "grid", gridTemplateColumns: "36px 1fr 32px 32px 36px", alignItems: "center", columnGap: 6, rowGap: 6, margin: "6px 0" }}>
            <div className="row-label" style={{ gridColumn: "1 / -1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f.rawName || f.name}>{stripExt(f.name)}:</div>
            
            <input type="color" value={colors[i] ?? "#ffffff"} onChange={(e) => setColors((prev) => prev.map((v, idx) => (idx === i ? e.target.value : v)))} aria-label={`${f.name} color`} className="color-input" style={{ width: 36, height: 22, border: "1px solid #fff", borderRadius: 4, padding: 0, cursor: "pointer", background: "transparent" }}/>
            
            <input className="slider" type="range" min={0} max={1} step={0.01} value={opacities[i] ?? 1} onChange={(e) => { const v = parseFloat(e.target.value); setOpacities((prev) => prev.map((x, idx) => (idx === i ? v : x))) }} style={{ width: "calc(100% - 12px)", minWidth: 110 }} aria-label={`${f.name} opacity`} />
            
            <button 
              onClick={() => { if (isTexAvailable) setVertexColors(prev => prev.map((v, idx) => idx === i ? !v : v)) }}
              disabled={!isTexAvailable}
              title={isTexAvailable ? "Přepnout texturu / barevná data" : "Sken neobsahuje barevná data"}
              style={{
                  width: 32, height: 22, fontSize: 10, fontWeight: "bold",
                  background: vertexColors[i] && isTexAvailable ? "rgba(59,130,246,.45)" : "transparent",
                  border: "1px solid rgba(255,255,255,0.4)", borderRadius: 4, 
                  color: isTexAvailable ? "#fff" : "rgba(255,255,255,0.25)", 
                  cursor: isTexAvailable ? "pointer" : "not-allowed", 
                  padding: 0,
                  textDecoration: isTexAvailable ? "none" : "line-through"
              }}
            >
              TEX
            </button>

            <button 
              onClick={() => setWireframes(prev => prev.map((v, idx) => idx === i ? !v : v))}
              title="Přepnout drátěný model (Wireframe)"
              style={{
                  width: 32, height: 22, fontSize: 10, fontWeight: "bold",
                  background: wireframes[i] ? "rgba(59,130,246,.45)" : "transparent",
                  border: "1px solid rgba(255,255,255,0.4)", borderRadius: 4, 
                  color: "#fff", cursor: "pointer", padding: 0
              }}
            >
              WF
            </button>

            <button className={`toggle icon-btn ${visibles[i] ? "is-on" : "is-off"}`} onClick={() => setVisibles((prev) => prev.map((v, idx) => (idx === i ? !v : v)))} aria-label={visibles[i] ? `Hide ${f.name}` : `Show ${f.name}`} title={visibles[i] ? "Skrýt" : "Zobrazit"} style={{ width: 36, height: 22, display: "inline-flex", alignItems: "center", justifyContent: "center", padding: 0, margin: 0, background: "transparent", border: "1px solid #fff", borderRadius: 4, cursor: "pointer" }}>
              <img src={(visibles[i] ?? true) ? ICONS.eye : ICONS.eyeOff} alt="" width={14} height={14} style={{ display: "block", pointerEvents: "none", userSelect: "none" }}/>
            </button>
          </div>
        );
      })}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 10 }}>
        <Switch checked={autoSmooth} onChange={setAutoSmooth} label="Auto smooth" />
        <button 
          onClick={() => setDidInitialFrame(false)}
          style={{
            background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)",
            borderRadius: 6, color: "white", padding: "4px 10px", fontSize: 11, cursor: "pointer",
            transition: "background 0.2s", fontWeight: "bold"
          }}
          title="Vrátí kameru do výchozí polohy"
        >
          Reset view
        </button>
      </div>
    </>
  )

  const sidebar = (
    <div className="sidebar" style={{ position: "absolute", top: 10, left: 10, zIndex: 2, width: "clamp(260px, 28vw, 420px)", maxWidth: "calc(100vw - 20px)", color: "white", fontFamily: "sans-serif", fontSize: 14, backdropFilter: "blur(3px)", background: "rgba(0,0,0,.25)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 10, padding: 10, boxSizing: "border-box", maxHeight: "calc(100vh - 20px)", overflowY: "auto" }}>
      {title && (<div title={title} style={{ marginBottom: 10, padding: "10px 12px", borderRadius: 10, border: "1px solid rgba(255,255,255,.18)", background: "rgba(255,255,255,.08)", fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>)}
      
      {isMobile ? (
        <>
          <button onClick={() => setSlidersOpen((o) => !o)} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 12px", background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.18)", borderRadius: 10, color: "#fff", cursor: "pointer", fontWeight: 700, fontSize: 13 }}>
            <span>Nastavení modelů</span>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ transform: slidersOpen ? "rotate(90deg)" : "rotate(0deg)", transition: "transform .15s ease" }} aria-hidden><path d="M8 5l8 7-8 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
          {slidersOpen && <div style={{ marginTop: 8, border: "1px solid rgba(255,255,255,.15)", borderRadius: 10, padding: 10, background: "rgba(255,255,255,.06)" }}>{slidersContent}</div>}
        </>
      ) : (
        <div style={{ border: "1px solid rgba(255,255,255,.15)", borderRadius: 10, padding: 10, background: "rgba(255,255,255,.06)" }}>{slidersContent}</div>
      )}

      {photos && photos.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <button onClick={() => setLightbox({ open: true, src: photos[0].u, alt: photos[0].n || "" })} style={{ width: "100%", padding: "8px 10px", background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.18)", borderRadius: 10, color: "#fff", cursor: "pointer", fontWeight: 700, fontSize: 13 }}>Fotky ({photos.length})</button>
        </div>
      )}
    </div>
  )

  const topBarRight = !isMobile && (
    <div style={{ position: "absolute", top: 10, right: 10, zIndex: 10, display: "flex", flexDirection: "column", gap: 10, fontFamily: "sans-serif", color: "white" }}>
      
      <div style={{ width: 270 }}>
        <button 
          onClick={() => { setHeatmapMenuOpen(prev => !prev); setComparisonMenuOpen(false) }}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            background: heatmapMenuOpen ? "rgba(239,68,68,.8)" : "rgba(0,0,0,.25)",
            backdropFilter: "blur(3px)", border: "1px solid rgba(255,255,255,.15)",
            borderRadius: 10, padding: "10px 14px", color: "white", cursor: "pointer",
            fontWeight: "bold", fontSize: 14, transition: "background 0.2s", width: "100%"
          }}
          title="Změřit mezeru a průnik mezi horním a dolním modelem"
        >
          Okluze
        </button>

        <div style={{
          maxHeight: heatmapMenuOpen ? "500px" : "0px",
          opacity: heatmapMenuOpen ? 1 : 0,
          overflow: "hidden",
          transition: "max-height 0.4s ease-in-out, opacity 0.3s ease",
          pointerEvents: heatmapMenuOpen ? "auto" : "none"
        }}>
          <div style={{
            marginTop: 8,
            background: "rgba(0,0,0,.85)", backdropFilter: "blur(8px)",
            border: "1px solid rgba(255,255,255,.2)", borderRadius: 10,
            padding: 12, width: 240, color: "white", boxShadow: "0 10px 30px rgba(0,0,0,0.5)"
          }}>
            <div style={{ marginBottom: 12, fontSize: 13, fontWeight: "bold", color: "#ccc" }}>
              Vyberte analyzovaný model a protilehlý model:
            </div>

            <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, fontSize: 11, color: "#bbb", cursor: "pointer" }}>
              <input type="checkbox" checked={invertOcclusionSign} onChange={(e) => setInvertOcclusionSign(e.target.checked)} />
              Obrátit znaménko (pro model s opačnými normálami)
            </label>
            
            <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 180, overflowY: "auto", marginBottom: 16 }}>
              {files.map((f) => (
                <label key={f.url} style={{ display: "flex", alignItems: "center", gap: 8, cursor: heatmapSelection.length >= 2 && !heatmapSelection.includes(f.url) ? "not-allowed" : "pointer", fontSize: 13, opacity: heatmapSelection.length >= 2 && !heatmapSelection.includes(f.url) ? 0.5 : 1 }}>
                  <input 
                    type="checkbox" 
                    checked={heatmapSelection.includes(f.url)}
                    onChange={() => toggleHeatmapModel(f.url)}
                    disabled={heatmapSelection.length >= 2 && !heatmapSelection.includes(f.url)}
                    style={{ width: 16, height: 16, cursor: "inherit" }}
                  />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {stripExt(f.name)}
                  </span>
                </label>
              ))}
            </div>

            <button 
              onClick={handleApplyHeatmap}
              disabled={heatmapSelection.length !== 2 || isCalculatingHeatmap}
              style={{
                width: "100%", padding: "10px 0", borderRadius: 6,
                background: heatmapSelection.length === 2 && !isCalculatingHeatmap ? "#fbbf24" : "rgba(255,255,255,0.1)",
                color: heatmapSelection.length === 2 && !isCalculatingHeatmap ? "black" : "#888",
                fontWeight: "bold", border: "none", cursor: heatmapSelection.length === 2 && !isCalculatingHeatmap ? "pointer" : "not-allowed",
                transition: "background 0.2s"
              }}
            >
              Vypočítat
            </button>

            {hasComputedHeatmap && (
              <div style={{ marginTop: 12, borderTop: "1px solid rgba(255,255,255,.2)", paddingTop: 12 }}>
                <Switch checked={showHeatmap} onChange={(checked) => { setShowHeatmap(checked); if (checked) setShowComparison(false) }} label="Zobrazit mapu okluze" />
                <div style={{ fontSize: 10, color: "#888", marginTop: 8 }}>
                  Záporná hodnota = průnik. Dvojklikem připnete hodnotu.
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div style={{ width: 270 }}>
        <button
          onClick={() => { setComparisonMenuOpen(prev => !prev); setHeatmapMenuOpen(false) }}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            background: comparisonMenuOpen ? "rgba(37,99,235,.85)" : "rgba(0,0,0,.25)",
            backdropFilter: "blur(3px)", border: "1px solid rgba(255,255,255,.15)",
            borderRadius: 10, padding: "10px 14px", color: "white", cursor: "pointer",
            fontWeight: "bold", fontSize: 14, transition: "background 0.2s", width: "100%"
          }}
          title="Oboustranně porovnat podobnost povrchů dvou modelů"
        >
          Porovnání
        </button>

        <div style={{
          maxHeight: comparisonMenuOpen ? "720px" : "0px",
          opacity: comparisonMenuOpen ? 1 : 0,
          overflow: "hidden",
          transition: "max-height 0.4s ease-in-out, opacity 0.3s ease",
          pointerEvents: comparisonMenuOpen ? "auto" : "none"
        }}>
          <div style={{
            marginTop: 8, background: "rgba(0,0,0,.88)", backdropFilter: "blur(8px)",
            border: "1px solid rgba(255,255,255,.2)", borderRadius: 10,
            padding: 12, width: 270, boxSizing: "border-box", color: "white", boxShadow: "0 10px 30px rgba(0,0,0,0.5)"
          }}>
            <div style={{ marginBottom: 12, fontSize: 13, fontWeight: "bold", color: "#ccc" }}>
              Vyberte 2 modely pro porovnání povrchů:
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 160, overflowY: "auto", marginBottom: 14 }}>
              {files.map((f) => (
                <label key={f.url} style={{ display: "flex", alignItems: "center", gap: 8, cursor: comparisonSelection.length >= 2 && !comparisonSelection.includes(f.url) ? "not-allowed" : "pointer", fontSize: 13, opacity: comparisonSelection.length >= 2 && !comparisonSelection.includes(f.url) ? 0.5 : 1 }}>
                  <input
                    type="checkbox"
                    checked={comparisonSelection.includes(f.url)}
                    onChange={() => toggleComparisonModel(f.url)}
                    disabled={comparisonSelection.length >= 2 && !comparisonSelection.includes(f.url)}
                    style={{ width: 16, height: 16, cursor: "inherit" }}
                  />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{stripExt(f.name)}</span>
                </label>
              ))}
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 11, color: "#bbb" }}>
              <span>Tolerance shody</span><b>{comparisonTolerance.toFixed(2)} mm</b>
            </div>
            <input type="range" min={0.05} max={1} step={0.05} value={comparisonTolerance} onChange={(e) => { setComparisonTolerance(Number(e.target.value)); setHasComputedComparison(false); setShowComparison(false) }} style={{ width: "100%", marginBottom: 12 }} />

            <button
              onClick={handleApplyComparison}
              disabled={comparisonSelection.length !== 2 || isCalculatingComparison}
              style={{
                width: "100%", padding: "10px 0", borderRadius: 6,
                background: comparisonSelection.length === 2 && !isCalculatingComparison ? "#60a5fa" : "rgba(255,255,255,0.1)",
                color: comparisonSelection.length === 2 && !isCalculatingComparison ? "#07111f" : "#888",
                fontWeight: "bold", border: "none", cursor: comparisonSelection.length === 2 && !isCalculatingComparison ? "pointer" : "not-allowed"
              }}
            >Vypočítat podobnost</button>

            {hasComputedComparison && comparisonStats && (
              <div style={{ marginTop: 12, borderTop: "1px solid rgba(255,255,255,.2)", paddingTop: 12 }}>
                <Switch checked={showComparison} onChange={(checked) => { setShowComparison(checked); if (checked) setShowHeatmap(false) }} label="Zobrazit mapu odchylek" />
                <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "5px 12px", marginTop: 12, fontSize: 11 }}>
                  <span>Průměrná odchylka</span><b>{comparisonStats.mean.toFixed(3)} mm</b>
                  <span>RMS</span><b>{comparisonStats.rms.toFixed(3)} mm</b>
                  <span>95. percentil</span><b>{comparisonStats.percentile95.toFixed(3)} mm</b>
                  <span>Maximum</span><b>{comparisonStats.max.toFixed(3)} mm</b>
                  <span>V toleranci</span><b>{comparisonStats.withinTolerance.toFixed(1)} %</b>
                </div>
                <div style={{ fontSize: 10, color: "#888", marginTop: 9, lineHeight: 1.35 }}>
                  Oboustranná povrchová odchylka v aktuální poloze modelů.
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div>
        <button 
          onClick={() => setIsAutoRotating(p => !p)}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            background: isAutoRotating ? "rgba(59,130,246,.8)" : "rgba(0,0,0,.25)",
            backdropFilter: "blur(3px)", border: "1px solid rgba(255,255,255,.15)",
            borderRadius: 10, padding: "10px 14px", color: "white", cursor: "pointer",
            fontWeight: "bold", fontSize: 14, transition: "background 0.2s", width: "100%"
          }}
        >
          <svg 
            width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" 
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" 
            style={{ animation: isAutoRotating ? "spin 4s linear infinite" : "none" }}
          >
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
          </svg>
          360° Spin
        </button>

        <div style={{
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

      <div style={{ background: "rgba(0,0,0,.25)", backdropFilter: "blur(3px)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 10, padding: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", position: "relative", minHeight: 24 }}>
          <Switch checked={clippingEnabled} onChange={setClippingEnabled} label="Průřez" />
          {clippingEnabled && (
            <button 
              onClick={handleResetPlane}
              style={{
                position: "absolute", right: 0,
                background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)",
                borderRadius: 6, color: "white", padding: "4px 8px", fontSize: 11, cursor: "pointer",
                transition: "background 0.2s"
              }}
              title="Vrátí průřez do výchozí pozice uprostřed modelu"
            >
              Reset
            </button>
          )}
        </div>
        {clippingEnabled && (
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

  return (
    <div className="stage" style={{ position: "relative", width: "100vw", height: "100vh", background: "black" }}>
      <PreloadIcons />
      {logoEl}
      {!hideSidebar && sidebar}
      {topBarRight}

      {/* OVERLAY BĚHEM NAČÍTÁNÍ MODELŮ */}
      {!allLoaded && files.length > 0 && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.85)", 
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", 
          color: "white", fontFamily: "sans-serif"
        }}>
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: "spin 1s linear infinite", marginBottom: 16 }}>
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
          <div style={{ fontSize: 18, fontWeight: "bold" }}>Načítám modely...</div>
        </div>
      )}

      {/* OVERLAY BĚHEM VÝPOČTU ANALÝZY */}
      {(isCalculatingHeatmap || isCalculatingComparison) && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.7)", 
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", 
          color: "white", fontFamily: "sans-serif"
        }}>
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: "spin 1s linear infinite", marginBottom: 16 }}>
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
          <div style={{ fontSize: 18, fontWeight: "bold" }}>
            {isCalculatingComparison ? "Porovnávám povrchy..." : "Vypočítávám mapu okluze..."}
          </div>
        </div>
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

      {showHeatmap && hasComputedHeatmap && (
        <div style={{
          position: "absolute", top: 20, left: "50%", transform: "translateX(-50%)",
          zIndex: 100, background: "rgba(0,0,0,0.65)", padding: "12px 24px",
          borderRadius: 12, border: "1px solid rgba(255,255,255,0.2)",
          color: "white", fontFamily: "sans-serif", fontSize: 12,
          display: "flex", flexDirection: "column", alignItems: "center", gap: 8,
          backdropFilter: "blur(6px)", boxShadow: "0 4px 12px rgba(0,0,0,0.5)"
        }}>
          <span style={{ fontWeight: "bold", fontSize: 14 }}>Okluze – průnik a mezera (mm)</span>
          <div style={{
            width: 300, height: 12, borderRadius: 6,
            background: "linear-gradient(to right, #7e22ce 0%, #ef4444 25%, #facc15 37.5%, #22c55e 62.5%, #ffffff 100%)",
            boxShadow: "inset 0 1px 3px rgba(0,0,0,0.4)"
          }} />
          <div style={{ display: "flex", justifyContent: "space-between", width: 300, fontSize: 11, fontWeight: "bold", opacity: 0.8 }}>
            <span>-1.0−</span><span>-0.5</span><span>0</span><span>1.0</span><span>2.0+</span>
          </div>
        </div>
      )}

      {showComparison && hasComputedComparison && (
        <div style={{
          position: "absolute", top: 20, left: "50%", transform: "translateX(-50%)",
          zIndex: 100, background: "rgba(0,0,0,0.65)", padding: "12px 24px",
          borderRadius: 12, border: "1px solid rgba(255,255,255,0.2)",
          color: "white", fontFamily: "sans-serif", fontSize: 12,
          display: "flex", flexDirection: "column", alignItems: "center", gap: 8,
          backdropFilter: "blur(6px)", boxShadow: "0 4px 12px rgba(0,0,0,0.5)"
        }}>
          <span style={{ fontWeight: "bold", fontSize: 14 }}>Porovnání povrchů – absolutní odchylka (mm)</span>
          <div style={{ width: 300, height: 12, borderRadius: 6, background: "linear-gradient(to right, #2563eb 0%, #22c55e 25%, #facc15 50%, #ef4444 75%, #a21caf 100%)" }} />
          <div style={{ display: "flex", justifyContent: "space-between", width: 300, fontSize: 11, fontWeight: "bold", opacity: 0.8 }}>
            <span>0</span><span>{comparisonTolerance.toFixed(2)}</span><span>{(comparisonTolerance * 2).toFixed(2)}</span><span>{(comparisonTolerance * 4).toFixed(2)}</span><span>více</span>
          </div>
        </div>
      )}

      {clippingEnabled && !isMobile && <Overlay2D segments={sliceSegments} modelColors={colors} boundingBox={sliceBBox} measureState={measureState} setMeasureState={setMeasureState} />}

      <Canvas
        orthographic
        camera={{ position: [0, 0, 300], near: 0.01, far: 100000, zoom: 0.9 }}
        gl={{ preserveDrawingBuffer: true }}
        onCreated={({ gl }) => {
            gl.setClearAlpha(0)
            gl.localClippingEnabled = false
        }}
        style={{ position: "absolute", inset: 0, zIndex: 1, background: "transparent" }}
      >
        <ambientLight intensity={0.35 * sceneIntensity} />
        <directionalLight position={[0, 5, 5]} intensity={1.2 * sceneIntensity} />
        <directionalLight position={[-10, 0, 0]} intensity={0.9 * sceneIntensity} />
        <directionalLight position={[10, 0, 0]} intensity={1.0 * sceneIntensity} />
        <directionalLight position={[0, -5, -5]} intensity={0.7 * sceneIntensity} />

        <Headlight enabled={headlightCfg.enabled} intensity={headlightCfg.intensity * highlightIntensity} />

        <AutoRotateScene enabled={isAutoRotating} target={cameraTarget} speedFactor={spinSpeed} />

        <group ref={rootGroupRef}>
          <Suspense fallback={null}>
            {files.map((f, i) => (
              <AnyModel
                key={`${f.url}-${i}`}
                name={f.rawName || f.name}
                url={f.url}
                color={colors[i] ?? "#ffffff"}
                opacity={opacities[i] ?? 1}
                visible={visibles[i] ?? true}
                onLoaded={handleModelLoaded}
                onMeshReady={handleMeshReady}
                autoSmooth={autoSmooth}
                smoothAngle={smoothAngle}
                wireframe={wireframes[i] || false}
                roughness={roughnesses[i] ?? (typeof f.r === "number" ? f.r : 0.5)}
                metalness={metalnesses[i] ?? (typeof f.m === "number" ? f.m : 0.5)}
                useVertexColors={vertexColors[i]}
                keepMaterials={!!f.km}
                renderOrder={i}
                analysisMode={
                  showHeatmap && heatmapSelection[0] === f.url
                    ? "occlusion"
                    : showComparison && comparisonSelection.includes(f.url)
                      ? "comparison"
                      : null
                }
                onHoverDist={handleHeatmapHover} 
                onPinNote={handlePinNote}
              />
            ))}
          </Suspense>
          
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

        {clippingEnabled && !isMobile && (
          <group ref={setPlaneGroup}>
            <mesh>
              <circleGeometry args={[planeRadius, 64]} />
              <meshBasicMaterial color="#b88f8f" transparent opacity={0.25} side={THREE.DoubleSide} depthWrite={false} />
            </mesh>
            <SliceOutline3D segments={sliceSegments} modelColors={colors} color="#eab308" />
            <Measurement3D measureState={measureState} boundingBox={sliceBBox} />
          </group>
        )}

        {clippingEnabled && !isMobile && planeGroup && (
          <TransformControls 
            ref={transformRotateRef}
            object={planeGroup}
            mode="rotate"
            space="local"
            size={0.72}
            showX={true}
            showY={true}
            showZ={false}
            onChange={() => {
              if (planeGroup) {
                if (transformRotateRef.current?.dragging) {
                    setMeasureState(prev => (prev.active || prev.p1) ? { active: false, p1: null, p2: null, snappedP2: null } : prev);
                }
                planeGroup.updateMatrixWorld(true)
                planeMatrixRef.current.copy(planeGroup.matrix)
                const normal = new THREE.Vector3(0, 0, 1).transformDirection(planeGroup.matrixWorld).normalize()
                const pos = new THREE.Vector3().setFromMatrixPosition(planeGroup.matrixWorld)
                clipPlaneRef.current.setFromNormalAndCoplanarPoint(normal, pos)
                requestClipUpdate() 
              }
            }}
          />
        )}

        {clippingEnabled && !isMobile && planeGroup && (
          <TransformControls 
            ref={transformTranslateRef}
            object={planeGroup}
            mode="translate"
            space="local"
            size={1.18}
            showX={false}
            showY={false}
            showZ={true}
            onChange={() => {
              if (planeGroup) {
                if (transformTranslateRef.current?.dragging) {
                    setMeasureState(prev => (prev.active || prev.p1) ? { active: false, p1: null, p2: null, snappedP2: null } : prev);
                }
                planeGroup.updateMatrixWorld(true)
                planeMatrixRef.current.copy(planeGroup.matrix)
                const normal = new THREE.Vector3(0, 0, 1).transformDirection(planeGroup.matrixWorld).normalize()
                const pos = new THREE.Vector3().setFromMatrixPosition(planeGroup.matrixWorld)
                clipPlaneRef.current.setFromNormalAndCoplanarPoint(normal, pos)
                requestClipUpdate() 
              }
            }}
          />
        )}

        {clippingEnabled && !isMobile && (
          <>
            <ThickRotationGizmo controlRef={transformRotateRef} />
            <GizmoManager rotateRef={transformRotateRef} translateRef={transformTranslateRef} trackballRef={trackballRef} />
          </>
        )}

        <ViewStateSync trackballRef={trackballRef} />

        {frameKey && !initialCameraState && (
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

        {frameKey && initialCameraState && (
          <CustomCameraSetter
            camState={initialCameraState}
            triggerKey={frameKey}
            onFramed={() => setDidInitialFrame(true)}
            setTarget={setCameraTarget}
          />
        )}

        <TouchTrackballControls key="trackball" ref={trackballRef} target={cameraTarget} />
        <RightButtonPan key="pan" setTarget={setCameraTarget} trackballRef={trackballRef} />
      </Canvas>

      <Lightbox open={lightbox.open} onClose={() => setLightbox({ open: false, src: null, alt: "" })} src={lightbox.src} alt={lightbox.alt} />

      <style jsx global>{`
        @keyframes spin { 
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
