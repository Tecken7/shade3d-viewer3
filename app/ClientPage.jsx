"use client"

import { Canvas, useThree, useFrame } from "@react-three/fiber"
import * as THREE from "three"
import { Suspense, useEffect, useMemo, useRef, useState } from "react"
import { Html } from "@react-three/drei"
import { TrackballControls } from "three/examples/jsm/controls/TrackballControls"
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader"
import { STLLoader } from "three/examples/jsm/loaders/STLLoader"
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader"

const LIVE_MSG_TYPES = new Set(["SHADE3D_LIVE", "SHADE3D_LIVE_V6", "SHADE3D_LIVE_V5"])
const SUPABASE_URL = "https://jqnkdjgmenerioodqcpa.supabase.co"
const PUBLIC_BUCKET = "shade3d-viewer2"
const DEFAULT_LOGO = "/Arthetic_logo.png"

/* helpers */
const stripExt = (s) => (s ? s.replace(/\.[^.]+$/, "") : "")
const clamp01 = (x) => Math.max(0, Math.min(1, x))
const clamp = (x, a, b) => Math.max(a, Math.min(b, x))
const getParam = (name) => {
  if (typeof window === "undefined") return null
  try { return new URL(window.location.href).searchParams.get(name) } catch { return null }
}
async function fetchJSON(url) { const r = await fetch(url, { cache: "no-store" }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() }
function inferExt(s) { if (!s) return ""; const m = s.split("?")[0].match(/\.([a-z0-9]+)$/i); return m ? m[1].toLowerCase() : "" }

/* icons */
const ICON_BASE = (() => {
  const q = getParam("iconBase")
  if (q && /^(https?:)?\/\//i.test(q)) return q.replace(/\/+$/, "") + "/"
  if (q && q.startsWith("/")) return q.replace(/\/+$/, "") + "/"
  return "/icons/"
})()
const ICONS = { eye: `${ICON_BASE}Eye.png`, eyeOff: `${ICON_BASE}Eye-off.png` }
function PreloadIcons(){ useEffect(()=>{ try{ Object.values(ICONS).forEach(src=>{ const i=new Image(); i.decoding="async"; i.src=src }) }catch{} },[]); return null }

/* autosmooth */
const DEFAULT_SMOOTH_ANGLE = 30
function autoSmoothGeometry(geometry, angleDeg = DEFAULT_SMOOTH_ANGLE) {
  const angle = clamp(angleDeg, 0, 89.9) * Math.PI / 180
  const g = geometry.index ? geometry.toNonIndexed() : geometry.clone()
  const pos = g.getAttribute("position"); const tri = pos.count/3
  const faceNormals = new Array(tri)
  const a=new THREE.Vector3(), b=new THREE.Vector3(), c=new THREE.Vector3(), cb=new THREE.Vector3(), ab=new THREE.Vector3()
  for (let f=0; f<tri; f++){ const i=f*3; a.fromBufferAttribute(pos,i); b.fromBufferAttribute(pos,i+1); c.fromBufferAttribute(pos,i+2); cb.subVectors(c,b); ab.subVectors(a,b); cb.cross(ab).normalize(); faceNormals[f]=cb.clone() }
  const groups=new Map(), key=(i)=>`${pos.getX(i).toFixed(5)},${pos.getY(i).toFixed(5)},${pos.getZ(i).toFixed(5)}`
  for (let i=0;i<pos.count;i++){ const k=key(i); (groups.get(k) || (groups.set(k,[]),groups.get(k))).push(i) }
  const normals=new Float32Array(pos.count*3), tmp=new THREE.Vector3(), cosT=Math.cos(angle)
  groups.forEach((cornerIdxs)=>{
    const ns=cornerIdxs.map(ci=>faceNormals[Math.floor(ci/3)])
    for (let idx=0; idx<cornerIdxs.length; idx++){
      const ci=cornerIdxs[idx], nRef=ns[idx]; let nx=0,ny=0,nz=0
      for (let j=0;j<ns.length;j++){ const nj=ns[j]; if (nRef.dot(nj)>=cosT){ nx+=nj.x; ny+=nj.y; nz+=nj.z } }
      tmp.set(nx,ny,nz); if (tmp.lengthSq()===0) tmp.copy(nRef); tmp.normalize()
      const w=ci*3; normals[w]=tmp.x; normals[w+1]=tmp.y; normals[w+2]=tmp.z
    }
  })
  g.setAttribute("normal", new THREE.BufferAttribute(normals,3))
  g.computeBoundingBox(); g.computeBoundingSphere()
  return g
}

/* small UI bits */
function InlineLoader({ text }) {
  return (
    <Html center>
      <div style={{ background:"rgba(0,0,0,.7)", padding:"16px 28px", borderRadius:10, color:"#fff", fontFamily:"sans-serif", fontSize:16 }}>
        ⏳ {text || "Načítám…"}
      </div>
    </Html>
  )
}
function Switch({ checked, onChange, label }) {
  const k=(e)=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); onChange(!checked) } }
  const W=38,H=22,K=18
  return (
    <div style={{ display:"flex", alignItems:"center", gap:8 }}>
      {label && <span style={{ opacity:.85 }}>{label}</span>}
      <button type="button" role="switch" aria-checked={checked} onClick={()=>onChange(!checked)} onKeyDown={k}
        style={{ position:"relative", width:W, height:H, borderRadius:999, border:"1px solid rgba(255,255,255,.22)",
          background: checked?"rgba(59,130,246,.45)":"rgba(255,255,255,.10)", cursor:"pointer", padding:0 }}>
        <span aria-hidden style={{ position:"absolute", top:"50%", transform:"translateY(-50%)",
          left: checked ? W-K-3 : 3, width:K, height:K, borderRadius:"50%", background:"#fff",
          boxShadow:"0 1px 3px rgba(0,0,0,.35)", transition:"left .15s ease" }}/>
      </button>
    </div>
  )
}

