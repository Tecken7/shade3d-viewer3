"use client"

import { Canvas, useThree, useFrame } from "@react-three/fiber"
import * as THREE from "three"
import { Suspense, useEffect, useMemo, useRef, useState } from "react"
import { HexColorPicker, HexColorInput } from "react-colorful"
import { Html } from "@react-three/drei"
import { TrackballControls } from "three/examples/jsm/controls/TrackballControls"
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader"
import { STLLoader } from "three/examples/jsm/loaders/STLLoader"
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader"

/* ---------- Konstanty ---------- */
const LIVE_MSG_TYPES = new Set(["SHADE3D_LIVE", "SHADE3D_LIVE_V6", "SHADE3D_LIVE_V5"])

/* ---------- Ikony + preload ---------- */
const ICONS = {
  eye: "/icons/Eye.png",
  eyeOff: "/icons/Eye-off.png",
}
function PreloadIcons() {
  useEffect(() => {
    Object.values(ICONS).forEach((src) => {
      const img = new Image()
      img.decoding = "async"
      img.src = src
    })
  }, [])
  return null
}

/* ---------- Helpers ---------- */
const DEFAULT_LOGO = "/Arthetic_logo.png"
const stripExt = (s) => (s ? s.replace(/\.[^.]+$/, "") : "")
const clamp01 = (x) => Math.max(0, Math.min(1, x))
const getParam = (name) => {
  if (typeof window === "undefined") return null
  return new URL(window.location.href).searchParams.get(name)
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

/* ---------- Auto Smooth ---------- */
function autoSmoothGeometry(geometry, angleDeg = 30) {
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
  const keyOf = (ix) =>
    `${pos.getX(ix).toFixed(5)},${pos.getY(ix).toFixed(5)},${pos.getZ(ix).toFixed(5)}`
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
      <div style={{
        background: "rgba(0,0,0,0.7)",
        padding: "16px 28px",
        borderRadius: 10,
        color: "white",
        fontFamily: "sans-serif",
        fontSize: 16
      }}>
        ⏳ {text || "Načítám…"}
      </div>
    </Html>
  )
}

/* ---------- AnyModel ---------- */
function AnyModel({
  name, url,
  color, opacity, visible,
  onLoaded, autoSmooth, smoothAngle,
  roughness = 0.5, metalness = 0.5,
  useVertexColors = false,
  keepMaterials = false,
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
          setObject3D(obj)
          setLoading(false)
          onLoaded && onLoaded(obj)
        }
      } catch (e) {
        if (!cancelled) setLoading(false)
        console.error("Model load error:", e)
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ext])

  // AutoSmooth re-aplikace při změně
  useEffect(() => {
    if (!object3D) return
    object3D.traverse((child) => {
      if (!child.isMesh) return
      if (!child.userData._baseGeom) child.userData._baseGeom = child.geometry
      const base = child.userData._baseGeom

      let newGeom = base
      if (autoSmooth) newGeom = autoSmoothGeometry(base, smoothAngle)
      else {
        newGeom = base.clone()
        newGeom.computeVertexNormals()
      }

      if (child.userData._derivedGeom && child.userData._derivedGeom !== base) {
        child.userData._derivedGeom.dispose()
      }
      child.geometry = newGeom
      child.userData._derivedGeom = newGeom
    })
  }, [object3D, autoSmooth, smoothAngle])

  // Materiál a vzhled
  useEffect(() => {
    if (!object3D) return
    object3D.traverse((child) => {
      if (!child.isMesh) return
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
    })
  }, [object3D, color, opacity, roughness, metalness, useVertexColors, keepMaterials])

  if (!object3D) return loading ? <InlineLoader text={`Načítám ${name || url}`} /> : null
  return visible ? <primitive object={object3D} /> : null
}

/* ---------- Headlight ---------- */
function Headlight({ enabled = true, intensity = 2, color = "#ffffff" }) {
  const { camera } = useThree()
  const ref = useRef(null)
  useFrame(() => {
    if (ref.current) ref.current.position.copy(camera.position)
  })
  return (
    <pointLight ref={ref} color={color} intensity={enabled ? intensity : 0} distance={0} decay={0} />
  )
}

