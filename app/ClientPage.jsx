"use client"

import { Canvas, useThree, useFrame } from "@react-three/fiber"
import * as THREE from "three"
import { Suspense, useEffect, useMemo, useRef, useState } from "react"
import { Html } from "@react-three/drei"
import { TrackballControls } from "three/examples/jsm/controls/TrackballControls"
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader"
import { STLLoader } from "three/examples/jsm/loaders/STLLoader"
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader"

/* ---------- Konstanty ---------- */
const LIVE_MSG_TYPES = new Set(["SHADE3D_LIVE", "SHADE3D_LIVE_V6", "SHADE3D_LIVE_V5"])
const DEFAULT_LOGO = "/Arthetic_logo.png"

/* ---------- Helpers ---------- */
const clamp01 = (x) => Math.max(0, Math.min(1, x))
const stripExt = (s) => (s ? s.replace(/\.[^.]+$/, "") : "")
const inferExt = (s) => (s ? s.split("?")[0].split(".").pop()?.toLowerCase() || "" : "")
const getParam = (name) => (typeof window === "undefined" ? null : new URL(window.location.href).searchParams.get(name))

async function fetchJSON(url) {
  const r = await fetch(url, { cache: "no-store" })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

/* ---------- UI ---------- */
function InlineLoader({ text }) {
  return (
    <Html center>
      <div
        style={{
          background: "rgba(0,0,0,0.7)",
          padding: "12px 16px",
          borderRadius: 10,
          color: "white",
          fontFamily: "sans-serif",
          fontSize: 15,
        }}
      >
        ⏳ {text || "Načítám…"}
      </div>
    </Html>
  )
}

/* ---------- Auto smooth (rychlá verze) ---------- */
function autoSmoothGeometry(geometry) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry.clone()
  g.computeVertexNormals()
  g.computeBoundingBox()
  g.computeBoundingSphere()
  return g
}

/* ---------- Model ---------- */
function AnyModel({
  name,
  url,
  color,
  opacity,
  visible,
  onLoaded,
  autoSmooth,
  roughness = 0.5,
  metalness = 0.5,
  useVertexColors = false,
}) {
  const [object3D, setObject3D] = useState(null)
  const [loading, setLoading] = useState(true)

  // KLÍČOVÉ: vyber příponu primárně z názvu (Framer posílá data: URL bez přípony)
  const ext = useMemo(() => inferExt(name) || inferExt(url), [name, url])

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    ;(async () => {
      try {
        let obj

        if (ext === "stl") {
          const geom = await new STLLoader().loadAsync(url)
          const base = autoSmooth ? autoSmoothGeometry(geom) : geom
          obj = new THREE.Mesh(
            base,
            new THREE.MeshStandardMaterial({
              color: new THREE.Color(color || "#ffffff"),
              roughness,
              metalness,
              transparent: opacity < 1,
              opacity,
              side: THREE.DoubleSide,
              depthWrite: opacity === 1,
            })
          )
        } else if (ext === "ply") {
          const geom = await new PLYLoader().loadAsync(url)
          if (!geom.attributes.normal) geom.computeVertexNormals()
          const base = autoSmooth ? autoSmoothGeometry(geom) : geom
          obj = new THREE.Mesh(
            base,
            new THREE.MeshStandardMaterial({
              color: new THREE.Color(color || "#ffffff"),
              roughness,
              metalness,
              transparent: opacity < 1,
              opacity,
              side: THREE.DoubleSide,
              depthWrite: opacity === 1,
              vertexColors: !!useVertexColors && !!geom.getAttribute("color"),
            })
          )
        } else {
          // defaultně OBJ
          const loaded = await new OBJLoader().loadAsync(url)
          loaded.traverse((child) => {
            if (child.isMesh) {
              if (!child.geometry.attributes.normal) child.geometry.computeVertexNormals()
              child.material = new THREE.MeshStandardMaterial({
                color: new THREE.Color(color || "#ffffff"),
                roughness,
                metalness,
                transparent: opacity < 1,
                opacity,
                side: THREE.DoubleSide,
                depthWrite: opacity === 1,
              })
            }
          })
          obj = loaded
        }

        if (!cancelled) {
          setObject3D(obj)
          setLoading(false)
          onLoaded?.(obj)
        }
      } catch (e) {
        console.error("Model load error:", e)
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
    // re-load jen když se změní zdroj
  }, [url, name, ext])

  // živá změna materiálu
  useEffect(() => {
    if (!object3D) return
    object3D.traverse((child) => {
      if (!child.isMesh || !child.material) return
      child.material.color.set(color || "#ffffff")
      child.material.transparent = opacity < 1
      child.material.opacity = opacity
      child.material.roughness = typeof roughness === "number" ? roughness : 0.5
      child.material.metalness = typeof metalness === "number" ? metalness : 0.5
      child.material.needsUpdate = true
    })
  }, [object3D, color, opacity, roughness, metalness])

  if (!object3D) return loading ? <InlineLoader text={`Načítám ${name || url}`} /> : null
  return visible ? <primitive object={object3D} /> : null
}

/* ---------- Headlight ---------- */
function Headlight({ enabled = true, intensity = 2 }) {
  const { camera } = useThree()
  const ref = useRef(null)
  useFrame(() => {
    if (ref.current) ref.current.position.copy(camera.position)
  })
  return <pointLight ref={ref} intensity={enabled ? intensity : 0} color="#fff" distance={0} decay={0} />
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
    return () => controls.dispose()
  }, [camera, gl])
  useEffect(() => {
    controlsRef.current?.target.set(target[0], target[1], target[2])
    controlsRef.current?.update()
  }, [target])
  useFrame(() => controlsRef.current?.update())
  return null
}

