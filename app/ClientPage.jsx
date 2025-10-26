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
const DEFAULT_LOGO = "/Arthetic_logo.png"
const DEFAULT_SMOOTH_ANGLE = 30
const DEFAULT_COLOR = "#f5f5dc"

/* ---------- Helpers ---------- */
const stripExt = (s) => (s ? s.replace(/\.[^.]+$/, "") : "")
const getParam = (name) => {
  if (typeof window === "undefined") return null
  try {
    return new URL(window.location.href).searchParams.get(name)
  } catch {
    return null
  }
}
const buildPublicURL = (path) => `${SUPABASE_URL}/storage/v1/object/public/${PUBLIC_BUCKET}/${path}`

/* ---------- UI Helper Components ---------- */
function Switch({ checked, onChange, label }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

/* ---------- Loading Overlay ---------- */
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

/* ---------- Geometry Smoothing ---------- */
function autoSmoothGeometry(geometry, angleDeg = DEFAULT_SMOOTH_ANGLE) {
  const angleRad = (angleDeg * Math.PI) / 180
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
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(i)
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

/* ---------- Lights ---------- */
function Headlight({ enabled = true, intensity = 2 }) {
  const { camera } = useThree()
  const ref = useRef()
  useFrame(() => { if (ref.current) ref.current.position.copy(camera.position) })
  return <pointLight ref={ref} intensity={enabled ? intensity : 0} distance={0} decay={0} />
}

/* ---------- Trackball Controls (fixed) ---------- */
function FixedTrackballControls({ target = [0, 0, 0], disabled }) {
  const { camera, gl } = useThree()
  const ref = useRef()

  useEffect(() => {
    const c = new TrackballControls(camera, gl.domElement)
    c.rotateSpeed = 5
    c.zoomSpeed = 1.2
    c.panSpeed = 1
    c.staticMoving = true
    c.dynamicDampingFactor = 0.15
    c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ZOOM }
    c.enabled = !disabled
    ref.current = c

    const stopDrag = () => { c.mouseButtonsPressed = {} }
    gl.domElement.addEventListener("pointerup", stopDrag)
    gl.domElement.addEventListener("pointerleave", stopDrag)
    return () => {
      gl.domElement.removeEventListener("pointerup", stopDrag)
      gl.domElement.removeEventListener("pointerleave", stopDrag)
      c.dispose()
    }
  }, [camera, gl])

  useEffect(() => {
    if (ref.current) {
      ref.current.target.set(...target)
      ref.current.update()
    }
  }, [target])

  useEffect(() => {
    if (ref.current) ref.current.enabled = !disabled
  }, [disabled])

  useFrame(() => { ref.current?.update() })
  return null
}

/* ---------- Stable Right Mouse Pan ---------- */
function StablePan({ setTarget, controlsRef, onPanActive }) {
  const { camera, gl, size } = useThree()
  const isPanning = useRef(false)
  const last = useRef({ x: 0, y: 0 })
  const right = new THREE.Vector3(), up = new THREE.Vector3(), delta = new THREE.Vector3()
  const PAN_SENS = 0.8

  useEffect(() => {
    const el = gl.domElement
    const down = (e) => {
      if (e.button !== 2) return
      e.preventDefault()
      isPanning.current = true
      last.current = { x: e.clientX, y: e.clientY }
      try { el.setPointerCapture(e.pointerId) } catch {}
      controlsRef?.current && (controlsRef.current.enabled = false)
      onPanActive(true)
    }
    const move = (e) => {
      if (!isPanning.current) return
      const dx = e.clientX - last.current.x, dy = e.clientY - last.current.y
      last.current = { x: e.clientX, y: e.clientY }
      right.setFromMatrixColumn(camera.matrixWorld, 0).normalize()
      up.setFromMatrixColumn(camera.matrixWorld, 1).normalize()
      const scale = camera.isOrthographicCamera
        ? ((camera.right - camera.left) / (size.width * camera.zoom))
        : (camera.position.length() / Math.max(size.width, size.height))
      delta.copy(right).multiplyScalar(-dx * scale * PAN_SENS)
      delta.addScaledVector(up, dy * scale * PAN_SENS)
      camera.position.add(delta)
      setTarget?.((t) => [t[0] + delta.x, t[1] + delta.y, t[2] + delta.z])
      camera.updateProjectionMatrix()
    }
    const up = (e) => {
      if (!isPanning.current) return
      isPanning.current = false
      try { el.releasePointerCapture(e.pointerId) } catch {}
      controlsRef?.current && (controlsRef.current.enabled = true)
      onPanActive(false)
    }
    el.addEventListener("pointerdown", down)
    el.addEventListener("pointermove", move)
    el.addEventListener("pointerup", up)
    el.addEventListener("contextmenu", (e) => e.preventDefault())
    return () => {
      el.removeEventListener("pointerdown", down)
      el.removeEventListener("pointermove", move)
      el.removeEventListener("pointerup", up)
    }
  }, [camera, gl, size.width, size.height, setTarget, controlsRef])
  return null
}

/* ---------- Auto Frame ---------- */
function AutoCenterAndFrame({ rootRef, setTarget, margin = 1.3, desktopScale = 0.42 }) {
  const { camera, size } = useThree()
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    root.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(root)
    if (box.isEmpty()) return
    const center = new THREE.Vector3()
    box.getCenter(center)
    root.position.sub(center)
    setTarget([0, 0, 0])
    const dims = new THREE.Vector3()
    box.getSize(dims)
    const zoomX = size.width / (dims.x * margin)
    const zoomY = size.height / (dims.y * margin)
    const zoom = Math.min(zoomX, zoomY) * desktopScale
    const depth = Math.max(dims.z, Math.max(dims.x, dims.y) * 0.75)
    const dist = depth * 5
    camera.position.set(0, 0, dist)
    camera.zoom = zoom
    camera.updateProjectionMatrix()
  }, [rootRef, size.width, size.height, setTarget, margin, desktopScale, camera])
  return null
}

