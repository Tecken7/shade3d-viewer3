"use client"

import React, { Suspense, useEffect, useMemo, useRef, useState, useCallback } from "react"
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
  clipPlane = null, 
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
      clippingPlanes: clipPlane ? [clipPlane] : [], 
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
    const wfMat = new THREE.LineBasicMaterial({ color: 0x000000, depthTest: true, depthWrite: false, transparent: true, opacity: 0.95, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
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
                m.clippingPlanes = clipPlane ? [clipPlane] : []
                m.side = THREE.DoubleSide
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
  }, [url, ext])

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
  }, [object3D, autoSmooth, smoothAngle, wireframe])

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
        m.clippingPlanes = clipPlane ? [clipPlane] : []
        m.needsUpdate = true
      } else {
        const hasVC = !!child.geometry.getAttribute?.("color")
        const newMat = hasVC && useVertexColors ? makeMat({ vertexColors: true, color: new THREE.Color("#ffffff") }) : makeMat()
        if (child.material && child.material !== newMat) child.material.dispose()
        child.material = newMat
      }
      if (child.userData._edges) child.userData._edges.visible = !!wireframe
      else if (wireframe) rebuildWireOverlay(child)
    })
  }, [object3D, color, opacity, roughness, metalness, useVertexColors, keepMaterials, wireframe, clipPlane])

  if (!object3D) return null
  return visible ? <primitive object={object3D} /> : null
}

/* ---------- Headlight ---------- */
function Headlight({ enabled = true, intensity = 2, color = "#ffffff" }) {
  const { camera } = useThree()
  const ref = useRef(null)
  useFrame(() => { if (ref.current) ref.current.position.copy(camera.position) })
  return <pointLight ref={ref} color={color} intensity={enabled ? intensity : 0} distance={0} decay={0} />
}