/* AnyModel (wireframe overlay) */
function AnyModel({
  name, url,
  color, opacity, visible,
  onLoaded, autoSmooth, smoothAngle = DEFAULT_SMOOTH_ANGLE,
  roughness = 0.5, metalness = 0.5,
  useVertexColors = false, keepMaterials = false, wireframe = false,
}) {
  const [object3D, setObject3D] = useState(null)
  const [loading, setLoading] = useState(true)
  const ext = useMemo(() => inferExt(name || url), [name, url])
  const makeMat = (opts={}) => new THREE.MeshStandardMaterial({ color:new THREE.Color(color||"#fff"),
    roughness, metalness, transparent: opacity<1, opacity, side:THREE.DoubleSide, depthWrite: opacity===1, ...opts })
  const forEachMesh=(obj,cb)=>obj?.traverse?.(c=>{ if(c.isMesh) cb(c) })
  const rebuildWire = (mesh) => {
    if (mesh.userData._edges){ mesh.userData._edges.geometry?.dispose?.(); mesh.userData._edges.material?.dispose?.(); mesh.remove(mesh.userData._edges); mesh.userData._edges=null }
    if(!wireframe) return
    const wfGeom=new THREE.WireframeGeometry(mesh.geometry)
    const wfMat=new THREE.LineBasicMaterial({ color:0x000000, depthTest:true, depthWrite:false, transparent:true, opacity:.95, polygonOffset:true, polygonOffsetFactor:-2, polygonOffsetUnits:-2 })
    const lines=new THREE.LineSegments(wfGeom,wfMat); lines.renderOrder=(mesh.renderOrder||0)+10; mesh.add(lines); mesh.userData._edges=lines
  }

  useEffect(()=>{ let cancelled=false; setLoading(true); (async()=>{
    try{
      let obj
      if (ext==="stl"){
        const geom=await new STLLoader().loadAsync(url)
        if (!geom.attributes.normal) geom.computeVertexNormals()
        const base = autoSmooth ? autoSmoothGeometry(geom,smoothAngle) : (geom.computeVertexNormals(), geom)
        obj=new THREE.Mesh(base, makeMat()); obj.userData._baseGeom=geom; obj.userData._derivedGeom=base
      } else if (ext==="ply"){
        const geom=await new PLYLoader().loadAsync(url); const hasVC=!!geom.getAttribute("color")
        let base=geom; if (autoSmooth) base=autoSmoothGeometry(geom,smoothAngle); else if(!geom.attributes.normal) geom.computeVertexNormals()
        const mat = hasVC && useVertexColors ? makeMat({ vertexColors:true, color:new THREE.Color("#fff") }) : makeMat()
        obj=new THREE.Mesh(base, mat); obj.userData._baseGeom=geom; obj.userData._derivedGeom=base
      } else {
        const loaded=await new OBJLoader().loadAsync(url)
        if (keepMaterials){
          loaded.traverse((child)=>{ if(child.isMesh && child.material){ const m=child.material
            if("transparent" in m) m.transparent = opacity<1; if("opacity" in m) m.opacity=opacity
            if("roughness" in m) m.roughness=roughness; if("metalness" in m) m.metalness=metalness } })
        } else {
          const mat=makeMat(); loaded.traverse((child)=>{ if(child.isMesh) child.material=mat })
        }
        obj=loaded
      }
      if(!cancelled){ forEachMesh(obj,rebuildWire); setObject3D(obj); setLoading(false); onLoaded&&onLoaded(obj) }
    }catch(e){ console.error("Model load error:",e); if(!cancelled) setLoading(false) }
  })(); return()=>{ cancelled=true } },[url,ext])

  useEffect(()=>{ if(!object3D) return
    forEachMesh(object3D,(child)=>{
      if(!child.userData._baseGeom) child.userData._baseGeom=child.geometry
      const base=child.userData._baseGeom
      let newGeom=autoSmooth?autoSmoothGeometry(base,smoothAngle):(base.clone()); if(!autoSmooth) newGeom.computeVertexNormals()
      if(child.userData._derivedGeom && child.userData._derivedGeom!==base) child.userData._derivedGeom.dispose()
      child.geometry=newGeom; child.userData._derivedGeom=newGeom; rebuildWire(child)
    })
  },[object3D,autoSmooth,smoothAngle])

  useEffect(()=>{ if(!object3D) return
    forEachMesh(object3D,(child)=>{
      if(keepMaterials){
        const m=child.material; if(m){ if("transparent"in m) m.transparent=opacity<1; if("opacity"in m) m.opacity=opacity
          if("roughness"in m) m.roughness=roughness; if("metalness"in m) m.metalness=metalness
          if(!useVertexColors && "color"in m && color) m.color=new THREE.Color(color)
          if(useVertexColors && "vertexColors"in m){ m.vertexColors=true; if("color"in m) m.color=new THREE.Color("#fff") }
          m.needsUpdate=true
        }
      } else {
        const hasVC=!!child.geometry.getAttribute?.("color")
        child.material = hasVC && useVertexColors ? makeMat({ vertexColors:true, color:new THREE.Color("#fff") }) : makeMat()
      }
      if(child.userData._edges) child.userData._edges.visible=!!wireframe; else if(wireframe) rebuildWire(child)
    })
  },[object3D,color,opacity,roughness,metalness,useVertexColors,keepMaterials,wireframe])

  if(!object3D) return loading ? <InlineLoader text={`Načítám ${name || url}`} /> : null
  return visible ? <primitive object={object3D}/> : null
}

