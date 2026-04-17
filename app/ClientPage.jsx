"use client"

import React, { Suspense, useEffect, useMemo, useRef, useState } from "react"
import { Canvas, useThree, useFrame } from "@react-three/fiber"
import * as THREE from "three"
import { Html, TransformControls, OrbitControls } from "@react-three/drei"
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
function filesChanged(prev, next) {
  if (prev.length !== next.length) return true
  for (let i = 0; i < prev.length; i++) if (prev[i].url !== next[i].url) return true
  return false
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
    try { Object.values(ICONS).forEach((src) => { const i = new Image(); i.decoding="async"; i.src = src }) } catch {}
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
  const triCount = pos.count / 3
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
  for (let i = 0; i < pos.count; i++) {
    const k = keyOf(i)
    let arr = groups.get(k); if (!arr) { arr = []; groups.set(k, arr) }
    arr.push(i)
  }
  const normals = new Float32Array(pos.count * 3)
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
      tmp.set(nx, ny, nz); if (tmp.lengthSq() === 0) tmp.copy(nRef); tmp.normalize()
      const w = ci * 3; normals[w] = tmp.x; normals[w+1] = tmp.y; normals[w+2] = tmp.z
    }
  })
  g.setAttribute("normal", new THREE.BufferAttribute(normals, 3))
  g.computeBoundingBox(); g.computeBoundingSphere()
  return g
}

/* ---------- Loader ---------- */
function InlineLoader({ text }) {
  return (
    <Html center>
      <div style={{ background: "rgba(0,0,0,0.7)", padding: "16px 28px", borderRadius: 10, color: "white", fontFamily: "sans-serif", fontSize: 16 }}>
        ⏳ {text || "Načítám…"}
      </div>
    </Html>
  )
}

/* ---------- VEKTOROVÝ MODEL KOMPONENTA ---------- */
const CUT_LINE_THICKNESS = 0.2 // tloušťka linky v mm

