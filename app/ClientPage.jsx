"use client"

import React, { Suspense, useEffect, useMemo, useRef, useState } from "react"
import { Canvas, useThree, useFrame } from "@react-three/fiber"
import * as THREE from "three"
import { Html, TransformControls } from "@react-three/drei"
import { TrackballControls } from "three/examples/jsm/controls/TrackballControls"
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader"
import { STLLoader } from "three/examples/jsm/loaders/STLLoader"
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader"

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

/* ---------- AnyModel ---------- */
function AnyModel({
  name, url,
  color, opacity, visible,
  onLoaded, autoSmooth, smoothAngle = DEFAULT_SMOOTH_ANGLE,
  roughness = 0.5, metalness = 0.5,
  useVertexColors = false,
  keepMaterials = false,
  wireframe = false,
  clipPlanes = [], // NOVÉ: Podpora ořezu (řezů)
  measureMode = false,
  onMeasureClick = null,
  onMeasureMove = null
}) {
  const [object3D, setObject3D] = useState(null)
  const ext = useMemo(() => inferExt(name || url), [name, url])

  const makeMat = (opts = {}) =>
    new THREE.MeshStandardMaterial({
      color: new THREE.Color(color || "#ffffff"),
      roughness: typeof roughness === "number" ? roughness : 0.5,
      metalness: typeof metalness === "number" ? metalness : 0.5,
      transparent: opacity < 1,
      opacity,
      side: THREE.DoubleSide,
      depthWrite: opacity === 1,
      clippingPlanes: clipPlanes,
      clipShadows: true,
      ...opts,
    })

  const forEachMesh = (obj, cb) => obj?.traverse?.((child) => { if (child.isMesh) cb(child) })

  const rebuildWireOverlay = (mesh) => {
    if (mesh.userData._edges) {
      mesh.userData._edges.geometry?.dispose?.()
      mesh.userData._edges.material?.dispose?.()
      mesh.remove(mesh.userData._edges)
      mesh.userData._edges = null
    }
    if (!wireframe) return
    const wfGeom = new THREE.WireframeGeometry(mesh.geometry)
    const wfMat = new THREE.LineBasicMaterial({ 
        color: 0x000000, depthTest: true, depthWrite: false, transparent: true, opacity: 0.95, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
        clippingPlanes: clipPlanes
    })
    const lines = new THREE.LineSegments(wfGeom, wfMat)
    lines.renderOrder = (mesh.renderOrder || 0) + 10
    mesh.add(lines)
    mesh.userData._edges = lines
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
                const m = ch.material
                if ("transparent" in m) m.transparent = opacity < 1
                if ("opacity" in m) m.opacity = opacity
                if ("roughness" in m && typeof roughness === "number") m.roughness = roughness
                if ("metalness" in m && typeof metalness === "number") m.metalness = metalness
                m.clippingPlanes = clipPlanes
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
          forEachMesh(obj, (mesh) => rebuildWireOverlay(mesh))
          setObject3D(obj)
          onLoaded && onLoaded(url)
        }
      } catch (e) {
        console.error("Model load error:", e)
      }
    })()
    return () => { cancelled = true }
  }, [url, ext]) // eslint-disable-line

  useEffect(() => {
    if (!object3D) return
    object3D.traverse((child) => {
      if (!child.isMesh) return
      if (!child.userData._baseGeom) child.userData._baseGeom = child.geometry
      const base = child.userData._baseGeom
      let newGeom = base
      if (autoSmooth) newGeom = autoSmoothGeometry(base, smoothAngle)
      else { newGeom = base.clone(); newGeom.computeVertexNormals() }
      if (child.userData._derivedGeom && child.userData._derivedGeom !== base) child.userData._derivedGeom.dispose()
      child.geometry = newGeom; child.userData._derivedGeom = newGeom
      rebuildWireOverlay(child)
    })
  }, [object3D, autoSmooth, smoothAngle, wireframe, clipPlanes]) // eslint-disable-line

  useEffect(() => {
    if (!object3D) return
    object3D.traverse((child) => {
      if (!child.isMesh) return
      if (keepMaterials) {
        const m = child.material
        if (!m) return
        if ("transparent" in m) m.transparent = opacity < 1
        if ("opacity" in m) m.opacity = opacity
        if ("roughness" in m && typeof roughness === "number") m.roughness = roughness
        if ("metalness" in m && typeof metalness === "number") m.metalness = metalness
        if (!useVertexColors && "color" in m && color) m.color = new THREE.Color(color)
        if (useVertexColors && "vertexColors" in m) { m.vertexColors = true; if ("color" in m) m.color = new THREE.Color("#ffffff") }
        m.clippingPlanes = clipPlanes
        m.needsUpdate = true
      } else {
        const hasVC = !!child.geometry.getAttribute?.("color")
        child.material = hasVC && useVertexColors ? makeMat({ vertexColors: true, color: new THREE.Color("#ffffff") }) : makeMat()
      }
      if (child.userData._edges) child.userData._edges.visible = !!wireframe
      else if (wireframe) rebuildWireOverlay(child)
    })
  }, [object3D, color, opacity, roughness, metalness, useVertexColors, keepMaterials, wireframe, clipPlanes]) // eslint-disable-line

  if (!object3D) return null
  return visible ? (
    <primitive 
        object={object3D} 
        onClick={(e) => {
            if (!measureMode) return
            e.stopPropagation()
            onMeasureClick?.(e.point.clone())
        }}
        onPointerMove={(e) => {
            if (!measureMode) return
            e.stopPropagation()
            onMeasureMove?.(e.point.clone())
        }}
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
const TouchTrackballControls = React.forwardRef(({ target = [0, 0, 0], enabled = true, noRotate = false }, ref) => {
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
    // Pokud je noRotate zapnuté (např v mini-mapě), zakážeme levé tlačítko pro rotaci
    c.mouseButtons = { 
        LEFT: noRotate ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE, 
        MIDDLE: THREE.MOUSE.ZOOM, 
        RIGHT: THREE.MOUSE.PAN 
    }
    if (noRotate) c.noRotate = true
    
    controlsRef.current = c
    return () => c.dispose()
  }, [camera, gl, noRotate])
  
  useEffect(() => {
    if (controlsRef.current) {
        controlsRef.current.enabled = enabled
    }
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
function RightButtonPan({ setTarget, enabled = true }) {
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
      if (!enabled) return
      if ((e.button !== 2) && !(e.button === 0 && e.ctrlKey)) return
      e.preventDefault()
      e.stopPropagation()
      isPanning.current = true
      last.current = { x: e.clientX, y: e.clientY }
      try { el.setPointerCapture?.(e.pointerId); pointerIdRef.current = e.pointerId } catch {}
    }

    const onMove = (e) => {
      if (!isPanning.current || !enabled) return
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
  }, [camera, gl, size.width, size.height, setTarget, enabled])

  return null
}

/* ---------- VÝPOČET ROVINY ŘEZU ---------- */
function CutPlaneCalculator({ ndcLine, setCutPlane }) {
    const { camera } = useThree()
    
    useEffect(() => {
        if (!ndcLine || !ndcLine.start || !ndcLine.end) return
        
        const r1 = new THREE.Raycaster()
        r1.setFromCamera(ndcLine.start, camera)
        const r2 = new THREE.Raycaster()
        r2.setFromCamera(ndcLine.end, camera)

        const p1 = r1.ray.origin
        const p2 = r2.ray.origin
        const viewDir = new THREE.Vector3()
        camera.getWorldDirection(viewDir)

        const lineVec = new THREE.Vector3().subVectors(p2, p1)
        if (lineVec.lengthSq() < 0.0001) return // Předejít chybě při kliknutí bez tažení

        // Normála roviny kolmá na pohled kamery a načrtnutou linku
        const normal = new THREE.Vector3().crossVectors(lineVec, viewDir).normalize()
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, p1)
        
        setCutPlane(plane)
    }, [ndcLine, camera, setCutPlane])
    
    return null
}