/* lights */
function Headlight({ enabled=true, intensity=2, color="#ffffff" }) {
  const { camera } = useThree()
  const ref=useRef(null)
  useFrame(()=>{ if(ref.current) ref.current.position.copy(camera.position) })
  return <pointLight ref={ref} color={color} intensity={enabled?intensity:0} distance={0} decay={0}/>
}

/* controls */
function TouchTrackballControls({ target=[0,0,0] }) {
  const { camera, gl, size } = useThree()
  const ref=useRef(null)
  useEffect(()=>{ const c=new TrackballControls(camera,gl.domElement)
    c.rotateSpeed=5; c.zoomSpeed=1.2; c.panSpeed=1; c.staticMoving=true; c.dynamicDampingFactor=.15
    c.mouseButtons={ LEFT:THREE.MOUSE.ROTATE, MIDDLE:THREE.MOUSE.ZOOM, RIGHT:THREE.MOUSE.PAN }
    ref.current=c; return()=>c.dispose()
  },[camera,gl])
  useEffect(()=>{ const c=ref.current; if(!c) return; c.target.set(...target); c.update() },[target])
  useFrame(()=>{ const c=ref.current; if(!c) return; if(camera.isOrthographicCamera) c.panSpeed=camera.zoom*.4; c.update() })
  useEffect(()=>{ ref.current?.handleResize() },[size.width,size.height]); return null
}
function RightButtonPan({ setTarget }) {
  const { camera, gl, size } = useThree()
  const isPan=useRef(false), last=useRef({x:0,y:0}), pid=useRef(null)
  const PAN=.85, right=new THREE.Vector3(), up=new THREE.Vector3(), delta=new THREE.Vector3()
  useEffect(()=>{ const el=gl.domElement
    const onCtx=(e)=>e.preventDefault()
    const down=(e)=>{ if((e.button!==2)&&!(e.button===0&&e.ctrlKey)) return; e.preventDefault(); isPan.current=true; last.current={x:e.clientX,y:e.clientY}; pid.current=e.pointerId; try{el.setPointerCapture?.(e.pointerId)}catch{} }
    const move=(e)=>{ if(!isPan.current) return; e.preventDefault()
      const dx=e.clientX-last.current.x, dy=e.clientY-last.current.y; last.current={x:e.clientX,y:e.clientY}
      right.setFromMatrixColumn(camera.matrixWorld,0).normalize(); up.setFromMatrixColumn(camera.matrixWorld,1).normalize()
      if(camera.isOrthographicCamera){
        const wppX=((camera.right-camera.left)/(size.width*camera.zoom)), wppY=((camera.top-camera.bottom)/(size.height*camera.zoom))
        delta.copy(right).multiplyScalar(-dx*wppX*PAN).addScaledVector(up, dy*wppY*PAN)
        camera.position.add(delta); setTarget?.(t=>[t[0]+delta.x,t[1]+delta.y,t[2]+delta.z]); camera.updateProjectionMatrix()
      } else {
        const dist=camera.position.length(), s=(dist/Math.max(size.width,size.height))*PAN
        delta.copy(right).multiplyScalar(-dx*s).addScaledVector(up, dy*s)
        camera.position.add(delta); setTarget?.(t=>[t[0]+delta.x,t[1]+delta.y,t[2]+delta.z])
      }
    }
    const up=()=>{ if(!isPan.current) return; isPan.current=false; try{ el.releasePointerCapture?.(pid.current) }catch{}; pid.current=null }
    el.addEventListener("contextmenu",onCtx); el.addEventListener("pointerdown",down)
    window.addEventListener("pointermove",move,{capture:true}); window.addEventListener("pointerup",up,{capture:true})
    return()=>{ el.removeEventListener("contextmenu",onCtx); el.removeEventListener("pointerdown",down)
      window.removeEventListener("pointermove",move,{capture:true}); window.removeEventListener("pointerup",up,{capture:true}) }
  },[camera,gl,size.width,size.height,setTarget])
  return null
}

