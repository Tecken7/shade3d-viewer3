"use client"

import { Canvas, useThree, useFrame } from "@react-three/fiber"
import * as THREE from "three"
import { Suspense, useEffect, useMemo, useRef, useState } from "react"
import { Html } from "@react-three/drei"
import { TrackballControls } from "three/examples/jsm/controls/TrackballControls"
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader"
import { STLLoader } from "three/examples/jsm/loaders/STLLoader"
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader"

/* ---------- Config ---------- */
const SUPABASE_URL = "https://jqnkdjgmenerioodqcpa.supabase.co"
const PUBLIC_BUCKET = "shade3d-viewer2"
const LIVE_MSG_TYPES = new Set(["SHADE3D_LIVE", "SHADE3D_LIVE_V6", "SHADE3D_LIVE_V5"])
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
    Object.values(ICONS).forEach((src) => { const img = new Image(); img.decoding = "async"; img.src = src })
  }, [])
  return null
}

/* ---------- Loader Overlay ---------- */
function InlineLoader({ text }) {
  return (
    <Html center>
      <div style={{ background: "rgba(0,0,0,0.7)", padding: "16px 28px", borderRadius: 10, color: "white", fontFamily: "sans-serif", fontSize: 16 }}>
        ⏳ {text || "Načítám…"}
      </div>
    </Html>
  )
}

/* ---------- AutoSmooth (bez UI) ---------- */
const DEFAULT_SMOOTH_ANGLE = 30
function autoSmoothGeometry(geometry, angleDeg = DEFAULT_SMOOTH_ANGLE) {
  const angleRad = (Math.max(0, Math.min(89.9, angleDeg)) * Math.PI) / 180
  const g = geometry.index ? geometry.toNonIndexed() : geometry.clone()
  const pos = g.getAttribute("position")
  const vCount = pos.count
  const triCount = vCount / 3
  const faceNormals = new Array(triCount)
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  const cb = new THREE.Vector3(), ab = new THREE.Vector3()
  for (let f = 0; f < triCount; f++) {
    const i0 = f * 3, i1 = i0 + 1, i2 = i0 + 2
    a.fromBufferAttribute(pos, i0)
    b.fromBufferAttribute(pos, i1)
    c.fromBufferAttribute(pos, i2)
    cb.subVectors(c, b); ab.subVectors(a, b); cb.cross(ab).normalize()
    faceNormals[f] = cb.clone()
  }
  const groups = new Map()
  const keyOf = (ix) => `${pos.getX(ix).toFixed(5)},${pos.getY(ix).toFixed(5)},${pos.getZ(ix).toFixed(5)}`
  for (let i = 0; i < vCount; i++) {
    const k = keyOf(i); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i)
  }
  const normals = new Float32Array(vCount * 3)
  const tmp = new THREE.Vector3()
  const cosThresh = Math.cos(angleRad)
  groups.forEach((cornerIndices) => {
    const localFaceNs = cornerIndices.map((ci) => faceNormals[Math.floor(ci / 3)])
    for (let idx = 0; idx < cornerIndices.length; idx++) {
      const ci = cornerIndices[idx]; const nRef = localFaceNs[idx]
      let nx = 0, ny = 0, nz = 0
      for (let j = 0; j < localFaceNs.length; j++) {
        const nj = localFaceNs[j]; if (nRef.dot(nj) >= cosThresh) { nx += nj.x; ny += nj.y; nz += nj.z }
      }
      tmp.set(nx, ny, nz); if (tmp.lengthSq() === 0) tmp.copy(nRef); tmp.normalize()
      const w = ci * 3; normals[w] = tmp.x; normals[w + 1] = tmp.y; normals[w + 2] = tmp.z
    }
  })
  g.setAttribute("normal", new THREE.BufferAttribute(normals, 3))
  g.computeBoundingBox(); g.computeBoundingSphere()
  return g
}