/* ---------- 2D MĚŘENÍ RENDEROVAČ ---------- */
function MeasurementsRenderer({ points, currentStart, currentMouse }) {
    return (
      <group>
          {points.map((m, i) => (
              <MeasureLine key={i} p1={m.p1} p2={m.p2} dist={m.dist} />
          ))}
          {currentStart && currentMouse && (
              <MeasureLine p1={currentStart} p2={currentMouse} dist={currentStart.distanceTo(currentMouse)} isTemp />
          )}
      </group>
    )
  }
  
  function MeasureLine({ p1, p2, dist, isTemp = false }) {
    const geom = useMemo(() => new THREE.BufferGeometry().setFromPoints([p1, p2]), [p1, p2])
    const mid = useMemo(() => p1.clone().lerp(p2, 0.5), [p1, p2])
    return (
      <group>
          <mesh position={p1}><sphereGeometry args={[0.6, 16, 16]} /><meshBasicMaterial color={isTemp ? "#aaaaaa" : "#ffd700"} depthTest={false} /></mesh>
          <mesh position={p2}><sphereGeometry args={[0.6, 16, 16]} /><meshBasicMaterial color={isTemp ? "#aaaaaa" : "#ffd700"} depthTest={false} /></mesh>
          <line geometry={geom}>
              <lineBasicMaterial color={isTemp ? "#aaaaaa" : "#ffd700"} linewidth={3} depthTest={false} />
          </line>
          <Html position={mid} center zIndexRange={[100, 0]} style={{ pointerEvents: "none", background: "rgba(0,0,0,0.75)", color: isTemp ? "#ddd" : "#ffd700", padding: "3px 6px", borderRadius: 4, fontSize: 13, fontWeight: "bold", whiteSpace: "nowrap", border: "1px solid rgba(255,255,255,0.2)" }}>
              {dist.toFixed(2)} mm
          </Html>
      </group>
    )
  }

