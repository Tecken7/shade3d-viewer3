"use client"

import { Canvas, useThree, useFrame } from "@react-three/fiber"
import * as THREE from "three"
import { Suspense, useEffect, useMemo, useRef, useState } from "react"
import { Html } from "@react-three/drei"
import { TrackballControls } from "three/examples/jsm/controls/TrackballControls"
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader"
import { STLLoader } from "three/examples/jsm/loaders/STLLoader"
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader"

/* ---------- Live message types ---------- */
const LIVE_MSG_TYPES = new Set(["SHADE3D_LIVE", "SHADE3D_LIVE_V6", "SHADE3D_LIVE_V5"])

/* ---------- Helpers ---------- */
const DEFAULT_LOGO = "/Arthetic_logo.png"
const stripExt = (s?: string) => (s ? s.replace(/\.[^.]+$/, "") : "")
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
function inferExt(nameOrUrl?: string) {
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

/* ---------- AnyModel (s wireframe overlay) ---------- */
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
  useVertexColors?: boolean, keepMaterials?: boolean,
  wireframe?: boolean
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

  const forEachMesh = (obj: any, cb: (m: THREE.Mesh) => void) => {
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
        let obj: THREE.Object3D
        if (ext === "stl") {
          const geom = await new STLLoader().loadAsync(url)
          if (!geom.attributes.normal) geom.computeVertexNormals()
          const base = autoSmooth ? autoSmoothGeometry(geom, smoothAngle) : (geom.computeVertexNormals(), geom)
          const mat = makeMat()
          obj = new THREE.Mesh(base, mat)
          ;(obj as any).userData._baseGeom = geom
          ;(obj as any).userData._derivedGeom = base
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
          ;(obj as any).userData._baseGeom = geom
          ;(obj as any).userData._derivedGeom = base
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
        if (!cancelled) setLoading(false)
        console.error("Model load error:", e)
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ext])

  // Re-smoothing + rebuild overlay při změně
  useEffect(() => {
    if (!object3D) return
    forEachMesh(object3D, (child: any) => {
      if (!child.userData._baseGeom) child.userData._baseGeom = child.geometry
      const base: THREE.BufferGeometry = child.userData._baseGeom
      let newGeom: THREE.BufferGeometry = base
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

  // Materiál + viditelnost overlaye
  useEffect(() => {
    if (!object3D) return
    ;(object3D as any).traverse?.((child: any) => {
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
      if (child.userData._edges) child.userData._edges.visible = !!wireframe
      else if (wireframe) rebuildWireOverlay(child)
    })
  }, [object3D, color, opacity, roughness, metalness, useVertexColors, keepMaterials, wireframe])

  if (!object3D) return loading ? <InlineLoader text={`Načítám ${name || url}`} /> : null
  return visible ? <primitive object={object3D} /> : null
}

/* ---------- Headlight ---------- */
function Headlight({ enabled = true, intensity = 2, color = "#ffffff" }: { enabled?: boolean, intensity?: number, color?: string }) {
  const { camera } = useThree()
  const ref = useRef<THREE.PointLight | null>(null)
  useFrame(() => { if (ref.current) ref.current.position.copy(camera.position) })
  return <pointLight ref={ref} color={color} intensity={enabled ? intensity : 0} distance={0} decay={0} />
}

/* ---------- Trackball (lepší resize/ovládání) ---------- */
function TouchTrackballControls({ target = [0, 0, 0] }: { target?: [number, number, number] }) {
  const { camera, gl, size } = useThree()
  const controlsRef = useRef<any>(null)

  useEffect(() => {
    const controls = new TrackballControls(camera, gl.domElement)
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

  useFrame(() => {
    const c = controlsRef.current
    if (!c) return
    if ((camera as any).isOrthographicCamera) c.panSpeed = (camera as any).zoom * 0.4
    c.update()
  })

  useEffect(() => {
    controlsRef.current?.handleResize?.()
  }, [size.width, size.height])

  return null
}

/* ---------- Right Button / Ctrl+Left – Pan ---------- */
function RightButtonPan({ setTarget }: { setTarget?: React.Dispatch<React.SetStateAction<[number, number, number]>> }) {
  const { camera, gl, size } = useThree()
  const isPanning = useRef(false)
  const last = useRef({ x: 0, y: 0 })
  const pointerIdRef = useRef<number | null>(null)

  const PAN_SENSITIVITY = 0.85
  const right = new THREE.Vector3()
  const up = new THREE.Vector3()
  const deltaWorld = new THREE.Vector3()

  useEffect(() => {
    const el = gl.domElement as HTMLElement

    const onContext = (e: MouseEvent) => { e.preventDefault() }

    const onDown = (e: PointerEvent) => {
      if ((e.button !== 2) && !(e.button === 0 && (e as any).ctrlKey)) return
      e.preventDefault()
      e.stopPropagation()
      isPanning.current = true
      last.current = { x: e.clientX, y: e.clientY }
      pointerIdRef.current = e.pointerId
      try { (el as any).setPointerCapture?.(e.pointerId) } catch {}
    }

    const onMove = (e: PointerEvent) => {
      if (!isPanning.current) return
      e.preventDefault()
      e.stopPropagation()

      const dx = e.clientX - last.current.x
      const dy = e.clientY - last.current.y
      last.current = { x: e.clientX, y: e.clientY }

      right.setFromMatrixColumn((camera as any).matrixWorld, 0).normalize()
      up.setFromMatrixColumn((camera as any).matrixWorld, 1).normalize()

      if ((camera as any).isOrthographicCamera) {
        const cam = camera as any
        const wppX = ((cam.right - cam.left) / (size.width * cam.zoom))
        const wppY = ((cam.top - cam.bottom) / (size.height * cam.zoom))
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

    const onUp = (e: PointerEvent) => {
      if (!isPanning.current) return
      e.preventDefault()
      e.stopPropagation()
      isPanning.current = false
      try { (el as any).releasePointerCapture?.(pointerIdRef.current) } catch {}
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

/* ---------- AutoCenter & AutoFrame (se shouldFrame) ---------- */
function AutoCenterAndFrame({
  rootRef, depsKey, setTarget,
  margin = 1.2, isMobile = false, desktopScale = 0.4, mobileScale = 1.0,
  centerMode = "combined",
  shouldFrame,
}: {
  rootRef: React.MutableRefObject<THREE.Group | undefined>,
  depsKey: string,
  setTarget: (t: [number, number, number]) => void,
  margin?: number, isMobile?: boolean, desktopScale?: number, mobileScale?: number,
  centerMode?: "per" | "combined" | "none",
  shouldFrame?: React.MutableRefObject<boolean>
}) {
  const { camera, size } = useThree()

  useEffect(() => {
    if (shouldFrame && !shouldFrame.current) return

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

    const depth = Math.max(dims2.z, Math.max(dims2.x, dims2.y) * 0.75) || 1
    const safeDist = depth * 4
    ;(camera as any).near = Math.max(0.01, safeDist * 0.001)
    ;(camera as any).far = safeDist * 50 + 100
    camera.position.set(ctr.x, ctr.y, ctr.z + safeDist)
    ;(camera as any).zoom = Math.max(newZoom, 0.01)
    camera.updateProjectionMatrix()

    if (shouldFrame) shouldFrame.current = false
  }, [depsKey, size.width, size.height, isMobile, desktopScale, mobileScale, margin, centerMode])

  return null
}

/* ---------- Hlavní komponenta (Live + Upgrady) ---------- */
export default function ClientPage() {
  // světla
  const [lightIntensity] = useState(1)
  const [headlightCfg, setHeadlightCfg] = useState({ enabled: true, intensity: 2.0 })

  // UI fade-in
  const [uiReady, setUiReady] = useState(false)
  useEffect(() => { const id = requestAnimationFrame(() => setUiReady(true)); return () => cancelAnimationFrame(id) }, [])

  // mobile detection
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

  // modely
  const [files, setFiles] = useState<any[]>([])
  const [colors, setColors] = useState<string[]>([])
  const [opacities, setOpacities] = useState<number[]>([])
  const [visibles, setVisibles] = useState<boolean[]>([])
  const [roughnesses, setRoughnesses] = useState<number[]>([])
  const [metalnesses, setMetalnesses] = useState<number[]>([])
  const [fatal, setFatal] = useState<string | null>(null)

  // auto smooth + wireframe
  const [autoSmooth, setAutoSmooth] = useState((getParam("smooth") ?? "1") !== "0")
  const [smoothAngle, setSmoothAngle] = useState(() => {
    const v = parseFloat(getParam("smoothAngle") ?? "30")
    return isFinite(v) ? Math.max(0, Math.min(80, v)) : 30
  })
  const [wireframe, setWireframe] = useState(false)

  // logo
  const [logoCfg, setLogoCfg] = useState({ url: DEFAULT_LOGO, opacity: 0.9, width: 160, pos: "bc" as "bc" | "bl" | "br" })

  // kamera / frame kontrola
  const [loadedCount, setLoadedCount] = useState(0)
  const handleModelLoaded = () => setLoadedCount((n) => n + 1)
  const centerParam = (getParam("center") || "combined").toLowerCase()
  const centerMode = (["per", "combined", "none"] as const).includes(centerParam as any) ? (centerParam as any) : "combined"
  const shouldFrameRef = useRef(true)
  const prevFileKeysRef = useRef<string[]>([])
  const getFileKeys = (arr: any[]) => (arr || []).map(f => `${f.url}::${f.rawName || f.name}`)

  // init z URL / manifestu (bez demo fallbacku v live módu)
  useEffect(() => {
    ;(async () => {
      try {
        const manifestUrl = getParam("manifest")
        const filesParam = getParam("files")
        const mode = (getParam("mode") || "").toLowerCase()
        const noDemo = (getParam("noDemo") ?? (mode === "live" ? "1" : "0")) !== "0"

        if (manifestUrl) {
          const m = await fetchJSON(manifestUrl)
          const Fs = (m?.files || []).map((x: any, i: number) => ({
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

          setTitle(typeof m?.title === "string" ? m.title : (getParam("title") ?? null))
          const logoUrl = m?.logo?.url || DEFAULT_LOGO
          setLogoCfg({
            url: logoUrl || null,
            opacity: clamp01(parseFloat(getParam("logoOpacity") ?? "0.9")),
            width: parseInt(getParam("logoWidth") ?? (window.innerWidth < 768 ? "120" : "160"), 10),
            pos: (getParam("logoPos") as any) || "bc",
          })

          const hl = m?.lights?.headlight
          if (hl && typeof hl === "object") setHeadlightCfg({
            enabled: typeof hl.enabled === "boolean" ? hl.enabled : true,
            intensity: typeof hl.intensity === "number" ? hl.intensity : 2.0,
          })
          const scI = m?.lights?.intensity
          if (typeof scI === "number") { /* zachováno, ale neukládáme lightIntensity state */ }

          prevFileKeysRef.current = getFileKeys(Fs)
          shouldFrameRef.current = true
          return
        }

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
            url: getParam("logo") === "none" ? null : (getParam("logo") || DEFAULT_LOGO),
            opacity: clamp01(parseFloat(getParam("logoOpacity") ?? "0.9")),
            width: parseInt(getParam("logoWidth") ?? (window.innerWidth < 768 ? "120" : "160"), 10),
            pos: (getParam("logoPos") as any) || "bc",
          })

          const qOn = getParam("headlight")
          const qI = parseFloat(getParam("headlightI") ?? "NaN")
          setHeadlightCfg({ enabled: qOn == null ? true : qOn !== "0", intensity: isFinite(qI) ? qI : 2.0 })

          prevFileKeysRef.current = getFileKeys(Fs)
          shouldFrameRef.current = true
          return
        }

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
          shouldFrameRef.current = false // live payload si vyžádá frame
          return
        }

        setFiles([]); setColors([]); setOpacities([]); setVisibles([]); setRoughnesses([]); setMetalnesses([])
      } catch (e) {
        console.error(e)
        setFatal("Tento náhled není dostupný (chyba při načtení dat).")
      }
    })()
  }, [])

  /* ───────── LIVE MODE: postMessage listener (zachováno) ───────── */
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
        pos: p.logo?.pos || (old.pos as any),
      }))
    }
    if (p.lights) {
      if (typeof p.lights.intensity === "number") { /* unused scalar kept */ }
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

  // logo
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

  // scene root
  const rootRef = useRef<THREE.Group>()

  // klíč pro AutoCenterAndFrame (jen pokud máme rámovat)
  const frameDepsKey = shouldFrameRef.current
    ? `frame-${files.length}-${loadedCount}`
    : `noframe-${files.length}-${loadedCount}`

  // target kamery
  const [cameraTarget, setCameraTarget] = useState<[number, number, number]>([0, 0, 0])

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
                  background: "rgba(255,255,255,.08)", fontSize: 13, fontWeight: 600,
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"
                }}
              >
                {title}
              </div>
            )}

            {/* AutoSmooth + angle */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, justifyContent: "space-between" }}>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                <input type="checkbox" checked={autoSmooth} onChange={(e) => setAutoSmooth(e.target.checked)} />
                <span>Auto smooth</span>
              </label>
              <span style={{ opacity: 0.8, fontSize: 12 }}>Úhel: {Math.round(smoothAngle)}°</span>
            </div>
            <input
              className="slider"
              type="range" min={0} max={80} step={1}
              value={smoothAngle}
              onChange={(e) => setSmoothAngle(parseFloat(e.target.value))}
              style={{ width: "100%", marginTop: 6 }}
              aria-label="Smooth angle"
            />

            {/* Wireframe */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, justifyContent: "flex-start" }}>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                <input type="checkbox" checked={wireframe} onChange={(e) => setWireframe(e.target.checked)} />
                <span>Wireframe</span>
              </label>
            </div>
          </>
        )}
      </div>

      {/* CANVAS */}
      <Canvas
        orthographic
        camera={{ position: [0, 0, 100], near: 0.01, far: 100000 }}
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

            <group ref={rootRef as any}>
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
              rootRef={rootRef as any}
              depsKey={shouldFrameRef.current ? `frame-${files.length}-${loadedCount}` : `noframe-${files.length}-${loadedCount}`}
              setTarget={(t) => setCameraTarget(t)}
              margin={1.2}
              isMobile={isMobile}
              desktopScale={0.4}
              mobileScale={1.0}
              centerMode={centerMode}
              shouldFrame={shouldFrameRef}
            />

            <TouchTrackballControls target={cameraTarget} />
            <RightButtonPan setTarget={setCameraTarget} />
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