/* ---------- AutoFrame (jen při změně files) ---------- */
function AutoFrame({ rootRef, triggerRef, setTarget }) {
  const { camera, size } = useThree()
  useEffect(() => {
    if (!triggerRef.current) return
    triggerRef.current = false

    const root = rootRef.current
    if (!root) return
    root.updateWorldMatrix(true, true)
    const box = new THREE.Box3().setFromObject(root)
    if (box.isEmpty()) return

    const center = new THREE.Vector3()
    const dims = new THREE.Vector3()
    box.getCenter(center)
    box.getSize(dims)

    // centrování do [0,0,0]
    root.position.sub(center)
    setTarget([0, 0, 0])

    const margin = 1.2
    const objW = Math.max(dims.x, 1e-6) * margin
    const objH = Math.max(dims.y, 1e-6) * margin
    const zoomX = size.width / objW
    const zoomY = size.height / objH
    const newZoom = Math.max(Math.min(zoomX, zoomY) * 0.9, 0.01)

    camera.near = 0.1
    camera.far = Math.max(dims.length() * 10, 10000)
    camera.position.set(0, 0, Math.max(dims.z * 3, 1000))
    camera.zoom = newZoom
    camera.updateProjectionMatrix()
  }, [size.width, size.height])
  return null
}

/* ======================================================================= */