function AnyModel({
  name, url, color, opacity, visible,
  onLoaded, autoSmooth, smoothAngle = DEFAULT_SMOOTH_ANGLE,
  roughness = 0.5, metalness = 0.5, useVertexColors = false,
  keepMaterials = false, wireframe = false,
  outlinePlane = null, 
  isSliceView = false,
  onSnapMove = null, onSnapClick = null, onSnapDoubleClick = null
}) {
  const [object3D, setObject3D] = useState(null)
  const ext = useMemo(() => inferExt(name || url), [name, url])
  
  // Barva linky: Oranžová v 3D, barva skenu v 2D
  const outlineColor = useMemo(() => new THREE.Color(isSliceView ? (color || "#ffffff") : "#ff9900"), [isSliceView, color])

  const makeMat = (opts = {}) => {
    const baseMat = isSliceView 
      ? new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, ...opts })
      : new THREE.MeshStandardMaterial({
          color: new THREE.Color(color || "#ffffff"),
          roughness: typeof roughness === "number" ? roughness : 0.5,
          metalness: typeof metalness === "number" ? metalness : 0.5,
          transparent: opacity < 1, opacity,
          side: THREE.DoubleSide, depthWrite: opacity === 1,
          ...opts,
      })

    // VEKTOROVÝ SHADER: Matematicky vyřízne jen tenkou čáru
    baseMat.onBeforeCompile = (shader) => {
        shader.uniforms.uOutlinePlane = { value: new THREE.Vector4(0, 0, 0, 0) }
        shader.uniforms.uOutlineColor = { value: outlineColor }
        baseMat.userData.shader = shader

        shader.vertexShader = `
            varying vec3 vCustomWorldPos;
            ${shader.vertexShader}
        `.replace(
            `#include <worldpos_vertex>`,
            `#include <worldpos_vertex>\n vCustomWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
        )

        if (isSliceView) {
            // 2D VEKTOROVÝ LOOK: Všechno kromě čáry zmizí
            shader.fragmentShader = `
                uniform vec4 uOutlinePlane;
                uniform vec3 uOutlineColor;
                varying vec3 vCustomWorldPos;
                ${shader.fragmentShader}
            `.replace(
                `#include <dithering_fragment>`,
                `#include <dithering_fragment>\n if (length(uOutlinePlane.xyz) > 0.5) {\n float dist = dot(vCustomWorldPos, uOutlinePlane.xyz) + uOutlinePlane.w;\n if (abs(dist) > ${CUT_LINE_THICKNESS.toFixed(3)}) {\n discard;\n } else {\n gl_FragColor = vec4(uOutlineColor, 1.0);\n }\n } else { discard; }`
            )
        } else {
            // 3D LOOK: Čára svítí přes model
            shader.fragmentShader = `
                uniform vec4 uOutlinePlane;
                uniform vec3 uOutlineColor;
                varying vec3 vCustomWorldPos;
                ${shader.fragmentShader}
            `.replace(
                `#include <dithering_fragment>`,
                `#include <dithering_fragment>\n if (length(uOutlinePlane.xyz) > 0.5) {\n float dist = dot(vCustomWorldPos, uOutlinePlane.xyz) + uOutlinePlane.w;\n if (abs(dist) < ${CUT_LINE_THICKNESS.toFixed(3)}) {\n gl_FragColor = vec4(uOutlineColor, 1.0);\n }\n }`
            )
        }
    }
    return baseMat
  }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        let obj
        if (ext === "stl") {
          const geom = await new STLLoader().loadAsync(url)
          if (!geom.attributes.normal) geom.computeVertexNormals()
          obj = new THREE.Mesh(geom, makeMat())
          obj.userData._baseGeom = geom
        } else if (ext === "ply") {
          const geom = await new PLYLoader().loadAsync(url)
          obj = new THREE.Mesh(geom, makeMat())
          obj.userData._baseGeom = geom
        } else {
          obj = await new OBJLoader().loadAsync(url)
          if (!keepMaterials) {
            const mat = makeMat()
            obj.traverse((ch) => { if (ch.isMesh) ch.material = mat })
          }
        }
        if (!cancelled) {
          setObject3D(obj)
          onLoaded && onLoaded(url)
        }
      } catch (e) { console.error("Model load error:", e) }
    })()
    return () => { cancelled = true }
  }, [url, ext]) // eslint-disable-line

  useEffect(() => {
    if (!object3D) return
    object3D.traverse((child) => {
      if (!child.isMesh) return
      if (!child.userData._baseGeom) child.userData._baseGeom = child.geometry
      const base = child.userData._baseGeom
      
      if (child.userData._derivedGeom && child.userData._derivedGeom !== base) {
         child.userData._derivedGeom.dispose()
      }

      let newGeom = base
      if (autoSmooth && !isSliceView) newGeom = autoSmoothGeometry(base, smoothAngle)
      else { newGeom = base.clone(); newGeom.computeVertexNormals() }
      
      child.geometry = newGeom
      child.userData._derivedGeom = newGeom
    })
  }, [object3D, autoSmooth, smoothAngle, isSliceView]) // eslint-disable-line

  useEffect(() => {
    if (!object3D) return
    object3D.traverse((child) => {
      if (!child.isMesh) return
      
      let m = child.material
      if (!m) return
      
      if (!isSliceView) {
          m.transparent = opacity < 1
          m.opacity = opacity
          if ("roughness" in m) m.roughness = typeof roughness === "number" ? roughness : 0.5
          if ("metalness" in m) m.metalness = typeof metalness === "number" ? metalness : 0.5
          
          if (!keepMaterials) {
              const hasVC = !!child.geometry.getAttribute?.("color")
              m.color = new THREE.Color(hasVC && useVertexColors ? "#ffffff" : (color || "#ffffff"))
              m.vertexColors = hasVC && useVertexColors
          } else {
              if (!useVertexColors && "color" in m && color) m.color = new THREE.Color(color)
              if (useVertexColors && "vertexColors" in m) { 
                  m.vertexColors = true
                  if ("color" in m) m.color = new THREE.Color("#ffffff") 
              }
          }
      } else {
          m.color = new THREE.Color(color || "#ffffff")
      }
      
      m.needsUpdate = true
    })
  }, [object3D, color, opacity, roughness, metalness, useVertexColors, keepMaterials, wireframe, isSliceView]) // eslint-disable-line

  useFrame(() => {
      if (object3D) {
          object3D.traverse((child) => {
              if (child.isMesh && child.material?.userData?.shader) {
                  const uPlane = child.material.userData.shader.uniforms.uOutlinePlane.value
                  if (outlinePlane) {
                      uPlane.set(outlinePlane.normal.x, outlinePlane.normal.y, outlinePlane.normal.z, outlinePlane.constant)
                  } else {
                      uPlane.set(0, 0, 0, 0)
                  }
              }
          })
      }
  })

  if (!object3D) return null
  return visible ? (
    <primitive 
      object={object3D} 
      onClick={(e) => {
          if (!isSliceView) return
          e.stopPropagation()
          onSnapClick?.(e.point.clone())
      }}
      onDoubleClick={(e) => {
          if (!isSliceView) return
          e.stopPropagation()
          onSnapDoubleClick?.(e.point.clone())
      }}
      onPointerMove={(e) => {
          if (!isSliceView) return
          e.stopPropagation()
          onSnapMove?.(e.point.clone())
      }}
    />
  ) : null
}