/* ---------- Model Loader ---------- */
function AnyModel({ name, url, color, opacity, visible, onLoaded, autoSmooth, roughness = 0.5, metalness = 0.5, useVertexColors = false, keepMaterials = false }) {
  const [object3D, setObject3D] = useState(null)
  const [loading, setLoading] = useState(true)
  const ext = useMemo(() => inferExt(name || url), [name, url])
  const makeMat = (opts = {}) => new THREE.MeshStandardMaterial({ color: new THREE.Color(color || "#fff"), roughness, metalness, transparent: opacity < 1, opacity, side: THREE.DoubleSide, depthWrite: opacity === 1, ...opts })
  const forEachMesh = (obj, cb) => { obj?.traverse?.((child) => { if (child.isMesh) cb(child) }) }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        let obj
        if (ext === "stl") {
          const geom = await new STLLoader().loadAsync(url)
          if (!geom.attributes.normal) geom.computeVertexNormals()
          const base = autoSmooth ? autoSmoothGeometry(geom, DEFAULT_SMOOTH_ANGLE) : geom
          const mat = makeMat()
          obj = new THREE.Mesh(base, mat)
        } else if (ext === "ply") {
          const geom = await new PLYLoader().loadAsync(url)
          const hasVC = !!geom.getAttribute("color")
          const base = autoSmooth ? autoSmoothGeometry(geom, DEFAULT_SMOOTH_ANGLE) : geom
          const mat = hasVC && useVertexColors ? makeMat({ vertexColors: true }) : makeMat()
          obj = new THREE.Mesh(base, mat)
        } else {
          const loaded = await new OBJLoader().loadAsync(url)
          const mat = makeMat()
          loaded.traverse((child) => { if (child.isMesh) child.material = mat })
          obj = loaded
        }
        if (!cancelled) { setObject3D(obj); setLoading(false); onLoaded && onLoaded(obj) }
      } catch (e) { console.error(e); if (!cancelled) setLoading(false) }
    })()
    return () => { cancelled = true }
  }, [url, ext])

  useEffect(() => {
    if (!object3D) return
    forEachMesh(object3D, (child) => {
      if (child.material) {
        child.material.color = new THREE.Color(color || "#fff")
        child.material.transparent = opacity < 1
        child.material.opacity = opacity
        child.material.needsUpdate = true
      }
    })
  }, [object3D, color, opacity])

  if (!object3D) return loading ? <InlineLoader text={`Načítám ${name}`} /> : null
  return visible ? <primitive object={object3D} /> : null
}

/* ---------- Headlight ---------- */
function Headlight({ enabled = true, intensity = 2 }) {
  const { camera } = useThree()
  const ref = useRef()
  useFrame(() => { if (ref.current) ref.current.position.copy(camera.position) })
  return <pointLight ref={ref} intensity={enabled ? intensity : 0} distance={0} decay={0} />
}

/* ---------- Trackball Controls ---------- */
function TouchTrackballControls({ target = [0, 0, 0], disabled = false, onReady }) {
  const { camera, gl, size } = useThree()
  const controlsRef = useRef(null)
  useEffect(() => {
    const controls = new TrackballControls(camera, gl.domElement)
    controls.rotateSpeed = 5
    controls.zoomSpeed = 1.2
    controls.panSpeed = 1
    controls.staticMoving = true
    controls.dynamicDampingFactor = 0.1
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ZOOM }
    controls.enabled = !disabled
    controlsRef.current = controls
    onReady && onReady(controls)
    return () => controls.dispose()
  }, [camera, gl])

  useEffect(() => {
    if (controlsRef.current) {
      controlsRef.current.enabled = !disabled
      controlsRef.current.target.set(target[0], target[1], target[2])
    }
  }, [disabled, target])

  useFrame(() => { if (!controlsRef.current?.enabled) return; if (camera.isOrthographicCamera) controlsRef.current.panSpeed = camera.zoom * 0.4; controlsRef.current.update() })
  useEffect(() => { controlsRef.current?.handleResize() }, [size.width, size.height])
  return null
}

/* ---------- Right Mouse Pan ---------- */
function RightButtonPan({ setTarget, controlsRef }) {
  const { camera, gl, size } = useThree()
  const isPanning = useRef(false)
  const last = useRef({ x: 0, y: 0 })
  const pointerId = useRef(null)
  const right = new THREE.Vector3(), up = new THREE.Vector3(), delta = new THREE.Vector3()
  const PAN_SENS = 0.85

  useEffect(() => {
    const el = gl.domElement
    const down = (e) => {
      if ((e.button !== 2) && !(e.button === 0 && e.ctrlKey)) return
      e.preventDefault()
      isPanning.current = true
      last.current = { x: e.clientX, y: e.clientY }
      pointerId.current = e.pointerId
      try { el.setPointerCapture(e.pointerId) } catch {}
      if (controlsRef?.current) controlsRef.current.enabled = false
    }
    const move = (e) => {
      if (!isPanning.current) return
      e.preventDefault()
      const dx = e.clientX - last.current.x, dy = e.clientY - last.current.y
      last.current = { x: e.clientX, y: e.clientY }
      right.setFromMatrixColumn(camera.matrixWorld, 0).normalize()
      up.setFromMatrixColumn(camera.matrixWorld, 1).normalize()
      if (camera.isOrthographicCamera) {
        const wppX = ((camera.right - camera.left) / (size.width * camera.zoom))
        const wppY = ((camera.top - camera.bottom) / (size.height * camera.zoom))
        delta.copy(right).multiplyScalar(-dx * wppX * PAN_SENS).addScaledVector(up, dy * wppY * PAN_SENS)
      } else {
        const dist = camera.position.length()
        const scale = (dist / Math.max(size.width, size.height)) * PAN_SENS
        delta.copy(right).multiplyScalar(-dx * scale).addScaledVector(up, dy * scale)
      }
      camera.position.add(delta)
      setTarget((t) => [t[0] + delta.x, t[1] + delta.y, t[2] + delta.z])
      camera.updateProjectionMatrix()
    }
    const up = () => {
      if (!isPanning.current) return
      isPanning.current = false
      try { el.releasePointerCapture(pointerId.current) } catch {}
      if (controlsRef?.current) controlsRef.current.enabled = true
    }
    const ctx = (e) => e.preventDefault()
    el.addEventListener("contextmenu", ctx)
    el.addEventListener("pointerdown", down)
    el.addEventListener("pointermove", move)
    el.addEventListener("pointerup", up)
    return () => {
      el.removeEventListener("contextmenu", ctx)
      el.removeEventListener("pointerdown", down)
      el.removeEventListener("pointermove", move)
      el.removeEventListener("pointerup", up)
    }
  }, [camera, gl, size.width, size.height, setTarget, controlsRef])

  return null
}