/* ---------- Model Loader ---------- */
function AnyModel({ name, url, color, opacity, visible, onLoaded, autoSmooth, wireframe }) {
  const [object3D, setObject3D] = useState(null)
  const ext = useMemo(() => name?.split(".").pop()?.toLowerCase() ?? "", [name])
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        let obj
        if (ext === "stl") {
          const geom = await new STLLoader().loadAsync(url)
          if (!geom.attributes.normal) geom.computeVertexNormals()
          const base = autoSmooth ? autoSmoothGeometry(geom) : geom
          obj = new THREE.Mesh(base, new THREE.MeshStandardMaterial({
            color: new THREE.Color(color),
            metalness: 0.5, roughness: 0.5, transparent: opacity < 1, opacity, wireframe
          }))
        } else if (ext === "ply") {
          const geom = await new PLYLoader().loadAsync(url)
          if (!geom.attributes.normal) geom.computeVertexNormals()
          const base = autoSmooth ? autoSmoothGeometry(geom) : geom
          obj = new THREE.Mesh(base, new THREE.MeshStandardMaterial({
            color: new THREE.Color(color),
            metalness: 0.5, roughness: 0.5, transparent: opacity < 1, opacity, wireframe
          }))
        } else {
          const loaded = await new OBJLoader().loadAsync(url)
          loaded.traverse((ch) => {
            if (ch.isMesh) {
              ch.material = new THREE.MeshStandardMaterial({
                color: new THREE.Color(color),
                metalness: 0.5, roughness: 0.5, transparent: opacity < 1, opacity, wireframe
              })
            }
          })
          obj = loaded
        }
        if (!cancelled) {
          setObject3D(obj)
          onLoaded?.(obj)
        }
      } catch (err) {
        console.error(err)
      }
    })()
    return () => { cancelled = true }
  }, [url, color, opacity, visible, autoSmooth, wireframe])

  if (!object3D) return <InlineLoader text={`Načítám ${name}`} />
  return visible ? <primitive object={object3D} /> : null
}

/* ---------- Main ---------- */
export default function ClientPage() {
  const [files, setFiles] = useState([])
  const [colors, setColors] = useState([])
  const [opacities, setOpacities] = useState([])
  const [visibles, setVisibles] = useState([])
  const [autoSmooth, setAutoSmooth] = useState(true)
  const [wireframe, setWireframe] = useState(false)
  const [cameraTarget, setCameraTarget] = useState([0, 0, 0])
  const rootRef = useRef()
  const controlsRef = useRef()
  const [loadedCount, setLoadedCount] = useState(0)
  const [panActive, setPanActive] = useState(false)
  const [shouldFrame, setShouldFrame] = useState(true)

  useEffect(() => {
    const listener = (event) => {
      if (event.data?.type === "shade3d-update") {
        const data = event.data.payload
        setFiles(data.files || [])
        setColors(data.colors || [])
        setOpacities(data.opacities || [])
        setVisibles(data.visibles || [])
        setShouldFrame(true)
        setLoadedCount(0)
      }
    }
    window.addEventListener("message", listener)
    return () => window.removeEventListener("message", listener)
  }, [])

  const handleModelLoaded = () => {
    setLoadedCount((n) => {
      const newVal = n + 1
      if (newVal === files.length) setShouldFrame(false)
      return newVal
    })
  }

  return (
    <div style={{ position: "relative", width: "100vw", height: "100vh", background: "black" }}>
      <Canvas orthographic camera={{ position: [0, 0, 100], near: 0.01, far: 100000 }}>
        <ambientLight intensity={0.4} />
        <directionalLight position={[5, 5, 10]} intensity={1.2} />
        <Headlight enabled intensity={1.6} />
        <group ref={rootRef}>
          <Suspense fallback={null}>
            {files.map((f, i) => (
              <AnyModel
                key={i}
                name={f.name}
                url={f.url}
                color={colors[i] || DEFAULT_COLOR}
                opacity={opacities[i] ?? 1}
                visible={visibles[i] ?? true}
                autoSmooth={autoSmooth}
                wireframe={wireframe}
                onLoaded={handleModelLoaded}
              />
            ))}
          </Suspense>
        </group>

        {loadedCount === files.length && shouldFrame && (
          <AutoCenterAndFrame rootRef={rootRef} setTarget={setCameraTarget} />
        )}

        <FixedTrackballControls target={cameraTarget} disabled={panActive} ref={controlsRef} />
        <StablePan setTarget={setCameraTarget} controlsRef={controlsRef} onPanActive={setPanActive} />
      </Canvas>
    </div>
  )
}