export default function ClientPage() {
  // světla
  const [lightIntensity, setLightIntensity] = useState(1)
  const [headlightCfg, setHeadlightCfg] = useState({ enabled: true, intensity: 2 })

  // UI – autosmooth
  const [autoSmooth, setAutoSmooth] = useState((getParam("smooth") ?? "1") !== "0")
  const [smoothAngle, setSmoothAngle] = useState(() => {
    const v = parseFloat(getParam("smoothAngle") ?? "30")
    return isFinite(v) ? Math.max(0, Math.min(80, v)) : 30
  })

  // metadata
  const [title, setTitle] = useState(null)
  const [fatal, setFatal] = useState(null)

  // modely + per-file parametry
  const [files, setFiles] = useState([]) // [{url, name, rawName}]
  const [colors, setColors] = useState([])
  const [opacities, setOpacities] = useState([])
  const [visibles, setVisibles] = useState([])
  const [roughnesses, setRoughnesses] = useState([])
  const [metalnesses, setMetalnesses] = useState([])

  // logo
  const [logoCfg, setLogoCfg] = useState({ url: DEFAULT_LOGO, opacity: 0.9, width: 160, pos: "bc" })

  // frame control
  const frameTriggerRef = useRef(true)

  // refs pro „aktuální“ hodnoty (aby listener neměl stale stav)
  const filesRef = useRef(files)
  const colorsRef = useRef(colors)
  const opacRef = useRef(opacities)
  const visRef = useRef(visibles)
  const roughRef = useRef(roughnesses)
  const metalRef = useRef(metalnesses)

  useEffect(() => { filesRef.current = files }, [files])
  useEffect(() => { colorsRef.current = colors }, [colors])
  useEffect(() => { opacRef.current = opacities }, [opacities])
  useEffect(() => { visRef.current = visibles }, [visibles])
  useEffect(() => { roughRef.current = roughnesses }, [roughnesses])
  useEffect(() => { metalRef.current = metalnesses }, [metalnesses])

  const keyOf = (f) => `${f.url}::${f.rawName || f.name}`
  const buildIndexByKey = (arr) => {
    const map = new Map()
    arr.forEach((f, i) => map.set(keyOf(f), i))
    return map
  }

  // init z manifestu / query
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
            url: x.u,
            name: stripExt(x.n) || `Model ${i + 1}`,
            rawName: x.n,
            c: x.c,
            o: typeof x.o === "number" ? clamp01(x.o) : 1,
            v: typeof x.v === "boolean" ? x.v : true,
            r: typeof x.r === "number" ? clamp01(x.r) : 0.5,
            m: typeof x.m === "number" ? clamp01(x.m) : 0.5,
            vc: !!x.vc,
            km: !!x.km,
          }))

          setFiles(Fs)
          const palette = ["#f5f5dc", "#8e8e8e", "#ffffff", "#ffd7a8", "#c0c0c0", "#e6f0ff", "#ffeedd"]
          setColors(Fs.map((f, i) => f.c || palette[i % palette.length]))
          setOpacities(Fs.map((f) => f.o))
          setVisibles(Fs.map((f) => f.v))
          setRoughnesses(Fs.map((f) => f.r))
          setMetalnesses(Fs.map((f) => f.m))

          setTitle(typeof m?.title === "string" ? m.title : (getParam("title") ?? null))

          const hl = m?.lights?.headlight
          if (hl && typeof hl === "object") {
            setHeadlightCfg({
              enabled: typeof hl.enabled === "boolean" ? hl.enabled : true,
              intensity: typeof hl.intensity === "number" ? hl.intensity : 2,
            })
          }
          if (typeof m?.lights?.intensity === "number") setLightIntensity(m.lights.intensity)

          const logoUrl = m?.logo?.url || DEFAULT_LOGO
          setLogoCfg({
            url: logoUrl || null,
            opacity: clamp01(parseFloat(getParam("logoOpacity") ?? "0.9")),
            width: parseInt(
              getParam("logoWidth") ?? (typeof window !== "undefined" && window.innerWidth < 768 ? "120" : "160"),
              10
            ),
            pos: getParam("logoPos") || "bc",
          })

          frameTriggerRef.current = true
          return
        }

        if (filesParam) {
          let arr = null
          try {
            arr = JSON.parse(filesParam)
          } catch {}
          if (!arr) {
            try {
              arr = JSON.parse(decodeURIComponent(filesParam))
            } catch {}
          }
          const Fs = (Array.isArray(arr) ? arr : [])
            .filter((x) => x && x.u)
            .map((x, i) => ({
              url: x.u,
              name: stripExt(x.n) || `Model ${i + 1}`,
              rawName: x.n,
              c: x.c,
              o: typeof x.o === "number" ? clamp01(x.o) : 1,
              v: typeof x.v === "boolean" ? x.v : true,
              r: typeof x.r === "number" ? clamp01(x.r) : 0.5,
              m: typeof x.m === "number" ? clamp01(x.m) : 0.5,
              vc: !!x.vc,
              km: !!x.km,
            }))

          setFiles(Fs)
          const palette = ["#f5f5dc", "#8e8e8e", "#ffffff", "#ffd7a8", "#c0c0c0", "#e6f0ff", "#ffeedd"]
          setColors(Fs.map((f, i) => f.c || palette[i % palette.length]))
          setOpacities(Fs.map((f) => f.o))
          setVisibles(Fs.map((f) => f.v))
          setRoughnesses(Fs.map((f) => f.r))
          setMetalnesses(Fs.map((f) => f.m))

          setTitle(getParam("title") ?? null)
          const qOn = getParam("headlight")
          const qI = parseFloat(getParam("headlightI") ?? "NaN")
          setHeadlightCfg({ enabled: qOn == null ? true : qOn !== "0", intensity: isFinite(qI) ? qI : 2 })
          const scI = parseFloat(getParam("li") ?? "NaN")
          if (isFinite(scI)) setLightIntensity(scI)

          setLogoCfg({
            url: getParam("logo") === "none" ? null : getParam("logo") || DEFAULT_LOGO,
            opacity: clamp01(parseFloat(getParam("logoOpacity") ?? "0.9")),
            width: parseInt(
              getParam("logoWidth") ?? (typeof window !== "undefined" && window.innerWidth < 768 ? "120" : "160"),
              10
            ),
            pos: getParam("logoPos") || "bc",
          })

          frameTriggerRef.current = true
          return
        }

        const modeLive = (getParam("mode") || "").toLowerCase() === "live"
        const suppressDemo = noDemo || modeLive
        if (suppressDemo) {
          setFiles([])
          setColors([])
          setOpacities([])
          setVisibles([])
          setRoughnesses([])
          setMetalnesses([])
          setTitle(getParam("title") ?? null)
          setLogoCfg({
            url: getParam("logo") === "none" ? null : getParam("logo") || DEFAULT_LOGO,
            opacity: clamp01(parseFloat(getParam("logoOpacity") ?? "0.9")),
            width: parseInt(
              getParam("logoWidth") ?? (typeof window !== "undefined" && window.innerWidth < 768 ? "120" : "160"),
              10
            ),
            pos: getParam("logoPos") || "bc",
          })
          // čekáme na live payload
          frameTriggerRef.current = false
        }
      } catch (e) {
        console.error(e)
        setFatal("Tento náhled není dostupný (chyba při načtení dat).")
      }
    })()
  }, [])

  /* ---------- LIVE: postMessage listener (robust) ---------- */
  useEffect(() => {
    const onMsg = (e) => {
      const data = e.data
      if (!(data && LIVE_MSG_TYPES.has(data.type) && data.payload)) return
      const p = data.payload

      // 1) pouze světla
      if (p.onlyLights && p.lights) {
        if (typeof p.lights.intensity === "number") setLightIntensity(p.lights.intensity)
        if (p.lights.headlight) {
          setHeadlightCfg((old) => ({
            enabled: typeof p.lights.headlight.enabled === "boolean" ? p.lights.headlight.enabled : old.enabled,
            intensity: typeof p.lights.headlight.intensity === "number" ? p.lights.headlight.intensity : old.intensity,
          }))
        }
        return
      }

      // 2) pouze parametry → když files ještě nemáme, povyš na plný payload
      if (p.onlyParams) {
        const currFiles = filesRef.current
        if ((!currFiles || currFiles.length === 0) && Array.isArray(p.files) && p.files.length > 0) {
          // inicializace z onlyParams
          const newFiles = p.files.map((x, i) => ({
            url: x.u,
            name: stripExt(x.n || `Model ${i + 1}`),
            rawName: x.n || `Model${i + 1}`,
            c: x.c,
            o: typeof x.o === "number" ? clamp01(x.o) : 1,
            v: typeof x.v === "boolean" ? x.v : true,
            r: typeof x.r === "number" ? clamp01(x.r) : 0.5,
            m: typeof x.m === "number" ? clamp01(x.m) : 0.5,
            vc: !!x.vc,
            km: !!x.km,
          }))
          setFiles(newFiles)
          const palette = ["#f5f5dc", "#8e8e8e", "#ffffff", "#ffd7a8", "#c0c0c0", "#e6f0ff", "#ffeedd"]
          setColors(newFiles.map((f, i) => f.c || palette[i % palette.length]))
          setOpacities(newFiles.map((f) => f.o))
          setVisibles(newFiles.map((f) => f.v))
          setRoughnesses(newFiles.map((f) => f.r))
          setMetalnesses(newFiles.map((f) => f.m))
          frameTriggerRef.current = true // poprvé přerámuj
        } else if (Array.isArray(p.files) && p.files.length > 0) {
          // máme files → jen přepiš parametry (bez přerámování)
          const idxByKey = buildIndexByKey(filesRef.current)
          const C = [...colorsRef.current]
          const O = [...opacRef.current]
          const V = [...visRef.current]
          const R = [...roughRef.current]
          const M = [...metalRef.current]
          for (const x of p.files) {
            const k = `${x.u}::${x.n || x.name || ""}`
            const i = idxByKey.get(k)
            if (i == null) continue
            if (x.c != null) C[i] = x.c
            if (typeof x.o === "number") O[i] = clamp01(x.o)
            if (typeof x.v === "boolean") V[i] = !!x.v
            if (typeof x.r === "number") R[i] = clamp01(x.r)
            if (typeof x.m === "number") M[i] = clamp01(x.m)
          }
          setColors(C)
          setOpacities(O)
          setVisibles(V)
          setRoughnesses(R)
          setMetalnesses(M)
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
        return
      }

      // 3) plný payload (změna / doplnění modelů)
      if (Array.isArray(p.files)) {
        const newFiles = p.files.map((x, i) => ({
          url: x.u,
          name: stripExt(x.n || `Model ${i + 1}`),
          rawName: x.n || `Model${i + 1}`,
          c: x.c,
          o: typeof x.o === "number" ? clamp01(x.o) : 1,
          v: typeof x.v === "boolean" ? x.v : true,
          r: typeof x.r === "number" ? clamp01(x.r) : 0.5,
          m: typeof x.m === "number" ? clamp01(x.m) : 0.5,
          vc: !!x.vc,
          km: !!x.km,
        }))

        const oldKeys = (filesRef.current || []).map(keyOf)
        const newKeys = newFiles.map(keyOf)
        const changed = newKeys.length !== oldKeys.length || newKeys.some((k, i) => k !== oldKeys[i])

        if (changed) {
          setFiles(newFiles)
          const palette = ["#f5f5dc", "#8e8e8e", "#ffffff", "#ffd7a8", "#c0c0c0", "#e6f0ff", "#ffeedd"]
          setColors(newFiles.map((f, i) => f.c || palette[i % palette.length]))
          setOpacities(newFiles.map((f) => f.o))
          setVisibles(newFiles.map((f) => f.v))
          setRoughnesses(newFiles.map((f) => f.r))
          setMetalnesses(newFiles.map((f) => f.m))
          frameTriggerRef.current = true
        } else {
          const idxByKey = buildIndexByKey(filesRef.current)
          const C = [...colorsRef.current]
          const O = [...opacRef.current]
          const V = [...visRef.current]
          const R = [...roughRef.current]
          const M = [...metalRef.current]
          for (const f of newFiles) {
            const i = idxByKey.get(keyOf(f))
            if (i == null) continue
            if (f.c != null) C[i] = f.c
            if (typeof f.o === "number") O[i] = f.o
            if (typeof f.v === "boolean") V[i] = f.v
            if (typeof f.r === "number") R[i] = f.r
            if (typeof f.m === "number") M[i] = f.m
          }
          setColors(C)
          setOpacities(O)
          setVisibles(V)
          setRoughnesses(R)
          setMetalnesses(M)
        }
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
    }

    window.addEventListener("message", onMsg)
    return () => window.removeEventListener("message", onMsg)
  }, [])

  // canvas target
  const rootRef = useRef()
  const [cameraTarget, setCameraTarget] = useState([0, 0, 0])

  // jednoduché UI pro AutoSmooth
  const [uiReady, setUiReady] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setUiReady(true))
    return () => cancelAnimationFrame(id)
  }, [])

  return (
    <div style={{ position: "relative", width: "100vw", height: "100vh", background: "black" }}>
      {/* panel */}
      <div
        style={{
          position: "absolute",
          top: 10,
          left: 10,
          zIndex: 2,
          color: "white",
          fontFamily: "sans-serif",
          fontSize: 14,
          opacity: uiReady ? 1 : 0,
          transition: "opacity .12s ease",
          background: "rgba(0,0,0,.25)",
          border: "1px solid rgba(255,255,255,.15)",
          borderRadius: 8,
          padding: "8px 10px",
          width: "clamp(240px, 30vw, 420px)",
        }}
      >
        {title && (
          <div
            title={title}
            style={{
              marginBottom: 8,
              maxWidth: 280,
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,.18)",
              background: "rgba(255,255,255,.08)",
              fontSize: 13,
              fontWeight: 600,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {title}
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
            <input type="checkbox" checked={autoSmooth} onChange={(e) => setAutoSmooth(e.target.checked)} />
            <span>Auto smooth</span>
          </label>
          <span style={{ opacity: 0.8, fontSize: 12 }}>Úhel: {Math.round(smoothAngle)}°</span>
          <input
            type="range"
            min={0}
            max={80}
            step={1}
            value={smoothAngle}
            onChange={(e) => setSmoothAngle(parseFloat(e.target.value))}
            style={{ width: 120 }}
          />
        </div>
      </div>

      {/* logo */}
      {logoCfg.url && (
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
      )}

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

            <group ref={rootRef}>
              <Suspense fallback={null}>
                {files.map((f, i) => (
                  <AnyModel
                    key={f.url}
                    name={f.rawName || f.name}
                    url={f.url}
                    color={colors[i] ?? "#ffffff"}
                    opacity={opacities[i] ?? 1}
                    visible={visibles[i] ?? true}
                    onLoaded={() => {}}
                    autoSmooth={autoSmooth}
                    roughness={roughnesses[i] ?? (typeof f.r === "number" ? f.r : 0.5)}
                    metalness={metalnesses[i] ?? (typeof f.m === "number" ? f.m : 0.5)}
                    useVertexColors={!!f.vc}
                  />
                ))}
              </Suspense>
            </group>

            <AutoFrame rootRef={rootRef} triggerRef={frameTriggerRef} setTarget={setCameraTarget} />
            <TouchTrackballControls target={cameraTarget} />
          </>
        )}
      </Canvas>

      <style jsx global>{`
        input[type="range"] { appearance: none; height: 14px; background: transparent; margin: 5px 0; }
        input[type="range"]::-webkit-slider-runnable-track { height: 4px; background: white; border-radius: 2px; }
        input[type="range"]::-webkit-slider-thumb { appearance: none; width: 14px; height: 14px; border-radius: 50%; background: white; cursor: pointer; box-shadow: 0 0 2px black; margin-top: -5px; }
        input[type="range"]::-moz-range-track { height: 4px; background: white; border-radius: 2px; }
        input[type="range"]::-moz-range-thumb { width: 14px; height: 14px; border-radius: 50%; background: white; cursor: pointer; box-shadow: 0 0 2px black; border: none; }
      `}</style>
    </div>
  )
}
