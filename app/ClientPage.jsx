"use client"

import React, { useEffect, useMemo, useRef, useState, Suspense } from "react"
import * as THREE from "three"
import { Canvas, useFrame, useThree } from "@react-three/fiber"
import { OrbitControls, Environment, useProgress, Html } from "@react-three/drei"
import { STLLoader } from "three-stdlib/loaders/STLLoader"
import { OBJLoader } from "three-stdlib/loaders/OBJLoader"
import { PLYLoader } from "three-stdlib/loaders/PLYLoader"

// ---------- Helpers ----------
const DEFAULT_LOGO = "/Arthetic_logo.png"
const stripExt = (s) => (s || "").replace(/\.[^.]+$/, "")
const clamp01 = (x) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0))
const getParam = (name) => {
  if (typeof window === "undefined") return null
  return new URLSearchParams(window.location.search).get(name)
}
const fetchJSON = async (url) => {
  const r = await fetch(url)
  if (!r.ok) throw new Error("HTTP " + r.status)
  return await r.json()
}

const LIVE_MSG_TYPES = new Set(["SHADE3D_LIVE", "SHADE3D_LIVE_V6", "SHADE3D_LIVE_V5"])
const hdrPath = "/hdr/studio_small_03_1k.hdr"

// ---------- Loaders ----------
const loadGeometry = async (url) => {
  const lower = url.split("?")[0].toLowerCase()
  if (lower.endsWith(".stl")) {
    const loader = new STLLoader()
    const geom = await loader.loadAsync(url)
    // STL → BufferGeometry
    return new THREE.BufferGeometry().copy(geom)
  }
  if (lower.endsWith(".obj")) {
    const loader = new OBJLoader()
    const obj = await loader.loadAsync(url)
    // Sloučíme do jedné geometrie (BBox, draw je rychlejší)
    const merged = new THREE.BufferGeometry()
    const geometries = []
    obj.traverse((c) => {
      if (c.isMesh && c.geometry) geometries.push(c.geometry)
    })
    if (geometries.length === 1) return geometries[0]
    if (geometries.length > 1) {
      const g = THREE.BufferGeometryUtils
      if (g && g.mergeBufferGeometries) return g.mergeBufferGeometries(geometries, true)
      // fallback – vezmi první
      return geometries[0]
    }
    // nic nenašlo
    return new THREE.BoxGeometry(1, 1, 1)
  }
  if (lower.endsWith(".ply")) {
    const loader = new PLYLoader()
    const geom = await loader.loadAsync(url)
    geom.computeVertexNormals()
    return geom
  }
  // fallback
  return new THREE.BoxGeometry(1, 1, 1)
}

// ---------- UI ----------
function LoaderOverlay() {
  const { active, progress } = useProgress()
  if (!active) return null
  return (
    <Html center style={{ pointerEvents: "none" }}>
      <div style={{ color: "#fff", fontFamily: "Inter, system-ui, sans-serif", fontWeight: 600 }}>
        Načítám… {Math.round(progress)}%
      </div>
    </Html>
  )
}

// ---------- Model mesh ----------
function ModelItem({ file, color = "#ffffff", opacity = 1, visible = true, roughness = 0.5, metalness = 0.5, vertexColors = false, keepMat = false, onLoaded }) {
  const meshRef = useRef()
  const [geom, setGeom] = useState(null)

  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        const g = await loadGeometry(file.url)
        if (!mounted) return
        setGeom(g)
        onLoaded && onLoaded()
      } catch (e) {
        console.error("Load failed:", file.url, e)
        onLoaded && onLoaded()
      }
    })()
    return () => {
      mounted = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.url])

  const mat = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color),
      opacity: clamp01(opacity),
      transparent: opacity < 1,
      roughness: clamp01(roughness),
      metalness: clamp01(metalness),
      side: THREE.DoubleSide,
    })
    if (vertexColors) m.vertexColors = true
    return m
  }, [color, opacity, roughness, metalness, vertexColors])

  if (!geom) return null
  return (
    <mesh ref={meshRef} geometry={geom} material={mat} visible={visible} />
  )
}