/* ---------- AutoCenter & Frame ---------- */
function AutoCenterAndFrame({ rootRef, depsKey, setTarget, margin = 1.15 }) {
  const { camera, size } = useThree()
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    root.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(root)
    if (box.isEmpty()) return
    const center = new THREE.Vector3(); box.getCenter(center)
    const sphere = new THREE.Sphere(); box.getBoundingSphere(sphere)
    const R = Math.max(sphere.radius, 1e-6)
    root.position.sub(center); root.updateMatrixWorld(true); setTarget([0, 0, 0])
    const w = size.width, h = size.height
    const zoomX = w / (2 * R * margin), zoomY = h / (2 * R * margin)
    const zoom = Math.max(Math.min(zoomX, zoomY), 0.01)
    const depth = Math.max(box.getSize(new THREE.Vector3()).z, R * 0.75)
    const dist = Math.max(depth * 4, R * 4, 10)
    camera.position.set(0, 0, dist)
    camera.near = Math.max(0.01, dist * 0.001)
    camera.far = dist * 50 + 100
    camera.zoom = zoom
    camera.updateProjectionMatrix()
  }, [depsKey, size.width, size.height, rootRef, setTarget, camera])
  return null
}

/* ---------- Hlavní stránka ---------- */
export default function ClientPage() {
  const [files, setFiles] = useState([])
  const [colors, setColors] = useState([])
  const [opacities, setOpacities] = useState([])
  const [visibles, setVisibles] = useState([])
  const [autoSmooth] = useState(true)
  const [lightIntensity] = useState(1)
  const [headlightCfg] = useState({ enabled: true, intensity: 2 })
  const [cameraTarget, setCameraTarget] = useState([0, 0, 0])
  const [loadedCount, setLoadedCount] = useState(0)
  const handleModelLoaded = () => setLoadedCount((n) => n + 1)
  const rootRef = useRef()
  const controlsRef = useRef()
  const frameDepsKey = `frame-${files.length}-${loadedCount}`

  useEffect(() => {
    const f = getParam("files")
    if (f) {
      let arr; try { arr = JSON.parse(decodeURIComponent(f)) } catch {}
      if (!Array.isArray(arr)) return
      const Fs = arr.map((x, i) => ({
        url: x.u, name: stripExt(x.n) || `Model ${i + 1}`,
        c: x.c, o: x.o ?? 1, v: x.v ?? true
      }))
      setFiles(Fs)
      setColors(Fs.map((f, i) => f.c || ["#f5f5dc", "#ccc", "#fff"][i % 3]))
      setOpacities(Fs.map(f => f.o ?? 1))
      setVisibles(Fs.map(f => f.v ?? true))
    }
  }, [])

  return (
    <div style={{ position: "relative", width: "100vw", height: "100vh", background: "black" }}>
      <PreloadIcons />
      <Canvas orthographic camera={{ position: [0, 0, 100], near: 0.01, far: 100000 }} gl={{ alpha: true }} style={{ position: "absolute", inset: 0 }}>
        <ambientLight intensity={lightIntensity * 0.4} />
        <directionalLight position={[0, 5, 5]} intensity={lightIntensity * 1.5} />
        <Headlight enabled={headlightCfg.enabled} intensity={headlightCfg.intensity} />

        <group ref={rootRef}>
          <Suspense fallback={null}>
            {files.map((f, i) => (
              <AnyModel key={i} name={f.name} url={f.url} color={colors[i]} opacity={opacities[i]} visible={visibles[i]} autoSmooth={autoSmooth} onLoaded={handleModelLoaded} />
            ))}
          </Suspense>
        </group>

        <AutoCenterAndFrame rootRef={rootRef} depsKey={frameDepsKey} setTarget={setCameraTarget} />
        <TouchTrackballControls target={cameraTarget} onReady={(c) => (controlsRef.current = c)} />
        <RightButtonPan setTarget={setCameraTarget} controlsRef={controlsRef} />
      </Canvas>
    </div>
  )
}
