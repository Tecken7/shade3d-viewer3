"use client"

import { Canvas, useThree, useFrame } from "@react-three/fiber"
import * as THREE from "three"
import { Suspense, useEffect, useMemo, useRef, useState } from "react"
import { Html } from "@react-three/drei"
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

/* ---------- Ikony + preload ---------- */
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

/* ---------- Auto Smooth ---------- */
const DEFAULT_SMOOTH_ANGLE = 30
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

/* ---------- Loader (overlay) ---------- */
function InlineLoader({ text }) {
  return (
    <Html center>
      <div style={{ background: "rgba(0,0,0,0.7)", padding: "16px 28px", borderRadius: 10, color: "white", fontFamily: "sans-serif", fontSize: 16 }}>
        ⏳ {text || "Načítám…"}
      </div>
    </Html>
  )
}

/* ---------- AnyModel (wireframe overlay) ---------- */
function AnyModel({
  name, url,
  color, opacity, visible,
  onLoaded, autoSmooth, smoothAngle = DEFAULT_SMOOTH_ANGLE,
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

  const forEachMesh = (obj, cb) => {
    obj?.traverse?.((child) => { if (child.isMesh) cb(child) })
  }

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
          const mat = hasVC && useVertexColors
            ? makeMat({ vertexColors: true, color: new THREE.Color("#ffffff") })
            : makeMat()
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

  // Re-smooth + rebuild overlay on change
  useEffect(() => {
    if (!object3D) return
    forEachMesh(object3D, (child) => {
      if (!child.userData._baseGeom) child.userData._baseGeom = child.geometry
      const base = child.userData._baseGeom
      let newGeom = base
      if (autoSmooth) newGeom = autoSmoothGeometry(base, smoothAngle)
      else { newGeom = base.clone(); newGeom.computeVertexNormals() }

      if (child.userData._derivedGeom && child.userData._derivedGeom !== base) {
        child.userData._derivedGeom.dispose()
      }
      child.geometry = newGeom
      child.userData._derivedGeom = newGeom

      rebuildWireOverlay(child)
    })
  }, [object3D, autoSmooth, smoothAngle])

  // Materials + wireframe visibility toggle
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
        const mat = hasVC && useVertexColors
          ? makeMat({ vertexColors: true, color: new THREE.Color("#ffffff") })
          : makeMat()
        child.material = mat
      }
      if (child.userData._edges) child.userData._edges.visible = !!wireframe
      else if (wireframe) rebuildWireOverlay(child)
    })
  }, [object3D, color, opacity, roughness, metalness, useVertexColors, keepMaterials, wireframe])

  if (!object3D) return loading ? <InlineLoader text={`Načítám ${name || url}`} /> : null
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
function TouchTrackballControls({ target = [0, 0, 0] }) {
  const { camera, gl, size } = useThree()
  const controlsRef = useRef(null)

  useEffect(() => {
    const controls = new TrackballControls(camera, gl.domElement)
    controls.rotateSpeed = 5.0
    controls.zoomSpeed = 1.2
    controls.panSpeed = 1.0
    controls.staticMoving = true
    controls.dynamicDampingFactor = 0.15
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.ZOOM,
      RIGHT: THREE.MOUSE.PAN,
    }
    controlsRef.current = controls
    return () => { controls.dispose() }
  }, [camera, gl])

  useEffect(() => {
    const c = controlsRef.current
    if (!c) return
    c.target.set(target[0], target[1], target[2])
    c.update()
  }, [target])

  useFrame(() => {
    const c = controlsRef.current
    if (!c) return
    if (camera.isOrthographicCamera) c.panSpeed = camera.zoom * 0.4
    c.update()
  })

  useEffect(() => {
    controlsRef.current?.handleResize()
  }, [size.width, size.height])

  return null
}

