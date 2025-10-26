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

/* ---------- Live protokol ---------- */
const LIVE_MSG_TYPES = new Set(["SHADE3D_LIVE", "SHADE3D_LIVE_V6", "SHADE3D_LIVE_V5"])

/* ---------- Helpers ---------- */
const DEFAULT_LOGO = "/Arthetic_logo.png"
const SUPABASE_URL = "https://jqnkdjgmenerioodqcpa.supabase.co"
const PUBLIC_BUCKET = "shade3d-viewer2"

const stripExt = (s: string) => (s ? s.replace(/\.[^.]+$/, "") : "")
const clamp01 = (x: number) => Math.max(0, Math.min(1, x))
const getParam = (name: string) => {
  if (typeof window === "undefined") return null
  try { return new URL(window.location.href).searchParams.get(name) } catch { return null }
}
async function fetchJSON(url: string) {
  const r = await fetch(url, { cache: "no-store" })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}
function inferExt(nameOrUrl?: string | null) {
  if (!nameOrUrl) return ""
  const s = nameOrUrl.split("?")[0]
  const m = s.match(/\.([a-z0-9]+)$/i)
  return m ? m[1].toLowerCase() : ""
}

/* ---------- Ikony (konfigurovatelný base) + preload ---------- */
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
function autoSmoothGeometry(geometry: THREE.BufferGeometry, angleDeg = 30) {
  const angle = Math.max(0, Math.min(89.9, angleDeg))
  const angleRad = (angle * Math.PI) / 180

  const g = geometry.index ? geometry.toNonIndexed() : geometry.clone()
  const pos = g.getAttribute("position") as THREE.BufferAttribute
  const vCount = pos.count
  const triCount = vCount / 3

  const faceNormals: THREE.Vector3[] = new Array(triCount)
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

  const groups = new Map<string, number[]>()
  const keyOf = (ix: number) =>
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
function InlineLoader({ text }: { text?: string }) {
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

/* ---------- AnyModel + FULL wireframe overlay ---------- */
function AnyModel({
  name, url,
  color, opacity, visible,
  onLoaded, autoSmooth, smoothAngle = 30,
  roughness = 0.5, metalness = 0.5,
  useVertexColors = false,
  keepMaterials = false,
  wireframe = false,
}: {
  name?: string, url: string,
  color?: string, opacity: number, visible: boolean,
  onLoaded?: (obj: THREE.Object3D) => void, autoSmooth: boolean, smoothAngle?: number,
  roughness?: number, metalness?: number,
  useVertexColors?: boolean, keepMaterials?: boolean, wireframe?: boolean
}) {
  const [object3D, setObject3D] = useState<THREE.Object3D | null>(null)
  const [loading, setLoading] = useState(true)
  const ext = useMemo(() => inferExt(name || url), [name, url])

  const makeMat = (opts: THREE.MeshStandardMaterialParameters = {}) =>
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

  const forEachMesh = (obj: THREE.Object3D | null, cb: (m: THREE.Mesh) => void) => {
    obj?.traverse?.((child: any) => { if (child.isMesh) cb(child) })
  }

  const rebuildWireOverlay = (mesh: any) => {
    if (mesh.userData._edges) {
      mesh.userData._edges.geometry?.dispose?.()
      mesh.userData._edges.material?.dispose?.()
      mesh.remove(mesh.userData._edges)
      mesh.userData._edges = null
    }
    if (!wireframe) return
    const geom = mesh.geometry as THREE.BufferGeometry
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
        let obj: any
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
            loaded.traverse((child: any) => {
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
            loaded.traverse((child: any) => { if (child.isMesh) child.material = mat })
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
    forEachMesh(object3D, (child: any) => {
      if (!child.userData._baseGeom) child.userData._baseGeom = child.geometry
      const base = child.userData._baseGeom as THREE.BufferGeometry
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

  useEffect(() => {
    if (!object3D) return
    forEachMesh(object3D, (child: any) => {
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
  const ref = useRef<THREE.PointLight | null>(null)
  useFrame(() => { if (ref.current) ref.current.position.copy((camera as any).position) })
  return <pointLight ref={ref} color={color} intensity={enabled ? intensity : 0} distance={0} decay={0} />
}

/* ---------- Trackball (lepší ovládání + resize) ---------- */
function TouchTrackballControls({ target = [0, 0, 0] }: { target?: [number, number, number] }) {
  const { camera, gl, size } = useThree()
  const controlsRef = useRef<any>(null)

  useEffect(() => {
    const controls = new (TrackballControls as any)(camera, gl.domElement)
    controls.rotateSpeed = 5.0
    controls.zoomSpeed = 1.2
    controls.panSpeed = 1.0
    controls.staticMoving = true
    controls.dynamicDampingFactor = 0.15
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ZOOM }
    controlsRef.current = controls
    return () => { controls.dispose() }
  }, [camera, gl])

  useEffect(() => {
    const c = controlsRef.current
    if (!c) return
    c.target.set(target[0], target[1], target[2])
    c.update()
  }, [target])

  useEffect(() => { controlsRef.current?.handleResize?.() }, [size.width, size.height])

  useFrame(() => {
    const c = controlsRef.current
    if (!c) return
    if ((camera as any).isOrthographicCamera) c.panSpeed = (camera as any).zoom * 0.4
    c.update()
  })

  return null
}

/* ---------- Vlastní PAN (pravé tlačítko / Ctrl+levé) ---------- */
function RightButtonPan({ setTarget }: { setTarget: React.Dispatch<React.SetStateAction<[number, number, number]>> }) {
  const { camera, gl, size } = useThree()
  const isPanning = useRef(false)
  const last = useRef({ x: 0, y: 0 })
  const pointerIdRef = useRef<number | null>(null)

  const PAN_SENSITIVITY = 0.85
  const right = new THREE.Vector3()
  const up = new THREE.Vector3()
  const deltaWorld = new THREE.Vector3()

  useEffect(() => {
    const el = gl.domElement as any

    const onContext = (e: PointerEvent) => { e.preventDefault() }
    const onDown = (e: any) => {
      if ((e.button !== 2) && !(e.button === 0 && e.ctrlKey)) return
      e.preventDefault()
      e.stopPropagation()
      isPanning.current = true
      last.current = { x: e.clientX, y: e.clientY }
      pointerIdRef.current = e.pointerId
      try { el.setPointerCapture?.(e.pointerId) } catch {}
    }
    const onMove = (e: any) => {
      if (!isPanning.current) return
      e.preventDefault()
      e.stopPropagation()
      const dx = e.clientX - last.current.x
      const dy = e.clientY - last.current.y
      last.current = { x: e.clientX, y: e.clientY }

      right.setFromMatrixColumn((camera as any).matrixWorld, 0).normalize()
      up.setFromMatrixColumn((camera as any).matrixWorld, 1).normalize()

      if ((camera as any).isOrthographicCamera) {
        const wppX = (((camera as any).right - (camera as any).left) / (size.width * (camera as any).zoom))
        const wppY = (((camera as any).top - (camera as any).bottom) / (size.height * (camera as any).zoom))
        const moveRight = -dx * wppX * PAN_SENSITIVITY
        const moveUp    =  dy * wppY * PAN_SENSITIVITY
        deltaWorld.copy(right).multiplyScalar(moveRight).addScaledVector(up, moveUp)
        ;(camera as any).position.add(deltaWorld)
        setTarget?.((t) => [t[0] + deltaWorld.x, t[1] + deltaWorld.y, t[2] + deltaWorld.z])
        ;(camera as any).updateProjectionMatrix()
      } else {
        const dist = (camera as any).position.length()
        const scale = (dist / Math.max(size.width, size.height)) * PAN_SENSITIVITY
        deltaWorld.copy(right).multiplyScalar(-dx * scale).addScaledVector(up, dy * scale)
        ;(camera as any).position.add(deltaWorld)
        setTarget?.((t) => [t[0] + deltaWorld.x, t[1] + deltaWorld.y, t[2] + deltaWorld.z])
      }
    }
    const onUp = (e: any) => {
      if (!isPanning.current) return
      e.preventDefault()
      e.stopPropagation()
      isPanning.current = false
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
  }, [camera, gl, size.width, size.height, setTarget])

  return null
}

/* ---------- Color popover (UI re-use) ---------- */
function ColorSwatch({ color, onChange, ariaLabel }: { color: string, onChange: (v: string) => void, ariaLabel?: string }) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const onDocClick = (e: any) => { if (open && containerRef.current && !containerRef.current.contains(e.target)) setOpen(false) }
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

/* ---------- Lightbox pro fotky ---------- */
function Lightbox({ open, onClose, src, alt }: { open: boolean, onClose: () => void, src: string | null, alt?: string }) {
  if (!open || !src) return null
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
      <img src={src} alt={alt || ""} style={{ maxWidth: "96vw", maxHeight: "92vh", objectFit: "contain", borderRadius: 12, boxShadow: "0 10px 40px rgba(0,0,0,.6)", border: "1px solid rgba(255,255,255,.15)" }} />
    </div>
  )
}

/* ---------- AutoCenter & AutoFrame (zachováno pro live) ---------- */
function AutoCenterAndFrame({
  rootRef, depsKey, setTarget,
  margin = 1.2, isMobile = false, desktopScale = 0.4, mobileScale = 1.0,
  centerMode = "combined", shouldFrame,
}: {
  rootRef: React.RefObject<THREE.Group>
  depsKey: string
  setTarget: React.Dispatch<React.SetStateAction<[number, number, number]>>
  margin?: number, isMobile?: boolean, desktopScale?: number, mobileScale?: number
  centerMode?: "per" | "combined" | "none"
  shouldFrame: React.MutableRefObject<boolean>
}) {
  const { camera, size } = useThree()
  useEffect(() => {
    if (!shouldFrame?.current) return
    const root = rootRef.current as any
    if (!root) return

    root.updateMatrixWorld(true)
    const boxAll = new THREE.Box3().setFromObject(root)
    if (boxAll.isEmpty()) return

    const centerAll = new THREE.Vector3()
    const dims = new THREE.Vector3()
    boxAll.getCenter(centerAll)
    boxAll.getSize(dims)

    if (centerMode === "per") {
      root.children.forEach((child: any) => {
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

    ;(camera as any).near = 0.1
    ;(camera as any).far = Math.max(safeDist * 10, 1e6)
    ;(camera as any).zoom = Math.max(newZoom, 0.01)
    ;(camera as any).position.set(ctr.x, ctr.y, ctr.z + safeDist)
    ;(camera as any).updateProjectionMatrix()

    shouldFrame.current = false
  }, [depsKey, size.width, size.height, isMobile, desktopScale, mobileScale, margin, centerMode])
  return null
}

/* ---------- Hlavní komponenta (LIVE + nové featury) ---------- */
export default function ClientPage() {
  const [lightIntensity, setLightIntensity] = useState(1)
  const [headlightCfg, setHeadlightCfg] = useState({ enabled: true, intensity: 2.0 })

  const [uiReady, setUiReady] = useState(false)
  useEffect(() => { const id = requestAnimationFrame(() => setUiReady(true)); return () => cancelAnimationFrame(id) }, [])

  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    try {
      const uaMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
      const coarse = typeof window !== "undefined" && window.matchMedia && window.matchMedia("(pointer: coarse)").matches
      const narrow = typeof window !== "undefined" && window.innerWidth < 768
      setIsMobile(uaMobile || coarse || narrow)
    } catch {}
  }, [])

  const [title, setTitle] = useState<string | null>(null)

  const [files, setFiles] = useState<any[]>([])
  const [colors, setColors] = useState<string[]>([])
  const [opacities, setOpacities] = useState<number[]>([])
  const [visibles, setVisibles] = useState<boolean[]>([])
  const [roughnesses, setRoughnesses] = useState<number[]>([])
  const [metalnesses, setMetalnesses] = useState<number[]>([])
  const [fatal, setFatal] = useState<string | null>(null)

  const [autoSmooth, setAutoSmooth] = useState((getParam("smooth") ?? "1") !== "0")
  const [smoothAngle, setSmoothAngle] = useState(() => {
    const v = parseFloat(getParam("smoothAngle") ?? "30")
    return isFinite(v) ? Math.max(0, Math.min(80, v)) : 30
  })
  const [wireframe, setWireframe] = useState(false)

  const [logoCfg, setLogoCfg] = useState({ url: DEFAULT_LOGO, opacity: 0.9, width: 160, pos: "bc" as "bl" | "bc" | "br" })
  const [photos, setPhotos] = useState<Array<{ n?: string, u: string }>>([])
  const [lightbox, setLightbox] = useState<{ open: boolean, src: string | null, alt?: string }>({ open: false, src: null })

  // kamera
  const [loadedCount, setLoadedCount] = useState(0)
  const handleModelLoaded = () => setLoadedCount((n) => n + 1)
  const centerParam = (getParam("center") || "combined").toLowerCase()
  const centerMode = (["per", "combined", "none"] as const).includes(centerParam as any) ? (centerParam as any) : "combined"

  // framing control pro LIVE
  const shouldFrameRef = useRef(true)
  const prevFileKeysRef = useRef<string[]>([])
  const getFileKeys = (arr: any[]) => (arr || []).map(f => `${f.url}::${f.rawName || f.name}`)

  // jediný zdroj pravdy pro target kamery
  const [cameraTarget, setCameraTarget] = useState<[number, number, number]>([0, 0, 0])

  /* ───────── INIT: manifest (?m nebo ?manifest) / ?files / LIVE noDemo ───────── */
  useEffect(() => {
    ;(async () => {
      try {
        // 1) Pretty: ?m=<folder> (stahuje manifest z public bucketu)
        const mId = getParam("m")
        if (mId) {
          const manifestUrl = `${SUPABASE_URL}/storage/v1/object/public/${PUBLIC_BUCKET}/manifests/${encodeURIComponent(mId)}.json`
          const m = await fetchJSON(manifestUrl)
          const Fs = (m?.files || []).map((x: any, i: number) => ({
            url: x.u, name: stripExt(x.n) || `Model ${i + 1}`, rawName: x.n,
            c: x.c, o: typeof x.o === "number" ? clamp01(x.o) : 1,
            v: typeof x.v === "boolean" ? x.v : true,
            r: typeof x.r === "number" ? clamp01(x.r) : 0.5,
            m: typeof x.m === "number" ? clamp01(x.m) : 0.5,
            vc: !!x.vc, km: !!x.km,
          }))
          if (!Fs.length) throw new Error("Manifest je prázdný.")
          setFiles(Fs)
          const palette = ["#f5f5dc", "#8e8e8e", "#ffffff", "#ffd7a8", "#c0c0c0", "#e6f0ff", "#ffeedd"]
          setColors(Fs.map((f: any, i: number) => f.c || palette[i % palette.length]))
          setOpacities(Fs.map((f: any) => (typeof f.o === "number" ? clamp01(f.o) : 1)))
          setVisibles(Fs.map((f: any) => (typeof f.v === "boolean" ? f.v : true)))
          setRoughnesses(Fs.map((f: any) => (typeof f.r === "number" ? clamp01(f.r) : 0.5)))
          setMetalnesses(Fs.map((f: any) => (typeof f.m === "number" ? clamp01(f.m) : 0.5)))
          setTitle(typeof m?.title === "string" ? m.title : (getParam("title") ?? null))
          const logoUrl = m?.logo?.url || DEFAULT_LOGO
          setLogoCfg({
            url: logoUrl || null,
            opacity: clamp01(parseFloat(getParam("logoOpacity") ?? "0.9")),
            width: parseInt(getParam("logoWidth") ?? (window.innerWidth < 768 ? "120" : "160"), 10),
            pos: (getParam("logoPos") as any) || "bc",
          })
          const hl = m?.lights?.headlight
          setHeadlightCfg({
            enabled: typeof hl?.enabled === "boolean" ? hl.enabled : true,
            intensity: typeof hl?.intensity === "number" ? hl.intensity : 2.0,
          })
          setPhotos(Array.isArray(m?.photos) ? m.photos.filter((p: any) => p && p.u) : [])
          prevFileKeysRef.current = getFileKeys(Fs)
          shouldFrameRef.current = true
          return
        }

        // 2) manifest URL
        const manifestUrlParam = getParam("manifest")
        if (manifestUrlParam) {
          const m = await fetchJSON(manifestUrlParam)
          const Fs = (m?.files || []).map((x: any, i: number) => ({
            url: x.u, name: stripExt(x.n) || `Model ${i + 1}`, rawName: x.n,
            c: x.c, o: typeof x.o === "number" ? clamp01(x.o) : 1,
            v: typeof x.v === "boolean" ? x.v : true,
            r: typeof x.r === "number" ? clamp01(x.r) : 0.5,
            m: typeof x.m === "number" ? clamp01(x.m) : 0.5,
            vc: !!x.vc, km: !!x.km,
          }))
          if (!Fs.length) throw new Error("Manifest je prázdný.")
          setFiles(Fs)
          const palette = ["#f5f5dc", "#8e8e8e", "#ffffff", "#ffd7a8", "#c0c0c0", "#e6f0ff", "#ffeedd"]
          setColors(Fs.map((f: any, i: number) => f.c || palette[i % palette.length]))
          setOpacities(Fs.map((f: any) => (typeof f.o === "number" ? clamp01(f.o) : 1)))
          setVisibles(Fs.map((f: any) => (typeof f.v === "boolean" ? f.v : true)))
          setRoughnesses(Fs.map((f: any) => (typeof f.r === "number" ? clamp01(f.r) : 0.5)))
          setMetalnesses(Fs.map((f: any) => (typeof f.m === "number" ? clamp01(f.m) : 0.5)))
          setTitle(typeof m?.title === "string" ? m.title : (getParam("title") ?? null))
          const logoUrl = m?.logo?.url || DEFAULT_LOGO
          setLogoCfg({
            url: logoUrl || null,
            opacity: clamp01(parseFloat(getParam("logoOpacity") ?? "0.9")),
            width: parseInt(getParam("logoWidth") ?? (window.innerWidth < 768 ? "120" : "160"), 10),
            pos: (getParam("logoPos") as any) || "bc",
          })
          const qOn = getParam("headlight")
          const qI = parseFloat(getParam("headlightI") ?? "NaN")
          setHeadlightCfg({
            enabled: qOn == null ? true : qOn !== "0",
            intensity: isFinite(qI) ? qI : 2.0,
          })
          setPhotos(Array.isArray(m?.photos) ? m.photos.filter((p: any) => p && p.u) : [])
          prevFileKeysRef.current = getFileKeys(Fs)
          shouldFrameRef.current = true
          return
        }

        // 3) ?files=
        const filesParam = getParam("files")
        if (filesParam) {
          let arr: any = null
          try { arr = JSON.parse(filesParam) } catch {}
          if (!arr) { try { arr = JSON.parse(decodeURIComponent(filesParam)) } catch {} }
          const Fs = (Array.isArray(arr) ? arr : []).filter((x) => x && x.u).map((x: any, i: number) => ({
            url: x.u, name: stripExt(x.n) || `Model ${i + 1}`, rawName: x.n,
            c: x.c, o: typeof x.o === "number" ? clamp01(x.o) : 1,
            v: typeof x.v === "boolean" ? x.v : true,
            r: typeof x.r === "number" ? clamp01(x.r) : 0.5,
            m: typeof x.m === "number" ? clamp01(x.m) : 0.5,
            vc: !!x.vc, km: !!x.km,
          }))
          setFiles(Fs)
          const palette = ["#f5f5dc", "#8e8e8e", "#ffffff", "#ffd7a8", "#c0c0c0", "#e6f0ff", "#ffeedd"]
          setColors(Fs.map((f: any, i: number) => f.c || palette[i % palette.length]))
          setOpacities(Fs.map((f: any) => f.o))
          setVisibles(Fs.map((f: any) => f.v))
          setRoughnesses(Fs.map((f: any) => f.r))
          setMetalnesses(Fs.map((f: any) => f.m))
          setTitle(getParam("title") ?? null)
          setLogoCfg({
            url: getParam("logo") === "none" ? null : getParam("logo") || DEFAULT_LOGO,
            opacity: clamp01(parseFloat(getParam("logoOpacity") ?? "0.9")),
            width: parseInt(getParam("logoWidth") ?? (window.innerWidth < 768 ? "120" : "160"), 10),
            pos: (getParam("logoPos") as any) || "bc",
          })
          prevFileKeysRef.current = getFileKeys(Fs)
          shouldFrameRef.current = true
          return
        }

        // 4) LIVE režim bez dema
        const mode = (getParam("mode") || "").toLowerCase()
        const noDemo = (getParam("noDemo") ?? (mode === "live" ? "1" : "0")) !== "0"
        const modeLive = mode === "live"
        const suppressDemo = noDemo || modeLive
        if (suppressDemo) {
          setFiles([]); setColors([]); setOpacities([]); setVisibles([]); setRoughnesses([]); setMetalnesses([])
          setTitle(getParam("title") ?? null)
          setLogoCfg({
            url: getParam("logo") === "none" ? null : (getParam("logo") || DEFAULT_LOGO),
            opacity: clamp01(parseFloat(getParam("logoOpacity") ?? "0.9")),
            width: parseInt(getParam("logoWidth") ?? (window.innerWidth < 768 ? "120" : "160"), 10),
            pos: (getParam("logoPos") as any) || "bc",
          })
          shouldFrameRef.current = false
          return
        }

        // fallback: prázdno (nebo si tu dejte demo)
        setFiles([]); setColors([]); setOpacities([]); setVisibles([]); setRoughnesses([]); setMetalnesses([])
      } catch (e: any) {
        console.error(e)
        setFatal("Tento náhled není dostupný (chyba při načtení dat).")
      }
    })()
  }, [])

  /* ───────── LIVE postMessage listener ───────── */
  const applyLivePayload = (p: any) => {
    if (!p) return
    let filesActuallyChanged = false
    if (Array.isArray(p.files) && !(p.onlyParams && p.files.length === 0)) {
      const newFiles = p.files.map((x: any, i: number) => ({
        url: x.u, name: stripExt(x.n || `Model ${i + 1}`), rawName: x.n || `Model${i + 1}`,
        c: x.c, o: typeof x.o === "number" ? clamp01(x.o) : 1,
        v: typeof x.v === "boolean" ? x.v : true,
        r: typeof x.r === "number" ? clamp01(x.r) : 0.5,
        m: typeof x.m === "number" ? clamp01(x.m) : 0.5,
        vc: !!x.vc, km: !!x.km,
      }))

      const newKeys = newFiles.map((f: any) => `${f.url}::${f.rawName || f.name}`)
      const prevKeys = prevFileKeysRef.current
      filesActuallyChanged =
        newKeys.length !== prevKeys.length ||
        newKeys.some((k, i) => k !== prevKeys[i])

      setFiles(newFiles)
      prevFileKeysRef.current = newKeys

      const palette = ["#f5f5dc", "#8e8e8e", "#ffffff", "#ffd7a8", "#c0c0c0", "#e6f0ff", "#ffeedd"]
      setColors(newFiles.map((f: any, i: number) => f.c || palette[i % palette.length]))
      setOpacities(newFiles.map((f: any) => f.o))
      setVisibles(newFiles.map((f: any) => f.v))
      setRoughnesses(newFiles.map((f: any) => f.r))
      setMetalnesses(newFiles.map((f: any) => f.m))
    }

    if (typeof p.title === "string" || p.title === null) setTitle(p.title ?? null)
    if (p.logo) {
      setLogoCfg((old) => ({
        url: p.logo?.url ?? old.url,
        opacity: typeof p.logo?.opacity === "number" ? clamp01(p.logo.opacity) : old.opacity,
        width: typeof p.logo?.width === "number" ? p.logo.width : old.width,
        pos: (p.logo?.pos as any) || old.pos,
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
    const onMsg = (e: MessageEvent) => {
      const data: any = e.data
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

  /* ---------- UI prvky ---------- */
  const logoEl = logoCfg.url && (
    <img
      src={logoCfg.url!}
      alt=""
      style={{
        position: "absolute",
        bottom: (logoCfg.pos === "bc" || logoCfg.pos === "bl" || logoCfg.pos === "br") ? 12 : "auto",
        left: logoCfg.pos === "bl" ? 12 : logoCfg.pos === "bc" ? "50%" : "auto",
        right: logoCfg.pos === "br" ? 12 : "auto",
        transform: logoCfg.pos === "bc" ? "translateX(-50%)" : "none",
        width: logoCfg.width, opacity: logoCfg.opacity, zIndex: 0,
        pointerEvents: "none", userSelect: "none",
        filter: "drop-shadow(0 0 1px rgba(0,0,0,.25))",
      }}
    />
  )

  const rootRef = useRef<THREE.Group>(null)
  const frameDepsKey = shouldFrameRef.current
    ? `frame-${files.length}-${loadedCount}`
    : `noframe-${files.length}-${loadedCount}`

  return (
    <div className="stage" style={{ position: "relative", width: "100vw", height: "100vh", background: "black" }}>
      <PreloadIcons />
      {logoEl}

      {/* Panel */}
      <div
        className="controls-panel"
        style={{
          position: "absolute",
          top: 10, left: 10, zIndex: 2,
          color: "white", fontFamily: "sans-serif", fontSize: "14px",
          opacity: uiReady ? 1 : 0, transition: "opacity .12s ease",
          backdropFilter: "blur(3px)", background: "rgba(0,0,0,.25)",
          border: "1px solid rgba(255,255,255,.15)", borderRadius: 8,
          padding: "8px 10px", width: "clamp(260px, 30vw, 420px)",
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
                  marginBottom: 8, maxWidth: 320, padding: "6px 10px",
                  borderRadius: 8, border: "1px solid rgba(255,255,255,.18)",
                  background: "rgba(255,255,255,.08)", fontSize: 13, fontWeight: 700,
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"
                }}
              >
                {title}
              </div>
            )}

            {/* Per-model ovladače */}
            {files.map((f, i) => (
              <div key={`${f.url}-${i}`} style={{ display: "grid", gridTemplateColumns: "36px 1fr 36px", alignItems: "center", gap: 6, margin: "6px 0" }}>
                <div style={{ gridColumn: "1 / -1", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={f.rawName || f.name}>
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

            {/* Auto smooth + Úhel + Wireframe */}
            <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                  <input type="checkbox" checked={autoSmooth} onChange={(e) => setAutoSmooth(e.target.checked)} />
                  <span>Auto smooth</span>
                </label>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                  <input type="checkbox" checked={wireframe} onChange={(e) => setWireframe(e.target.checked)} />
                  <span>Wireframe</span>
                </label>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ opacity: 0.8, fontSize: 12 }}>Úhel: {Math.round(smoothAngle)}°</span>
                <input className="slider" type="range" min={0} max={80} step={1} value={smoothAngle}
                  onChange={(e) => setSmoothAngle(parseFloat(e.target.value))} style={{ width: 160 }} />
              </div>
            </div>

            {/* Fotky (pokud jsou v manifestu) */}
            {photos.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>Fotky ({photos.length})</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(72px,1fr))", gap: 8 }}>
                  {photos.map((p, i) => (
                    <button key={i} onClick={() => setLightbox({ open: true, src: p.u, alt: p.n || "" })}
                      style={{ padding: 0, margin: 0, border: "none", background: "transparent", cursor: "pointer", borderRadius: 8, overflow: "hidden", boxShadow: "0 1px 6px rgba(0,0,0,.35)", border: "1px solid rgba(255,255,255,.12)" }}
                      title={p.n || ""}>
                      <img src={p.u} alt={p.n || ""} loading="lazy" style={{ display: "block", width: "100%", height: 72, objectFit: "cover" }} />
                    </button>
                  ))}
                </div>
              </div>
            )}
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

            <AutoCenterAndFrame
              rootRef={rootRef}
              depsKey={shouldFrameRef.current ? `frame-${files.length}-${loadedCount}` : `noframe-${files.length}-${loadedCount}`}
              setTarget={setCameraTarget}
              margin={1.2}
              isMobile={isMobile}
              desktopScale={0.4}
              mobileScale={1.0}
              centerMode={centerMode as any}
              shouldFrame={shouldFrameRef}
            />

            <TouchTrackballControls target={cameraTarget} />
            <RightButtonPan setTarget={setCameraTarget} />
          </>
        )}
      </Canvas>

      <Lightbox open={!!lightbox.open} onClose={() => setLightbox({ open: false, src: null })} src={lightbox.src} alt={lightbox.alt || ""} />

      {/* Globální styly */}
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
