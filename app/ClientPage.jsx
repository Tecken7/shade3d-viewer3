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
const ICONS = { eye: "/icons/Eye.png", eyeOff: "/icons/Eye-off.png" }
function PreloadIcons() { useEffect(() => { Object.values(ICONS).forEach(src => { const i = new Image(); i.decoding="async"; i.src = src }) }, []); return null }

/* ---------- Helpers ---------- */
const DEFAULT_LOGO = "/Arthetic_logo.png"
const stripExt = (s) => s?.replace(/\.[^.]+$/, "") || ""
const clamp01 = (x) => Math.max(0, Math.min(1, x))
const getParam = (name) => (typeof window === "undefined" ? null : new URL(window.location.href).searchParams.get(name))
async function fetchJSON(url){ const r=await fetch(url,{cache:"no-store"}); if(!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() }
function inferExt(nameOrUrl){ if(!nameOrUrl) return ""; const s=nameOrUrl.split("?")[0]; const m=s.match(/\.([a-z0-9]+)$/i); return m?m[1].toLowerCase():"" }

/* ---------- Auto Smooth ---------- */
function autoSmoothGeometry(geometry, angleDeg=30){
  const angle=Math.max(0,Math.min(89.9,angleDeg)), angleRad=angle*Math.PI/180
  const g = geometry.index ? geometry.toNonIndexed() : geometry.clone()
  const pos=g.getAttribute("position"), vCount=pos.count, triCount=vCount/3
  const faceNormals=new Array(triCount)
  const a=new THREE.Vector3(), b=new THREE.Vector3(), c=new THREE.Vector3(), cb=new THREE.Vector3(), ab=new THREE.Vector3()
  for(let f=0;f<triCount;f++){ const i0=f*3,i1=i0+1,i2=i0+2; a.fromBufferAttribute(pos,i0); b.fromBufferAttribute(pos,i1); c.fromBufferAttribute(pos,i2); cb.subVectors(c,b); ab.subVectors(a,b); cb.cross(ab).normalize(); faceNormals[f]=cb.clone() }
  const groups=new Map(), keyOf=(ix)=>`${pos.getX(ix).toFixed(5)},${pos.getY(ix).toFixed(5)},${pos.getZ(ix).toFixed(5)}`
  for(let i=0;i<vCount;i++){ const k=keyOf(i); let arr=groups.get(k); if(!arr){arr=[];groups.set(k,arr)} arr.push(i) }
  const normals=new Float32Array(vCount*3), tmp=new THREE.Vector3(), cosThresh=Math.cos(angleRad)
  groups.forEach((cornerIndices)=>{
    const localFaceNs=cornerIndices.map((ci)=>faceNormals[Math.floor(ci/3)])
    for(let idx=0; idx<cornerIndices.length; idx++){
      const ci=cornerIndices[idx], nRef=localFaceNs[idx]; let nx=0,ny=0,nz=0
      for(let j=0;j<localFaceNs.length;j++){ const nj=localFaceNs[j]; if(nRef.dot(nj)>=cosThresh){ nx+=nj.x; ny+=nj.y; nz+=nj.z } }
      tmp.set(nx,ny,nz); if(tmp.lengthSq()===0) tmp.copy(nRef); tmp.normalize()
      const w=ci*3; normals[w]=tmp.x; normals[w+1]=tmp.y; normals[w+2]=tmp.z
    }
  })
  g.setAttribute("normal", new THREE.BufferAttribute(normals,3))
  g.computeBoundingBox(); g.computeBoundingSphere()
  return g
}

/* ---------- Loader overlay ---------- */
function InlineLoader({ text }) {
  return (
    <Html center>
      <div style={{background:"rgba(0,0,0,.7)",padding:"16px 28px",borderRadius:10,color:"#fff",fontFamily:"sans-serif",fontSize:16}}>
        ⏳ {text || "Načítám…"}
      </div>
    </Html>
  )
}

/* ---------- AnyModel ---------- */
function AnyModel({ name,url,color,opacity,visible,onLoaded,autoSmooth,smoothAngle,roughness=0.5,metalness=0.5,useVertexColors=false,keepMaterials=false }) {
  const [object3D,setObject3D]=useState(null)
  const [loading,setLoading]=useState(true)
  const ext=useMemo(()=>inferExt(name||url),[name,url])

  const makeMat=(opts={})=>new THREE.MeshStandardMaterial({
    color:new THREE.Color(color||"#ffffff"),
    roughness: typeof roughness==="number"?roughness:0.5,
    metalness: typeof metalness==="number"?metalness:0.5,
    transparent: opacity<1, opacity, side:THREE.DoubleSide, depthWrite:opacity===1, ...opts
  })

  useEffect(()=>{ let cancelled=false; setLoading(true); (async()=>{
    try{
      let obj
      if(ext==="stl"){
        const geom=await new STLLoader().loadAsync(url)
        if(!geom.attributes.normal) geom.computeVertexNormals()
        const base=autoSmooth?autoSmoothGeometry(geom,smoothAngle):(geom.computeVertexNormals(),geom)
        obj=new THREE.Mesh(base, makeMat()); obj.userData._baseGeom=geom; obj.userData._derivedGeom=base
      } else if(ext==="ply"){
        const geom=await new PLYLoader().loadAsync(url)
        const hasVC=!!geom.getAttribute("color")
        let base=geom
        if(autoSmooth) base=autoSmoothGeometry(geom,smoothAngle)
        else if(!geom.attributes.normal) geom.computeVertexNormals()
        const mat = hasVC && useVertexColors ? makeMat({vertexColors:true,color:new THREE.Color("#ffffff")}) : makeMat()
        obj=new THREE.Mesh(base,mat); obj.userData._baseGeom=geom; obj.userData._derivedGeom=base
      } else {
        const loaded=await new OBJLoader().loadAsync(url)
        if(keepMaterials){
          loaded.traverse((child)=>{ if(child.isMesh){ const mat=child.material; if(mat){ if("transparent"in mat) mat.transparent=opacity<1; if("opacity"in mat) mat.opacity=opacity; if("roughness"in mat && typeof roughness==="number") mat.roughness=roughness; if("metalness"in mat && typeof metalness==="number") mat.metalness=metalness } } })
          obj=loaded
        } else {
          const mat=makeMat()
          loaded.traverse((child)=>{ if(child.isMesh) child.material=mat })
          obj=loaded
        }
      }
      if(!cancelled){ setObject3D(obj); setLoading(false); onLoaded && onLoaded(obj) }
    }catch(e){ if(!cancelled) setLoading(false); console.error("Model load error:",e) }
  })(); return ()=>{ cancelled=true } },[url,ext]) // eslint-disable-line

  useEffect(()=>{ if(!object3D) return
    object3D.traverse((child)=>{
      if(!child.isMesh) return
      if(!child.userData._baseGeom) child.userData._baseGeom=child.geometry
      const base=child.userData._baseGeom
      let newGeom=base
      if(autoSmooth) newGeom=autoSmoothGeometry(base,smoothAngle)
      else { newGeom=base.clone(); newGeom.computeVertexNormals() }
      if(child.userData._derivedGeom && child.userData._derivedGeom!==base){ child.userData._derivedGeom.dispose() }
      child.geometry=newGeom; child.userData._derivedGeom=newGeom
    })
  },[object3D,autoSmooth,smoothAngle])

  useEffect(()=>{ if(!object3D) return
    object3D.traverse((child)=>{
      if(!child.isMesh) return
      if(keepMaterials){
        const mat=child.material
        if(mat){
          if("transparent"in mat) mat.transparent=opacity<1
          if("opacity"in mat) mat.opacity=opacity
          if("roughness"in mat && typeof roughness==="number") mat.roughness=roughness
          if("metalness"in mat && typeof metalness==="number") mat.metalness=metalness
          if(!useVertexColors && "color"in mat && color) mat.color=new THREE.Color(color)
          if(useVertexColors && "vertexColors"in mat){ mat.vertexColors=true; if("color"in mat) mat.color=new THREE.Color("#ffffff") }
          mat.needsUpdate=true
        }
      } else {
        const hasVC=!!child.geometry.getAttribute?.("color")
        const mat= hasVC && useVertexColors ? makeMat({vertexColors:true,color:new THREE.Color("#ffffff")}) : makeMat()
        child.material=mat
      }
    })
  },[object3D,color,opacity,roughness,metalness,useVertexColors,keepMaterials])

  if(!object3D) return loading ? <InlineLoader text={`Načítám ${name||url}`} /> : null
  return visible ? <primitive object={object3D} /> : null
}

/* ---------- Headlight ---------- */
function Headlight({ enabled=true, intensity=2, color="#ffffff" }){
  const { camera }=useThree(); const ref=useRef(null)
  useFrame(()=>{ if(ref.current) ref.current.position.copy(camera.position) })
  return <pointLight ref={ref} color={color} intensity={enabled?intensity:0} distance={0} decay={0} />
}

/* ---------- Trackball ---------- */
function TouchTrackballControls({ target=[0,0,0] }){
  const { camera, gl }=useThree(); const controlsRef=useRef(null)
  useEffect(()=>{ const controls=new TrackballControls(camera,gl.domElement)
    controls.rotateSpeed=5; controls.zoomSpeed=1.2; controls.panSpeed=1; controls.staticMoving=true; controlsRef.current=controls
    const ts=(e)=>{ e.preventDefault(); controls.handleTouchStart(e) }
    const tm=(e)=>{ e.preventDefault(); controls.handleTouchMove(e) }
    gl.domElement.addEventListener("touchstart",ts,{passive:false}); gl.domElement.addEventListener("touchmove",tm,{passive:false})
    return ()=>{ gl.domElement.removeEventListener("touchstart",ts); gl.domElement.removeEventListener("touchmove",tm); controls.dispose() }
  },[camera,gl])
  useEffect(()=>{ if(!controlsRef.current) return; controlsRef.current.target.set(target[0],target[1],target[2]); controlsRef.current.update() },[target])
  useFrame(()=>{ if(!controlsRef.current) return; if(camera.isOrthographicCamera) controlsRef.current.panSpeed=camera.zoom*0.4; controlsRef.current.update() })
  return null
}

/* ---------- AutoCenter & AutoFrame ---------- */
function AutoCenterAndFrame({ rootRef,depsKey,setTarget, margin=1.2,isMobile=false,desktopScale=0.4,mobileScale=1.0, centerMode="combined", shouldFrame }) {
  const { camera,size }=useThree()
  useEffect(()=>{ if(!shouldFrame?.current) return
    const root=rootRef.current; if(!root) return
    root.updateMatrixWorld(true)
    const boxAll=new THREE.Box3().setFromObject(root); if(boxAll.isEmpty()) return
    const centerAll=new THREE.Vector3(), dims=new THREE.Vector3(); boxAll.getCenter(centerAll); boxAll.getSize(dims)
    if(centerMode==="per"){ root.children.forEach((child)=>{ const b=new THREE.Box3().setFromObject(child); if(b.isEmpty()) return; const cWorld=new THREE.Vector3(); b.getCenter(cWorld); child.position.sub(cWorld) }); root.updateMatrixWorld(true); setTarget([0,0,0]) }
    else if(centerMode==="combined"){ root.position.sub(centerAll); root.updateMatrixWorld(true); setTarget([0,0,0]) }
    else { setTarget([centerAll.x,centerAll.y,centerAll.z]) }
    const after=new THREE.Box3().setFromObject(root); const dims2=new THREE.Vector3(), ctr=new THREE.Vector3(); after.getSize(dims2); after.getCenter(ctr)
    const objW=Math.max(dims2.x,1e-6), objH=Math.max(dims2.y,1e-6)
    const zoomX=size.width/(objW*margin), zoomY=size.height/(objH*margin)
    let newZoom=Math.min(zoomX,zoomY); newZoom*=isMobile?mobileScale:desktopScale
    const diag=Math.sqrt(dims2.x*dims2.x+dims2.y*dims2.y+dims2.z*dims2.z); const safeDist=Math.max(diag*2.5,1000)
    camera.near=0.1; camera.far=Math.max(safeDist*10,1e6); camera.zoom=Math.max(newZoom,0.01)
    camera.position.set(ctr.x,ctr.y,ctr.z+safeDist); camera.updateProjectionMatrix()
    shouldFrame.current=false
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[depsKey,size.width,size.height,isMobile,desktopScale,mobileScale,margin,centerMode])
  return null
}

/* ---------- ClientPage ---------- */
export default function ClientPage(){
  const [lightIntensity,setLightIntensity]=useState(()=>{ const li=parseFloat(getParam("li")??"NaN"); return isFinite(li)?li:1 })
  const [headlightCfg,setHeadlightCfg]=useState(()=>{ const qOn=getParam("headlight"); const qI=parseFloat(getParam("headlightI")??"NaN"); return { enabled: qOn==null?true:qOn!=="0", intensity: isFinite(qI)?qI:2 } })
  const [uiReady,setUiReady]=useState(false); useEffect(()=>{ const id=requestAnimationFrame(()=>setUiReady(true)); return ()=>cancelAnimationFrame(id) },[])
  const [isMobile,setIsMobile]=useState(false); useEffect(()=>{ const ua=/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent); const coarse=window.matchMedia?.("(pointer: coarse)")?.matches; const narrow=window.innerWidth<768; setIsMobile(!!(ua||coarse||narrow)) },[])
  const [title,setTitle]=useState(null)

  const [files,setFiles]=useState([]) // {url,name,rawName,c,o,v,r,m,vc,km}
  const [colors,setColors]=useState([]); const [opacities,setOpacities]=useState([]); const [visibles,setVisibles]=useState([])
  const [roughnesses,setRoughnesses]=useState([]); const [metalnesses,setMetalnesses]=useState([]); const [fatal,setFatal]=useState(null)

  const [autoSmooth,setAutoSmooth]=useState((getParam("smooth")??"1")!=="0")
  const [smoothAngle,setSmoothAngle]=useState(()=>{ const v=parseFloat(getParam("smoothAngle")??"30"); return isFinite(v)?Math.max(0,Math.min(80,v)):30 })

  const [logoCfg,setLogoCfg]=useState({ url: DEFAULT_LOGO, opacity:0.9, width:160, pos:"bc" })

  const [cameraTarget,setCameraTarget]=useState([0,0,0])
  const [loadedCount,setLoadedCount]=useState(0)
  const handleModelLoaded=()=>setLoadedCount((n)=>n+1)

  const centerParam=(getParam("center")||"combined").toLowerCase()
  const centerMode=["per","combined","none"].includes(centerParam)?centerParam:"combined"

  const shouldFrameRef=useRef(true)
  const prevFileKeysRef=useRef([])
  const cameraStateRef=useRef({ position:[0,0,1000], target:[0,0,0], zoom:1 })
  const getFileKeys=(arr)=>(arr||[]).map(f=>`${f.url}::${f.rawName||f.name}`)

  // DETEKCE LIVE: pokud je stránka v iframe NEBO má ?mode=live/?noDemo=1 → nikdy nenačítej demo
  const isEmbedded = typeof window !== "undefined" && window.self !== window.top
  const isLiveParam = ((getParam("mode")||"").toLowerCase()==="live") || getParam("noDemo")==="1"
  const blockDemo = isEmbedded || isLiveParam

  // INIT
  useEffect(()=>{ (async()=>{
    try{
      const manifestUrl=getParam("manifest")
      if(manifestUrl){
        const m=await fetchJSON(manifestUrl)
        const Fs=(m?.files||[]).map((x,i)=>({ url:x.u, name:stripExt(x.n)||`Model ${i+1}`, rawName:x.n, c:x.c,
          o: typeof x.o==="number"?clamp01(x.o):1, v: typeof x.v==="boolean"?x.v:true,
          r: typeof x.r==="number"?clamp01(x.r):0.5, m: typeof x.m==="number"?clamp01(x.m):0.5, vc:!!x.vc, km:!!x.km }))
        if(!Fs.length) throw new Error("Manifest je prázdný.")
        setFiles(Fs)
        const palette=["#f5f5dc","#8e8e8e","#ffffff","#ffd7a8","#c0c0c0","#e6f0ff","#ffeedd"]
        setColors(Fs.map((f,i)=>f.c||palette[i%palette.length])); setOpacities(Fs.map(f=>f.o)); setVisibles(Fs.map(f=>f.v))
        setRoughnesses(Fs.map(f=>f.r)); setMetalnesses(Fs.map(f=>f.m))
        setTitle(typeof m?.title==="string"?m.title:(getParam("title")??null))
        const logoUrl=m?.logo?.url || DEFAULT_LOGO
        setLogoCfg({ url: logoUrl||null, opacity: clamp01(parseFloat(getParam("logoOpacity")??"0.9")), width: parseInt(getParam("logoWidth") ?? (window.innerWidth<768?"120":"160"),10), pos: getParam("logoPos") || "bc" })
        if(m?.lights){ if(typeof m.lights.intensity==="number") setLightIntensity(m.lights.intensity)
          if(m.lights.headlight){ setHeadlightCfg({ enabled: typeof m.lights.headlight.enabled==="boolean"?m.lights.headlight.enabled:true, intensity: typeof m.lights.headlight.intensity==="number"?m.lights.headlight.intensity:2 }) } }
        prevFileKeysRef.current=getFileKeys(Fs); shouldFrameRef.current=true; return
      }

      const f=getParam("files")
      if(f){
        let arr=null; try{ arr=JSON.parse(f) }catch{}; if(!arr){ try{ arr=JSON.parse(decodeURIComponent(f)) }catch{} }
        if(!Array.isArray(arr)) throw new Error("Neplatný formát ?files=")
        const Fs=arr.filter((x)=>x&&x.u).map((x,i)=>({ url:x.u, name:stripExt(x.n)||`Model ${i+1}`, rawName:x.n, c:x.c,
          o: typeof x.o==="number"?clamp01(x.o):1, v: typeof x.v==="boolean"?x.v:true,
          r: typeof x.r==="number"?clamp01(x.r):0.5, m: typeof x.m==="number"?clamp01(x.m):0.5, vc:!!x.vc, km:!!x.km }))
        setFiles(Fs)
        const palette=["#f5f5dc","#8e8e8e","#ffffff","#ffd7a8","#c0c0c0","#e6f0ff","#ffeedd"]
        setColors(Fs.map((f,i)=>f.c||palette[i%palette.length])); setOpacities(Fs.map(f=>f.o)); setVisibles(Fs.map(f=>f.v))
        setRoughnesses(Fs.map(f=>f.r)); setMetalnesses(Fs.map(f=>f.m))
        setTitle(getParam("title")??null)
        setLogoCfg({ url: getParam("logo")==="none"?null:(getParam("logo")||DEFAULT_LOGO),
          opacity: clamp01(parseFloat(getParam("logoOpacity")??"0.9")),
          width: parseInt(getParam("logoWidth") ?? (window.innerWidth<768?"120":"160"),10),
          pos: getParam("logoPos") || "bc" })
        prevFileKeysRef.current=getFileKeys(Fs); shouldFrameRef.current=true; return
      }

      // ───────────── ŽÁDNÝ DEMO FALLBACK ─────────────
      if(blockDemo){
        setFiles([]); setColors([]); setOpacities([]); setVisibles([]); setRoughnesses([]); setMetalnesses([])
        return
      }

      // (Volitelné) demo – můžeš smazat i tohle:
      // const FsDemo=[]
      // setFiles(FsDemo)

    }catch(e){ console.error(e); setFatal("Tento náhled není dostupný (chyba při načtení dat).") }
  })() },[]) // eslint-disable-line

  /* ──────────────── LIVE MODE ──────────────── */
  const applyLivePayload=(p)=>{
    if(!p) return
    let filesActuallyChanged=false
    if(Array.isArray(p.files)){
      const newFiles=p.files.map((x,i)=>({ url:x.u, name:stripExt(x.n||`Model ${i+1}`), rawName:x.n||`Model${i+1}`, c:x.c,
        o: typeof x.o==="number"?clamp01(x.o):1, v: typeof x.v==="boolean"?x.v:true,
        r: typeof x.r==="number"?clamp01(x.r):0.5, m: typeof x.m==="number"?clamp01(x.m):0.5, vc:!!x.vc, km:!!x.km }))
      const newKeys=newFiles.map(f=>`${f.url}::${f.rawName||f.name}`), prevKeys=prevFileKeysRef.current
      filesActuallyChanged = newKeys.length!==prevKeys.length || newKeys.some((k,i)=>k!==prevKeys[i])
      setFiles(newFiles); prevFileKeysRef.current=newKeys
      const palette=["#f5f5dc","#8e8e8e","#ffffff","#ffd7a8","#c0c0c0","#e6f0ff","#ffeedd"]
      setColors(newFiles.map((f,i)=>f.c||palette[i%palette.length]))
      setOpacities(newFiles.map((f)=>f.o)); setVisibles(newFiles.map((f)=>f.v))
      setRoughnesses(newFiles.map((f)=>f.r)); setMetalnesses(newFiles.map((f)=>f.m))
    }
    if(typeof p.title==="string" || p.title===null) setTitle(p.title??null)
    if(p.logo){ setLogoCfg((old)=>({ url: p.logo?.url ?? old.url, opacity: typeof p.logo?.opacity==="number"?clamp01(p.logo.opacity):old.opacity, width: typeof p.logo?.width==="number"?p.logo.width:old.width, pos: p.logo?.pos || old.pos })) }
    if(p.lights){ if(typeof p.lights.intensity==="number") setLightIntensity(p.lights.intensity)
      if(p.lights.headlight){ setHeadlightCfg((old)=>({ enabled: typeof p.lights.headlight.enabled==="boolean"?p.lights.headlight.enabled:old.enabled, intensity: typeof p.lights.headlight.intensity==="number"?p.lights.headlight.intensity:old.intensity })) } }
    shouldFrameRef.current=filesActuallyChanged
    if(filesActuallyChanged) setLoadedCount(0)
  }

  useEffect(()=>{ const onMsg=(e)=>{ const data=e.data; if(data && LIVE_MSG_TYPES.has(data.type) && data.payload){ console.debug("[viewer3] live payload:", {files:data.payload.files?.length||0, title:data.payload.title}); applyLivePayload(data.payload) } }
    window.addEventListener("message",onMsg); return ()=>window.removeEventListener("message",onMsg)
  },[])

  const logoEl = logoCfg.url && (
    <img src={logoCfg.url} alt="" style={{ position:"absolute",
      bottom: ["bc","bl","br"].includes(logoCfg.pos)?12:"auto",
      left: logoCfg.pos==="bl"?12:(logoCfg.pos==="bc"?"50%":"auto"),
      right: logoCfg.pos==="br"?12:"auto", transform: logoCfg.pos==="bc"?"translateX(-50%)":"none",
      width: logoCfg.width, opacity: logoCfg.opacity, zIndex:0, pointerEvents:"none", userSelect:"none", filter:"drop-shadow(0 0 1px rgba(0,0,0,.25))" }} />
  )

  const rootRef=useRef()
  function CameraStateKeeper(){ const { camera }=useThree(); const targetRef=useRef(new THREE.Vector3(...cameraTarget))
    useEffect(()=>{ targetRef.current.set(...cameraTarget) },[cameraTarget])
    useFrame(()=>{ /* persist */ })
    return null
  }

  return (
    <div className="stage" style={{ position:"relative", width:"100vw", height:"100vh", background:"black" }}>
      <PreloadIcons />{logoEl}

      {/* malý panel jen pro demo ladění */}
      <div className="controls-panel" style={{ position:"absolute", top:10, left:10, zIndex:2, color:"#fff", fontFamily:"sans-serif", fontSize:14, opacity:uiReady?1:0, transition:"opacity .12s", backdropFilter:"blur(3px)", background:"rgba(0,0,0,.25)", border:"1px solid rgba(255,255,255,.15)", borderRadius:8, padding:"8px 10px", width:"clamp(240px, 30vw, 420px)", maxWidth:"calc(100vw - 20px)" }}>
        {title && <div title={title} style={{ marginBottom:8, maxWidth:280, padding:"6px 10px", borderRadius:8, border:"1px solid rgba(255,255,255,.18)", background:"rgba(255,255,255,.08)", fontSize:13, fontWeight:600, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{title}</div>}
        {files.map((f,i)=>(
          <div key={i} style={{ display:"grid", gridTemplateColumns:"36px 1fr 26px", alignItems:"center", columnGap:6, rowGap:6, margin:"6px 0" }}>
            <div style={{ gridColumn:"1 / -1", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }} title={f.rawName||f.name}>{stripExt(f.name)}:</div>
            <div><ColorSwatch color={colors[i] ?? "#ffffff"} onChange={(c)=>setColors((prev)=>prev.map((v,idx)=>(idx===i?c:v)))} ariaLabel={`${f.name} color`} /></div>
            <div style={{ minWidth:0 }}>
              <input className="slider" type="range" min={0} max={1} step={0.01} value={opacities[i] ?? 1} onChange={(e)=>{ const v=parseFloat(e.target.value); setOpacities((prev)=>prev.map((x,idx)=>(idx===i?v:x))) }} style={{ width:"calc(100% - 18px)", minWidth:140 }} />
            </div>
            <button onClick={()=>setVisibles((prev)=>prev.map((v,idx)=>(idx===i?!v:v)))} aria-label={visibles[i]?"Hide":"Show"} style={{ position:"relative", width:26, height:22, padding:0, display:"inline-flex", alignItems:"center", justifyContent:"center", overflow:"hidden", background:"transparent", border:"1px solid white", borderRadius:6, color:"white", cursor:"pointer" }}>
              <img src={ICONS.eye} alt="" width="18" height="18" style={{ position:"absolute", inset:0, width:18, height:18, margin:"auto", opacity: visibles[i]?1:0, transition:"opacity .06s" }}/>
              <img src={ICONS.eyeOff} alt="" width="18" height="18" style={{ position:"absolute", inset:0, width:18, height:18, margin:"auto", opacity: visibles[i]?0:1, transition:"opacity .06s" }}/>
            </button>
            <div style={{ gridColumn:"1 / -1", display:"flex", alignItems:"center", gap:8, justifyContent:"flex-end" }}>
              <label style={{ display:"inline-flex", alignItems:"center", gap:6, cursor:"pointer" }}>
                <input type="checkbox" checked={autoSmooth} onChange={(e)=>setAutoSmooth(e.target.checked)} />
                <span>Auto smooth</span>
              </label>
              <span style={{ opacity:.8, fontSize:12 }}>Úhel: {Math.round(smoothAngle)}°</span>
              <input className="slider" type="range" min={0} max={80} step={1} value={smoothAngle} onChange={(e)=>setSmoothAngle(parseFloat(e.target.value))} style={{ width:120 }} />
            </div>
          </div>
        ))}
      </div>

      <Canvas orthographic camera={{ position:[0,0,1000], near:0.1, far:1e7 }} gl={{ alpha:true }} onCreated={({gl})=>gl.setClearAlpha(0)} style={{ position:"absolute", inset:0, zIndex:1, background:"transparent" }}>
        <>
          <ambientLight intensity={lightIntensity*0.4*(headlightCfg.enabled?0.5:1)} />
          <directionalLight position={[0,5,5]} intensity={lightIntensity*1.5*(headlightCfg.enabled?0.5:1)} />
          <directionalLight position={[-10,0,0]} intensity={lightIntensity*1.0*(headlightCfg.enabled?0.5:1)} />
          <directionalLight position={[10,0,0]} intensity={lightIntensity*1.2*(headlightCfg.enabled?0.5:1)} />
          <directionalLight position={[0,-5,-5]} intensity={lightIntensity*0.8*(headlightCfg.enabled?0.5:1)} />
          <Headlight enabled={headlightCfg.enabled} intensity={headlightCfg.intensity} />

          <group ref={rootRef}>
            <Suspense fallback={null}>
              {files.map((f,i)=>(
                <AnyModel key={i} name={f.rawName||f.name} url={f.url}
                  color={colors[i] ?? "#ffffff"} opacity={opacities[i] ?? 1} visible={visibles[i] ?? true}
                  onLoaded={handleModelLoaded} autoSmooth={autoSmooth} smoothAngle={smoothAngle}
                  roughness={roughnesses[i] ?? (typeof f.r==="number"?f.r:0.5)}
                  metalness={metalnesses[i] ?? (typeof f.m==="number"?f.m:0.5)}
                  useVertexColors={!!f.vc} keepMaterials={!!f.km} />
              ))}
            </Suspense>
          </group>

          <AutoCenterAndFrame rootRef={rootRef} depsKey={shouldFrameRef.current?`frame-${files.length}-${loadedCount}`:`noframe-${files.length}-${loadedCount}`} setTarget={setCameraTarget} margin={1.2} isMobile={isMobile} desktopScale={0.4} mobileScale={1.0} centerMode={centerMode} shouldFrame={shouldFrameRef} />
          <TouchTrackballControls target={cameraTarget} />
          <CameraStateKeeper />
        </>
      </Canvas>

      <style jsx global>{`
        .slider{appearance:none;height:14px;background:transparent;margin:5px 0;display:inline-block}
        .slider::-webkit-slider-runnable-track{height:4px;background:#fff;border-radius:2px}
        .slider::-webkit-slider-thumb{appearance:none;width:14px;height:14px;border-radius:50%;background:#fff;cursor:pointer;box-shadow:0 0 2px #000;margin-top:-5px}
        .slider::-moz-range-track{height:4px;background:#fff;border-radius:2px}
        .slider::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:#fff;cursor:pointer;border:none;box-shadow:0 0 2px #000}
        @media (max-width:720px){ .controls-panel{left:8px!important;right:8px;width:auto!important;max-width:calc(100vw - 16px)!important} }
      `}</style>
    </div>
  )
}