// ---------- Scene & camera framing ----------
function SceneContent({
  files, colors, opacities, visibles, roughnesses, metalnesses, useVC, keepMTL,
  logoCfg, lightIntensity, headlightCfg,
  onModelLoaded, cameraShouldFrameRef, lastFrameBoxRef,
}) {
  const { scene } = useThree()
  const controlsRef = useRef()
  const cameraRef = useThree((s) => s.camera)

  // Headlight
  const headlightRef = useRef()
  useEffect(() => {
    if (!headlightRef.current) return
    headlightRef.current.intensity = headlightCfg?.enabled ? (headlightCfg.intensity || 2) : 0
  }, [headlightCfg])

  // OrbitControls target is preserved; frame only when asked
  const frameScene = () => {
    // Compute bbox
    const box = new THREE.Box3()
    let hasGeometry = false
    scene.traverse((o) => {
      if (o.isMesh && o.visible && o.geometry) {
        o.geometry.computeBoundingBox?.()
        const b = o.geometry.boundingBox || new THREE.Box3().setFromObject(o)
        if (b && isFinite(b.min.x) && isFinite(b.max.x)) {
          box.union(b)
          hasGeometry = true
        }
      }
    })
    if (!hasGeometry) return
    lastFrameBoxRef.current = box.clone()

    const size = new THREE.Vector3()
    box.getSize(size)
    const center = new THREE.Vector3()
    box.getCenter(center)

    // distance heuristika
    const maxDim = Math.max(size.x, size.y, size.z)
    const fov = THREE.MathUtils.degToRad(cameraRef.fov || 50)
    const dist = Math.max(maxDim / (2 * Math.tan(fov / 2)), 0.1) * 1.25

    const dir = new THREE.Vector3(1, 1, 1).normalize()
    const pos = center.clone().add(dir.multiplyScalar(dist))

    // apply
    cameraRef.position.copy(pos)
    cameraRef.near = Math.max(dist / 100, 0.01)
    cameraRef.far = dist * 100 + maxDim * 2
    cameraRef.updateProjectionMatrix()

    if (controlsRef.current) {
      controlsRef.current.target.copy(center)
      controlsRef.current.update()
    }
  }

  // Re-frame effect (only when files change & load completes)
  useEffect(() => {
    if (!cameraShouldFrameRef.current) return
    // frame after a tick (geoms present)
    const t = setTimeout(() => {
      frameScene()
      cameraShouldFrameRef.current = false
    }, 20)
    return () => clearTimeout(t)
    // deps intentionally left empty; controlled by ref flag
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files.length])

  // Key light rig
  useFrame(() => {
    if (!headlightRef.current) return
    headlightRef.current.position.copy(cameraRef.position)
  })

  return (
    <>
      <ambientLight intensity={Math.max(0, lightIntensity) * 0.25} />
      <directionalLight position={[3, 5, 2]} intensity={Math.max(0, lightIntensity) * 0.8} />
      <directionalLight position={[-3, 2, -2]} intensity={Math.max(0, lightIntensity) * 0.4} />
      <pointLight ref={headlightRef} intensity={headlightCfg?.enabled ? (headlightCfg.intensity || 2) : 0} />

      {files.map((f, i) => (
        <ModelItem
          key={`${f.url}::${f.rawName || f.name}`}
          file={f}
          color={colors[i] ?? "#ffffff"}
          opacity={opacities[i] ?? 1}
          visible={visibles[i] ?? true}
          roughness={roughnesses[i] ?? 0.5}
          metalness={metalnesses[i] ?? 0.5}
          vertexColors={!!useVC[i]}
          keepMat={!!keepMTL[i]}
          onLoaded={onModelLoaded}
        />
      ))}

      <Environment files={hdrPath} background={false} />

      <OrbitControls ref={controlsRef} enableDamping dampingFactor={0.05} />
    </>
  )
}