/* ---------- Trackball ---------- */
function TouchTrackballControls({ target = [0, 0, 0] }) {
  const { camera, gl } = useThree()
  const controlsRef = useRef(null)

  useEffect(() => {
    const controls = new TrackballControls(camera, gl.domElement)
    controls.rotateSpeed = 5.0
    controls.zoomSpeed = 1.2
    controls.panSpeed = 1.0
    controls.staticMoving = true
    controlsRef.current = controls
    const ts = (e) => { e.preventDefault(); controls.handleTouchStart(e) }
    const tm = (e) => { e.preventDefault(); controls.handleTouchMove(e) }
    gl.domElement.addEventListener("touchstart", ts, { passive: false })
    gl.domElement.addEventListener("touchmove", tm, { passive: false })
    return () => {
      gl.domElement.removeEventListener("touchstart", ts)
      gl.domElement.removeEventListener("touchmove", tm)
      controls.dispose()
    }
  }, [camera, gl])

  useEffect(() => {
    if (!controlsRef.current) return
    controlsRef.current.target.set(target[0], target[1], target[2])
    controlsRef.current.update()
  }, [target])

  useFrame(() => {
    if (!controlsRef.current) return
    if (camera.isOrthographicCamera) controlsRef.current.panSpeed = camera.zoom * 0.4
    controlsRef.current.update()
  })

  return null
}

/* ---------- Persist camera (anti-reset) ---------- */
function usePersistCamera(targetRef) {
  const { camera } = useThree()
  const saved = useRef(null)

  useFrame(() => {
    saved.current = {
      pos: [camera.position.x, camera.position.y, camera.position.z],
      zoom: camera.zoom ?? 1,
      target: targetRef.current ?? [0, 0, 0],
    }
  })

  useEffect(() => {
    const s = saved.current
    if (!s) return
    camera.position.set(...s.pos)
    if ("zoom" in camera) {
      camera.zoom = s.zoom
      camera.updateProjectionMatrix()
    }
  }, [camera])
}

function PersistCameraBridge({ targetRef }) {
  usePersistCamera(targetRef)
  return null
}

/* ---------- AutoCenter & AutoFrame ---------- */
function AutoCenterAndFrame({
  rootRef, depsKey, setTarget,
  margin = 1.2, isMobile = false, desktopScale = 0.4, mobileScale = 1.0,
  centerMode = "combined",
  shouldFrame,
}) {
  const { camera, size } = useThree()

  useEffect(() => {
    if (!shouldFrame?.current) return

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

    const diag = Math.sqrt(dims2.x * dims2.x + dims2.y * dims2.y + dims2.z * dims2.z)
    const safeDist = Math.max(diag * 2.5, 1000)

    camera.near = 0.1
    camera.far = Math.max(safeDist * 10, 1e6)
    camera.zoom = Math.max(newZoom, 0.01)
    camera.position.set(ctr.x, ctr.y, ctr.z + safeDist)
    camera.updateProjectionMatrix()

    shouldFrame.current = false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depsKey, size.width, size.height, isMobile, desktopScale, mobileScale, margin, centerMode])

  return null
}