/* ---------- AutoCenter & AutoFrame (one-shot) ---------- */
function AutoCenterAndFrame({
  rootRef, triggerKey, onFramed,
  margin = 1.12,            // víc prostoru kolem objektu
  isMobile = false,
  desktopScale = 1.0,
  mobileScale = 1.0,
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
    } else if (centerMode === "combined") {
      root.position.sub(centerAll)
      root.updateMatrixWorld(true)
    }

    const after = new THREE.Box3().setFromObject(root)
    const dims2 = new THREE.Vector3()
    const ctr = new THREE.Vector3()
    after.getSize(dims2)
    after.getCenter(ctr)

    // Zoom tak, aby se vešel s marginem
    const objW = Math.max(dims2.x, 1e-6)
    const objH = Math.max(dims2.y, 1e-6)
    const zoomX = size.width / (objW * margin)
    const zoomY = size.height / (objH * margin)
    let newZoom = Math.min(zoomX, zoomY)
    newZoom *= isMobile ? mobileScale : desktopScale

    // Bezpečná vzdálenost – výrazně větší než dřív
    const depth = Math.max(dims2.z, Math.max(dims2.x, dims2.y) * 0.75) || 1
    const safeDist = depth * 10 // dříve 4 → 10 je konzervativnější
    camera.near = Math.max(0.01, safeDist * 0.001)
    camera.far = safeDist * 80 + 200
    camera.position.set(ctr.x, ctr.y, ctr.z + safeDist)
    camera.zoom = Math.max(newZoom, 0.01)
    camera.updateProjectionMatrix()

    onFramed && onFramed()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerKey])

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

/* ---------- Switch (kompaktní) ---------- */
function Switch({ checked, onChange, label }) {
  const handleKey = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      onChange(!checked)
    }
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
          cursor: "pointer",
          transition: "background .15s ease, border-color .15s ease",
          outline: "none", padding: 0,
        }}
        title={label}
      >
        <span
          aria-hidden
          style={{
            position: "absolute",
            top: "50%", transform: "translateY(-50%)",
            left: checked ? TRACK_W - KNOB - 3 : 3,
            width: KNOB, height: KNOB,
            borderRadius: "50%", background: "#fff",
            boxShadow: "0 1px 3px rgba(0,0,0,.35)",
            transition: "left .15s ease",
          }}
        />
      </button>
    </div>
  )
}