/* framing */
function AutoCenterAndFrame({
  rootRef, depsKey, setTarget,
  margin=0.9, isMobile=false, desktopScale=1.0, mobileScale=1.0,
  centerMode="combined", shouldFrame,
}) {
  const { camera, size } = useThree()
  useEffect(()=> {
    if (shouldFrame && !shouldFrame.current) return
    const root=rootRef.current; if(!root) return
    root.updateMatrixWorld(true)
    const box=new THREE.Box3().setFromObject(root); if(box.isEmpty()) return
    const center=new THREE.Vector3(), sizeV=new THREE.Vector3(); box.getCenter(center); box.getSize(sizeV)

    if(centerMode==="per"){ root.children.forEach(ch=>{ const b=new THREE.Box3().setFromObject(ch); if(b.isEmpty()) return; const c=new THREE.Vector3(); b.getCenter(c); ch.position.sub(c) }); root.updateMatrixWorld(true); setTarget([0,0,0]) }
    else if(centerMode==="combined"){ root.position.sub(center); root.updateMatrixWorld(true); setTarget([0,0,0]) }
    else { setTarget([center.x,center.y,center.z]) }

    const after=new THREE.Box3().setFromObject(root), d=new THREE.Vector3(), ctr=new THREE.Vector3(); after.getSize(d); after.getCenter(ctr)
    const objW=Math.max(d.x,1e-6), objH=Math.max(d.y,1e-6)
    const zoomX=size.width/(objW*margin), zoomY=size.height/(objH*margin)
    let newZoom=Math.min(zoomX,zoomY)

    const FILL_BOOST = isMobile ? 2.0 : 3.0
    newZoom *= (isMobile?mobileScale:desktopScale) * FILL_BOOST

    const depth=Math.max(d.z, Math.max(d.x,d.y)*0.5) || 1
    const safeDist = Math.max(depth*1.4, Math.max(d.x,d.y)*0.6)

    camera.near = Math.max(0.01, safeDist*0.001)
    camera.far  = safeDist*60 + 100
    camera.position.set(ctr.x, ctr.y, ctr.z + safeDist)
    camera.zoom = clamp(newZoom, 0.01, 5000)
    camera.updateProjectionMatrix()

    if (shouldFrame) shouldFrame.current=false
  },[depsKey,size.width,size.height,isMobile,desktopScale,mobileScale,margin,centerMode])
  return null
}

/* lightbox */
function Lightbox({ open, onClose, src, alt }) {
  if (!open || !src) return null
  return (
    <div onClick={onClose} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.85)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:50 }}>
      <img src={src} alt={alt||""} style={{ maxWidth:"96vw", maxHeight:"92vh", objectFit:"contain", borderRadius:12, boxShadow:"0 10px 40px rgba(0,0,0,.6)", border:"1px solid rgba(255,255,255,.15)" }}/>
    </div>
  )
}