/* ---------- Color popover (UI) ---------- */
function ColorSwatch({ color, onChange, ariaLabel }) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef(null)
  useEffect(() => {
    const onDocClick = (e) => { if (open && containerRef.current && !containerRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener("mousedown", onDocClick)
    return () => document.removeEventListener("mousedown", onDocClick)
  }, [open])
  return (
    <div ref={containerRef} className="swatch-wrap" style={{ position: "relative", display: "inline-block" }}>
      <button
        aria-label={ariaLabel || "color picker"}
        onClick={() => setOpen((v) => !v)}
        className="swatch-btn"
        style={{ width: 36, height: 22, borderRadius: 4, border: "1px solid #fff", background: color, cursor: "pointer", boxShadow: "0 0 0 1px rgba(0,0,0,.25) inset" }}
      />
      {open && (
        <div className="swatch-pop" style={{ position: "absolute", zIndex: 20, top: 28, left: 0, background: "rgba(0,0,0,.92)", padding: 12, borderRadius: 10, border: "1px solid rgba(255,255,255,.18)", backdropFilter: "blur(4px)", boxShadow: "0 6px 24px rgba(0,0,0,.35)" }}>
          <HexColorPicker color={color} onChange={onChange} />
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
            <span style={{ color: "#fff", fontSize: 12 }}>#</span>
            <HexColorInput color={color} onChange={onChange} prefixed={false} style={{ width: 90, padding: "4px 6px", borderRadius: 6, border: "1px solid #444", background: "#111", color: "#fff", fontFamily: "monospace", fontSize: 12 }} />
          </div>
        </div>
      )}
    </div>
  )
}

/* ---------- ClientPage (Viewer) ---------- */
export default function ClientPage() {
  // světla – pevné, ovládání přes manifest/URL/live
  const [lightIntensity, setLightIntensity] = useState(1)
  const [headlightCfg, setHeadlightCfg] = useState({ enabled: true, intensity: 2.0 })

  const [uiReady, setUiReady] = useState(false)
  useEffect(() => { const id = requestAnimationFrame(() => setUiReady(true)); return () => cancelAnimationFrame(id) }, [])

  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    const uaMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    const coarse = typeof window !== "undefined" && window.matchMedia && window.matchMedia("(pointer: coarse)").matches
    const narrow = typeof window !== "undefined" && window.innerWidth < 768
    setIsMobile(uaMobile || coarse || narrow)
  }, [])

  const [title, setTitle] = useState(null)

  // modely
  const [files, setFiles] = useState([])
  const [colors, setColors] = useState([])
  const [opacities, setOpacities] = useState([])
  const [visibles, setVisibles] = useState([])
  const [roughnesses, setRoughnesses] = useState([])
  const [metalnesses, setMetalnesses] = useState([])
  const [fatal, setFatal] = useState(null)

  // auto smooth
  const [autoSmooth, setAutoSmooth] = useState((getParam("smooth") ?? "1") !== "0")
  const [smoothAngle, setSmoothAngle] = useState(() => {
    const v = parseFloat(getParam("smoothAngle") ?? "30")
    return isFinite(v) ? Math.max(0, Math.min(80, v)) : 30
  })

  const [logoCfg, setLogoCfg] = useState({ url: DEFAULT_LOGO, opacity: 0.9, width: 160, pos: "bc" })

  // camera
  const [loadedCount, setLoadedCount] = useState(0)
  const handleModelLoaded = () => setLoadedCount((n) => n + 1)

  const centerParam = (getParam("center") || "combined").toLowerCase()
  const centerMode = ["per", "combined", "none"].includes(centerParam) ? centerParam : "combined"

  // frame control
  const shouldFrameRef = useRef(true)
  const prevFileKeysRef = useRef([])
  const getFileKeys = (arr) => (arr || []).map(f => `${f.url}::${f.rawName || f.name}`)

  // NEW: frame verze – reframe jen při změně files
  const frameVersionRef = useRef(0)
  const [frameDepsKey, setFrameDepsKey] = useState(`frame-0`)
  const bumpFrameVersion = () => {
    frameVersionRef.current += 1
    setFrameDepsKey(`frame-${frameVersionRef.current}`)
  }

  /* ───────── init from params/manifest (NO DEMO FALLBACK) ───────── */
  useEffect(() => {
    ;(async () => {
      try {
        const manifestUrl = getParam("manifest")
        const filesParam = getParam("files")
        const mode = (getParam("mode") || "").toLowerCase()
        const noDemo = (getParam("noDemo") ?? (mode === "live" ? "1" : "0")) !== "0"

        if (manifestUrl) {
          const m = await fetchJSON(manifestUrl)
          const Fs = (m?.files || []).map((x, i) => ({
            url: x.u, name: stripExt(x.n) || `Model ${i + 1}`, rawName: x.n,
            c: x.c, o: typeof x.o === "number" ? clamp01(x.o) : 1,
            v: typeof x.v === "boolean" ? x.v : true,
            r: typeof x.r === "number" ? clamp01(x.r) : 0.5,
            m: typeof x.m === "number" ? clamp01(x.m) : 0.5,
            vc: !!x.vc, km: !!x.km,
          }))
          setFiles(Fs)
          const palette = ["#f5f5dc", "#8e8e8e", "#ffffff", "#ffd7a8", "#c0c0c0", "#e6f0ff", "#ffeedd"]
          setColors(Fs.map((f, i) => f.c || palette[i % palette.length]))
          setOpacities(Fs.map((f) => f.o))
          setVisibles(Fs.map((f) => f.v))
          setRoughnesses(Fs.map((f) => f.r))
          setMetalnesses(Fs.map((f) => f.m))

          setTitle(typeof m?.title === "string" ? m.title : (getParam("title") ?? null))
          const logoUrl = m?.logo?.url || DEFAULT_LOGO
          setLogoCfg({
            url: logoUrl || null,
            opacity: clamp01(parseFloat(getParam("logoOpacity") ?? "0.9")),
            width: parseInt(getParam("logoWidth") ?? (window.innerWidth < 768 ? "120" : "160"), 10),
            pos: getParam("logoPos") || "bc",
          })

          const hl = m?.lights?.headlight
          if (hl && typeof hl === "object") setHeadlightCfg({
            enabled: typeof hl.enabled === "boolean" ? hl.enabled : true,
            intensity: typeof hl.intensity === "number" ? hl.intensity : 2.0,
          })
          const scI = m?.lights?.intensity
          if (typeof scI === "number") setLightIntensity(scI)

          const newKeys = getFileKeys(Fs)
          prevFileKeysRef.current = newKeys
          shouldFrameRef.current = true
          bumpFrameVersion()
          return
        }

        if (filesParam) {
          let arr = null
          try { arr = JSON.parse(filesParam) } catch {}
          if (!arr) { try { arr = JSON.parse(decodeURIComponent(filesParam)) } catch {} }
          const Fs = (Array.isArray(arr) ? arr : []).filter((x) => x && x.u).map((x, i) => ({
            url: x.u, name: stripExt(x.n) || `Model ${i + 1}`, rawName: x.n,
            c: x.c, o: typeof x.o === "number" ? clamp01(x.o) : 1,
            v: typeof x.v === "boolean" ? x.v : true,
            r: typeof x.r === "number" ? clamp01(x.r) : 0.5,
            m: typeof x.m === "number" ? clamp01(x.m) : 0.5,
            vc: !!x.vc, km: !!x.km,
          }))
          setFiles(Fs)
          const palette = ["#f5f5dc", "#8e8e8e", "#ffffff", "#ffd7a8", "#c0c0c0", "#e6f0ff", "#ffeedd"]
          setColors(Fs.map((f, i) => f.c || palette[i % palette.length]))
          setOpacities(Fs.map((f) => f.o))
          setVisibles(Fs.map((f) => f.v))
          setRoughnesses(Fs.map((f) => f.r))
          setMetalnesses(Fs.map((f) => f.m))

          setTitle(getParam("title") ?? null)
          setLogoCfg({
            url: getParam("logo") === "none" ? null : getParam("logo") || DEFAULT_LOGO,
            opacity: clamp01(parseFloat(getParam("logoOpacity") ?? "0.9")),
            width: parseInt(getParam("logoWidth") ?? (window.innerWidth < 768 ? "120" : "160"), 10),
            pos: getParam("logoPos") || "bc",
          })

          const qOn = getParam("headlight")
          const qI = parseFloat(getParam("headlightI") ?? "NaN")
          setHeadlightCfg({ enabled: qOn == null ? true : qOn !== "0", intensity: isFinite(qI) ? qI : 2.0 })

          const scI = parseFloat(getParam("li") ?? "NaN")
          if (isFinite(scI)) setLightIntensity(scI)

          const newKeys = getFileKeys(Fs)
          prevFileKeysRef.current = newKeys
          shouldFrameRef.current = true
          bumpFrameVersion()
          return
        }

        // žádné manifest/parametry → v live režimu nebo s ?noDemo=1 necháváme prázdno
        const modeLive = mode === "live"
        const suppressDemo = noDemo || modeLive
        if (suppressDemo) {
          setFiles([]); setColors([]); setOpacities([]); setVisibles([]); setRoughnesses([]); setMetalnesses([])
          setTitle(getParam("title") ?? null)
          setLogoCfg({
            url: getParam("logo") === "none" ? null : (getParam("logo") || DEFAULT_LOGO),
            opacity: clamp01(parseFloat(getParam("logoOpacity") ?? "0.9")),
            width: parseInt(getParam("logoWidth") ?? (window.innerWidth < 768 ? "120" : "160"), 10),
            pos: getParam("logoPos") || "bc",
          })
          shouldFrameRef.current = false // počkáme na live payload
          return
        }

        // pokud opravdu chceš DEMO (nezadávej v produkci) → můžeš si sem ručně doplnit
        setFiles([]); setColors([]); setOpacities([]); setVisibles([]); setRoughnesses([]); setMetalnesses([])
      } catch (e) {
        console.error(e)
        setFatal("Tento náhled není dostupný (chyba při načtení dat).")
      }
    })()
  }, [])

  /* ───────── LIVE MODE: postMessage listener ───────── */
  const applyLivePayload = (p) => {
    if (!p) return

    let filesActuallyChanged = false
    if (Array.isArray(p.files)) {
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
      filesActuallyChanged =
        newKeys.length !== prevKeys.length ||
        newKeys.some((k, i) => k !== prevKeys[i])

      setFiles(newFiles)
      prevFileKeysRef.current = newKeys

      const palette = ["#f5f5dc", "#8e8e8e", "#ffffff", "#ffd7a8", "#c0c0c0", "#e6f0ff", "#ffeedd"]
      setColors(newFiles.map((f, i) => f.c || palette[i % palette.length]))
      setOpacities(newFiles.map((f) => f.o))
      setVisibles(newFiles.map((f) => f.v))
      setRoughnesses(newFiles.map((f) => f.r))
      setMetalnesses(newFiles.map((f) => f.m))
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
    if (filesActuallyChanged) {
      setLoadedCount(0)
      bumpFrameVersion()
    }
  }

  useEffect(() => {
    const onMsg = (e) => {
      const data = e.data
      if (data && LIVE_MSG_TYPES.has(data.type) && data.payload) {
        // Pokud Framer po načtení pošle explicitně „vyprázdni“
        if (Array.isArray(data.payload.files) && data.payload.files.length === 0) {
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

  // LOGO – pod modelem (z-index 0, Canvas má 1, UI má 2)
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

  // jediný zdroj pravdy pro target kamery
  const [cameraTarget, setCameraTarget] = useState([0, 0, 0])
  const cameraTargetRef = useRef([0, 0, 0])
  useEffect(() => { cameraTargetRef.current = cameraTarget }, [cameraTarget])

  const fillDim = headlightCfg.enabled ? 0.5 : 1

  return (
    <div
      className="stage"
      style={{ position: "relative", width: "100vw", height: "100vh", background: "black" }}
    >
      <PreloadIcons />
      {logoEl}

      {/* Panel (jen titul + autosmooth pro demo UI) */}
      <div
        className="controls-panel"
        style={{
          position: "absolute",
          top: 10, left: 10, zIndex: 2,
          color: "white", fontFamily: "sans-serif", fontSize: "14px",
          opacity: uiReady ? 1 : 0, transition: "opacity .12s ease",
          backdropFilter: "blur(3px)", background: "rgba(0,0,0,.25)",
          border: "1px solid rgba(255,255,255,.15)", borderRadius: 8,
          padding: "8px 10px", width: "clamp(240px, 30vw, 420px)",
          maxWidth: "calc(100vw - 20px)", boxSizing: "border-box",
        }}
      >
        {fatal ? (
          <div style={{ color: "#ff8b8b" }}>{fatal}</div>
        ) : (
          <>
            {title && (
              <div
                title={title}
                style={{
                  marginBottom: 8, maxWidth: 280, padding: "6px 10px",
                  borderRadius: 8, border: "1px solid rgba(255,255,255,.18)",
                  background: "rgba(255,255,255,.08)", fontSize: 13, fontWeight: 600,
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"
                }}
              >
                {title}
              </div>
            )}

            {/* AutoSmooth */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, justifyContent: "flex-end" }}>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                <input type="checkbox" checked={autoSmooth} onChange={(e) => setAutoSmooth(e.target.checked)} />
                <span>Auto smooth</span>
              </label>
              <span style={{ opacity: 0.8, fontSize: 12 }}>Úhel: {Math.round(smoothAngle)}°</span>
              <input className="slider" type="range" min={0} max={80} step={1} value={smoothAngle} onChange={(e) => setSmoothAngle(parseFloat(e.target.value))} style={{ width: 120 }} />
            </div>
          </>
        )}
      </div>

      {/* CANVAS */}
      <Canvas
        orthographic
        camera={{ position: [0, 0, 1000], near: 0.1, far: 1e7 }}
        gl={{ alpha: true }}
        onCreated={({ gl }) => gl.setClearAlpha(0)}
        style={{ position: "absolute", inset: 0, zIndex: 1, background: "transparent" }}
      >
        {!fatal && (
          <>
            <ambientLight intensity={lightIntensity * 0.4 * (headlightCfg.enabled ? 0.5 : 1)} />
            <directionalLight position={[0, 5, 5]} intensity={lightIntensity * 1.5 * (headlightCfg.enabled ? 0.5 : 1)} />
            <directionalLight position={[-10, 0, 0]} intensity={lightIntensity * 1.0 * (headlightCfg.enabled ? 0.5 : 1)} />
            <directionalLight position={[10, 0, 0]} intensity={lightIntensity * 1.2 * (headlightCfg.enabled ? 0.5 : 1)} />
            <directionalLight position={[0, -5, -5]} intensity={lightIntensity * 0.8 * (headlightCfg.enabled ? 0.5 : 1)} />

            <Headlight enabled={headlightCfg.enabled} intensity={headlightCfg.intensity} />

            {/* perzistence kamery */}
            <PersistCameraBridge targetRef={cameraTargetRef} />

            <group ref={rootRef}>
              <Suspense fallback={null}>
                {files.map((f, i) => (
                  <AnyModel
                    key={i}
                    name={f.rawName || f.name}
                    url={f.url}
                    color={colors[i] ?? "#ffffff"}
                    opacity={opacities[i] ?? 1}
                    visible={visibles[i] ?? true}
                    onLoaded={handleModelLoaded}
                    autoSmooth={autoSmooth}
                    smoothAngle={smoothAngle}
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
              depsKey={frameDepsKey}           {/* <- jen verze, žádný loadedCount ani files.length */}
              setTarget={setCameraTarget}
              margin={1.2}
              isMobile={isMobile}
              desktopScale={0.4}
              mobileScale={1.0}
              centerMode={centerMode}
              shouldFrame={shouldFrameRef}
            />

            <TouchTrackballControls target={cameraTarget} />
          </>
        )}
      </Canvas>

      {/* Globální styly */}
      <style jsx global>{`
        .slider { appearance: none; height: 14px; background: transparent; margin: 5px 0; display: inline-block; }
        .slider::-webkit-slider-runnable-track { height: 4px; background: white; border-radius: 2px; }
        .slider::-webkit-slider-thumb { appearance: none; width: 14px; height: 14px; border-radius: 50%; background: white; cursor: pointer; box-shadow: 0 0 2px black; margin-top: -5px; }
        .slider::-moz-range-track { height: 4px; background: white; border-radius: 2px; }
        .slider::-moz-range-thumb { width: 14px; height: 14px; border-radius: 50%; background: white; cursor: pointer; box-shadow: 0 0 2px black; border: none; }

        @media (max-width: 720px) {
          .controls-panel {
            left: 8px !important;
            right: 8px;
            width: auto !important;
            max-width: calc(100vw - 16px) !important;
          }
        }
      `}</style>
    </div>
  )
}