/* ---------- Hlavní komponenta ---------- */
export default function ClientPage() {
  // světla
  const [sceneIntensity, setSceneIntensity] = useState(1)   // ← slider „Světla scéna“
  const [highlightIntensity, setHighlightIntensity] = useState(1)
  const [headlightCfg, setHeadlightCfg] = useState({ enabled: true, intensity: 2.0 })

  // detekce mobilu
  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    try {
      const uaMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
      const coarse = typeof window !== "undefined" && window.matchMedia && window.matchMedia("(pointer: coarse)").matches
      const narrow = typeof window !== "undefined" && window.innerWidth < 768
      setIsMobile(uaMobile || coarse || narrow)
    } catch {}
  }, [])

  // titulek, logo
  const [title, setTitle] = useState(null)
  const [logoCfg, setLogoCfg] = useState({ url: DEFAULT_LOGO, opacity: 0.9, width: 160, pos: "bc" })

  // modely
  const [files, setFiles] = useState([])
  const [colors, setColors] = useState([])
  const [opacities, setOpacities] = useState([])
  const [visibles, setVisibles] = useState([])
  const [roughnesses, setRoughnesses] = useState([])
  const [metalnesses, setMetalnesses] = useState([])
  const [fatal, setFatal] = useState(null)

  // vzhled
  const [autoSmooth, setAutoSmooth] = useState((getParam("smooth") ?? "1") !== "0")
  const [smoothAngle] = useState(30)
  const [wireframe, setWireframe] = useState(false)

  // fotky (z manifestu)
  const [photos, setPhotos] = useState([])
  const [lightbox, setLightbox] = useState({ open: false, src: null, alt: "" })

  // UI – sekce na mobilu sbalené
  const [photosOpen, setPhotosOpen] = useState(!isMobile)
  useEffect(() => { setPhotosOpen(!isMobile) }, [isMobile])
  const [slidersOpen, setSlidersOpen] = useState(!isMobile)
  useEffect(() => { setSlidersOpen(!isMobile) }, [isMobile])

  // camera/centrování
  const [cameraTarget, setCameraTarget] = useState([0, 0, 0])
  const [loadedCount, setLoadedCount] = useState(0)
  const [didInitialFrame, setDidInitialFrame] = useState(false) // ← jen jednou po načtení všech
  const handleModelLoaded = () => setLoadedCount((n) => n + 1)
  const centerParam = (getParam("center") || "combined").toLowerCase()
  const centerMode = ["per", "combined", "none"].includes(centerParam) ? centerParam : "combined"

  // LIVE režim pomocné
  const prevFileKeysRef = useRef([])
  const getFileKeys = (arr) => (arr || []).map(f => `${f.url}::${f.rawName || f.name}`)

  // init z URL/manifestu/m
  useEffect(() => {
    ;(async () => {
      try {
        const mId = getParam("m")
        const manifestUrlParam = getParam("manifest")
        const filesParam = getParam("files")

        const applyFiles = (Fs, titleStr, logoUrl, headlight) => {
          if (!Fs.length) throw new Error("Manifest je prázdný.")
          setFiles(Fs)
          const palette = ["#f5f5dc", "#8e8e8e", "#ffffff", "#ffd7a8", "#c0c0c0", "#e6f0ff", "#ffeedd"]
          setColors(Fs.map((f, i) => f.c || palette[i % palette.length]))
          setOpacities(Fs.map((f) => (typeof f.o === "number" ? clamp01(f.o) : 1)))
          setVisibles(Fs.map((f) => (typeof f.v === "boolean" ? f.v : true)))
          setRoughnesses(Fs.map((f) => (typeof f.r === "number" ? clamp01(f.r) : 0.5)))
          setMetalnesses(Fs.map((f) => (typeof f.m === "number" ? clamp01(f.m) : 0.5)))
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
          prevFileKeysRef.current = getFileKeys(Fs)
          setDidInitialFrame(false) // až po načtení všech
          setLoadedCount(0)
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
          applyFiles(Fs, m?.title, m?.logo?.url, m?.lights?.headlight)
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
          applyFiles(Fs, m?.title, m?.logo?.url, null)
          return
        }

        if (filesParam) {
          let arr = null
          try { arr = JSON.parse(filesParam) } catch {}
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
          applyFiles(Fs, getParam("title") ?? null, null, null)
          return
        }

        // žádné vstupy — čekáme na LIVE
        setFiles([]); setColors([]); setOpacities([]); setVisibles([]); setRoughnesses([]); setMetalnesses([])
      } catch (e) {
        console.error(e)
        setFatal("Tento náhled není dostupný (chyba při načtení dat).")
      }
    })()
  }, [])

  // LIVE payload aplikace (z Frameru)
  const applyLivePayload = (p) => {
    if (!p) return
    if (Array.isArray(p.files) && !(p.onlyParams && p.files.length === 0)) {
      const newFiles = p.files.map((x, i) => ({
        url: x.u, name: stripExt(x.n || `Model ${i + 1}`), rawName: x.n || `Model${i + 1}`,
        c: x.c, o: typeof x.o === "number" ? clamp01(x.o) : 1,
        v: typeof x.v === "boolean" ? x.v : true,
        r: typeof x.r === "number" ? clamp01(x.r) : 0.5,
        m: typeof x.m === "number" ? clamp01(x.m) : 0.5,
        vc: !!x.vc, km: !!x.km,
      }))
      const palette = ["#f5f5dc", "#8e8e8e", "#ffffff", "#ffd7a8", "#c0c0c0", "#e6f0ff", "#ffeedd"]
      setFiles(newFiles)
      setColors(newFiles.map((f, i) => f.c || palette[i % palette.length]))
      setOpacities(newFiles.map((f) => (typeof f.o === "number" ? clamp01(f.o) : 1)))
      setVisibles(newFiles.map((f) => (typeof f.v === "boolean" ? f.v : true)))
      setRoughnesses(newFiles.map((f) => (typeof f.r === "number" ? clamp01(f.r) : 0.5)))
      setMetalnesses(newFiles.map((f) => (typeof f.m === "number" ? clamp01(f.m) : 0.5)))
      prevFileKeysRef.current = getFileKeys(newFiles)
      setDidInitialFrame(false)
      setLoadedCount(0)
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
      if (typeof p.lights.scene === "number") setSceneIntensity(clamp01(p.lights.scene))
      if (typeof p.lights.highlight === "number") setHighlightIntensity(clamp01(p.lights.highlight))
      if (p.lights.headlight) {
        setHeadlightCfg((old) => ({
          enabled: typeof p.lights.headlight.enabled === "boolean" ? p.lights.headlight.enabled : old.enabled,
          intensity: typeof p.lights.headlight.intensity === "number" ? p.lights.headlight.intensity : old.intensity,
        }))
      }
    }
  }

  useEffect(() => {
    const onMsg = (e) => {
      const data = e.data
      if (data && LIVE_MSG_TYPES.has(data.type) && data.payload) {
        if (!data.payload.onlyParams && Array.isArray(data.payload.files) && data.payload.files.length === 0) {
          setFiles([]); setColors([]); setOpacities([]); setVisibles([]); setRoughnesses([]); setMetalnesses([])
          prevFileKeysRef.current = []
          return
        }
        applyLivePayload(data.payload)
      }
    }
    window.addEventListener("message", onMsg)
    return () => window.removeEventListener("message", onMsg)
  }, [])

  // logo overlay
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

  // ref na root group v Canvasu
  const rootRef = useRef()

  // obsah sliderů (levý panel)
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

  // render root až když je vše načtené → žádný „malý → skok“
  const allLoaded = files.length > 0 && loadedCount === files.length
  const frameKey = allLoaded && !didInitialFrame ? `frame-${files.length}` : `no-frame-${files.length}`

  return (
    <div className="stage" style={{ position: "relative", width: "100vw", height: "100vh", background: "black" }}>
      <PreloadIcons />
      {logoEl}
      {sidebar}

      <Canvas
        orthographic
        camera={{ position: [0, 0, 400], near: 0.01, far: 100000, zoom: 1 }}
        gl={{ alpha: true }}
        onCreated={({ gl }) => gl.setClearAlpha(0)}
        style={{ position: "absolute", inset: 0, zIndex: 1, background: "transparent" }}
      >
        <>
          {/* Světla scény (slider ovládá přímo intenzitu) */}
          <ambientLight intensity={0.35 * sceneIntensity} />
          <directionalLight position={[0, 5, 5]} intensity={1.2 * sceneIntensity} />
          <directionalLight position={[-10, 0, 0]} intensity={0.9 * sceneIntensity} />
          <directionalLight position={[10, 0, 0]} intensity={1.0 * sceneIntensity} />
          <directionalLight position={[0, -5, -5]} intensity={0.7 * sceneIntensity} />

          {/* Headlight */}
          <Headlight enabled={headlightCfg.enabled} intensity={headlightCfg.intensity * highlightIntensity} />

          {/* Zobrazíme modely až po načtení všech */}
          {allLoaded ? (
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
                    smoothAngle={smoothAngle}
                    wireframe={wireframe}
                    roughness={roughnesses[i] ?? (typeof f.r === "number" ? f.r : 0.5)}
                    metalness={metalnesses[i] ?? (typeof f.m === "number" ? f.m : 0.5)}
                    useVertexColors={!!f.vc}
                    keepMaterials={!!f.km}
                  />
                ))}
              </Suspense>
            </group>
          ) : (
            files.length > 0 && <InlineLoader text="Načítám modely…" />
          )}

          {/* Jednorázové zarámování po načtení všech */}
          {allLoaded && !didInitialFrame && (
            <AutoCenterAndFrame
              rootRef={rootRef}
              triggerKey={frameKey}
              onFramed={() => setDidInitialFrame(true)}
              margin={1.12}
              isMobile={isMobile}
              desktopScale={1.0}
              mobileScale={1.0}
              centerMode={centerMode}
            />
          )}

          <TouchTrackballControls target={cameraTarget} />
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

      {/* Ovládání „Světla scéna“ nad levou stranou – připoj si na svůj UI */}
      <div style={{position:"absolute",left:430,top:94, width:320, pointerEvents:"none"}}>
        {/* jen placeholder – slider máš už ve svém UI; důležité je, že níže voláš setSceneIntensity */}
      </div>
    </div>
  )
}