// ---------- Page ----------
export default function ClientPage() {
  const [fatal, setFatal] = useState(null)

  // files + per-item params
  const [files, setFiles] = useState([]) // [{url,name,rawName}]
  const [colors, setColors] = useState([])
  const [opacities, setOpacities] = useState([])
  const [visibles, setVisibles] = useState([])
  const [roughnesses, setRoughnesses] = useState([])
  const [metalnesses, setMetalnesses] = useState([])
  const [useVC, setUseVC] = useState([])
  const [keepMTL, setKeepMTL] = useState([])

  // header
  const [title, setTitle] = useState(null)
  const [logoCfg, setLogoCfg] = useState({ url: DEFAULT_LOGO, opacity: 0.9, width: 160, pos: "bc" })

  // lights
  const [lightIntensity, setLightIntensity] = useState(1.0)
  const [headlightCfg, setHeadlightCfg] = useState({ enabled: true, intensity: 2.0 })

  // loading counters → frame when all loaded
  const [loadedCount, setLoadedCount] = useState(0)
  const handleModelLoaded = () => setLoadedCount((n) => n + 1)

  // frame control
  const shouldFrameRef = useRef(true) // true only when files list actually changes
  const prevFileKeysRef = useRef([])
  const lastFrameBoxRef = useRef(null)

  const getFileKeys = (arr) => (arr || []).map((f) => `${f.url}::${f.rawName || f.name}`)

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
          setUseVC(Fs.map((f) => !!f.vc))
          setKeepMTL(Fs.map((f) => !!f.km))

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

          prevFileKeysRef.current = getFileKeys(Fs)
          shouldFrameRef.current = true
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
          setUseVC(Fs.map((f) => !!f.vc))
          setKeepMTL(Fs.map((f) => !!f.km))

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

          prevFileKeysRef.current = getFileKeys(Fs)
          shouldFrameRef.current = true
          return
        }

        // žádné manifest/parametry → v live režimu nebo s ?noDemo=1 necháváme prázdno
        const modeLive = mode === "live"
        const suppressDemo = noDemo || modeLive
        if (suppressDemo) {
          setFiles([]); setColors([]); setOpacities([]); setVisibles([]); setRoughnesses([]); setMetalnesses([]); setUseVC([]); setKeepMTL([])
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

        // Bez demo obsahu:
        setFiles([]); setColors([]); setOpacities([]); setVisibles([]); setRoughnesses([]); setMetalnesses([]); setUseVC([]); setKeepMTL([])
      } catch (e) {
        console.error(e)
        setFatal("Tento náhled není dostupný (chyba při načtení dat).")
      }
    })()
  }, [])

  /* ───────── LIVE MODE: postMessage listener ───────── */
  const applyLivePayload = (p) => {
    if (!p) return
    const onlyParams = !!p.onlyParams
    let filesActuallyChanged = false

    if (Array.isArray(p.files)) {
      if (!onlyParams) {
        // mění se soubory
        const newFiles = p.files.map((x, i) => ({
          url: x.u, name: stripExt(x.n || `Model ${i + 1}`), rawName: x.n || `Model${i + 1}`,
          c: x.c, o: typeof x.o === "number" ? clamp01(x.o) : 1,
          v: typeof x.v === "boolean" ? x.v : true,
          r: typeof x.r === "number" ? clamp01(x.r) : 0.5,
          m: typeof x.m === "number" ? clamp01(x.m) : 0.5,
          vc: !!x.vc, km: !!x.km,
        }))

        const newKeys = newFiles.map((f) => `${f.url}::${f.rawName || f.name}`)
        const prevKeys = prevFileKeysRef.current
        filesActuallyChanged = newKeys.length !== prevKeys.length || newKeys.some((k, i) => k !== prevKeys[i])

        setFiles(newFiles)
        prevFileKeysRef.current = newKeys

        const palette = ["#f5f5dc", "#8e8e8e", "#ffffff", "#ffd7a8", "#c0c0c0", "#e6f0ff", "#ffeedd"]
        setColors(newFiles.map((f, i) => f.c || palette[i % palette.length]))
        setOpacities(newFiles.map((f) => f.o))
        setVisibles(newFiles.map((f) => f.v))
        setRoughnesses(newFiles.map((f) => f.r))
        setMetalnesses(newFiles.map((f) => f.m))
        setUseVC(newFiles.map((f) => !!f.vc))
        setKeepMTL(newFiles.map((f) => !!f.km))
      } else {
        // onlyParams: uprav jen hodnoty, files nech
        setColors((old) => old.map((v, i) => (p.files[i] && p.files[i].c != null ? p.files[i].c : v)))
        setOpacities((old) => old.map((v, i) => (typeof p.files[i]?.o === "number" ? clamp01(p.files[i].o) : v)))
        setVisibles((old) => old.map((v, i) => (typeof p.files[i]?.v === "boolean" ? p.files[i].v : v)))
        setRoughnesses((old) => old.map((v, i) => (typeof p.files[i]?.r === "number" ? clamp01(p.files[i].r) : v)))
        setMetalnesses((old) => old.map((v, i) => (typeof p.files[i]?.m === "number" ? clamp01(p.files[i].m) : v)))
        setUseVC((old) => old.map((v, i) => (typeof p.files[i]?.vc === "boolean" ? !!p.files[i].vc : v)))
        setKeepMTL((old) => old.map((v, i) => (typeof p.files[i]?.km === "boolean" ? !!p.files[i].km : v)))
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

    // Reframe jen když se změnily soubory
    shouldFrameRef.current = filesActuallyChanged
    if (filesActuallyChanged) setLoadedCount(0)
  }

  useEffect(() => {
    const onMsg = (e) => {
      const data = e.data
      if (data && LIVE_MSG_TYPES.has(data.type) && data.payload) {
        // Framer může poslat „vyprázdni“:
        if (Array.isArray(data.payload.files) && data.payload.files.length === 0) {
          setFiles([]); setColors([]); setOpacities([]); setVisibles([]); setRoughnesses([]); setMetalnesses([]); setUseVC([]); setKeepMTL([])
          prevFileKeysRef.current = []
          shouldFrameRef.current = false
          return
        }
        applyLivePayload(data.payload)
      }
    }
    window.addEventListener("message", onMsg)
    return () => window.removeEventListener("message", onMsg)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // kdy frame? když se změní files & dohrají se gea
  useEffect(() => {
    // když počet načtených geometrií == files.length, povolíme případný frame
    if (files.length > 0 && loadedCount >= files.length) {
      // nic – samotný SceneContent se zaframeuje na základě shouldFrameRef
    }
  }, [files.length, loadedCount])

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
    <div style={{ position: "relative", width: "100vw", height: "100vh", background: "black" }}>
      {/* title overlay */}
      {title && (
        <div
          style={{
            position: "absolute",
            top: 12,
            left: 12,
            color: "#fff",
            fontFamily: "Inter, system-ui, sans-serif",
            fontWeight: 600,
            letterSpacing: 0.2,
            zIndex: 2,
            textShadow: "0 1px 2px rgba(0,0,0,.6)",
          }}
        >
          {title}
        </div>
      )}

      {/* logo */}
      {logoEl}

      {/* canvas */}
      <Canvas gl={{ antialias: true }} shadows camera={{ fov: 50, near: 0.1, far: 5000, position: [3, 2, 4] }}>
        <Suspense fallback={<LoaderOverlay />}>
          <SceneContent
            files={files}
            colors={colors}
            opacities={opacities}
            visibles={visibles}
            roughnesses={roughnesses}
            metalnesses={metalnesses}
            useVC={useVC}
            keepMTL={keepMTL}
            logoCfg={logoCfg}
            lightIntensity={lightIntensity}
            headlightCfg={headlightCfg}
            onModelLoaded={handleModelLoaded}
            cameraShouldFrameRef={shouldFrameRef}
            lastFrameBoxRef={lastFrameBoxRef}
          />
        </Suspense>
      </Canvas>

      {/* fatal error */}
      {fatal && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            placeItems: "center",
            color: "#ffbcbc",
            background: "rgba(43, 15, 15, .75)",
            fontFamily: "Inter, system-ui, sans-serif",
            fontWeight: 600,
          }}
        >
          {fatal}
        </div>
      )}
    </div>
  )
}
