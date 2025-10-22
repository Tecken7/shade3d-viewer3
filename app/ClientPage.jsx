"use client"

import { Canvas, useThree, useFrame } from "@react-three/fiber"
import * as THREE from "three"
import { Suspense, useEffect, useRef, useState } from "react"
import { Html } from "@react-three/drei"
import { TrackballControls } from "three/examples/jsm/controls/TrackballControls"
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader"
import { STLLoader } from "three/examples/jsm/loaders/STLLoader"
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader"

const LIVE_MSG_TYPES = new Set(["SHADE3D_LIVE", "SHADE3D_LIVE_V6", "SHADE3D_LIVE_V5"])
const DEFAULT_LOGO = "/Arthetic_logo.png"

const clamp01 = (x) => Math.max(0, Math.min(1, x))
const stripExt = (s) => (s ? s.replace(/\.[^.]+$/, "") : "")
const inferExt = (s) => s.split("?")[0].split(".").pop()?.toLowerCase()

function InlineLoader({ text }) {
  return (
    <Html center>
      <div
        style={{
          background: "rgba(0,0,0,0.7)",
          padding: "16px 28px",
          borderRadius: 10,
          color: "white",
          fontFamily: "sans-serif",
          fontSize: 16,
        }}
      >
        ⏳ {text || "Načítám…"}
      </div>
    </Html>
  )
}

function autoSmoothGeometry(geometry, angleDeg = 30) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry.clone()
  g.computeVertexNormals()
  g.computeBoundingBox()
  g.computeBoundingSphere()
  return g
}

/* ─────────── Model ─────────── */
function AnyModel({
  name,
  url,
  color,
  opacity,
  visible,
  onLoaded,
  roughness,
  metalness,
  useVertexColors,
  keepMaterials,
  autoSmooth,
  smoothAngle,
}) {
  const [object3D, setObject3D] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancel = false
    const ext = inferExt(url || name)
    const loader =
      ext === "stl"
        ? new STLLoader()
        : ext === "ply"
        ? new PLYLoader()
        : new OBJLoader()

    ;(async () => {
      try {
        const data = await loader.loadAsync(url)
        let obj
        if (ext === "stl" || ext === "ply") {
          const geom = data.isBufferGeometry ? data : data.geometry
          if (autoSmooth) autoSmoothGeometry(geom, smoothAngle)
          const mat = new THREE.MeshStandardMaterial({
            color,
            transparent: opacity < 1,
            opacity,
            roughness,
            metalness,
            vertexColors: useVertexColors,
          })
          obj = new THREE.Mesh(geom, mat)
        } else {
          obj = data
          obj.traverse((child) => {
            if (child.isMesh) {
              child.material = new THREE.MeshStandardMaterial({
                color,
                transparent: opacity < 1,
                opacity,
                roughness,
                metalness,
              })
            }
          })
        }
        if (!cancel) {
          setObject3D(obj)
          setLoading(false)
          onLoaded?.(obj)
        }
      } catch (e) {
        console.error("Model load error:", e)
        setLoading(false)
      }
    })()

    return () => (cancel = true)
  }, [url])

  // aktualizace parametrů (bez reloadu)
  useEffect(() => {
    if (!object3D) return
    object3D.traverse((child) => {
      if (child.isMesh && child.material) {
        child.material.color.set(color)
        child.material.opacity = opacity
        child.material.transparent = opacity < 1
        child.material.roughness = roughness
        child.material.metalness = metalness
        child.material.needsUpdate = true
      }
    })
  }, [object3D, color, opacity, roughness, metalness])

  if (!object3D) return loading ? <InlineLoader text={`Načítám ${name}`} /> : null
  return visible ? <primitive object={object3D} /> : null
}

/* ─────────── Světlo ─────────── */
function Headlight({ enabled = true, intensity = 2 }) {
  const { camera } = useThree()
  const ref = useRef()
  useFrame(() => ref.current && ref.current.position.copy(camera.position))
  return (
    <pointLight ref={ref} intensity={enabled ? intensity : 0} color="#ffffff" distance={0} decay={0} />
  )
}

/* ─────────── Trackball ─────────── */
function Trackball({ target = [0, 0, 0] }) {
  const { camera, gl } = useThree()
  const controlsRef = useRef()
  useEffect(() => {
    const controls = new TrackballControls(camera, gl.domElement)
    controls.rotateSpeed = 4
    controls.zoomSpeed = 1.2
    controls.panSpeed = 0.8
    controls.staticMoving = true
    controlsRef.current = controls
    return () => controls.dispose()
  }, [camera, gl])
  useEffect(() => {
    controlsRef.current?.target.set(...target)
  }, [target])
  useFrame(() => controlsRef.current?.update())
  return null
}

