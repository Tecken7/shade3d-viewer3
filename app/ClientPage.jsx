"use client"

import { Canvas, useThree, useFrame } from "@react-three/fiber"
import * as THREE from "three"
import { Suspense, useEffect, useMemo, useRef, useState } from "react"
import { Html } from "@react-three/drei"
import { TrackballControls } from "three/examples/jsm/controls/TrackballControls"
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader"
import { STLLoader } from "three/examples/jsm/loaders/STLLoader"
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader"

/* --------------------------------- CONST --------------------------------- */
const SUPABASE_URL = "https://jqnkdjgmenerioodqcpa.supabase.co"
const PUBLIC_BUCKET = "shade3d-viewer2"
const LIVE_MSG_TYPES = new Set(["SHADE3D_LIVE", "SHADE3D_LIVE_V6", "SHADE3D_LIVE_V5"])

const DEFAULT_LOGO = "/Arthetic_logo.png"
const DEFAULT_PALETTE = ["#f5f5dc", "#8e8e8e", "#ffffff", "#ffd7a8", "#c0c0c0", "#e6f0ff", "#ffeedd"]
const DEFAULT_SMOOTH_ANGLE = 30

/* -------------------------------- HELPERS -------------------------------- */
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

/* ----------------------------- ICONS + PRELOAD ---------------------------- */
const ICON_BASE = (() => {
  const q = getParam("iconBase")
  if (q && /^(https?:)?\/\//i.test(q)) return q.replace(/\/+$/, "") + "/"
  if (q && q.startsWith("/")) return q.replace(/\/+$/, "") + "/"
  return "/icons/"
})()
const ICONS = { eye: `${ICON_BASE}Eye.png`, eyeOff: `${ICON_BASE}Eye-off.png` }
function PreloadIcons() {
  useEffect(() => {
    try {
      Object.values(ICONS).forEach((src) => {
        const img = new Image()
        img.decoding = "async"
        img.src = src
      })
    } catch {}
  }, [])
  return null
}

/* ------------------------------- AUTO SMOOTH ------------------------------ */
function autoSmoothGeometry(geometry, angleDeg = DEFAULT_SMOOTH_ANGLE) {
  const angle = Math.max(0, Math.min(89.9, angleDeg))
  const angleRad = (angle * Math.PI) / 180
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
    cb.subVectors(c, b)
    ab.subVectors(a, b)
    cb.cross(ab).normalize()
    faceNormals[f] = cb.clone()
  }

  const groups = new Map()
  const keyOf = (ix) => `${pos.getX(ix).toFixed(5)},${pos.getY(ix).toFixed(5)},${pos.getZ(ix).toFixed(5)}`
  for (let i = 0; i < vCount; i++) {
    const k = keyOf(i)
    let arr = groups.get(k)
    if (!arr) { arr = []; groups.set(k, arr) }
    arr.push(i)
  }

  const normals = new Float32Array(vCount * 3)
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
      tmp.set(nx, ny, nz)
      if (tmp.lengthSq() === 0) tmp.copy(nRef)
      tmp.normalize()
      const w = ci * 3
      normals[w] = tmp.x; normals[w + 1] = tmp.y; normals[w + 2] = tmp.z
    }
  })

  g.setAttribute("normal", new THREE.BufferAttribute(normals, 3))
  g.computeBoundingBox()
  g.computeBoundingSphere()
  return g
}

/* ---------------------------------- UI ----------------------------------- */
function InlineLoader({ text }) {
  return (
    <Html center>
      <div style={{ background: "rgba(0,0,0,0.7)", padding: "16px 28px", borderRadius: 10, color: "white", fontFamily: "sans-serif", fontSize: 16 }}>
        ⏳ {text || "Načítám…"}
      </div>
    </Html>
  )
}

function Switch({ checked, onChange, label }) {
  const handleKey = (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onChange(!checked) }
  }
  const TRACK_W = 38, TRACK_H = 22, KNOB = 18
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {label && <span style={{ opacity: 0.85 }}>{label}</span>}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        onKeyDown={handleKey}
        style={{
          position: "relative",
          width: TRACK_W, height: TRACK_H,
          borderRadius: 999,
          border: "1px solid rgba(255,255,255,.22)",
          background: checked ? "rgba(59,130,246,.45)" : "rgba(255,255,255,.10)",
          cursor: "pointer", transition: "background .15s ease, border-color .15s ease",
          outline: "none", padding: 0,
        }}
        title={label}
      >
        <span aria-hidden style={{
          position: "absolute", top: "50%", transform: "translateY(-50%)",
          left: checked ? TRACK_W - KNOB - 3 : 3,
          width: KNOB, height: KNOB, borderRadius: "50%", background: "#fff",
          boxShadow: "0 1px 3px rgba(0,0,0,.35)", transition: "left .15s ease",
        }}/>
      </button>
    </div>
  )
}