/* ---------- Headlight ---------- */
function Headlight({ enabled = true, intensity = 2, color = "#ffffff" }) {
  const { camera } = useThree()
  const ref = useRef(null)
  useFrame(() => { if (ref.current) ref.current.position.copy(camera.position) })
  return <pointLight ref={ref} color={color} intensity={enabled ? intensity : 0} distance={0} decay={0} />
}

/* ---------- Trackball ---------- */
const TouchTrackballControls = React.forwardRef(({ target = [0, 0, 0], enabled = true }, ref) => {
  const { camera, gl, size } = useThree()
  const controlsRef = useRef(null)
  
  React.useImperativeHandle(ref, () => controlsRef.current)

  useEffect(() => {
    const c = new TrackballControls(camera, gl.domElement)
    c.rotateSpeed = 5.0
    c.zoomSpeed = 1.2
    c.panSpeed = 1.0
    c.staticMoving = true
    c.dynamicDampingFactor = 0.15
    c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ZOOM, RIGHT: THREE.MOUSE.PAN }
    controlsRef.current = c
    return () => c.dispose()
  }, [camera, gl])
  
  useEffect(() => {
    if (controlsRef.current) {
        controlsRef.current.enabled = enabled
    }
  }, [enabled])

  useEffect(() => {
    const c = controlsRef.current; if (!c) return
    c.target.set(target[0], target[1], target[2])
    c.update()
  }, [target])
  
  useFrame(() => { controlsRef.current?.update() })
  useEffect(() => { controlsRef.current?.handleResize() }, [size.width, size.height])
  return null
})

/* ---------- Vlastní pan ---------- */
function RightButtonPan({ setTarget, enabled = true }) {
  const { camera, gl, size } = useThree()
  const isPanning = useRef(false)
  const last = useRef({ x: 0, y: 0 })
  const pointerIdRef = useRef(null)

  const PAN_SENSITIVITY = 0.85
  const right = new THREE.Vector3()
  const up = new THREE.Vector3()
  const deltaWorld = new THREE.Vector3()

  useEffect(() => {
    const el = gl.domElement
    const onContext = (e) => { e.preventDefault() }

    const onDown = (e) => {
      if (!enabled) return
      if ((e.button !== 2) && !(e.button === 0 && e.ctrlKey)) return
      e.preventDefault()
      e.stopPropagation()
      isPanning.current = true
      last.current = { x: e.clientX, y: e.clientY }
      try { el.setPointerCapture?.(e.pointerId); pointerIdRef.current = e.pointerId } catch {}
    }

    const onMove = (e) => {
      if (!isPanning.current || !enabled) return
      e.preventDefault()
      e.stopPropagation()

      const dx = e.clientX - last.current.x
      const dy = e.clientY - last.current.y
      last.current = { x: e.clientX, y: e.clientY }

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

    const onUp = (e) => {
      if (!isPanning.current) return
      e.preventDefault()
      e.stopPropagation()
      isPanning.current = false
      if (pointerIdRef.current !== null) {
          try { el.releasePointerCapture?.(pointerIdRef.current) } catch {}
          pointerIdRef.current = null
      }
    }

    el.addEventListener("contextmenu", onContext)
    el.addEventListener("pointerdown", onDown)
    el.addEventListener("pointermove", onMove)
    el.addEventListener("pointerup", onUp)
    el.addEventListener("pointercancel", onUp)
    el.addEventListener("pointerleave", onUp)

    return () => {
      el.removeEventListener("contextmenu", onContext)
      el.removeEventListener("pointerdown", onDown)
      el.removeEventListener("pointermove", onMove)
      el.removeEventListener("pointerup", onUp)
      el.removeEventListener("pointercancel", onUp)
      el.removeEventListener("pointerleave", onUp)
    }
  }, [camera, gl, size.width, size.height, setTarget, enabled])

  return null
}

/* ---------- NÁSTROJ ŘEZ (DENTAL GIZMO - Poloprůhledný kruh) ---------- */
function ClippingGizmo({ plane, enabled, mode, setIsGizmoDragging, targetCenter }) {
  const meshRef = useRef(null)
  
  useEffect(() => {
    if (meshRef.current && enabled && plane) {
        meshRef.current.position.fromArray(targetCenter)
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,1), plane.normal)
        meshRef.current.quaternion.copy(q)
    }
  }, [enabled]) // eslint-disable-line

  useFrame(() => {
    if (meshRef.current && enabled && plane) {
        const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(meshRef.current.quaternion)
        plane.setFromNormalAndCoplanarPoint(normal, meshRef.current.position)
    }
  })

  if (!enabled) return null

  return (
    <TransformControls 
        mode={mode} 
        onDraggingChanged={(e) => {
            setIsGizmoDragging(e.value)
        }}
    >
        <mesh ref={meshRef}>
            <circleGeometry args={[40, 64]} />
            <meshBasicMaterial color="#ef4444" transparent opacity={0.15} side={THREE.DoubleSide} depthTest={false} depthWrite={false} />
            <lineSegments>
                <edgesGeometry args={[new THREE.CircleGeometry(40, 64)]} />
                <lineBasicMaterial color="#ffb700" depthTest={false} />
            </lineSegments>
        </mesh>
    </TransformControls>
  )
}