/* ---------- Trackball ---------- */
const TouchTrackballControls = React.forwardRef(({ target = [0, 0, 0], enabled = true }, ref) => {
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
    if(controlsRef.current) controlsRef.current.enabled = enabled
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
    if(!enabled) return;
    const el = gl.domElement

    const onContext = (e) => { e.preventDefault() }

    const onDown = (e) => {
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
  }, [camera, gl, size.width, size.height, setTarget, enabled])

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

/* ---------- 2D OVERLAY (MĚŘENÍ, PAN/ZOOM A VEKTOROVÉ ČÁRY) ---------- */
function Overlay2D({ segments, boundingBox }) {
  const [measureState, setMeasureState] = useState({ active: false, p1: null, p2: null, snappedP2: null })
  const svgRef = useRef(null)

  const [winSize, setWinSize] = useState({ w: 450, h: 320 })
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)

  const pathData = useMemo(() => {
      if (!segments || segments.length === 0) return ""
      let d = ""
      for (let i = 0; i < segments.length; i++) {
          const s = segments[i]
          d += `M${s[0].x.toFixed(2)},${s[0].y.toFixed(2)}L${s[1].x.toFixed(2)},${s[1].y.toFixed(2)}`
      }
      return d
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
      const pt = closestPointOnSegment(mousePoint, segments[i][0], segments[i][1])
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
            const scaleX = vW / winSize.w
            const scaleY = vH / winSize.h
            setPan(p => ({ x: p.x - dx * scaleX, y: p.y + dy * scaleY }))
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

  const distVal = measureState.p1 && measureState.snappedP2 
      ? Math.sqrt(distSq(measureState.p1, measureState.snappedP2)).toFixed(2) 
      : null

  return (
    <div 
      style={{
        position: 'absolute', bottom: 20, left: 20, width: winSize.w, height: winSize.h,
        background: '#1a1a1a', border: '1px solid #444', borderRadius: 8,
        zIndex: 100, overflow: 'visible', boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        cursor: measureState.active ? 'crosshair' : 'grab'
      }}
    >
      <div style={{ position: 'absolute', top: 8, left: 16, fontSize: 11, color: '#aaa', pointerEvents: 'none', zIndex: 11 }}>
        Levé tl. = posun, Kolečko = zoom<br/>Dvojklik = měření
      </div>
      {distVal && (
        <div style={{ position: 'absolute', top: 8, right: 16, fontSize: 18, fontWeight: 'bold', color: '#fbbf24', pointerEvents: 'none', zIndex: 11, textShadow: "0 2px 4px rgba(0,0,0,0.8)" }}>
          {distVal} mm
        </div>
      )}

      <div 
        onPointerDown={(e) => startResize(e, 'top-left')}
        style={{ position: 'absolute', top: -5, left: -5, width: 16, height: 16, cursor: 'nwse-resize', zIndex: 12, background: 'rgba(255,255,255,0.15)', borderRadius: '50%' }}
        title="Zvětšit/Zmenšit"
      />
      <div 
        onPointerDown={(e) => startResize(e, 'top-right')}
        style={{ position: 'absolute', top: -5, right: -5, width: 16, height: 16, cursor: 'nesw-resize', zIndex: 12, background: 'rgba(255,255,255,0.15)', borderRadius: '50%' }}
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
        <path d={pathData} stroke="#ffffff" strokeWidth={(boundingBox.width/300) * 1.5 || 0.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />

        {measureState.p1 && (
          <circle cx={measureState.p1.x} cy={measureState.p1.y} r={(boundingBox.width/300) * 4 || 1} fill="#fbbf24" />
        )}
        
        {measureState.p1 && measureState.snappedP2 && (
          <>
            <line 
              x1={measureState.p1.x} y1={measureState.p1.y} 
              x2={measureState.snappedP2.x} y2={measureState.snappedP2.y} 
              stroke="#fbbf24" strokeWidth={(boundingBox.width/300) * 1.5 || 0.5} opacity={0.7}
            />
            <circle cx={measureState.snappedP2.x} cy={measureState.snappedP2.y} r={(boundingBox.width/300) * 4 || 1} fill="#fbbf24" />
          </>
        )}
      </svg>
    </div>
  )
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

  // -- STAVY PRO ŘEZÁNÍ (CLIPPING) --
  const [clippingEnabled, setClippingEnabled] = useState(false)
  const [clipMode, setClipMode] = useState("translate")
  const planeGroupRef = useRef(null) 
  const clipPlaneRef = useRef(new THREE.Plane(new THREE.Vector3(1, 0, 0), 0))
  const [sliceSegments, setSliceSegments] = useState([])
  const [sliceBBox, setSliceBBox] = useState(null)
  const isDraggingGizmo = useRef(false)
  const [orbitEnabled, setOrbitEnabled] = useState(true) 

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

  const centerParam = (getParam("center") || "combined").toLowerCase()
  const centerMode = ["per", "combined", "none"].includes(centerParam) ? centerParam : "combined"

  const updateClippingLogic = useCallback(() => {
    if (!planeGroupRef.current || !rootGroupRef.current) return

    planeGroupRef.current.updateMatrixWorld(true)
    const normal = new THREE.Vector3(0, 0, 1).transformDirection(planeGroupRef.current.matrixWorld).normalize()
    const pos = new THREE.Vector3().setFromMatrixPosition(planeGroupRef.current.matrixWorld)
    clipPlaneRef.current.setFromNormalAndCoplanarPoint(normal, pos)

    const segments2D = []
    const invMat = planeGroupRef.current.matrixWorld.clone().invert()
    const plane = clipPlaneRef.current

    const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3()
    const edgePt = new THREE.Vector3(), locPt = new THREE.Vector3()

    rootGroupRef.current.children.forEach(child => {
       if (!child.isMesh || !child.visible) return
       child.updateMatrixWorld(true)
       const matrix = child.matrixWorld
       const geom = child.geometry
       const posAttr = geom.attributes.position
       const index = geom.index

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
               segments2D.push([ { x: pts[0], y: pts[1] }, { x: pts[2], y: pts[3] } ])
           }
       }

       if (index) {
           for(let i=0; i<index.count; i+=3) processTri(index.getX(i), index.getX(i+1), index.getX(i+2))
       } else {
           for(let i=0; i<posAttr.count; i+=3) processTri(i, i+1, i+2)
       }
    })

    setSliceSegments(segments2D)

    if (segments2D.length > 0) {
       let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
       for(let i=0; i<segments2D.length; i++){
           const s = segments2D[i]
           if(s[0].x < minX) minX = s[0].x; if(s[0].x > maxX) maxX = s[0].x;
           if(s[0].y < minY) minY = s[0].y; if(s[0].y > maxY) maxY = s[0].y;
           if(s[1].x < minX) minX = s[1].x; if(s[1].x > maxX) maxX = s[1].x;
           if(s[1].y < minY) minY = s[1].y; if(s[1].y > maxY) maxY = s[1].y;
       }
       setSliceBBox({ minX, minY, width: maxX - minX, height: maxY - minY })
    } else {
       setSliceBBox(null)
    }
  }, [])

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (!clippingEnabled || !planeGroupRef.current) return
      const step = 0.5 
      if (e.key === "ArrowUp" || e.key === "ArrowRight") {
         planeGroupRef.current.translateZ(step)
         updateClippingLogic()
      } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
         planeGroupRef.current.translateZ(-step)
         updateClippingLogic()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [clippingEnabled, updateClippingLogic])

  useEffect(() => {
     if (clippingEnabled && rootGroupRef.current && planeGroupRef.current) {
        const box = new THREE.Box3().setFromObject(rootGroupRef.current)
        if (!box.isEmpty()) {
           const center = new THREE.Vector3()
           box.getCenter(center)
           planeGroupRef.current.position.copy(center)
           planeGroupRef.current.rotation.set(0, 0, 0)
           planeGroupRef.current.updateMatrixWorld(true)
           updateClippingLogic()
        }
     } else if (!clippingEnabled) {
        setSliceSegments([])
        setSliceBBox(null)
     }
  }, [clippingEnabled, updateClippingLogic]) 

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
          
          <button 
            onClick={() => setVertexColors(prev => prev.map((v, idx) => idx === i ? !v : v))}
            title="Přepnout texturu / vertex colors"
            style={{
                width: 32, height: 22, fontSize: 10, fontWeight: "bold",
                background: vertexColors[i] ? "rgba(59,130,246,.45)" : "transparent",
                border: "1px solid rgba(255,255,255,0.4)", borderRadius: 4, color: "#fff", cursor: "pointer", padding: 0
            }}
          >
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

  const topBarRight = (
    <div style={{ position: "absolute", top: 10, right: 10, zIndex: 10, display: "flex", flexDirection: "column", gap: 10, fontFamily: "sans-serif", color: "white" }}>
      <div style={{ background: "rgba(0,0,0,.25)", backdropFilter: "blur(3px)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 10, padding: 12 }}>
        <Switch checked={clippingEnabled} onChange={setClippingEnabled} label="Nástroj řezu (Průřez)" />
        {clippingEnabled && (
          <div style={{ marginTop: 12, fontSize: 12, width: 220 }}>
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <button 
                onClick={() => setClipMode("translate")}
                style={{ flex: 1, padding: "6px", background: clipMode === "translate" ? "#3b82f6" : "rgba(255,255,255,.1)", border: "none", color: "#fff", borderRadius: 4, cursor: "pointer", fontWeight: "bold" }}
              >Posun</button>
              <button 
                onClick={() => setClipMode("rotate")}
                style={{ flex: 1, padding: "6px", background: clipMode === "rotate" ? "#3b82f6" : "rgba(255,255,255,.1)", border: "none", color: "#fff", borderRadius: 4, cursor: "pointer", fontWeight: "bold" }}
              >Rotace</button>
            </div>
            <p style={{ margin: 0, color: "#ccc", lineHeight: 1.4 }}>Gimbalem ovládejte rovinu. Šipkami posouvejte řez.</p>
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
      {sidebar}
      {topBarRight}

      {clippingEnabled && <Overlay2D segments={sliceSegments} boundingBox={sliceBBox} />}

      <Canvas
        orthographic
        camera={{ position: [0, 0, 300], near: 0.01, far: 100000, zoom: 0.9 }}
        onCreated={({ gl }) => {
            gl.setClearAlpha(0)
            gl.localClippingEnabled = true 
        }}
        style={{ position: "absolute", inset: 0, zIndex: 1, background: "transparent" }}
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
                clipPlane={clippingEnabled ? clipPlaneRef.current : null}
              />
            ))}
          </Suspense>
        </group>

        {clippingEnabled && (
          <TransformControls 
            mode={clipMode}
            onDraggingChanged={(e) => {
               if (trackballRef.current) trackballRef.current.enabled = !e.value // Synchronní vypnutí kamery
               setOrbitEnabled(!e.value)
               isDraggingGizmo.current = e.value
               if (!e.value) updateClippingLogic() 
            }}
            onChange={() => {
              if (isDraggingGizmo.current && planeGroupRef.current) {
                planeGroupRef.current.updateMatrixWorld(true)
                const normal = new THREE.Vector3(0, 0, 1).transformDirection(planeGroupRef.current.matrixWorld).normalize()
                const pos = new THREE.Vector3().setFromMatrixPosition(planeGroupRef.current.matrixWorld)
                clipPlaneRef.current.setFromNormalAndCoplanarPoint(normal, pos)
              }
            }}
          >
            <group ref={planeGroupRef}>
               <mesh>
                 <planeGeometry args={[200, 200]} />
                 <meshBasicMaterial color="#3b82f6" transparent opacity={0.1} side={THREE.DoubleSide} depthWrite={false} />
               </mesh>
            </group>
          </TransformControls>
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

        {/* Přidán prefix klíče (key), aby event listenery kamery naskočily v DOMu až ZA Gimbalem */}
        <TouchTrackballControls key={`trackball-${clippingEnabled}`} ref={trackballRef} target={cameraTarget} enabled={orbitEnabled} />
        <RightButtonPan key={`pan-${clippingEnabled}`} setTarget={setCameraTarget} enabled={orbitEnabled} />

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