/* ------------------------------- HEADLIGHT ------------------------------- */
function Headlight({ enabled = true, intensity = 2, color = "#ffffff" }) {
  const { camera } = useThree()
  const ref = useRef(null)
  useFrame(() => { if (ref.current) ref.current.position.copy(camera.position) })
  return <pointLight ref={ref} color={color} intensity={enabled ? intensity : 0} distance={0} decay={0} />
}

/* ------------------------------ TRACKBALL FIX ----------------------------- */
/** Trackball s pevným „release“ a vypínáním při pravém panu */
function TouchTrackballControls({ target = [0, 0, 0], disabled = false }) {
  const { camera, gl, size } = useThree()
  const controlsRef = useRef(null)

  // počítadlo přímo stavu levého tlačítka – kvůli „stuck“ na některých prohlížečích
  const pressedRef = useRef(false)

  useEffect(() => {
    const controls = new TrackballControls(camera, gl.domElement)
    controls.rotateSpeed = 5.0
    controls.zoomSpeed = 1.2
    controls.panSpeed = 1.0
    controls.staticMoving = true
    controls.dynamicDampingFactor = 0.15
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ZOOM }
    controls.enabled = !disabled
    controlsRef.current = controls

    const onPointerDown = (e) => {
      if (e.button === 0) pressedRef.current = true
    }
    const onPointerUp = () => {
      // vždy uvolni – fix stuck rotace
      pressedRef.current = false
      controlsRef.current?.reset() // reset vnitřního stavu drag deltas
      controlsRef.current?.update()
    }
    gl.domElement.addEventListener("pointerdown", onPointerDown, { passive: true })
    window.addEventListener("pointerup", onPointerUp, { passive: true })

    return () => {
      gl.domElement.removeEventListener("pointerdown", onPointerDown)
      window.removeEventListener("pointerup", onPointerUp)
      controls.dispose()
    }
  }, [camera, gl])

  useEffect(() => {
    const c = controlsRef.current
    if (!c) return
    c.target.set(target[0], target[1], target[2])
    c.update()
  }, [target])

  useEffect(() => {
    const c = controlsRef.current
    if (!c) return
    c.enabled = !disabled
  }, [disabled])

  useEffect(() => {
    controlsRef.current?.handleResize()
  }, [size.width, size.height])

  useFrame(() => {
    const c = controlsRef.current
    if (!c) return
    if (camera.isOrthographicCamera) c.panSpeed = camera.zoom * 0.4
    c.update()
  })

  return null
}