/* ---------- 2D MĚŘENÍ RENDEROVAČ ---------- */
function MeasurementsRenderer({ points, currentStart, currentMouse }) {
    return (
      <group>
          {points.map((m, i) => (
              <MeasureLine key={i} p1={m.p1} p2={m.p2} dist={m.dist} />
          ))}
          {currentStart && currentMouse && (
              <MeasureLine p1={currentStart} p2={currentMouse} dist={currentStart.distanceTo(currentMouse)} isTemp />
          )}
      </group>
    )
}

function MeasureLine({ p1, p2, dist, isTemp = false }) {
    const geom = useMemo(() => new THREE.BufferGeometry().setFromPoints([p1, p2]), [p1, p2])
    const mid = useMemo(() => p1.clone().lerp(p2, 0.5), [p1, p2])
    return (
      <group>
          <mesh position={p1}><sphereGeometry args={[0.3, 16, 16]} /><meshBasicMaterial color={isTemp ? "#aaaaaa" : "#ffd700"} depthTest={false} /></mesh>
          <mesh position={p2}><sphereGeometry args={[0.3, 16, 16]} /><meshBasicMaterial color={isTemp ? "#aaaaaa" : "#ffd700"} depthTest={false} /></mesh>
          <line geometry={geom}>
              <lineBasicMaterial color={isTemp ? "#aaaaaa" : "#ffd700"} linewidth={3} depthTest={false} />
          </line>
          <Html position={mid} center zIndexRange={[100, 0]} style={{ pointerEvents: "none", background: "rgba(0,0,0,0.75)", color: isTemp ? "#ddd" : "#ffd700", padding: "2px 5px", borderRadius: 4, fontSize: 12, fontWeight: "bold", whiteSpace: "nowrap", border: "1px solid rgba(255,255,255,0.2)" }}>
              {dist.toFixed(2)} mm
          </Html>
      </group>
    )
}