/* ─────────── AutoFrame (jen při změně files) ─────────── */
function AutoFrame({ rootRef, frameTriggerRef, setCameraTarget }) {
  const { camera, size } = useThree()
  useEffect(() => {
    if (!frameTriggerRef.current) return
    frameTriggerRef.current = false

    const root = rootRef.current
    if (!root) return
    const box = new THREE.Box3().setFromObject(root)
    const center = new THREE.Vector3()
    const sizeVec = new THREE.Vector3()
    box.getCenter(center)
    box.getSize(sizeVec)

    root.position.sub(center)
    setCameraTarget([0, 0, 0])

    const dist = Math.max(sizeVec.x, sizeVec.y, sizeVec.z) * 2
    camera.position.set(0, 0, dist)
    camera.zoom = (size.height / (sizeVec.y * 2)) * 0.8
    camera.updateProjectionMatrix()
  }, [size.width, size.height])
  return null
}
export default function ClientPage() {
  const [files, setFiles] = useState([])
  const [colors, setColors] = useState([])
  const [opacities, setOpacities] = useState([])
  const [roughs, setRoughs] = useState([])
  const [metals, setMetals] = useState([])
  const [visibles, setVisibles] = useState([])
  const [title, setTitle] = useState(null)
  const [logoCfg, setLogoCfg] = useState({ url: DEFAULT_LOGO, opacity: 0.9, width: 160, pos: "bc" })
  const [lightIntensity, setLightIntensity] = useState(1)
  const [headlight, setHeadlight] = useState({ enabled: true, intensity: 2 })

  const rootRef = useRef()
  const [cameraTarget, setCameraTarget] = useState([0, 0, 0])
  const frameTriggerRef = useRef(true)

  const keyOf = (f) => `${f.url}::${f.name}`

  /* ─────────── aplikace payloadu ─────────── */
  const applyLivePayload = (p) => {
    if (!p) return
    // světla
    if (p.onlyLights && p.lights) {
      setLightIntensity(p.lights.intensity ?? 1)
      if (p.lights.headlight)
        setHeadlight({
          enabled: p.lights.headlight.enabled ?? true,
          intensity: p.lights.headlight.intensity ?? 2,
        })
      return
    }

    // změna parametrů
    if (p.onlyParams) {
      const map = new Map(files.map((f, i) => [keyOf(f), i]))
      for (const f of p.files || []) {
        const idx = map.get(`${f.u}::${f.n}`)
        if (idx != null) {
          if (f.c) colors[idx] = f.c
          if (f.o != null) opacities[idx] = clamp01(f.o)
          if (f.r != null) roughs[idx] = clamp01(f.r)
          if (f.m != null) metals[idx] = clamp01(f.m)
          if (f.v != null) visibles[idx] = !!f.v
        }
      }
      setColors([...colors])
      setOpacities([...opacities])
      setRoughs([...roughs])
      setMetals([...metals])
      setVisibles([...visibles])
      setTitle(p.title ?? title)
      if (p.logo)
        setLogoCfg({
          url: p.logo.url ?? logoCfg.url,
          opacity: p.logo.opacity ?? logoCfg.opacity,
          width: p.logo.width ?? logoCfg.width,
          pos: p.logo.pos ?? logoCfg.pos,
        })
      return
    }

    // plný payload (změna modelů)
    if (Array.isArray(p.files)) {
      const newFiles = p.files.map((x, i) => ({
        url: x.u,
        name: x.n || `Model ${i + 1}`,
      }))
      const changed =
        newFiles.length !== files.length ||
        newFiles.some((f, i) => keyOf(f) !== keyOf(files[i] || {}))
      if (changed) {
        setFiles(newFiles)
        setColors(p.files.map((x) => x.c || "#ffffff"))
        setOpacities(p.files.map((x) => x.o ?? 1))
        setRoughs(p.files.map((x) => x.r ?? 0.5))
        setMetals(p.files.map((x) => x.m ?? 0.5))
        setVisibles(p.files.map((x) => x.v ?? true))
        frameTriggerRef.current = true // jen při změně modelů
      }
      setTitle(p.title ?? title)
      if (p.logo)
        setLogoCfg({
          url: p.logo.url ?? logoCfg.url,
          opacity: p.logo.opacity ?? logoCfg.opacity,
          width: p.logo.width ?? logoCfg.width,
          pos: p.logo.pos ?? logoCfg.pos,
        })
      if (p.lights) setLightIntensity(p.lights.intensity ?? 1)
    }
  }

  /* ─────────── listener pro Framer live ─────────── */
  useEffect(() => {
    const handler = (e) => {
      const d = e.data
      if (d && LIVE_MSG_TYPES.has(d.type)) applyLivePayload(d.payload)
    }
    window.addEventListener("message", handler)
    return () => window.removeEventListener("message", handler)
  }, [files])

  return (
    <div style={{ width: "100vw", height: "100vh", background: "#000", position: "relative" }}>
      {logoCfg.url && (
        <img
          src={logoCfg.url}
          style={{
            position: "absolute",
            bottom: 10,
            left: logoCfg.pos === "bl" ? 10 : logoCfg.pos === "bc" ? "50%" : "auto",
            right: logoCfg.pos === "br" ? 10 : "auto",
            transform: logoCfg.pos === "bc" ? "translateX(-50%)" : "none",
            opacity: logoCfg.opacity,
            width: logoCfg.width,
            pointerEvents: "none",
            userSelect: "none",
          }}
        />
      )}

      <Canvas
        orthographic
        camera={{ position: [0, 0, 1000], near: 0.1, far: 1e6 }}
        style={{ position: "absolute", inset: 0 }}
      >
        <ambientLight intensity={lightIntensity * 0.4} />
        <directionalLight position={[5, 5, 5]} intensity={lightIntensity} />
        <Headlight enabled={headlight.enabled} intensity={headlight.intensity} />

        <group ref={rootRef}>
          <Suspense fallback={null}>
            {files.map((f, i) => (
              <AnyModel
                key={f.url}
                name={f.name}
                url={f.url}
                color={colors[i] ?? "#ffffff"}
                opacity={opacities[i] ?? 1}
                roughness={roughs[i] ?? 0.5}
                metalness={metals[i] ?? 0.5}
                visible={visibles[i] ?? true}
              />
            ))}
          </Suspense>
        </group>

        <AutoFrame rootRef={rootRef} frameTriggerRef={frameTriggerRef} setCameraTarget={setCameraTarget} />
        <Trackball target={cameraTarget} />
      </Canvas>
    </div>
  )
}