/* ------------------------------ RIGHT PAN FIX ----------------------------- */
/** Panning pravým tlačítkem (nebo Ctrl+levé) – stabilní, bez wobble, s rAF */
function RightButtonPan({ setTarget, onActiveChange }) {
  const { camera, gl, size } = useThree()
  const isPanning = useRef(false)
  const last = useRef({ x: 0, y: 0 })
  const pointerIdRef = useRef(null)
  const frameRef = useRef(null)
  const accum = useRef({ dx: 0, dy: 0 }) // akumulace do rAF

  const PAN_SENSITIVITY = 0.9
  const right = new THREE.Vector3()
  const up = new THREE.Vector3()
  const deltaWorld = new THREE.Vector3()

  // rAF updater – aplikuje pohyb pouze jednou za frame
  const applyDelta = () => {
    frameRef.current = null
    const { dx, dy } = accum.current
    accum.current.dx = 0
    accum.current.dy = 0
    if (!dx && !dy) return

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

  useEffect(() => {
    const el = gl.domElement

    const onContext = (e) => { e.preventDefault() }

    const onDown = (e) => {
      if ((e.button !== 2) && !(e.button === 0 && e.ctrlKey)) return
      isPanning.current = true
      onActiveChange?.(true)
      last.current = { x: e.clientX, y: e.clientY }
      pointerIdRef.current = e.pointerId
      try { el.setPointerCapture?.(e.pointerId) } catch {}
      e.preventDefault()
      e.stopPropagation()
    }

    const onMove = (e) => {
      if (!isPanning.current) return
      const dx = e.clientX - last.current.x
      const dy = e.clientY - last.current.y
      last.current = { x: e.clientX, y: e.clientY }
      accum.current.dx += dx
      accum.current.dy += dy
      if (!frameRef.current) frameRef.current = requestAnimationFrame(applyDelta)
      e.preventDefault()
      e.stopPropagation()
    }

    const onUp = () => {
      if (!isPanning.current) return
      isPanning.current = false
      onActiveChange?.(false)
      if (frameRef.current) { cancelAnimationFrame(frameRef.current); frameRef.current = null }
      try { el.releasePointerCapture?.(pointerIdRef.current) } catch {}
      pointerIdRef.current = null
    }

    el.addEventListener("contextmenu", onContext)
    el.addEventListener("pointerdown", onDown)
    window.addEventListener("pointermove", onMove, { capture: true })
    window.addEventListener("pointerup", onUp, { capture: true })
    return () => {
      el.removeEventListener("contextmenu", onContext)
      el.removeEventListener("pointerdown", onDown)
      window.removeEventListener("pointermove", onMove, { capture: true })
      window.removeEventListener("pointerup", onUp, { capture: true })
    }
  }, [camera, gl, size.width, size.height])

  return null
}

/* ------------------------------ AUTO FRAME ORTHO -------------------------- */
function AutoCenterAndFrame({
  rootRef, depsKey, setTarget,
  margin = 1.30, // -> prostor kolem modelu
  isMobile = false, desktopScale = 0.42, mobileScale = 1.0,
  centerMode = "combined",
}) {
  const { camera, size } = useThree()

  useEffect(() => {
    const root = rootRef.current
    if (!root) return

    root.updateMatrixWorld(true)
    const boxAll = new THREE.Box3().setFromObject(root)
    if (boxAll.isEmpty()) return

    const centerAll = new THREE.Vector3()
    const dims = new THREE.Vector3()
    boxAll.getCenter(centerAll)
    boxAll.getSize(dims)

    if (centerMode === "per") {
      root.children.forEach((child) => {
        const b = new THREE.Box3().setFromObject(child)
        if (b.isEmpty()) return
        const cWorld = new THREE.Vector3()
        b.getCenter(cWorld)
        child.position.sub(cWorld)
      })
      root.updateMatrixWorld(true)
      setTarget([0, 0, 0])
    } else if (centerMode === "combined") {
      root.position.sub(centerAll)
      root.updateMatrixWorld(true)
      setTarget([0, 0, 0])
    } else {
      setTarget([centerAll.x, centerAll.y, centerAll.z])
    }

    const after = new THREE.Box3().setFromObject(root)
    const dims2 = new THREE.Vector3()
    const ctr = new THREE.Vector3()
    after.getSize(dims2)
    after.getCenter(ctr)

    const objW = Math.max(dims2.x, 1e-6)
    const objH = Math.max(dims2.y, 1e-6)
    const zoomX = size.width / (objW * margin)
    const zoomY = size.height / (objH * margin)
    let newZoom = Math.min(zoomX, zoomY)
    newZoom *= isMobile ? mobileScale : desktopScale

    // bezpečné vzdálení pro ortho – aby nebyl „na skle“
    const depth = Math.max(dims2.z, Math.max(dims2.x, dims2.y) * 0.75) || 1
    const safeDist = depth * 4.5   // trochu dál než dříve
    camera.near = Math.max(0.01, safeDist * 0.001)
    camera.far = safeDist * 60 + 100
    camera.position.set(ctr.x, ctr.y, ctr.z + safeDist)
    camera.zoom = Math.max(newZoom, 0.01)
    camera.updateProjectionMatrix()
  }, [depsKey, size.width, size.height, isMobile, desktopScale, mobileScale, margin, centerMode, setTarget])

  return null
}

/* -------------------------------- ANY MODEL ------------------------------- */
function AnyModel({
  name, url,
  color, opacity, visible,
  onLoaded, autoSmooth,
  roughness = 0.5, metalness = 0.5,
  useVertexColors = false,
  keepMaterials = false,
  wireframe = false,
}) {
  const [object3D, setObject3D] = useState(null)
  const [loading, setLoading] = useState(true)
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
    const geom = mesh.geometry
    if (!geom) return
    const wfGeom = new THREE.WireframeGeometry(geom)
    const wfMat = new THREE.LineBasicMaterial({
      color: 0x000000,
      depthTest: true,
      depthWrite: false,
      transparent: true,
      opacity: 0.95,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    })
    const lines = new THREE.LineSegments(wfGeom, wfMat)
    lines.renderOrder = (mesh.renderOrder || 0) + 10
    mesh.add(lines)
    mesh.userData._edges = lines
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        let obj
        if (ext === "stl") {
          const geom = await new STLLoader().loadAsync(url)
          if (!geom.attributes.normal) geom.computeVertexNormals()
          const base = autoSmooth ? autoSmoothGeometry(geom, DEFAULT_SMOOTH_ANGLE) : (geom.computeVertexNormals(), geom)
          const mat = makeMat()
          obj = new THREE.Mesh(base, mat)
          obj.userData._baseGeom = geom
          obj.userData._derivedGeom = base
        } else if (ext === "ply") {
          const geom = await new PLYLoader().loadAsync(url)
          const hasVC = !!geom.getAttribute("color")
          let base = geom
          if (autoSmooth) base = autoSmoothGeometry(geom, DEFAULT_SMOOTH_ANGLE)
          else if (!geom.attributes.normal) geom.computeVertexNormals()
          const mat = hasVC && useVertexColors ? makeMat({ vertexColors: true, color: new THREE.Color("#ffffff") }) : makeMat()
          obj = new THREE.Mesh(base, mat)
          obj.userData._baseGeom = geom
          obj.userData._derivedGeom = base
        } else {
          const loaded = await new OBJLoader().loadAsync(url)
          if (keepMaterials) {
            loaded.traverse((child) => {
              if (child.isMesh) {
                const mat = child.material
                if (mat) {
                  if ("transparent" in mat) mat.transparent = opacity < 1
                  if ("opacity" in mat) mat.opacity = opacity
                  if ("roughness" in mat && typeof roughness === "number") mat.roughness = roughness
                  if ("metalness" in mat && typeof metalness === "number") mat.metalness = metalness
                }
              }
            })
            obj = loaded
          } else {
            const mat = makeMat()
            loaded.traverse((child) => { if (child.isMesh) child.material = mat })
            obj = loaded
          }
        }

        if (!cancelled) {
          forEachMesh(obj, (mesh) => rebuildWireOverlay(mesh))
          setObject3D(obj)
          setLoading(false)
          onLoaded && onLoaded(obj)
        }
      } catch (e) {
        console.error("Model load error:", e)
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [url, ext])

  useEffect(() => {
    if (!object3D) return
    forEachMesh(object3D, (child) => {
      if (!child.userData._baseGeom) child.userData._baseGeom = child.geometry
      const base = child.userData._baseGeom
      let newGeom = base
      if (autoSmooth) newGeom = autoSmoothGeometry(base, DEFAULT_SMOOTH_ANGLE)
      else { newGeom = base.clone(); newGeom.computeVertexNormals() }
      if (child.userData._derivedGeom && child.userData._derivedGeom !== base) {
        child.userData._derivedGeom.dispose()
      }
      child.geometry = newGeom
      child.userData._derivedGeom = newGeom
      rebuildWireOverlay(child)
    })
  }, [object3D, autoSmooth])

  useEffect(() => {
    if (!object3D) return
    forEachMesh(object3D, (child) => {
      if (keepMaterials) {
        const mat = child.material
        if (mat) {
          if ("transparent" in mat) mat.transparent = opacity < 1
          if ("opacity" in mat) mat.opacity = opacity
          if ("roughness" in mat && typeof roughness === "number") mat.roughness = roughness
          if ("metalness" in mat && typeof metalness === "number") mat.metalness = metalness
          if (!useVertexColors && "color" in mat && color) mat.color = new THREE.Color(color)
          if (useVertexColors && "vertexColors" in mat) {
            mat.vertexColors = true
            if ("color" in mat) mat.color = new THREE.Color("#ffffff")
          }
          mat.needsUpdate = true
        }
      } else {
        const hasVC = !!child.geometry.getAttribute?.("color")
        const mat = hasVC && useVertexColors ? makeMat({ vertexColors: true, color: new THREE.Color("#ffffff") }) : makeMat()
        child.material = mat
      }
      if (child.userData._edges) child.userData._edges.visible = !!wireframe
      else if (wireframe) rebuildWireOverlay(child)
    })
  }, [object3D, color, opacity, roughness, metalness, useVertexColors, keepMaterials, wireframe])

  if (!object3D) return loading ? <InlineLoader text={`Načítám ${name || url}`} /> : null
  return visible ? <primitive object={object3D} /> : null
}