/* ---------- MINI-MAPA (Průřezové okno s vektorovým lookem) ---------- */
function CrossSectionWindow({ files, colors, visibles, roughnesses, metalnesses, vertexColors, cutPlane, onFlipCut, onClose }) {
    const [target, setTarget] = useState([0,0,0])
    const [measurePoints, setMeasurePoints] = useState([])
    const [measureStart, setMeasureStart] = useState(null)
    const [measureCurrent, setMeasureCurrent] = useState(null)
    const [snapPoint, setSnapPoint] = useState(null)

    const handleSnapMove = (point) => {
        if (!cutPlane) return
        const projected = new THREE.Vector3()
        cutPlane.projectPoint(point, projected) 
        setSnapPoint(projected)
        if (measureStart) setMeasureCurrent(projected)
    }

    const handleSnapDoubleClick = (point) => {
        if (!cutPlane) return
        const projected = new THREE.Vector3()
        cutPlane.projectPoint(point, projected)
        setMeasureStart(projected)
        setMeasureCurrent(projected)
    }

    const handleSnapClick = (point) => {
        if (!cutPlane || !measureStart) return
        const projected = new THREE.Vector3()
        cutPlane.projectPoint(point, projected)
        setMeasurePoints(prev => [...prev, { p1: measureStart, p2: projected, dist: measureStart.distanceTo(projected) }])
        setMeasureStart(null)
        setMeasureCurrent(null)
    }

    return (
        <div style={{ position: "absolute", bottom: 20, right: 20, width: "35vw", height: "35vw", maxWidth: 450, maxHeight: 450, minWidth: 280, minHeight: 280, background: "#111", border: "1px solid #444", borderRadius: 12, overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "0 10px 40px rgba(0,0,0,0.5)", zIndex: 10 }}>
            <div style={{ padding: "8px 12px", background: "#222", borderBottom: "1px solid #333", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span style={{ color: "white", fontSize: 13, fontWeight: "bold" }}>Průřez</span>
                    <button onClick={onFlipCut} style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", color: "#fff", borderRadius: 4, padding: "2px 8px", fontSize: 11, cursor: "pointer" }}>🔄 Otočit</button>
                    {measurePoints.length > 0 && (
                        <button onClick={() => setMeasurePoints([])} style={{ background: "rgba(239,68,68,.15)", border: "1px solid rgba(239,68,68,.5)", color: "#ffbaba", borderRadius: 4, padding: "2px 8px", fontSize: 11, cursor: "pointer" }}>🗑 Smazat</button>
                    )}
                </div>
                <button onClick={onClose} style={{ background: "none", border: "none", color: "#fff", cursor: "pointer", fontSize: 16, lineHeight: 1 }}>×</button>
            </div>
            
            <div style={{ flex: 1, position: "relative", background: "#000" }}>
                {!measureStart ? (
                    <div style={{ position: "absolute", top: 10, left: 0, right: 0, textAlign: "center", color: "rgba(255,255,255,0.5)", fontSize: 11, pointerEvents: "none", zIndex: 1 }}>Dvojklik na obrys = Měřit</div>
                ) : (
                    <div style={{ position: "absolute", top: 10, left: 0, right: 0, textAlign: "center", color: "#ffd700", fontSize: 11, pointerEvents: "none", zIndex: 1 }}>Klikněte pro ukotvení...</div>
                )}
                
                <Canvas orthographic style={{ width: "100%", height: "100%" }} onPointerOut={() => setSnapPoint(null)}>
                    <group>
                        <Suspense fallback={null}>
                            {files.map((f, i) => (
                            <AnyModel
                                key={`slice-${f.url}-${i}`}
                                url={f.url}
                                color={colors[i]} opacity={1} visible={visibles[i]}
                                autoSmooth={false} wireframe={false}
                                roughness={roughnesses[i]} metalness={metalnesses[i]} useVertexColors={vertexColors[i]}
                                outlinePlane={cutPlane} // VEKTOROVÝ REŽIM
                                isSliceView={true}
                                onSnapMove={handleSnapMove}
                                onSnapDoubleClick={handleSnapDoubleClick}
                                onSnapClick={handleSnapClick}
                            />
                            ))}
                        </Suspense>
                    </group>
                    <CrossSectionCamera setupPlane={cutPlane} setTarget={setTarget} />
                    <OrbitControls enableRotate={false} enableZoom={true} enablePan={true} target={target} makeDefault />
                    {snapPoint && (
                        <mesh position={snapPoint}><sphereGeometry args={[0.5, 16, 16]} /><meshBasicMaterial color="#ffb700" depthTest={false} /></mesh>
                    )}
                    <MeasurementsRenderer points={measurePoints} currentStart={measureStart} currentMouse={measureCurrent} />
                </Canvas>
            </div>
        </div>
    )
}

/* ---------- Setup Kamery pro Mini-Mapu ---------- */
function CrossSectionCamera({ setupPlane, setTarget }) {
    const { camera, size } = useThree()
    useEffect(() => {
        if (!setupPlane) return
        const cp = new THREE.Vector3()
        setupPlane.coplanarPoint(cp)
        camera.position.copy(cp).add(setupPlane.normal.clone().multiplyScalar(100))
        camera.lookAt(cp)
        if (Math.abs(setupPlane.normal.y) > 0.9) camera.up.set(0, 0, -Math.sign(setupPlane.normal.y))
        else camera.up.set(0, 1, 0)
        camera.zoom = Math.min(size.width, size.height) / 80
        camera.updateProjectionMatrix()
        setTarget([cp.x, cp.y, cp.z])
    }, [setupPlane, camera, size.width, size.height, setTarget])
    return null
}

/* ---------- AutoCenter & AutoFrame ---------- */
function AutoCenterAndFrame({ rootRef, triggerKey, onFramed, margin = 1.12, isMobile = false, desktopScale = 1.0, mobileScale = 1.0, centerMode = "combined", skipCamera = false, setTarget }) {
  const { camera, size } = useThree()
  
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    root.updateMatrixWorld(true)
    const boxAll = new THREE.Box3().setFromObject(root)
    if (boxAll.isEmpty()) return
    const centerAll = new THREE.Vector3()
    boxAll.getCenter(centerAll)
    if (centerMode === "per") {
      root.children.forEach((child) => {
        const b = new THREE.Box3().setFromObject(child)
        if (!b.isEmpty()) {
            const cWorld = new THREE.Vector3(); b.getCenter(cWorld)
            child.position.sub(cWorld)
        }
      })
      root.updateMatrixWorld(true)
    } else if (centerMode === "combined") {
      root.position.sub(centerAll)
      root.updateMatrixWorld(true)
    }
    if (!skipCamera) {
      const after = new THREE.Box3().setFromObject(root)
      const dims2 = new THREE.Vector3(), ctr = new THREE.Vector3()
      after.getSize(dims2); after.getCenter(ctr)
      const objW = Math.max(dims2.x, 1e-6)
      const objH = Math.max(dims2.y, 1e-6)
      const zoomX = size.width / (objW * margin)
      const zoomY = size.height / (objH * margin)
      let newZoom = Math.min(zoomX, zoomY) * (isMobile ? mobileScale : desktopScale)
      const depth = Math.max(dims2.z, Math.max(dims2.x, dims2.y) * 0.75) || 1
      const safeDist = depth * 10
      camera.near = Math.max(0.01, safeDist * 0.001)
      camera.far = safeDist * 80 + 200
      camera.position.set(ctr.x, ctr.y, ctr.z + safeDist)
      camera.up.set(0, 1, 0)
      camera.zoom = Math.max(newZoom, 0.01)
      camera.updateProjectionMatrix()
      if (setTarget) setTarget([ctr.x, ctr.y, ctr.z])
    }
    onFramed && onFramed()
  }, [triggerKey]) // eslint-disable-line
  return null
}

