'use client'
import React,{useCallback,useEffect,useMemo,useRef,useState} from 'react'
import {Canvas} from '@react-three/fiber'
import {Bounds,OrbitControls} from '@react-three/drei'
import * as THREE from 'three'
import {toCreasedNormals} from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import {unzip,zip,strToU8} from 'fflate'
import {HolePreview} from '../model-builder/HolePreview'
import {BuilderPreview} from '../model-builder/BuilderPreview'
import {DEFAULTS} from '../model-builder/engine.mjs'
import SceneLighting from '../viewer/SceneLighting'
import ViewerBackButton from '../ViewerBackButton'
import AnimatedSceneLoader,{useLoaderPresence} from '../AnimatedSceneLoader'
import '../SceneLoader.css'
import styles from './models.module.css'

const initial={convertBase:true,autoHeight:true,preserveOriginal:true,extendBase:false,autoHollow:true,wall:2.5,replaceHeight:2.5,bevel:1,bevelHeight:1,holes:true,diameter:6,logo:true,logoSize:1.8,tag:'',tagSize:4}
function Model({data,onProtect}){
 const geometry=useMemo(()=>{const raw=new THREE.BufferGeometry().setAttribute('position',new THREE.BufferAttribute(data.positions,3)).setIndex(new THREE.BufferAttribute(data.indices,1));const g=toCreasedNormals(raw,Math.PI/6);raw.dispose();return g},[data])
 useEffect(()=>()=>geometry?.dispose(),[geometry])
 return <mesh geometry={geometry} onClick={onProtect?e=>{if(e.delta<=4){e.stopPropagation();onProtect(e.point)}}:undefined}><meshStandardMaterial color="#AAA08E" roughness={.42} metalness={.51} side={THREE.DoubleSide}/></mesh>
}
function save(bytes,name){const url=URL.createObjectURL(new Blob([bytes],{type:name.endsWith('.zip')?'application/zip':'application/octet-stream'})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000)}
const safeName=name=>name.replace(/\.stl$/i,'').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_')+'-ARTHETIC.stl'
const statusText={waiting:'Připraveno',working:'Zpracovávám',ready:'Hotovo',error:'Vyžaduje pozornost',cancelled:'Zrušeno','needs-placement':'Umístit podpis','needs-drains':'Zkontrolovat otvory'}
export default function ModelsTool(){
 const [items,setItems]=useState([]),[settings,setSettings]=useState(initial),[active,setActive]=useState(null),[busy,setBusy]=useState(false),[reading,setReading]=useState(false),[message,setMessage]=useState(''),[progress,setProgress]=useState(0),[error,setError]=useState(''),[drag,setDrag]=useState(false),[view,setView]=useState('result')
 const input=useRef(),worker=useRef(),pendingReject=useRef(),runId=useRef(0),cancelled=useRef(false),alive=useRef(true),dragCount=useRef(0)
 const [protecting,setProtecting]=useState(false),[protectionRadius,setProtectionRadius]=useState(3)
 const [pendingHoles,setPendingHoles]=useState([]),[selectedHole,setSelectedHole]=useState('hole:0')
 const [pending,setPending]=useState([]),[labelIndex,setLabelIndex]=useState(0),[placing,setPlacing]=useState(false),[textStatus,setTextStatus]=useState({valid:false})
 const presence=useLoaderPresence(busy),selected=items.find(item=>item.id===active),result=selected?.result
 useEffect(()=>{setPending(result?.manual?.pending?.map(tag=>({...tag}))||[]);setLabelIndex(0);setPlacing(false)},[result])
 useEffect(()=>{setPendingHoles(result?.drainReview?.holes?.map(h=>({...h}))||[]);setSelectedHole('hole:0')},[result])
 const changeHoles=useCallback(patch=>{if(patch.holes)setPendingHoles(patch.holes.map(h=>({...h,length:Math.max(.5,Math.min(30,h.length)),outerLength:Math.max(.5,Math.min(20,h.outerLength)),position:[h.position[0],Math.max(0,Math.min(4,h.position[1])),h.position[2]],heightOffset:Math.max(0,Math.min(4,h.heightOffset??h.position[1]))})))},[])
 const editLabel=useCallback(patch=>setPending(current=>current.map((tag,i)=>i===labelIndex?{...tag,...patch}:tag)),[labelIndex])
 const pickLabel=useCallback(hit=>{editLabel({position:hit.point.toArray(),normal:hit.face.normal.toArray()});setPlacing(false)},[editLabel])
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;worker.current?.terminate();pendingReject.current?.(Error('Zrušeno'))}},[])
 useEffect(()=>setProtecting(false),[active])
 const update=(id,patch)=>setItems(current=>current.map(item=>item.id===id?{...item,...patch}:item))
 const change=(key,value)=>setSettings(current=>({...current,[key]:value}))
 async function addFiles(files){
  if(busy||reading)return
  setReading(true);setError('')
  try{
   const added=[];let total=0
   for(const file of files){
    if(!/\.(stl|zip)$/i.test(file.name))continue
    if(file.size>300*1024*1024)throw Error('Jeden vstupní soubor může mít nejvýše 300 MB.')
    const buffer=await file.arrayBuffer()
    if(/\.zip$/i.test(file.name)){
     const entries=await new Promise((resolve,reject)=>unzip(new Uint8Array(buffer),{filter:entry=>{if(!/\.stl$/i.test(entry.name))return false;total+=entry.originalSize;if(total>600*1024*1024||entry.originalSize>150*1024*1024)throw Error('Rozbalená dávka je příliš velká. Rozdělte ji.');return true}},(err,value)=>err?reject(err):resolve(value)))
     for(const [name,bytes]of Object.entries(entries))if(!name.startsWith('__MACOSX/'))added.push({id:crypto.randomUUID(),name:name.split('/').pop(),buffer:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),status:'waiting'})
    }else{total+=buffer.byteLength;added.push({id:crypto.randomUUID(),name:file.name,buffer,status:'waiting'})}
   }
   if(!added.length)throw Error('Vyberte STL nebo ZIP obsahující STL modely.')
   if(added.length+items.length>40||total+items.reduce((n,item)=>n+item.buffer.byteLength,0)>600*1024*1024)throw Error('Dávku rozdělte na nejvýše 40 modelů / 600 MB.')
   setItems(current=>[...current,...added]);setActive(current=>current||added[0].id)
  }catch(err){setError(err.message)}finally{setReading(false);if(input.current)input.current.value=''}
 }
 function stop(){runId.current++;cancelled.current=true;worker.current?.terminate();worker.current=null;pendingReject.current?.(Error('Zrušeno'));pendingReject.current=null;setItems(current=>current.map(item=>item.status==='working'?{...item,status:'cancelled',error:'Převod byl zrušen.'}:item));setBusy(false)}
 async function run(onlyId,forceReview=false){
  if(busy||!items.length)return
  const ticket=++runId.current;cancelled.current=false;setBusy(true);setView('result');setError('');const batch=typeof onlyId==='string'?items.filter(item=>item.id===onlyId):items.slice(),config={...settings,reviewDrains:forceReview===true}
  for(let i=0;i<batch.length;i++){
   if(ticket!==runId.current||cancelled.current||!alive.current)break
   const item=batch[i];update(item.id,{status:'working',result:null,error:null});setActive(item.id);setMessage('Připravuji model…');setProgress(i/batch.length*100)
   try{
    const value=await new Promise((resolve,reject)=>{
     pendingReject.current=reject;const w=new Worker(new URL('./models.worker.js',import.meta.url));worker.current=w
     w.onmessage=({data})=>{if(data.progress){setMessage(data.progress);return}w.terminate();worker.current=null;data.error?reject(Error(data.error)):resolve(data.result)}
     w.onerror=()=>{w.terminate();worker.current=null;reject(Error('Výpočet se přerušil. Zkuste menší dávku.'))}
     const copy=item.buffer.slice(0);w.postMessage({buffer:copy,settings:{...config,reviewHoles:forceReview===true?item.result?.drainDrafts:undefined,protectedZones:item.protectedZones||[],tag:config.tag.replaceAll('{name}',item.name.replace(/\.stl$/i,''))}},[copy])
    })
    if(ticket===runId.current&&!cancelled.current&&alive.current)update(item.id,{status:value.status||'ready',result:value})
   }catch(err){if(ticket===runId.current&&!cancelled.current&&alive.current)update(item.id,{status:'error',error:err.message})}
   if(ticket===runId.current)setProgress((i+1)/batch.length*100)
  }
  if(ticket===runId.current&&alive.current&&!cancelled.current){setBusy(false);setMessage('Dávka zpracována')}
 }
 async function downloadAll(){
  const ready=items.filter(item=>item.result?.stl);if(!ready.length)return
  const files={},report=[]
  ready.forEach((item,i)=>{const name=`${String(i+1).padStart(2,'0')}-${safeName(item.name)}`;files[name]=new Uint8Array(item.result.stl);report.push({file:name,...item.result.report})})
  files['kontrola-modelu.json']=strToU8(JSON.stringify(report,null,2))
  zip(files,{level:1},(err,bytes)=>err?setError('ZIP se nepodařilo připravit. Stáhněte modely jednotlivě.'):save(bytes,'ARTHETIC-modely.zip'))
 }
 async function applyLabels(){
  if(busy||!result?.manual)return
  const id=active,ticket=++runId.current;cancelled.current=false;setBusy(true);setError('');setMessage('Přizpůsobuji a spojuji podpis…');setProgress(0)
  try{
   const value=await new Promise((resolve,reject)=>{pendingReject.current=reject;const w=new Worker(new URL('./models.worker.js',import.meta.url));worker.current=w;w.onmessage=({data})=>{if(data.progress){setMessage(data.progress);return}w.terminate();worker.current=null;data.error?reject(Error(data.error)):resolve(data.result)};w.onerror=()=>{w.terminate();worker.current=null;reject(Error('Spojení podpisu se nepodařilo.'))};w.postMessage({manual:result.manual,pending,settings:result.manual.settings})})
   if(ticket===runId.current&&alive.current){update(id,{status:value.status,result:value});if(value.status==='ready')setProgress(100);else{setProgress(0);setError(value.message||'Podpis se nepodařilo spojit. Upravte jeho polohu nebo velikost.')}}
  }catch(e){if(ticket===runId.current)setError(e.message)}finally{if(ticket===runId.current)setBusy(false)}
 }
 async function applyDrains(){
  if(busy||!result?.drainManual)return
  const id=active,ticket=++runId.current;cancelled.current=false;setBusy(true);setError('');setMessage('Vyřezávám potvrzené odtoky…');setProgress(0)
  try{
   const value=await new Promise((resolve,reject)=>{pendingReject.current=reject;const w=new Worker(new URL('./models.worker.js',import.meta.url));worker.current=w;w.onmessage=({data})=>{if(data.progress){setMessage(data.progress);return}w.terminate();worker.current=null;data.error?reject(Error(data.error)):resolve(data.result)};w.onerror=()=>{w.terminate();worker.current=null;reject(Error('Otvory se nepodařilo vyříznout.'))};w.postMessage({drainManual:result.drainManual,holes:pendingHoles,settings:result.drainManual.settings})})
   if(ticket===runId.current&&alive.current){update(id,{status:value.status,result:value});setProgress(100)}
  }catch(e){if(ticket===runId.current)setError(e.message)}finally{if(ticket===runId.current)setBusy(false)}
 }
 const selectedIndex=Number(selectedHole?.split(':')[1]),selectedDraft=pendingHoles[selectedIndex]
 const editHole=patch=>changeHoles({holes:pendingHoles.map((h,i)=>i===selectedIndex?{...h,...patch}:h)})
 const holeField=(label,key,min,max,step=.1)=><label className={styles.field}>{label}<input type="number" disabled={busy} min={min} max={max} step={step} value={Number((key==='heightOffset'?selectedDraft.position[1]:selectedDraft[key]??0).toFixed(2))} onChange={e=>{const value=e.target.valueAsNumber;if(Number.isFinite(value)){const v=Math.max(min,Math.min(max,value));editHole(key==='heightOffset'?{heightOffset:v,position:[selectedDraft.position[0],v,selectedDraft.position[2]]}:{[key]:v})}}}/></label>
 const toggle=(label,key,disabled=false)=><button type="button" className={styles.toggle} role="switch" aria-checked={!!settings[key]} disabled={busy||disabled} onClick={()=>change(key,!settings[key])}><span>{label}</span><i/></button>
 const number=(label,key,min,max,step=.1)=><label className={styles.field}><span>{label}</span><input type="number" min={min} max={max} step={step} value={settings[key]} disabled={busy} onChange={e=>{if(e.target.value!==''&&Number.isFinite(e.target.valueAsNumber))change(key,e.target.valueAsNumber)}}/></label>
 return <main className={styles.app}>
  <header className={styles.header}><ViewerBackButton onClick={()=>{if(window.parent!==window)window.parent.postMessage({type:'arthetic-models-back'},'https://www.arthetic.cz');else window.location.href='https://www.arthetic.cz/casecloud'}}/><div><h1>Models</h1><p>Úprava hotových modelů</p></div><span className={styles.local}>Soubory zůstávají v tomto prohlížeči</span></header>
  <aside className={styles.left}>
   <div className={styles.sectionHead}><h2>MODELY</h2><button type="button" disabled={busy||reading} aria-label="Přidat modely" onClick={()=>input.current?.click()}>+</button></div>
   <input ref={input} type="file" accept=".stl,.zip" multiple hidden onChange={e=>addFiles([...e.target.files])}/>
   <button type="button" className={`${styles.drop} ${drag?styles.drag:''}`} disabled={busy||reading} onClick={()=>input.current?.click()} onDragEnter={e=>{e.preventDefault();dragCount.current++;setDrag(true)}} onDragOver={e=>e.preventDefault()} onDragLeave={()=>{if(--dragCount.current<=0)setDrag(false)}} onDrop={e=>{e.preventDefault();dragCount.current=0;setDrag(false);addFiles([...e.dataTransfer.files])}}>{reading?'Připravuji soubory…':'Přetáhněte STL nebo ZIP'}<small>Hotové modely, dosedací plochou dolů · mm</small></button>
   <div className={styles.list}>{items.map(item=><button type="button" key={item.id} className={`${styles.item} ${active===item.id?styles.selected:''}`} onClick={()=>{setActive(item.id);setView('result')}}><span>{item.name}</span><small className={item.status==='error'?styles.error:''}>{statusText[item.status]}</small></button>)}</div>
   {!busy&&items.length>0&&<button type="button" className={styles.secondary} onClick={()=>{setItems([]);setActive(null)}}>Vyprázdnit seznam</button>}
   <button type="button" className={styles.primary} disabled={!items.length||busy||reading} onClick={run}>Zpracovat {items.length?`modely (${items.length})`: 'modely'}</button>
   {busy&&<button type="button" onClick={stop}>Zrušit převod</button>}
   {items.some(item=>item.result?.stl)&&<button type="button" disabled={busy} onClick={downloadAll}>Stáhnout ZIP ({items.filter(item=>item.result?.stl).length})</button>}
  </aside>
  <section className={styles.scene} aria-label="Náhled modelu">
   {result||selected?.buffer?<><div className={styles.viewButtons}><button type="button" disabled={!result} aria-pressed={view==='result'} onClick={()=>setView('result')}>Výsledek</button><button type="button" aria-pressed={view==='original'} onClick={()=>setView('original')}>Původní model</button></div><Preview key={`${active}-${view}`} result={result} original={!result||view==='original'?selected.buffer:null} manual={view==='result'&&result?.manual?pending[labelIndex]:null} placing={placing} onPick={pickLabel} onChange={editLabel} onStatus={setTextStatus} drainReview={view==='result'?result?.drainReview:null} draftHoles={pendingHoles} selectedHole={selectedHole} selectHole={setSelectedHole} changeHoles={changeHoles} busy={busy} protecting={protecting} zones={selected?.protectedZones||[]} onProtect={point=>{update(active,{protectedZones:[...(selected.protectedZones||[]),{center:[point.x,-point.z],radius:protectionRadius,kind:'manual'}]});setProtecting(false)}}/></>:<div className={styles.empty}><svg width="68" height="68" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M8 34V21C8 5 40 5 40 21v13h-7V22c0-9-18-9-18 0v12Z"/><path d="M8 38h32" strokeDasharray="3 3"/></svg><p>{selected?.error||'Nahrajte modely a spusťte úpravu.'}</p>{selected?.error&&<small>Model nebyl exportován. Změňte nastavení a spusťte převod znovu.</small>}</div>}
   {selected?.error&&!busy&&<div className={styles.review}><p style={{whiteSpace:'normal'}}>{selected.error}</p><button type="button" onClick={()=>run(selected.id)}>Zpracovat znovu</button></div>}
   {result?.stl&&!busy&&<div className={styles.review}>{result.report.warnings?.map(message=><p key={message} role="status" style={{whiteSpace:'normal'}}>{message}</p>)}<p>Uzavřený model · dosedací plocha {result.report.contactAfter.toFixed(1)} mm²</p><button type="button" className={styles.primary} onClick={()=>save(result.stl,safeName(selected.name))}>Stáhnout STL</button></div>}
   <AnimatedSceneLoader visible={presence.visible} exiting={presence.exiting} status={message} progress={progress} progressLabel="Zpracování dávky"/>
  </section>
  <aside className={styles.right}>
   {result?.manual&&<><h2>Dokončení podpisu</h2><p className={styles.note}>{result.message||'Báze je připravená. Otočte model a vyberte místo pro podpis ručně.'}</p><label className={styles.field}>Popisek<select disabled={busy} value={labelIndex} onChange={e=>{setLabelIndex(Number(e.target.value));setPlacing(false)}}>{pending.map((tag,i)=><option key={i} value={i}>{tag.name||tag.text}</option>)}</select></label>{pending[labelIndex]&&!pending[labelIndex].brand&&<label className={styles.field}>Text<input disabled={busy} value={pending[labelIndex].text} maxLength={60} onChange={e=>editLabel({text:e.target.value})}/></label>}{pending[labelIndex]&&<label className={styles.field}>Velikost (mm)<input disabled={busy} type="number" min="1" max={pending[labelIndex].brand?6:12} step="0.1" value={pending[labelIndex].size} onChange={e=>{if(Number.isFinite(e.target.valueAsNumber))editLabel({size:e.target.valueAsNumber})}}/></label>}<button type="button" disabled={busy} aria-pressed={placing} onClick={()=>{setView('result');setPlacing(!placing)}}>Umístit na model</button><small>Kliknutím umístíte text. Tažením za text jej posunete; tažením mimo text otáčíte model.</small><small>{textStatus.error}</small><button type="button" className={styles.primary} disabled={busy||placing||!textStatus.valid||pending.some(t=>!t.position)} onClick={applyLabels}>Použít podpis</button><div className={styles.divider}/></>}
   {result?.drainReview&&<><h2>Odtokové otvory</h2><p className={styles.note} style={{marginTop:0,paddingTop:0}}>{result.message}</p><div style={{display:'flex',gap:6}}>{pendingHoles.map((h,i)=><button type="button" key={i} disabled={busy} aria-pressed={selectedHole===`hole:${i}`} onClick={()=>setSelectedHole(`hole:${i}`)}>Otvor {i+1}</button>)}</div>{selectedDraft&&<><button type="button" role="switch" aria-checked={selectedDraft.enabled!==false} disabled={busy} className={styles.toggle} onClick={()=>editHole({enabled:selectedDraft.enabled===false})}><span>Použít otvor</span><i/></button>{holeField('Průměr válce (mm)','diameter',2,8)}{holeField('Výška středu (mm)','heightOffset',0,4)}{holeField('Natočení válce (°)','yaw',-180,180,1)}{holeField('Délka dovnitř (mm)','length',.5,30)}{holeField('Délka ven (mm)','outerLength',.5,20)}</>}<button type="button" className={styles.primary} disabled={busy} onClick={applyDrains}>{pendingHoles.some(h=>h.enabled!==false)?'Vyříznout otvory':'Pokračovat bez otvorů'}</button><div className={styles.divider}/></>}
   {result?.stl&&settings.convertBase&&settings.holes&&!settings.extendBase&&<button type="button" disabled={busy} onClick={()=>run(selected.id,true)}>Upravit otvory</button>}
   <h2>Nastavení úpravy</h2>{toggle('Upravit spodek báze','convertBase')}
   {settings.convertBase&&<>{toggle('Prodloužit bázi','extendBase')}{settings.extendBase?<>{number('Prodloužení báze (mm)','replaceHeight',1,6)}<small>Prodloužení mění vzdálenost od pinu ke spodní ploše.</small></>:<small>Původní výška a dosednutí pinu zůstávají zachované. Bevel vynechá chráněné detaily.</small>}{toggle('Plné modely automaticky vydutit','autoHollow')}{settings.autoHollow&&number('Tloušťka stěny (mm)','wall',1.5,5)}{number('Šířka bevelu (mm)','bevel',0,1.5)}{settings.bevel>0&&<>{number('Výška bevelu (mm)','bevelHeight',.2,settings.extendBase?Math.min(4,settings.replaceHeight-.1):4)}<small>Vyšší bevel při stejné šířce zachová jeho spodní obrys. Dosedací lem se dopočítá automaticky.</small></>}{toggle('Odtokové otvory','holes')}{settings.holes&&number('Průměr otvorů (mm)','diameter',2,settings.extendBase?6:8)}</>}
   {settings.convertBase&&!settings.extendBase&&selected&&<><div className={styles.divider}/><h2>Ochrana původních detailů</h2><small>Tagy a uložení pinů chrání automat. Kliknutím můžete přidat další místo, kde se nebude řezat ani doplňovat lem.</small><label className={styles.field}>Poloměr ochrany (mm)<input type="number" min="1" max="8" step=".5" value={protectionRadius} disabled={busy} onChange={e=>{if(Number.isFinite(e.target.valueAsNumber))setProtectionRadius(Math.max(1,Math.min(8,e.target.valueAsNumber)))}}/></label><button type="button" disabled={busy||!!result?.manual} aria-pressed={protecting} onClick={()=>{setProtecting(!protecting);setPlacing(false)}}>{protecting?'Klikněte na chráněné místo':'Přidat ochranu v náhledu'}</button>{!!selected.protectedZones?.length&&<><small>Ruční oblasti: {selected.protectedZones.length}. Použijí se při dalším převodu.</small><button type="button" disabled={busy} onClick={()=>update(active,{protectedZones:[]})}>Smazat ruční ochranu</button><button type="button" className={styles.primary} disabled={busy} onClick={()=>run(selected.id)}>Použít ochranu</button></>}</>}
   <div className={styles.divider}/>{toggle('Designed by ARTHETIC','logo')}{settings.logo&&<>{number('Velikost podpisu (mm)','logoSize',1,6)}<small>Automaticky na skutečnou vnitřní stěnu dutiny.</small></>}
   <div className={styles.divider}/><label className={styles.field}>Vnější tag<input value={settings.tag} maxLength={60} placeholder="Volitelné · např. {name}" disabled={busy} onChange={e=>change('tag',e.target.value)}/></label>{settings.tag&&number('Velikost tagu (mm)','tagSize',1,12)}
   <p className={styles.note}>Nastavení se použije při dalším zpracování. Před tiskem zkontrolujte náhled i výsledek ve sliceru.</p>
  </aside>
  {error&&<div role="alert" className={styles.toast}><span>{error}</span><button type="button" aria-label="Zavřít upozornění" onClick={()=>setError('')}>×</button></div>}
 </main>
}
function Preview({result,original,manual,placing,onPick,onChange,onStatus,protecting,zones,onProtect,drainReview,draftHoles,selectedHole,selectHole,changeHoles,busy}){
 const [data,setData]=useState(result),controls=useRef()
 const geometry=useMemo(()=>result?new THREE.BufferGeometry().setAttribute('position',new THREE.BufferAttribute(result.positions,3)).setIndex(new THREE.BufferAttribute(result.indices,1)):null,[result])
 useEffect(()=>()=>geometry?.dispose(),[geometry])
 const options=useMemo(()=>manual?{...DEFAULTS,text:manual.text,textSize:manual.size,textDepth:manual.depth,textMode:manual.mode,textWeight:manual.weight??500,textRotation:manual.rotation??0,textPosition:manual.position,textNormal:manual.normal,baseDirection:-1}:null,[manual])
 const changeText=useCallback(patch=>onChange({position:patch.textPosition,normal:patch.textNormal}),[onChange])
 const markHoleDragging=useCallback(()=>{},[])
 const drainOptions=useMemo(()=>drainReview?{cutHoles:false,bottomContour:drainReview.bottomContour,holes:draftHoles,holeYaw:0}:null,[drainReview,draftHoles])
 const restoreControls=useCallback(()=>{if(controls.current)controls.current.enabled=true},[])
 useEffect(()=>{let live=true;if(!original)setData(result);else import('./stl.mjs').then(async({readSTL})=>{const p=readSTL(original),{indexed}=await import('../model-builder/engine.mjs');let base=Infinity;for(let i=2;i<p.length;i+=3)base=Math.min(base,p[i]);const local=p.slice();for(let i=0;i<p.length;i+=3){local[i+1]=p[i+2]-base;local[i+2]=-p[i+1]}const mesh=indexed(local,{exact:true});if(live)setData({positions:Float32Array.from(mesh.vertices),indices:Uint32Array.from(mesh.faces)})}).catch(()=>{if(live)setData(null)});return()=>{live=false}},[original,result])
 return <Canvas onPointerMissed={()=>selectHole?.(null)} camera={{position:[0,45,90],fov:35}} dpr={[1,1.5]} style={{cursor:protecting?'crosshair':undefined}}><SceneLighting/><Bounds key={data===result&&data?'result':data?'source':'empty'} fit clip observe margin={1.35}>{manual?<BuilderPreview geometry={geometry} fontUrlOverride={manual.brand?'/wasm/model-builder/arthetic-logo-font.json':undefined} options={options} placing={placing} onSurfaceClick={onPick} change={changeText} select={()=>{}} controlsRef={controls} onDragEnd={restoreControls} onTextStatus={onStatus}/>:data?<Model data={data} onProtect={protecting?onProtect:undefined}/>:null}</Bounds>{drainOptions&&<HolePreview options={drainOptions} selected={selectedHole} select={selectHole} change={changeHoles} dragging={markHoleDragging} controlsRef={controls} onDragEnd={restoreControls} interactionLocked={busy}/>}{zones?.map((zone,i)=><mesh key={i} position={[zone.center[0],2,-zone.center[1]]} raycast={()=>null}><cylinderGeometry args={[zone.radius,zone.radius,4,32,1,true]}/><meshBasicMaterial color="#87baff" transparent opacity={.25} side={THREE.DoubleSide} depthWrite={false}/></mesh>)}<OrbitControls ref={controls} makeDefault enableDamping dampingFactor={.12}/></Canvas>
}