/* -------------------------------- LIGHTBOX -------------------------------- */
function Lightbox({ open, onClose, src, alt }) {
  if (!open || !src) return null
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
      <img src={src} alt={alt || ""} style={{ maxWidth: "96vw", maxHeight: "92vh", objectFit: "contain", borderRadius: 12, boxShadow: "0 10px 40px rgba(0,0,0,.6)", border: "1px solid rgba(255,255,255,.15)" }} />
    </div>
  )
}

/* ------------------------------- MAIN PAGE -------------------------------- */
export default function ClientPage() {
  const [lightIntensity, setLightIntensity] = useState(1)
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

  const [files, setFiles] = useState([])
  const [colors, setColors] = useState([])
  const [opacities, setOpacities] = useState([])
  const [visibles, setVisibles] = useState([])
  const [roughnesses, setRoughnesses] = useState([])
  const [metalnesses, setMetalnesses] = useState([])
  const [fatal, setFatal] = useState(null)

  const [autoSmooth, setAutoSmooth] = useState((getParam("smooth") ?? "1") !== "0")
  const [wireframe, setWireframe] = useState(false)

  const [logoCfg, setLogoCfg] = useState({ url: DEFAULT_LOGO, opacity: 0.9, width: 160, pos: "bc" })
  const [photos, setPhotos] = useState([])
  const [lightbox, setLightbox] = useState({ open: false, src: null, alt: "" })

  const [photosOpen, setPhotosOpen] = useState(!isMobile)
  useEffect(() => { setPhotosOpen(!isMobile) }, [isMobile])

  const [slidersOpen, setSlidersOpen] = useState(!isMobile)
  useEffect(() => { setSlidersOpen(!isMobile) }, [isMobile])

  const [cameraTarget, setCameraTarget] = useState([0, 0, 0])
  const [loadedCount, setLoadedCount] = useState(0)
  const handleModelLoaded = () => setLoadedCount((n) => n + 1)

  const rootRef = useRef()

  const centerParam = (getParam("center") || "combined").toLowerCase()
  const centerMode = ["per", "combined", "none"].includes(centerParam) ? centerParam : "combined"

  // LIVE helper (Framer): porovnání keys pro „should frame“
  const prevFileKeysRef = useRef([])
  const getFileKeys = (arr) => (arr || []).map(f => `${f.url}::${f.rawName || f.name}`)
  const shouldFrameRef = useRef(true)

  useEffect(() => {
    ;(async () => {
      try {
        // 1) ?m= (public manifest on supabase)
        const mId = getParam("m")
        if (mId) {
          const manifestUrl = `${SUPABASE_URL}/storage/v1/object/public/${PUBLIC_BUCKET}/manifests/${encodeURIComponent(mId)}.json`
          const m = await fetchJSON(manifestUrl)
          const Fs = (m?.files || []).map((x, i) => ({
            url: x.u, name: stripExt(x.n) || `Model ${i + 1}`, rawName: x.n,
            c: x.c, o: typeof x.o === "number" ? clamp01(x.o) : 1,
            v: typeof x.v === "boolean" ? x.v : true,
            r: typeof x.r === "number" ? clamp01(x.r) : 0.5,
            m: typeof x.m === "number" ? clamp01(x.m) : 0.5,
            vc: !!x.vc, km: !!x.km,
          }))
          if (!Fs.length) throw new Error("Manifest je prázdný.")
          setFiles(Fs)
          setColors(Fs.map((f, i) => f.c || DEFAULT_PALETTE[i % DEFAULT_PALETTE.length]))
          setOpacities(Fs.map((f) => (typeof f.o === "number" ? clamp01(f.o) : 1)))
          setVisibles(Fs.map((f) => (typeof f.v === "boolean" ? f.v : true)))
          setRoughnesses(Fs.map((f) => (typeof f.r === "number" ? clamp01(f.r) : 0.5)))
          setMetalnesses(Fs.map((f) => (typeof f.m === "number" ? clamp01(f.m) : 0.5)))
          setTitle(typeof m?.title === "string" ? m.title : (getParam("title") ?? null))
          const logoUrl = m?.logo?.url || DEFAULT_LOGO
          setLogoCfg({
            url: logoUrl || null,
            opacity: clamp01(parseFloat(getParam("logoOpacity") ?? "0.9")),
            width: parseInt(getParam("logoWidth") ?? (window.innerWidth < 768 ? "120" : "160"), 10),
            pos: getParam("logoPos") || "bc",
          })
          const hl = m?.lights?.headlight
          setHeadlightCfg({
            enabled: typeof hl?.enabled === "boolean" ? hl.enabled : true,
            intensity: typeof hl?.intensity === "number" ? hl.intensity : 2.0,
          })
          setPhotos(Array.isArray(m?.photos) ? m.photos.filter(p => p && p.u) : [])
          prevFileKeysRef.current = getFileKeys(Fs)
          shouldFrameRef.current = true
          return
        }

        // 2) ?manifest= (absolute url)
        const manifestUrlParam = getParam("manifest")
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
          if (!Fs.length) throw new Error("Manifest je prázdný.")
          setFiles(Fs)
          setColors(Fs.map((f, i) => f.c || DEFAULT_PALETTE[i % DEFAULT_PALETTE.length]))
          setOpacities(Fs.map((f) => (typeof f.o === "number" ? clamp01(f.o) : 1)))
          setVisibles(Fs.map((f) => (typeof f.v === "boolean" ? f.v : true)))
          setRoughnesses(Fs.map((f) => (typeof f.r === "number" ? clamp01(f.r) : 0.5)))
          setMetalnesses(Fs.map((f) => (typeof f.m === "number" ? clamp01(f.m) : 0.5)))
          setTitle(typeof m?.title === "string" ? m.title : (getParam("title") ?? null))
          const logoUrl = m?.logo?.url || DEFAULT_LOGO
          setLogoCfg({
            url: logoUrl || null,
            opacity: clamp01(parseFloat(getParam("logoOpacity") ?? "0.9")),
            width: parseInt(getParam("logoWidth") ?? (window.innerWidth < 768 ? "120" : "160"), 10),
            pos: getParam("logoPos") || "bc",
          })
          const qOn = getParam("headlight")
          const qI = parseFloat(getParam("headlightI") ?? "NaN")
          setHeadlightCfg({
            enabled: qOn == null ? true : qOn !== "0",
            intensity: isFinite(qI) ? qI : 2.0,
          })
          setPhotos(Array.isArray(m?.photos) ? m.photos.filter(p => p && p.u) : [])
          prevFileKeysRef.current = getFileKeys(Fs)
          shouldFrameRef.current = true
          return
        }

        // 3) ?files=[..]
        const f = getParam("files")
        if (f) {
          let arr = null
          try { arr = JSON.parse(f) } catch {}
          if (!arr) { try { arr = JSON.parse(decodeURIComponent(f)) } catch {} }
          if (!Array.isArray(arr)) throw new Error("Neplatný formát parametru ?files=")
          const Fs = arr.filter((x) => x && x.u).map((x, i) => ({
            url: x.u, name: stripExt(x.n) || `Model ${i + 1}`, rawName: x.n,
            c: x.c, o: typeof x.o === "number" ? clamp01(x.o) : 1,
            v: typeof x.v === "boolean" ? x.v : true,
            r: typeof x.r === "number" ? clamp01(x.r) : 0.5,
            m: typeof x.m === "number" ? clamp01(x.m) : 0.5,
            vc: !!x.vc, km: !!x.km,
          }))
          setFiles(Fs)
          setColors(Fs.map((f, i) => f.c || DEFAULT_PALETTE[i % DEFAULT_PALETTE.length]))
          setOpacities(Fs.map((f) => (typeof f.o === "number" ? clamp01(f.o) : 1)))
          setVisibles(Fs.map((f) => (typeof f.v === "boolean" ? f.v : true)))
          setRoughnesses(Fs.map((f) => (typeof f.r === "number" ? clamp01(f.r) : 0.5)))
          setMetalnesses(Fs.map((f) => (typeof f.m === "number" ? clamp01(f.m) : 0.5)))
          setTitle(getParam("title") ?? null)
          setLogoCfg({
            url: getParam("logo") === "none" ? null : getParam("logo") || DEFAULT_LOGO,
            opacity: clamp01(parseFloat(getParam("logoOpacity") ?? "0.9")),
            width: parseInt(getParam("logoWidth") ?? (window.innerWidth < 768 ? "120" : "160"), 10),
            pos: getParam("logoPos") || "bc",
          })
          setPhotos([])
          prevFileKeysRef.current = getFileKeys(Fs)
          shouldFrameRef.current = true
          return
        }

        // dev fallback
        const Fs = [
          { url: "/models/Upper.obj", name: "Upper", rawName: "Upper.obj", r: 0.5, m: 0.5, v: true, vc: false, km: false },
          { url: "/models/Lower.stl", name: "Lower", rawName: "Lower.stl", r: 0.5, m: 0.5, v: true, vc: false, km: false },
          { url: "/models/Crown21.ply", name: "Bridge", rawName: "Crown21.ply", r: 0.5, m: 0.5, v: true, vc: false, km: false },
        ]
        setFiles(Fs)
        setColors(Fs.map((_, i) => DEFAULT_PALETTE[i % DEFAULT_PALETTE.length]))
        setOpacities(Fs.map(() => 1))
        setVisibles(Fs.map((f) => f.v))
        setRoughnesses(Fs.map((f) => f.r))
        setMetalnesses(Fs.map((f) => f.m))
        setPhotos([])
        prevFileKeysRef.current = getFileKeys(Fs)
        shouldFrameRef.current = true
      } catch (e) {
        console.error(e)
        setFatal("Tento náhled není dostupný (chyba při načtení dat).")
      }
    })()
  }, [])

  /* --------- LIVE (Framer) – přijímání postMessage a update scény --------- */
  const applyLivePayload = (p) => {
    if (!p) return

    let filesActuallyChanged = false
    if (Array.isArray(p.files) && !(p.onlyParams && p.files.length === 0)) {
      const newFiles = p.files.map((x, i) => ({
        url: x.u, name: stripExt(x.n || `Model ${i + 1}`), rawName: x.n || `Model${i + 1}`,
        c: x.c, o: typeof x.o === "number" ? clamp01(x.o) : 1,
        v: typeof x.v === "boolean" ? x.v : true,
        r: typeof x.r === "number" ? clamp01(x.r) : 0.5,
        m: typeof x.m === "number" ? clamp01(x.m) : 0.5,
        vc: !!x.vc, km: !!x.km,
      }))
      const newKeys = newFiles.map(f => `${f.url}::${f.rawName || f.name}`)
      const prevKeys = prevFileKeysRef.current
      filesActuallyChanged = newKeys.length !== prevKeys.length || newKeys.some((k, i) => k !== prevKeys[i])

      setFiles(newFiles)
      prevFileKeysRef.current = newKeys

      setColors(newFiles.map((f, i) => f.c || DEFAULT_PALETTE[i % DEFAULT_PALETTE.length]))
      setOpacities(newFiles.map((f) => (typeof f.o === "number" ? clamp01(f.o) : 1)))
      setVisibles(newFiles.map((f) => (typeof f.v === "boolean" ? f.v : true)))
      setRoughnesses(newFiles.map((f) => (typeof f.r === "number" ? clamp01(f.r) : 0.5)))
      setMetalnesses(newFiles.map((f) => (typeof f.m === "number" ? clamp01(f.m) : 0.5)))
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
    if (p.lights) {
      if (typeof p.lights.intensity === "number") setLightIntensity(p.lights.intensity)
      if (p.lights.headlight) {
        setHeadlightCfg((old) => ({
          enabled: typeof p.lights.headlight.enabled === "boolean" ? p.lights.headlight.enabled : old.enabled,
          intensity: typeof p.lights.headlight.intensity === "number" ? p.lights.headlight.intensity : old.intensity,
        }))
      }
    }

    shouldFrameRef.current = filesActuallyChanged
    if (filesActuallyChanged) setLoadedCount(0)
  }

  useEffect(() => {
    const onMsg = (e) => {
      const data = e.data
      if (data && LIVE_MSG_TYPES.has(data.type) && data.payload) {
        if (!data.payload.onlyParams && Array.isArray(data.payload.files) && data.payload.files.length === 0) {
          setFiles([]); setColors([]); setOpacities([]); setVisibles([]); setRoughnesses([]); setMetalnesses([])
          prevFileKeysRef.current = []
          shouldFrameRef.current = false
          return
        }
        applyLivePayload(data.payload)
      }
    }
    window.addEventListener("message", onMsg)
    return () => window.removeEventListener("message", onMsg)
  }, [])

  /* ---------------------------- UI – boční panel --------------------------- */
  const slidersContent = fatal ? (
    <div style={{ color: "#ff8b8b" }}>{fatal}</div>
  ) : (
    <>
      {files.map((f, i) => (
        <div key={`${f.url}-${i}`} className="control-row" style={{ display: "grid", gridTemplateColumns: "36px 1fr 36px", alignItems: "center", columnGap: 6, rowGap: 6, margin: "6px 0" }}>
          <div className="row-label" style={{ gridColumn: "1 / -1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f.rawName || f.name}>
            {stripExt(f.name)}:
          </div>

          <input
            type="color"
            value={colors[i] ?? "#ffffff"}
            onChange={(e) => setColors((prev) => prev.map((v, idx) => (idx === i ? e.target.value : v)))}
            aria-label={`${f.name} color`}
            className="color-input"
            style={{ width: 36, height: 22, border: "1px solid #fff", borderRadius: 4, padding: 0, cursor: "pointer", background: "transparent" }}
          />

          <input
            className="slider"
            type="range" min={0} max={1} step={0.01}
            value={opacities[i] ?? 1}
            onChange={(e) => { const v = parseFloat(e.target.value); setOpacities((prev) => prev.map((x, idx) => (idx === i ? v : x))) }}
            style={{ width: "calc(100% - 18px)", minWidth: 140 }}
            aria-label={`${f.name} opacity`}
          />

          <button
            className={`toggle icon-btn ${visibles[i] ? "is-on" : "is-off"}`}
            onClick={() => setVisibles((prev) => prev.map((v, idx) => (idx === i ? !v : v)))}
            aria-label={visibles[i] ? `Hide ${f.name}` : `Show ${f.name}`}
            title={visibles[i] ? "Skrýt" : "Zobrazit"}
            style={{
              width: 36, height: 22,
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              padding: 0, margin: 0, background: "transparent",
              border: "1px solid #fff", borderRadius: 4, cursor: "pointer",
            }}
          >
            <img
              src={(visibles[i] ?? true) ? ICONS.eye : ICONS.eyeOff}
              alt=""
              width={14}
              height={14}
              style={{ display: "block", pointerEvents: "none", userSelect: "none" }}
            />
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
    <div
      className="sidebar"
      style={{
        position: "absolute",
        top: 10, left: 10, zIndex: 2,
        width: "clamp(260px, 28vw, 420px)",
        maxWidth: "calc(100vw - 20px)",
        color: "white", fontFamily: "sans-serif", fontSize: 14,
        backdropFilter: "blur(3px)", background: "rgba(0,0,0,.25)",
        border: "1px solid rgba(255,255,255,.15)", borderRadius: 10,
        padding: 10, boxSizing: "border-box",
        maxHeight: "calc(100vh - 20px)", overflowY: "auto",
      }}
    >
      {title && (
        <div
          title={title}
          style={{
            marginBottom: 10,
            padding: "10px 12px",
            borderRadius: 10,
            border: "1px solid rgba(255,255,255,.18)",
            background: "rgba(255,255,255,.08)",
            fontSize: 13,
            fontWeight: 700,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {title}
        </div>
      )}

      <div>
        {isMobile ? (
          <>
            <button
              onClick={() => setSlidersOpen((o) => !o)}
              aria-expanded={slidersOpen}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                padding: "10px 12px",
                background: "rgba(255,255,255,.08)",
                border: "1px solid rgba(255,255,255,.18)",
                borderRadius: 10,
                color: "#fff",
                cursor: "pointer",
                fontWeight: 700,
                fontSize: 13,
              }}
            >
              <span>Nastavení modelu</span>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ transform: slidersOpen ? "rotate(90deg)" : "rotate(0deg)", transition: "transform .15s ease" }} aria-hidden>
                <path d="M8 5l8 7-8 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>

            {slidersOpen && (
              <div style={{ marginTop: 8, border: "1px solid rgba(255,255,255,.15)", borderRadius: 10, background: "rgba(255,255,255,.06)", padding: 10 }}>
                {slidersContent}
              </div>
            )}
          </>
        ) : (
          <div style={{ border: "1px solid rgba(255,255,255,.15)", borderRadius: 10, padding: 10, background: "rgba(255,255,255,.06)" }}>
            {slidersContent}
          </div>
        )}
      </div>

      {photos && photos.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <button
            onClick={() => setPhotosOpen((o) => !o)}
            aria-expanded={photosOpen}
            style={{
              width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
              gap: 10, padding: "10px 12px", background: "rgba(255,255,255,.08)",
              border: "1px solid rgba(255,255,255,.18)", borderRadius: 10, color: "#fff",
              cursor: "pointer", fontWeight: 700, fontSize: 13,
            }}
          >
            <span>Fotky ({photos.length})</span>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ transform: photosOpen ? "rotate(90deg)" : "rotate(0deg)", transition: "transform .15s ease" }} aria-hidden>
              <path d="M8 5l8 7-8 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>

          {photosOpen && (
            <div style={{ marginTop: 8, border: "1px solid rgba(255,255,255,.15)", borderRadius: 10, background: "rgba(255,255,255,.06)", padding: 8 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))", gap: 8 }}>
                {photos.map((p, i) => (
                  <button key={i} onClick={() => setLightbox({ open: true, src: p.u, alt: p.n || `Photo ${i+1}` })} style={{ padding: 0, margin: 0, border: "none", background: "transparent", cursor: "pointer", borderRadius: 8, overflow: "hidden", boxShadow: "0 1px 6px rgba(0,0,0,.35)", border: "1px solid rgba(255,255,255,.12)" }} title={p.n || ""}>
                    <img src={p.u} alt={p.n || ""} loading="lazy" style={{ display: "block", width: "100%", height: 72, objectFit: "cover" }} />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )

  /* ------------------------------- RENDER --------------------------------- */
  const frameDepsKey = shouldFrameRef.current
    ? `frame-${files.length}-${loadedCount}`
    : `noframe-${files.length}-${loadedCount}`

  const [panActive, setPanActive] = useState(false) // vypíná Trackball při pravém panu

  const logoEl = logoCfg.url && (
    <img
      src={logoCfg.url}
      alt=""
      style={{
        position: "absolute",
        bottom: logoCfg.pos === "bc" || logoCfg.pos === "bl" || logoCfg.pos === "br" ? 12 : "auto",
        left: logoCfg.pos === "bl" ? 12 : logoCfg.pos === "bc" ? "50%" : "auto",
        right: logoCfg.pos === "br" ? 12 : "auto",
        transform: logoCfg.pos === "bc" ? "translateX(-50%)" : "none",
        width: logoCfg.width,
        opacity: logoCfg.opacity,
        zIndex: 0,
        pointerEvents: "none",
        userSelect: "none",
        filter: "drop-shadow(0 0 1px rgba(0,0,0,.25))",
      }}
    />
  )

  return (
    <div className="stage" style={{ position: "relative", width: "100vw", height: "100vh", background: "black" }}>
      <PreloadIcons />
      {logoEl}
      {sidebar}

      <Canvas
        orthographic
        camera={{ position: [0, 0, 100], near: 0.01, far: 1e6 }}
        gl={{ alpha: true }}
        onCreated={({ gl }) => gl.setClearAlpha(0)}
        style={{ position: "absolute", inset: 0, zIndex: 1, background: "transparent" }}
      >
        <>
          <ambientLight intensity={lightIntensity * 0.4 * (headlightCfg.enabled ? 0.5 : 1)} />
          <directionalLight position={[0, 5, 5]} intensity={lightIntensity * 1.5 * (headlightCfg.enabled ? 0.5 : 1)} />
          <directionalLight position={[-10, 0, 0]} intensity={lightIntensity * 1.0 * (headlightCfg.enabled ? 0.5 : 1)} />
          <directionalLight position={[10, 0, 0]} intensity={lightIntensity * 1.2 * (headlightCfg.enabled ? 0.5 : 1)} />
          <directionalLight position={[0, -5, -5]} intensity={lightIntensity * 0.8 * (headlightCfg.enabled ? 0.5 : 1)} />
          <Headlight enabled={headlightCfg.enabled} intensity={headlightCfg.intensity} />

          <group ref={rootRef}>
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
                  wireframe={wireframe}
                  roughness={roughnesses[i] ?? (typeof f.r === "number" ? f.r : 0.5)}
                  metalness={metalnesses[i] ?? (typeof f.m === "number" ? f.m : 0.5)}
                  useVertexColors={!!f.vc}
                  keepMaterials={!!f.km}
                />
              ))}
            </Suspense>
          </group>

          <AutoCenterAndFrame
            rootRef={rootRef}
            depsKey={frameDepsKey}
            setTarget={setCameraTarget}
            margin={1.30}
            isMobile={isMobile}
            desktopScale={0.42}
            mobileScale={1.00}
            centerMode={centerMode}
          />

          <TouchTrackballControls target={cameraTarget} disabled={panActive} />
          <RightButtonPan setTarget={setCameraTarget} onActiveChange={setPanActive} />
        </>
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
        .color-input::-webkit-color-swatch { border: none; border-radius: 2px; }
        .color-input::-moz-color-swatch { border: none; }

        @media (max-width: 720px) {
          .sidebar {
            left: 8px !important;
            width: calc(100vw - 16px) !important;
            max-width: calc(100vw - 16px) !important;
          }
        }
      `}</style>
    </div>
  )
}