/* ---------- MINI-MAPA (Průřezové okno) ---------- */
function CrossSectionWindow({ files, colors, opacities, visibles, roughnesses, metalnesses, vertexColors, cutPlane, onFlipCut, onClose }) {
    const [target, setTarget] = useState([0,0,0])
    const [measureMode, setMeasureMode] = useState(true) // V řezu se defaultně rovnou měří
    const [measurePoints, setMeasurePoints] = useState([])
    const [measureStart, setMeasureStart] = useState(null)
    const [measureCurrent, setMeasureCurrent] = useState(null)

    // Vytvoření "plátku" pro řez v mini-mapě (tloušťka 1mm)
    const slicePlanes = useMemo(() => {
        if (!cutPlane) return []
        const p1 = new THREE.Plane(cutPlane.normal.clone(), cutPlane.constant + 0.5)
        const p2 = new THREE.Plane(cutPlane.normal.clone().negate(), -cutPlane.constant + 0.5)
        return [p1, p2]
    }, [cutPlane])

    const handleMeasureClick = (point) => {
        if (!measureStart) {
            setMeasureStart(point)
        } else {
            setMeasurePoints(prev => [...prev, { p1: measureStart, p2: point, dist: measureStart.distanceTo(point) }])
            setMeasureStart(null)
            setMeasureCurrent(null)
        }
    }

    return (
        <div style={{ position: "absolute", bottom: 20, right: 20, width: "35vw", height: "35vw", maxWidth: 450, maxHeight: 450, minWidth: 280, minHeight: 280, background: "#111", border: "1px solid #444", borderRadius: 12, overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "0 10px 40px rgba(0,0,0,0.5)", zIndex: 10 }}>
            {/* Hlavička okna s nástroji */}
            <div style={{ padding: "8px 12px", background: "#222", borderBottom: "1px solid #333", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span style={{ color: "white", fontSize: 13, fontWeight: "bold" }}>Průřez</span>
                    <button onClick={onFlipCut} style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", color: "#fff", borderRadius: 4, padding: "2px 8px", fontSize: 11, cursor: "pointer" }}>🔄 Otočit</button>
                    {measurePoints.length > 0 && (
                        <button onClick={() => setMeasurePoints([])} style={{ background: "rgba(239,68,68,.15)", border: "1px solid rgba(239,68,68,.5)", color: "#ffbaba", borderRadius: 4, padding: "2px 8px", fontSize: 11, cursor: "pointer" }}>🗑 Smazat míry</button>
                    )}
                </div>
                <button onClick={onClose} style={{ background: "none", border: "none", color: "#fff", cursor: "pointer", fontSize: 16, lineHeight: 1 }}>×</button>
            </div>
            
            {/* Canvas s řezem */}
            <div style={{ flex: 1, position: "relative", background: "#000" }}>
                {measureStart && <div style={{ position: "absolute", top: 10, left: 0, right: 0, textAlign: "center", color: "#ffd700", fontSize: 11, pointerEvents: "none", zIndex: 1 }}>Vyberte druhý bod měření...</div>}
                
                <Canvas orthographic gl={{ localClippingEnabled: true }} style={{ width: "100%", height: "100%" }}>
                    <ambientLight intensity={1.5} />
                    <group>
                        <Suspense fallback={null}>
                            {files.map((f, i) => (
                            <AnyModel
                                key={`slice-${f.url}-${i}`}
                                url={f.url}
                                color={colors[i]} opacity={1} visible={visibles[i]}
                                autoSmooth={true} wireframe={false}
                                roughness={roughnesses[i]} metalness={metalnesses[i]} useVertexColors={vertexColors[i]}
                                clipPlanes={slicePlanes} // Aplikace plátku
                                measureMode={measureMode}
                                onMeasureClick={handleMeasureClick}
                                onMeasureMove={(p) => measureStart && setMeasureCurrent(p)}
                            />
                            ))}
                        </Suspense>
                    </group>
                    
                    {/* Nasměrování kamery kolmo na rovinu */}
                    <CrossSectionCamera setupPlane={cutPlane} setTarget={setTarget} />
                    <TouchTrackballControls target={target} enabled={!measureMode} noRotate={true} />
                    <RightButtonPan setTarget={setTarget} enabled={!measureMode} />
                    
                    <MeasurementsRenderer points={measurePoints} currentStart={measureStart} currentMouse={measureCurrent} />
                </Canvas>
            </div>
        </div>
    )
}

/* ---------- Setup Kamery pro Mini-Mapu ---------- */
function CrossSectionCamera({ setupPlane, setTarget }) {
    const { camera, size } = useThree()
    useEffect(() => {
        if (!setupPlane) return
        const cp = new THREE.Vector3()
        setupPlane.coplanarPoint(cp)
        
        // Kamera kouká přesně proti normále (do řezu)
        camera.position.copy(cp).add(setupPlane.normal.clone().multiplyScalar(100))
        camera.lookAt(cp)
        if (Math.abs(setupPlane.normal.y) > 0.9) camera.up.set(0, 0, -Math.sign(setupPlane.normal.y))
        else camera.up.set(0, 1, 0)
        
        // Zoom nastavíme tak, aby se model vešel (odhad cca 80mm zorné pole)
        camera.zoom = Math.min(size.width, size.height) / 80
        camera.near = 0.1
        camera.far = 200
        camera.updateProjectionMatrix()
        
        setTarget([cp.x, cp.y, cp.z])
    }, [setupPlane, camera, size.width, size.height, setTarget])
    return null
}

/* ---------- AutoCenter & AutoFrame ---------- */
function AutoCenterAndFrame({ rootRef, triggerKey, onFramed, margin = 1.12, isMobile = false, desktopScale = 1.0, mobileScale = 1.0, centerMode = "combined", skipCamera = false, setTarget }) {
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

    if (!skipCamera) {
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
    }

    onFramed && onFramed()
  }, [triggerKey]) // eslint-disable-line
  
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

/* ---------- SYNC STAVU POHLEDU DO FRAMERU ---------- */
function ViewStateSync({ trackballRef }) {
  const { camera, size } = useThree()

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

  return null
}

/* ---------- Hlavní komponenta ---------- */
export default function ClientPage() {
  const [sceneIntensity, setSceneIntensity] = useState(1)
  const [highlightIntensity, setHighlightIntensity] = useState(1)
  const [headlightCfg, setHeadlightCfg] = useState({ enabled: true, intensity: 2.0 })

  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    try {
      const uaMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
      const coarse = typeof window !== "undefined" && window.matchMedia && window.matchMedia("(pointer: coarse)").matches
      const narrow = typeof window !== "undefined" && window.innerWidth < 768
      setIsMobile(uaMobile || coarse || narrow)
    } catch {}
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
  const [fatal, setFatal] = useState(null)

  const [autoSmooth, setAutoSmooth] = useState(true)
  const [smoothAngle] = useState(30)
  const [wireframe, setWireframe] = useState(false)

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
  
  const [loadedUrls, setLoadedUrls] = useState(new Set())
  const handleModelLoaded = (url) => setLoadedUrls((prev) => { const n = new Set(prev); n.add(url); return n; })

  const centerParam = (getParam("center") || "combined").toLowerCase()
  const centerMode = ["per", "combined", "none"].includes(centerParam) ? centerParam : "combined"

  const [initialCameraState, setInitialCameraState] = useState(null)

  // NÁSTROJE
  const [toolMode, setToolMode] = useState("none") // none, cut
  const [ndcCutLine, setNdcCutLine] = useState(null)
  const [cutPlane, setCutPlane] = useState(null)
  
  // Pomocné stavy pro SVG kreslení lajny
  const [cutStartPos, setCutStartPos] = useState(null)
  const [cutCurrentPos, setCutCurrentPos] = useState(null)

  const handlePointerDown = (e) => {
    if (toolMode !== 'cut') return
    e.preventDefault()
    setCutStartPos({ x: e.clientX, y: e.clientY })
    setCutCurrentPos({ x: e.clientX, y: e.clientY })
  }

  const handlePointerMove = (e) => {
    if (toolMode !== 'cut' || !cutStartPos) return
    e.preventDefault()
    setCutCurrentPos({ x: e.clientX, y: e.clientY })
  }

  const handlePointerUp = (e) => {
    if (toolMode !== 'cut' || !cutStartPos) return
    e.preventDefault()
    const bounds = e.currentTarget.getBoundingClientRect()
    const ndc1 = new THREE.Vector2(
        ((cutStartPos.x - bounds.left) / bounds.width) * 2 - 1,
        -((cutStartPos.y - bounds.top) / bounds.height) * 2 + 1
    )
    const ndc2 = new THREE.Vector2(
        ((e.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((e.clientY - bounds.top) / bounds.height) * 2 + 1
    )
    setNdcCutLine({ start: ndc1, end: ndc2 })
    setCutStartPos(null)
    setCutCurrentPos(null)
    setToolMode('none')
  }

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
        }

        if (mId) {
          const m = await fetchJSON(`${SUPABASE_URL}/storage/v1/object/public/${PUBLIC_BUCKET}/manifests/${encodeURIComponent(mId)}.json`)
          const Fs = (m?.files || []).map((x, i) => ({
            url: x.u, name: stripExt(x.n) || `Model ${i + 1}`, rawName: x.n,
            c: x.c, o: typeof x.o === "number" ? clamp01(x.o) : 1,
            v: typeof x.v === "boolean" ? x.v : true,
            r: typeof x.r === "number" ? clamp01(x.r) : 0.5,
            m: typeof x.m === "number" ? clamp01(x.m) : 0.5,
            vc: !!x.vc, km: !!x.km,
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
            vc: !!x.vc, km: !!x.km,
          }))
          applyFiles(Fs, m?.title, m?.logo?.url, null, m?.camera)
          if (typeof m?.lights?.intensity === "number") setSceneIntensity(clamp01(m.lights.intensity))
          if (Array.isArray(m?.photos)) setPhotos(m.photos.map((p) => ({ u: p.u, n: p.n })))
          return
        }

        if (filesParam) {
          let arr = null; try { arr = JSON.parse(filesParam) } catch {}
          if (!arr) { try { arr = JSON.parse(decodeURIComponent(filesParam)) } catch {} }
          if (!Array.isArray(arr)) throw new Error("Neplatný formát parametru ?files=")
          const Fs = arr.filter((x) => x && x.u).map((x, i) => ({
            url: x.u, name: stripExt(x.n) || `Model ${i + 1}`, rawName: x.n,
            c: x.c, o: typeof x.o === "number" ? clamp01(x.o) : 1,
            v: typeof x.v === "boolean" ? x.v : true,
            r: typeof x.r === "number" ? clamp01(x.r) : 0.5,
            m: typeof x.m === "number" ? clamp01(x.m) : 0.5,
            vc: !!x.vc, km: !!x.km,
          }))
          applyFiles(Fs, getParam("title") ?? null, null, null, null)
          const li = parseFloat(getParam("li") || getParam("light") || "")
          if (!Number.isNaN(li)) setSceneIntensity(clamp01(li))
          const headI = parseFloat(getParam("headlightI") || "")
          if (!Number.isNaN(headI)) setHeadlightCfg((o) => ({ ...o, intensity: headI }))
          return
        }

        setFiles([]); setColors([]); setOpacities([]); setVisibles([]); setRoughnesses([]); setMetalnesses([]); setVertexColors([])
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
        const newFiles = p.files.map((x, i) => ({
          url: x.u, name: stripExt(x.n || `Model ${i + 1}`), rawName: x.n || `Model${i + 1}`,
          c: x.c, o: typeof x.o === "number" ? clamp01(x.o) : 1,
          v: typeof x.v === "boolean" ? x.v : true,
          r: typeof x.r === "number" ? clamp01(x.r) : 0.5,
          m: typeof x.m === "number" ? clamp01(x.m) : 0.5,
          vc: !!x.vc, km: !!x.km,
        }))

        const urlsChanged = filesChanged(files, newFiles)

        setFiles(newFiles)
        const palette = ["#f5f5dc", "#8e8e8e", "#ffffff", "#ffd7a8", "#c0c0c0", "#e6f0ff", "#ffeedd"]
        setColors(newFiles.map((f, i) => f.c || palette[i % palette.length]))
        setOpacities(newFiles.map((f) => (typeof f.o === "number" ? clamp01(f.o) : 1)))
        setVisibles(newFiles.map((f) => (typeof f.v === "boolean" ? f.v : true)))
        setRoughnesses(newFiles.map((f) => (typeof f.r === "number" ? clamp01(f.r) : 0.5)))
        setMetalnesses(newFiles.map((f) => (typeof f.m === "number" ? clamp01(f.m) : 0.5)))
        setVertexColors(newFiles.map((f) => !!f.vc))

        if (urlsChanged) { 
            setDidInitialFrame(false); 
            setInitialCameraState(null); 
            setCutPlane(null);
            setNdcCutLine(null);
            setToolMode('none');
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
      {files.map((f, i) => (
        <div key={`${f.url}-${i}`} className="control-row" style={{ display: "grid", gridTemplateColumns: "36px 1fr 32px 36px", alignItems: "center", columnGap: 6, rowGap: 6, margin: "6px 0" }}>
          <div className="row-label" style={{ gridColumn: "1 / -1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f.rawName || f.name}>{stripExt(f.name)}:</div>
          <input type="color" value={colors[i] ?? "#ffffff"} onChange={(e) => setColors((prev) => prev.map((v, idx) => (idx === i ? e.target.value : v)))} aria-label={`${f.name} color`} className="color-input" style={{ width: 36, height: 22, border: "1px solid #fff", borderRadius: 4, padding: 0, cursor: "pointer", background: "transparent" }}/>
          <input className="slider" type="range" min={0} max={1} step={0.01} value={opacities[i] ?? 1} onChange={(e) => { const v = parseFloat(e.target.value); setOpacities((prev) => prev.map((x, idx) => (idx === i ? v : x))) }} style={{ width: "calc(100% - 12px)", minWidth: 110 }} aria-label={`${f.name} opacity`} />
          <button onClick={() => setVertexColors(prev => prev.map((v, idx) => idx === i ? !v : v))} title="Přepnout texturu" style={{ width: 32, height: 22, fontSize: 10, fontWeight: "bold", background: vertexColors[i] ? "rgba(59,130,246,.45)" : "transparent", border: "1px solid rgba(255,255,255,0.4)", borderRadius: 4, color: "#fff", cursor: "pointer", padding: 0 }}>
            TEX
          </button>
          <button className={`toggle icon-btn ${visibles[i] ? "is-on" : "is-off"}`} onClick={() => setVisibles((prev) => prev.map((v, idx) => (idx === i ? !v : v)))} aria-label={visibles[i] ? `Hide ${f.name}` : `Show ${f.name}`} title={visibles[i] ? "Skrýt" : "Zobrazit"} style={{ width: 36, height: 22, display: "inline-flex", alignItems: "center", justifyContent: "center", padding: 0, margin: 0, background: "transparent", border: "1px solid #fff", borderRadius: 4, cursor: "pointer" }}>
            <img src={(visibles[i] ?? true) ? ICONS.eye : ICONS.eyeOff} alt="" width={14} height={14} style={{ display: "block", pointerEvents: "none", userSelect: "none" }}/>
          </button>
        </div>
      ))}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 10 }}>
        <Switch checked={autoSmooth} onChange={setAutoSmooth} label="Auto smooth" />
        <Switch checked={wireframe} onChange={setWireframe} label="Wireframe" />
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

  // NÁSTROJE VPRAVO NAHOŘE
  const toolsMenu = (
      <div style={{ position: "absolute", top: 10, right: 10, zIndex: 10, display: "flex", gap: 8 }}>
          {cutPlane && (
              <button 
                  onClick={() => { setCutPlane(null); setNdcCutLine(null); setToolMode('none') }} 
                  style={{ background: "rgba(239,68,68,.15)", border: "1px solid rgba(239,68,68,.5)", color: "#ffbaba", borderRadius: 8, padding: "8px 12px", fontSize: 13, fontWeight: "bold", cursor: "pointer", boxShadow: "0 4px 12px rgba(0,0,0,0.3)" }}
              >
                  ✖ Zrušit řez
              </button>
          )}
          <button 
              onClick={() => setToolMode(toolMode === 'cut' ? 'none' : 'cut')} 
              style={{ background: toolMode === 'cut' ? "rgba(59,130,246,0.3)" : "rgba(0,0,0,0.5)", border: toolMode === 'cut' ? "1px solid rgba(59,130,246,0.8)" : "1px solid rgba(255,255,255,0.2)", color: "#fff", borderRadius: 8, padding: "8px 12px", fontSize: 13, fontWeight: "bold", cursor: "pointer", backdropFilter: "blur(4px)", boxShadow: "0 4px 12px rgba(0,0,0,0.3)" }}
          >
              {toolMode === 'cut' ? "Kreslete myší přes modely..." : "✂️ Řez"}
          </button>
      </div>
  )

  const allLoaded = files.length > 0 && files.every(f => loadedUrls.has(f.url))
  const frameKey = allLoaded && !didInitialFrame ? `frame-${files.length}` : ""

  return (
    <div 
        className="stage" 
        style={{ position: "relative", width: "100vw", height: "100vh", background: "black" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={handlePointerUp}
    >
      <PreloadIcons />
      {logoEl}
      {sidebar}
      {files.length > 0 && toolsMenu}

      {/* SVG Overlay pro kreslení řezu */}
      {toolMode === 'cut' && cutStartPos && cutCurrentPos && (
          <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", zIndex: 5, pointerEvents: "none" }}>
              <line x1={cutStartPos.x} y1={cutStartPos.y} x2={cutCurrentPos.x} y2={cutCurrentPos.y} stroke="#ef4444" strokeWidth="3" strokeDasharray="6 4" />
          </svg>
      )}

      {/* Zde se renderuje sekundární okno s Průřezem */}
      {cutPlane && (
          <CrossSectionWindow 
              files={files} colors={colors} opacities={opacities} visibles={visibles} roughnesses={roughnesses} metalnesses={metalnesses} vertexColors={vertexColors}
              cutPlane={cutPlane} 
              onFlipCut={() => {
                  const newPlane = cutPlane.clone().negate()
                  setCutPlane(newPlane)
              }}
              onClose={() => { setCutPlane(null); setNdcCutLine(null) }}
          />
      )}

      <Canvas
        orthographic
        camera={{ position: [0, 0, 300], near: 0.01, far: 100000, zoom: 0.9 }}
        gl={{ alpha: true, localClippingEnabled: true }}
        onCreated={({ gl }) => gl.setClearAlpha(0)}
        style={{ position: "absolute", inset: 0, zIndex: 1, background: "transparent", pointerEvents: toolMode === 'cut' ? 'none' : 'auto' }}
      >
        <ambientLight intensity={0.35 * sceneIntensity} />
        <directionalLight position={[0, 5, 5]} intensity={1.2 * sceneIntensity} />
        <directionalLight position={[-10, 0, 0]} intensity={0.9 * sceneIntensity} />
        <directionalLight position={[10, 0, 0]} intensity={1.0 * sceneIntensity} />
        <directionalLight position={[0, -5, -5]} intensity={0.7 * sceneIntensity} />

        <Headlight enabled={headlightCfg.enabled} intensity={headlightCfg.intensity * highlightIntensity} />

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
                autoSmooth={autoSmooth}
                smoothAngle={smoothAngle}
                wireframe={wireframe}
                roughness={roughnesses[i] ?? (typeof f.r === "number" ? f.r : 0.5)}
                metalness={metalnesses[i] ?? (typeof f.m === "number" ? f.m : 0.5)}
                useVertexColors={vertexColors[i]}
                keepMaterials={!!f.km}
                clipPlanes={cutPlane ? [cutPlane] : []}
              />
            ))}
          </Suspense>
        </group>

        <CutPlaneCalculator ndcLine={ndcCutLine} setCutPlane={setCutPlane} />
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

        <TouchTrackballControls 
            ref={trackballRef} 
            target={cameraTarget} 
            enabled={toolMode === 'none'}
        />
        <RightButtonPan 
            setTarget={setCameraTarget} 
            enabled={toolMode === 'none'}
        />

        {!allLoaded && files.length > 0 && <InlineLoader text="Načítám modely…" />}
      </Canvas>

      <Lightbox open={lightbox.open} onClose={() => setLightbox({ open: false, src: null, alt: "" })} src={lightbox.src} alt={lightbox.alt} />

      <style jsx global>{`
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