/* ---------- Nasazení uložené kamery ---------- */
function CustomCameraSetter({ camState, triggerKey, onFramed, setTarget }) {
  const { camera, size } = useThree()
  useEffect(() => {
    if (!camState) return
    if (camState.matrix) {
      camera.matrix.fromArray(camState.matrix)
      camera.matrix.decompose(camera.position, camera.quaternion, camera.scale)
    } else if (camState.position) {
        camera.position.fromArray(camState.position)
    }
    if (camState.up) camera.up.fromArray(camState.up)
    if (camState.zoom) {
       if (camState.canvasSize) {
          const savedMin = Math.min(camState.canvasSize[0], camState.canvasSize[1])
          const currentMin = Math.min(size.width, size.height)
          camera.zoom = camState.zoom * (currentMin / savedMin)
       } else {
          camera.zoom = camState.zoom
       }
    }
    camera.updateProjectionMatrix()
    if (camState.target && setTarget) {
      setTarget(camState.target)
    }
    onFramed && onFramed()
  }, [triggerKey, camState, camera, setTarget, size.width, size.height])
  return null
}

/* ---------- SYNC STAVU POHLEDU DO FRAMERU ---------- */
function ViewStateSync({ trackballRef }) {
  const { camera, size } = useThree()
  useEffect(() => {
    const interval = setInterval(() => {
      if (typeof window === "undefined" || !trackballRef?.current) return
      const c = trackballRef.current
      camera.updateMatrixWorld(true)
      const camData = {
        matrix: camera.matrix.toArray(),
        up: [camera.up.x, camera.up.y, camera.up.z],
        zoom: camera.zoom,
        canvasSize: [size.width, size.height],
        target: [c.target.x, c.target.y, c.target.z] 
      }
      const targetWindow = window.top || window.parent;
      if (targetWindow) {
        targetWindow.postMessage({
          type: "SHADE3D_VIEW_SYNC",
          payload: { camera: camData }
        }, "*")
      }
    }, 500)
    return () => clearInterval(interval)
  }, [camera, trackballRef, size.width, size.height])
  return null
}