/* ============ MAIN ============ */
export default function ClientPage() {
  /* světla – teď OBOJE ovladatelné */
  const [sceneIntensity, setSceneIntensity] = useState(() => {
    const q = parseFloat(getParam("scene") ?? "NaN")
    return isFinite(q) ? clamp(q, 0, 5) : 1
  })
  const [highlightIntensity, setHighlightIntensity] = useState(() => {
    const q = parseFloat(getParam("highlight") ?? "NaN")
    return isFinite(q) ? clamp(q, 0, 10) : 2.0
  })
  const [headlightCfg, setHeadlightCfg] = useState({ enabled: true, intensity: highlightIntensity })

  /* mobil */
  const [isMobile, setIsMobile] = useState(false)
  useEffect(()=>{ try{
    const ua=/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    const coarse=window.matchMedia?.("(pointer: coarse)")?.matches
    const narrow=window.innerWidth<768; setIsMobile(ua||coarse||narrow)
  }catch{} },[])

  /* titulek, logo, modely ... (beze změn) */
  const [title, setTitle] = useState(null)
  const [logoCfg, setLogoCfg] = useState({ url: DEFAULT_LOGO, opacity: 0.9, width: 160, pos: "bc" })
  const [files, setFiles] = useState([]), [colors, setColors] = useState([]), [opacities, setOpacities] = useState([])
  const [visibles, setVisibles] = useState([]), [roughnesses, setRoughnesses] = useState([]), [metalnesses, setMetalnesses] = useState([])
  const [fatal, setFatal] = useState(null)
  const [autoSmooth, setAutoSmooth] = useState((getParam("smooth") ?? "1") !== "0")
  const [smoothAngle] = useState(30)
  const [wireframe, setWireframe] = useState(false)
  const [photos, setPhotos] = useState([]), [lightbox, setLightbox] = useState({ open:false, src:null, alt:"" })
  const [photosOpen, setPhotosOpen] = useState(!isMobile); useEffect(()=>{ setPhotosOpen(!isMobile) },[isMobile])
  const [slidersOpen, setSlidersOpen] = useState(!isMobile); useEffect(()=>{ setSlidersOpen(!isMobile) },[isMobile])

  const [cameraTarget, setCameraTarget] = useState([0,0,0])
  const [loadedCount, setLoadedCount] = useState(0)
  const handleModelLoaded = () => setLoadedCount(n=>n+1)
  const centerParam = (getParam("center") || "combined").toLowerCase()
  const centerMode = ["per","combined","none"].includes(centerParam) ? centerParam : "combined"

  const shouldFrameRef = useRef(true)
  const prevFileKeysRef = useRef([]); const keyArr=(arr)=> (arr||[]).map(f=>`${f.url}::${f.rawName||f.name}`)

  useEffect(()=>{ (async()=>{
    try{
      const mId=getParam("m")
      const fromManifest = async (m) => {
        const Fs=(m?.files||[]).map((x,i)=>({ url:x.u, name:stripExt(x.n)||`Model ${i+1}`, rawName:x.n,
          c:x.c, o: typeof x.o==="number"?clamp01(x.o):1, v: typeof x.v==="boolean"?x.v:true,
          r: typeof x.r==="number"?clamp01(x.r):0.5, m: typeof x.m==="number"?clamp01(x.m):0.5, vc:!!x.vc, km:!!x.km }))
        if(!Fs.length) throw new Error("Manifest je prázdný.")
        setFiles(Fs)
        const pal=["#f5f5dc","#8e8e8e","#ffffff","#ffd7a8","#c0c0c0","#e6f0ff","#ffeedd"]
        setColors(Fs.map((f,i)=>f.c||pal[i%pal.length])); setOpacities(Fs.map(f=>typeof f.o==="number"?clamp01(f.o):1))
        setVisibles(Fs.map(f=>typeof f.v==="boolean"?f.v:true)); setRoughnesses(Fs.map(f=>typeof f.r==="number"?clamp01(f.r):0.5))
        setMetalnesses(Fs.map(f=>typeof f.m==="number"?clamp01(f.m):0.5))
        setTitle(typeof m?.title==="string"?m.title:(getParam("title")??null))
        const logoUrl=m?.logo?.url || DEFAULT_LOGO
        setLogoCfg({ url:logoUrl||null, opacity:clamp01(parseFloat(getParam("logoOpacity")??"0.9")),
          width:parseInt(getParam("logoWidth") ?? (window.innerWidth<768?"120":"160"),10), pos:getParam("logoPos")||"bc" })
        /* světla z manifestu */
        const sc = parseFloat(m?.lights?.scene ?? getParam("scene") ?? "NaN")
        if (isFinite(sc)) setSceneIntensity(clamp(sc,0,5))
        const hl = m?.lights?.headlight, hi = parseFloat(m?.lights?.highlight ?? getParam("highlight") ?? "NaN")
        setHeadlightCfg({
          enabled: typeof hl?.enabled==="boolean"?hl.enabled:true,
          intensity: isFinite(hi) ? clamp(hi,0,10) : (typeof hl?.intensity==="number"?hl.intensity:highlightIntensity),
        })
        setPhotos(Array.isArray(m?.photos)?m.photos.filter(p=>p&&p.u):[])
        prevFileKeysRef.current=keyArr(Fs); shouldFrameRef.current=true
      }

      if (mId){
        const mu=`${SUPABASE_URL}/storage/v1/object/public/${PUBLIC_BUCKET}/manifests/${encodeURIComponent(mId)}.json`
        const m=await fetchJSON(mu); await fromManifest(m); return
      }
      const manifestUrl=getParam("manifest")
      if (manifestUrl){ const m=await fetchJSON(manifestUrl); await fromManifest(m); return }

      const f=getParam("files")
      if (f){
        let arr=null; try{ arr=JSON.parse(f) }catch{}; if(!arr){ try{ arr=JSON.parse(decodeURIComponent(f)) }catch{} }
        if(!Array.isArray(arr)) throw new Error("Neplatný formát parametru ?files=")
        const Fs=arr.filter(x=>x&&x.u).map((x,i)=>({ url:x.u, name:stripExt(x.n)||`Model ${i+1}`, rawName:x.n,
          c:x.c, o: typeof x.o==="number"?clamp01(x.o):1, v: typeof x.v==="boolean"?x.v:true,
          r: typeof x.r==="number"?clamp01(x.r):0.5, m: typeof x.m==="number"?clamp01(x.m):0.5, vc:!!x.vc, km:!!x.km }))
        setFiles(Fs)
        const pal=["#f5f5dc","#8e8e8e","#ffffff","#ffd7a8","#c0c0c0","#e6f0ff","#ffeedd"]
        setColors(Fs.map((f,i)=>f.c||pal[i%pal.length])); setOpacities(Fs.map(f=>typeof f.o==="number"?clamp01(f.o):1))
        setVisibles(Fs.map(f=>typeof f.v==="boolean"?f.v:true)); setRoughnesses(Fs.map(f=>typeof f.r==="number"?clamp01(f.r):0.5))
        setMetalnesses(Fs.map(f=>typeof f.m==="number"?clamp01(f.m):0.5))
        setTitle(getParam("title") ?? null)
        setLogoCfg({ url: getParam("logo")==="none"?null:getParam("logo")||DEFAULT_LOGO,
          opacity:clamp01(parseFloat(getParam("logoOpacity") ?? "0.9")),
          width:parseInt(getParam("logoWidth") ?? (window.innerWidth<768?"120":"160"),10), pos:getParam("logoPos")||"bc" })
        /* světla z URL */
        const sc=parseFloat(getParam("scene") ?? "NaN"); if (isFinite(sc)) setSceneIntensity(clamp(sc,0,5))
        const hi=parseFloat(getParam("highlight") ?? "NaN"); if (isFinite(hi)) setHeadlightCfg(h=>({ ...h, intensity:clamp(hi,0,10) }))
        prevFileKeysRef.current=keyArr(Fs); shouldFrameRef.current=true; setPhotos([]); return
      }

      setFiles([]); setColors([]); setOpacities([]); setVisibles([]); setRoughnesses([]); setMetalnesses([])
      shouldFrameRef.current=false
    }catch(e){ console.error(e); setFatal("Tento náhled není dostupný (chyba při načtení dat).") }
  })() },[])

  /* LIVE: nyní přijímám lights.scene / lights.highlight i headlight */
  const applyLivePayload=(p)=>{
    if(!p) return
    let changed=false
    if(Array.isArray(p.files) && !(p.onlyParams && p.files.length===0)){
      const newFiles=p.files.map((x,i)=>({ url:x.u, name:stripExt(x.n||`Model ${i+1}`), rawName:x.n||`Model${i+1}`,
        c:x.c, o: typeof x.o==="number"?clamp01(x.o):1, v: typeof x.v==="boolean"?x.v:true,
        r: typeof x.r==="number"?clamp01(x.r):0.5, m: typeof x.m==="number"?clamp01(x.m):0.5, vc:!!x.vc, km:!!x.km }))
      const keys=newFiles.map(f=>`${f.url}::${f.rawName||f.name}`); const prev=prevFileKeysRef.current
      changed = keys.length!==prev.length || keys.some((k,i)=>k!==prev[i])
      setFiles(newFiles); prevFileKeysRef.current=keys
      const pal=["#f5f5dc","#8e8e8e","#ffffff","#ffd7a8","#c0c0c0","#e6f0ff","#ffeedd"]
      setColors(newFiles.map((f,i)=>f.c||pal[i%pal.length]))
      setOpacities(newFiles.map(f=>typeof f.o==="number"?clamp01(f.o):1))
      setVisibles(newFiles.map(f=>typeof f.v==="boolean"?f.v:true))
      setRoughnesses(newFiles.map(f=>typeof f.r==="number"?clamp01(f.r):0.5))
      setMetalnesses(newFiles.map(f=>typeof f.m==="number"?clamp01(f.m):0.5))
    }
    if (typeof p.title==="string" || p.title===null) setTitle(p.title ?? null)
    if (p.logo){ setLogoCfg(old=>({ url:p.logo?.url ?? old.url, opacity: typeof p.logo?.opacity==="number"?clamp01(p.logo.opacity):old.opacity,
      width: typeof p.logo?.width==="number"?p.logo.width:old.width, pos:p.logo?.pos||old.pos })) }
    if (p.lights){
      if (typeof p.lights.scene==="number") setSceneIntensity(clamp(p.lights.scene,0,5))
      if (typeof p.lights.highlight==="number") setHeadlightCfg(h=>({ ...h, intensity:clamp(p.lights.highlight,0,10) }))
      if (p.lights.headlight){ setHeadlightCfg(h=>({ enabled: typeof p.lights.headlight.enabled==="boolean"?p.lights.headlight.enabled:h.enabled,
        intensity: typeof p.lights.headlight.intensity==="number"?clamp(p.lights.headlight.intensity,0,10):h.intensity })) }
    }
    shouldFrameRef.current=changed; if(changed) setLoadedCount(0)
  }
  useEffect(()=>{ const onMsg=(e)=>{ const d=e.data; if(d && LIVE_MSG_TYPES.has(d.type) && d.payload){
      if(!d.payload.onlyParams && Array.isArray(d.payload.files) && d.payload.files.length===0){
        setFiles([]); setColors([]); setOpacities([]); setVisibles([]); setRoughnesses([]); setMetalnesses([]); prevFileKeysRef.current=[]; shouldFrameRef.current=false; return
      }
      applyLivePayload(d.payload)
    } }
    window.addEventListener("message",onMsg); return()=>window.removeEventListener("message",onMsg)
  },[])

  /* logo */
  const logoEl = logoCfg.url && (
    <img src={logoCfg.url} alt=""
      style={{ position:"absolute", bottom:(["bc","bl","br"].includes(logoCfg.pos)?12:"auto"),
        left: logoCfg.pos==="bl"?12:logoCfg.pos==="bc"?"50%":"auto", right: logoCfg.pos==="br"?12:"auto",
        transform: logoCfg.pos==="bc"?"translateX(-50%)":"none", width:logoCfg.width, opacity:logoCfg.opacity, zIndex:0,
        pointerEvents:"none", userSelect:"none", filter:"drop-shadow(0 0 1px rgba(0,0,0,.25))" }} />
  )

  const rootRef=useRef()

  /* levý panel – část s přepínači modelů; přidáno nic, vše původně */
  const slidersContent = fatal ? (
    <div style={{ color:"#ff8b8b" }}>{fatal}</div>
  ) : (
    <>
      {files.map((f,i)=>(
        <div key={`${f.url}-${i}`} className="control-row" style={{ display:"grid", gridTemplateColumns:"36px 1fr 36px", alignItems:"center", columnGap:6, rowGap:6, margin:"6px 0" }}>
          <div className="row-label" style={{ gridColumn:"1 / -1", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }} title={f.rawName||f.name}>{stripExt(f.name)}:</div>
          <input type="color" value={colors[i]??"#ffffff"} onChange={(e)=>setColors(p=>p.map((v,idx)=>idx===i?e.target.value:v))}
            aria-label={`${f.name} color`} className="color-input" style={{ width:36, height:22, border:"1px solid #fff", borderRadius:4, padding:0, cursor:"pointer", background:"transparent" }}/>
          <input className="slider" type="range" min={0} max={1} step={0.01} value={opacities[i]??1}
            onChange={(e)=>{ const v=parseFloat(e.target.value); setOpacities(p=>p.map((x,idx)=>idx===i?v:x)) }}
            style={{ width:"calc(100% - 18px)", minWidth:140 }} aria-label={`${f.name} opacity`} />
          <button className={`toggle icon-btn ${visibles[i]?"is-on":"is-off"}`} onClick={()=>setVisibles(p=>p.map((v,idx)=>idx===i?!v:v))}
            aria-label={visibles[i]?`Hide ${f.name}`:`Show ${f.name}`} title={visibles[i]?"Skrýt":"Zobrazit"}
            style={{ width:36, height:22, display:"inline-flex", alignItems:"center", justifyContent:"center", padding:0, margin:0, background:"transparent", border:"1px solid #fff", borderRadius:4, cursor:"pointer" }}>
            <img src={(visibles[i]??true)?ICONS.eye:ICONS.eyeOff} alt="" width={14} height={14} style={{ display:"block", pointerEvents:"none", userSelect:"none" }}/>
          </button>
        </div>
      ))}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:12, marginTop:10 }}>
        <Switch checked={autoSmooth} onChange={setAutoSmooth} label="Auto smooth" />
        <Switch checked={wireframe} onChange={setWireframe} label="Wireframe" />
      </div>
    </>
  )

  const sidebar=(/* ... beze změny, jen render slidersContent ... */ 
    <div className="sidebar" style={{ position:"absolute", top:10, left:10, zIndex:2, width:"clamp(260px, 28vw, 420px)", maxWidth:"calc(100vw - 20px)",
      color:"white", fontFamily:"sans-serif", fontSize:14, backdropFilter:"blur(3px)", background:"rgba(0,0,0,.25)", border:"1px solid rgba(255,255,255,.15)",
      borderRadius:10, padding:10, boxSizing:"border-box", maxHeight:"calc(100vh - 20px)", overflowY:"auto" }}>
      {title && (<div title={title} style={{ marginBottom:10, padding:"10px 12px", borderRadius:10, border:"1px solid rgba(255,255,255,.18)", background:"rgba(255,255,255,.08)",
        fontSize:13, fontWeight:700, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{title}</div>)}
      <div>{isMobile ? (
        <>
          <button onClick={()=>setSlidersOpen(o=>!o)} aria-expanded={slidersOpen}
            style={{ width:"100%", display:"flex", alignItems:"center", justifyContent:"space-between", gap:10, padding:"10px 12px",
              background:"rgba(255,255,255,.08)", border:"1px solid rgba(255,255,255,.18)", borderRadius:10, color:"#fff", cursor:"pointer", fontWeight:700, fontSize:13 }}>
            <span>Nastavení modelu</span>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ transform:slidersOpen?"rotate(90deg)":"rotate(0deg)", transition:"transform .15s ease" }} aria-hidden>
              <path d="M8 5l8 7-8 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          {slidersOpen && (<div style={{ marginTop:8, border:"1px solid rgba(255,255,255,.15)", borderRadius:10, background:"rgba(255,255,255,.06)", padding:10 }}>{slidersContent}</div>)}
        </>
      ) : (<div style={{ border:"1px solid rgba(255,255,255,.15)", borderRadius:10, padding:10, background:"rgba(255,255,255,.06)" }}>{slidersContent}</div>)}</div>
      {photos && photos.length>0 && (
        <div style={{ marginTop:10 }}>
          <button onClick={()=>setPhotosOpen(o=>!o)} aria-expanded={photosOpen}
            style={{ width:"100%", display:"flex", alignItems:"center", justifyContent:"space-between", gap:10, padding:"10px 12px",
              background:"rgba(255,255,255,.08)", border:"1px solid rgba(255,255,255,.18)", borderRadius:10, color:"#fff", cursor:"pointer", fontWeight:700, fontSize:13 }}>
            <span>Fotky ({photos.length})</span>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ transform:photosOpen?"rotate(90deg)":"rotate(0deg)", transition:"transform .15s ease" }} aria-hidden>
              <path d="M8 5l8 7-8 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          {photosOpen && (
            <div style={{ marginTop:8, border:"1px solid rgba(255,255,255,.15)", borderRadius:10, background:"rgba(255,255,255,.06)", padding:8 }}>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(72px, 1fr))", gap:8 }}>
                {photos.map((p,i)=>(
                  <button key={i} onClick={()=>setLightbox({ open:true, src:p.u, alt:p.n||`Photo ${i+1}` })}
                    style={{ padding:0, margin:0, border:"none", background:"transparent", cursor:"pointer", borderRadius:8, overflow:"hidden",
                      boxShadow:"0 1px 6px rgba(0,0,0,.35)", border:"1px solid rgba(255,255,255,.12)" }} title={p.n||""}>
                    <img src={p.u} alt={p.n||""} loading="lazy" style={{ display:"block", width:"100%", height:72, objectFit:"cover" }}/>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )

  /* deps key pro frame */
  const frameDepsKey = shouldFrameRef.current ? `frame-${files.length}-${loadedCount}` : `noframe-${files.length}-${loadedCount}`

  return (
    <div className="stage" style={{ position:"relative", width:"100vw", height:"100vh", background:"black" }}>
      <PreloadIcons />
      {logoEl}
      {sidebar}

      <Canvas orthographic camera={{ position:[0,0,100], near:0.01, far:100000 }}
        gl={{ alpha:true }} onCreated={({gl})=>gl.setClearAlpha(0)}
        style={{ position:"absolute", inset:0, zIndex:1, background:"transparent" }}>
        <>
          {/* „Světla scéna“ => sceneIntensity; „Světlo highlight“ => highlightIntensity */}
          <ambientLight intensity={0.4 * sceneIntensity * (headlightCfg.enabled ? 0.5 : 1)} />
          <directionalLight position={[0, 5, 5]}  intensity={1.5 * sceneIntensity * (headlightCfg.enabled ? 0.5 : 1)} />
          <directionalLight position={[-10, 0, 0]} intensity={1.0 * sceneIntensity * (headlightCfg.enabled ? 0.5 : 1)} />
          <directionalLight position={[10, 0, 0]}  intensity={1.2 * sceneIntensity * (headlightCfg.enabled ? 0.5 : 1)} />
          <directionalLight position={[0, -5, -5]} intensity={0.8 * sceneIntensity * (headlightCfg.enabled ? 0.5 : 1)} />
          <Headlight enabled={headlightCfg.enabled} intensity={headlightCfg.intensity} />

          <group ref={rootRef}>
            <Suspense fallback={null}>
              {files.map((f,i)=>(
                <AnyModel key={`${f.url}-${i}`} name={f.rawName||f.name} url={f.url}
                  color={colors[i]??"#ffffff"} opacity={opacities[i]??1} visible={visibles[i]??true}
                  onLoaded={handleModelLoaded} autoSmooth={autoSmooth} smoothAngle={smoothAngle} wireframe={wireframe}
                  roughness={roughnesses[i]??(typeof f.r==="number"?f.r:0.5)} metalness={metalnesses[i]??(typeof f.m==="number"?f.m:0.5)}
                  useVertexColors={!!f.vc} keepMaterials={!!f.km} />
              ))}
            </Suspense>
          </group>

          <AutoCenterAndFrame
            rootRef={rootRef}
            depsKey={frameDepsKey}
            setTarget={setCameraTarget}
            margin={0.9}
            isMobile={isMobile}
            desktopScale={1.0}
            mobileScale={1.0}
            centerMode={centerMode}
            shouldFrame={shouldFrameRef}
          />
          <TouchTrackballControls target={cameraTarget} />
          <RightButtonPan setTarget={setCameraTarget}/>
        </>
      </Canvas>

      <Lightbox open={lightbox.open} onClose={()=>setLightbox({ open:false, src:null, alt:"" })} src={lightbox.src} alt={lightbox.alt} />

      <style jsx global>{`
        .slider{ appearance:none; height:14px; background:transparent; margin:5px 0; display:inline-block; }
        .slider::-webkit-slider-runnable-track{ height:4px; background:white; border-radius:2px; }
        .slider::-webkit-slider-thumb{ appearance:none; width:14px; height:14px; border-radius:50%; background:white; cursor:pointer; box-shadow:0 0 2px black; margin-top:-5px; }
        .slider::-moz-range-track{ height:4px; background:white; border-radius:2px; }
        .slider::-moz-range-thumb{ width:14px; height:14px; border-radius:50%; background:white; cursor:pointer; box-shadow:0 0 2px black; border:none; }
        .color-input{ -webkit-appearance:none; appearance:none; }
        .color-input::-webkit-color-swatch-wrapper{ padding:0; } .color-input::-webkit-color-swatch{ border:none; border-radius:2px; }
        .color-input::-moz-color-swatch{ border:none; }
        @media (max-width:720px){ .sidebar{ left:8px!important; width:calc(100vw - 16px)!important; max-width:calc(100vw - 16px)!important; } }
      `}</style>
    </div>
  )
}