/* ---------- Hlavní komponenta ---------- */
export default function ClientPage() {
  const [sceneIntensity, setSceneIntensity] = useState(1)
  const [highlightIntensity, setHighlightIntensity] = useState(1)
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
  const [logoCfg, setLogoCfg] = useState({ url: DEFAULT_LOGO, opacity: 0.9, width: 160, pos: "bc" })
  const [files, setFiles] = useState([])
  const [colors, setColors] = useState([])
  const [opacities, setOpacities] = useState([])
  const [visibles, setVisibles] = useState([])
  const [roughnesses, setRoughnesses] = useState([])
  const [metalnesses, setMetalnesses] = useState([])
  const [vertexColors, setVertexColors] = useState([])
  const [fatal, setFatal] = useState(null)
  const [autoSmooth, setAutoSmooth] = useState(true)
  const [smoothAngle] = useState(30)
  const [wireframe, setWireframe] = useState(false)
  const [photos, setPhotos] = useState([])
  const [lightbox, setLightbox] = useState({ open: false, src: null, alt: "" })
  const [photosOpen, setPhotosOpen] = useState(!isMobile)
  useEffect(() => { setPhotosOpen(!isMobile) }, [isMobile])
  const [slidersOpen, setSlidersOpen] = useState(!isMobile)
  useEffect(() => { setSlidersOpen(!isMobile) }, [isMobile])

  const trackballRef = useRef(null)
  const rootGroupRef = useRef(null)
  const [cameraTarget, setCameraTarget] = useState([0, 0, 0])
  const [didInitialFrame, setDidInitialFrame] = useState(false)
  const [loadedUrls, setLoadedUrls] = useState(new Set())
  const handleModelLoaded = (url) => setLoadedUrls((prev) => { const n = new Set(prev); n.add(url); return n; })
  const centerParam = (getParam("center") || "combined").toLowerCase()
  const centerMode = ["per", "combined", "none"].includes(centerParam) ? centerParam : "combined"
  const [initialCameraState, setInitialCameraState] = useState(null)

  // NÁSTROJE ŘEZÁNÍ
  const [cutPlane, setCutPlane] = useState(null)
  const [clipMode, setClipMode] = useState("translate")
  const [isGizmoDragging, setIsGizmoDragging] = useState(false)

  const spawnNewCut = () => {
      if (!trackballRef.current) return
      const camera = trackballRef.current.object
      const viewDir = new THREE.Vector3()
      camera.getWorldDirection(viewDir)
      viewDir.y = 0 
      if (viewDir.lengthSq() < 0.001) viewDir.set(0, 0, -1)
      viewDir.normalize()
      const normal = new THREE.Vector3().crossVectors(viewDir, new THREE.Vector3(0, 1, 0)).normalize()
      const center = new THREE.Vector3().fromArray(cameraTarget)
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, center)
      setCutPlane(plane)
  }

  const allLoaded = files.length > 0 && files.every(f => loadedUrls.has(f.url))
  const frameKey = allLoaded && !didInitialFrame ? `frame-${files.length}` : ""

  return (
    <div className="stage" style={{ position: "relative", width: "100vw", height: "100vh", background: "black" }}>
      <PreloadIcons />
      {logoCfg.url && (
        <img src={logoCfg.url} alt="" style={{ position: "absolute", bottom: logoCfg.pos === "bc" || logoCfg.pos === "bl" || logoCfg.pos === "br" ? 12 : "auto", left: logoCfg.pos === "bl" ? 12 : logoCfg.pos === "bc" ? "50%" : "auto", right: logoCfg.pos === "br" ? 12 : "auto", transform: logoCfg.pos === "bc" ? "translateX(-50%)" : "none", width: logoCfg.width, opacity: logoCfg.opacity, zIndex: 0, pointerEvents: "none", userSelect: "none" }}/>
      )}
      
      {/* SIDEBAR */}
      <div className="sidebar" style={{ position: "absolute", top: 10, left: 10, zIndex: 2, width: "clamp(260px, 28vw, 420px)", maxWidth: "calc(100vw - 20px)", color: "white", fontFamily: "sans-serif", fontSize: 14, backdropFilter: "blur(3px)", background: "rgba(0,0,0,.25)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 10, padding: 10, maxHeight: "calc(100vh - 20px)", overflowY: "auto" }}>
        {title && (<div style={{ marginBottom: 10, padding: "10px 12px", borderRadius: 10, border: "1px solid rgba(255,255,255,.18)", background: "rgba(255,255,255,.08)", fontSize: 13, fontWeight: 700 }}>{title}</div>)}
        <div style={{ border: "1px solid rgba(255,255,255,.15)", borderRadius: 10, padding: 10, background: "rgba(255,255,255,.06)" }}>
            {files.map((f, i) => (
                <div key={`${f.url}-${i}`} style={{ display: "grid", gridTemplateColumns: "36px 1fr 32px 36px", alignItems: "center", columnGap: 6, rowGap: 6, margin: "6px 0" }}>
                <div style={{ gridColumn: "1 / -1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{stripExt(f.name)}:</div>
                <input type="color" value={colors[i] ?? "#ffffff"} onChange={(e) => setColors((prev) => prev.map((v, idx) => (idx === i ? e.target.value : v)))} style={{ width: 36, height: 22, border: "1px solid #fff", borderRadius: 4, padding: 0, cursor: "pointer", background: "transparent" }}/>
                <input type="range" min={0} max={1} step={0.01} value={opacities[i] ?? 1} onChange={(e) => setOpacities((prev) => prev.map((x, idx) => (idx === i ? parseFloat(e.target.value) : x))) } style={{ width: "calc(100% - 12px)" }} />
                <button onClick={() => setVertexColors(prev => prev.map((v, idx) => idx === i ? !v : v))} style={{ width: 32, height: 22, fontSize: 10, background: vertexColors[i] ? "rgba(59,130,246,.45)" : "transparent", border: "1px solid rgba(255,255,255,0.4)", borderRadius: 4, color: "#fff", cursor: "pointer" }}>TEX</button>
                <button onClick={() => setVisibles((prev) => prev.map((v, idx) => (idx === i ? !v : v)))} style={{ width: 36, height: 22, background: "transparent", border: "1px solid #fff", borderRadius: 4, cursor: "pointer" }}><img src={(visibles[i] ?? true) ? ICONS.eye : ICONS.eyeOff} width={14} height={14}/></button>
                </div>
            ))}
        </div>
      </div>

      {/* TLAČÍTKA NASTROJŮ */}
      <div style={{ position: "absolute", top: 10, right: 10, zIndex: 10, display: "flex", gap: 8 }}>
          {cutPlane && (
              <>
                  <button onClick={() => setClipMode(clipMode === "translate" ? "rotate" : "translate")} style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.3)", color: "#fff", borderRadius: 8, padding: "8px 12px", fontSize: 13, fontWeight: "bold", cursor: "pointer", backdropFilter: "blur(4px)" }}>{clipMode === "translate" ? "🔄 Rotovat" : "↕ Posunout"}</button>
                  <button onClick={() => setCutPlane(null)} style={{ background: "rgba(239,68,68,.15)", border: "1px solid rgba(239,68,68,.5)", color: "#ffbaba", borderRadius: 8, padding: "8px 12px", fontSize: 13, fontWeight: "bold", cursor: "pointer" }}>✖ Zrušit řez</button>
              </>
          )}
          {!cutPlane && <button onClick={spawnNewCut} style={{ background: "rgba(59,130,246,0.3)", border: "1px solid rgba(59,130,246,0.8)", color: "#fff", borderRadius: 8, padding: "8px 12px", fontSize: 13, fontWeight: "bold", cursor: "pointer" }}>✂️ Nový Řez</button>}
      </div>

      {cutPlane && (
          <CrossSectionWindow files={files} colors={colors} visibles={visibles} roughnesses={roughnesses} metalnesses={metalnesses} vertexColors={vertexColors} cutPlane={cutPlane} onFlipCut={() => setCutPlane(cutPlane.clone().negate())} onClose={() => setCutPlane(null)} />
      )}

      <Canvas orthographic camera={{ position: [0, 0, 300], near: 0.01, far: 100000, zoom: 0.9 }} gl={{ alpha: true }} onCreated={({ gl }) => gl.setClearAlpha(0)} style={{ position: "absolute", inset: 0, zIndex: 1 }}>
        <ambientLight intensity={0.35 * sceneIntensity} />
        <directionalLight position={[0, 5, 5]} intensity={1.2 * sceneIntensity} />
        <directionalLight position={[-10, 0, 0]} intensity={0.9 * sceneIntensity} />
        <directionalLight position={[10, 0, 0]} intensity={1.0 * sceneIntensity} />
        <Headlight enabled={headlightCfg.enabled} intensity={headlightCfg.intensity * highlightIntensity} />

        <group ref={rootGroupRef}>
          <Suspense fallback={null}>
            {files.map((f, i) => (
              <AnyModel key={`${f.url}-${i}`} name={f.rawName || f.name} url={f.url} color={colors[i]} opacity={opacities[i]} visible={visibles[i]} onLoaded={handleModelLoaded} autoSmooth={autoSmooth} smoothAngle={smoothAngle} wireframe={wireframe} roughness={roughnesses[i]} metalness={metalnesses[i]} useVertexColors={vertexColors[i]} keepMaterials={!!f.km} outlinePlane={cutPlane} isSliceView={false} />
            ))}
          </Suspense>
        </group>

        <ClippingGizmo plane={cutPlane} enabled={!!cutPlane} mode={clipMode} setIsGizmoDragging={setIsGizmoDragging} targetCenter={cameraTarget} />
        <ViewStateSync trackballRef={trackballRef} />

        {frameKey && !initialCameraState && (<AutoCenterAndFrame rootRef={rootGroupRef} triggerKey={frameKey} onFramed={() => setDidInitialFrame(true)} margin={1.12} isMobile={isMobile} centerMode={centerMode} setTarget={setCameraTarget} />)}
        {frameKey && initialCameraState && (<CustomCameraSetter camState={initialCameraState} triggerKey={frameKey} onFramed={() => setDidInitialFrame(true)} setTarget={setCameraTarget} />)}

        <TouchTrackballControls ref={trackballRef} target={cameraTarget} enabled={!isGizmoDragging} />
        <RightButtonPan setTarget={setCameraTarget} enabled={!isGizmoDragging} />
        {!allLoaded && files.length > 0 && <InlineLoader text="Načítám modely…" />}
      </Canvas>
    </div>
  )
}
