'use client'
import React,{useEffect,useMemo,useRef,useState} from 'react'
import {Canvas} from '@react-three/fiber'
import {Bounds,OrbitControls} from '@react-three/drei'
import * as THREE from 'three'
import {toCreasedNormals} from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import {unzip,zip,strToU8} from 'fflate'
import ViewerBackButton from '../ViewerBackButton'
import AnimatedSceneLoader,{useLoaderPresence} from '../AnimatedSceneLoader'
import '../SceneLoader.css'
import styles from './models.module.css'

const initial={convertBase:true,autoHeight:true,replaceHeight:2.5,bevel:1,holes:true,diameter:4.5,logo:true,logoSize:1.8,tag:'',tagSize:4}
function Model({data}){
 const geometry=useMemo(()=>{const raw=new THREE.BufferGeometry().setAttribute('position',new THREE.BufferAttribute(data.positions,3)).setIndex(new THREE.BufferAttribute(data.indices,1));const g=toCreasedNormals(raw,Math.PI/6);raw.dispose();return g},[data])
 useEffect(()=>()=>geometry.dispose(),[geometry])
 return <mesh geometry={geometry}><meshStandardMaterial color="#afa28a" roughness={.42} metalness={.51} side={THREE.DoubleSide}/></mesh>
}
function save(bytes,name){const url=URL.createObjectURL(new Blob([bytes],{type:name.endsWith('.zip')?'application/zip':'application/octet-stream'})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000)}
const safeName=name=>name.replace(/\.stl$/i,'').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_')+'-ARTHETIC.stl'
const statusText={waiting:'Připraveno',working:'Zpracovávám',ready:'Hotovo',error:'Vyžaduje pozornost',cancelled:'Zrušeno'}
export default function ModelsTool(){
 const [items,setItems]=useState([]),[settings,setSettings]=useState(initial),[active,setActive]=useState(null),[busy,setBusy]=useState(false),[reading,setReading]=useState(false),[message,setMessage]=useState(''),[progress,setProgress]=useState(0),[error,setError]=useState(''),[drag,setDrag]=useState(false),[view,setView]=useState('result')
 const input=useRef(),worker=useRef(),pendingReject=useRef(),runId=useRef(0),cancelled=useRef(false),alive=useRef(true),dragCount=useRef(0)
 const presence=useLoaderPresence(busy),selected=items.find(item=>item.id===active),result=selected?.result
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;worker.current?.terminate();pendingReject.current?.(Error('Zrušeno'))}},[])
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
 async function run(){
  if(busy||!items.length)return
  const ticket=++runId.current;cancelled.current=false;setBusy(true);setError('');const batch=items.slice(),config={...settings}
  for(let i=0;i<batch.length;i++){
   if(ticket!==runId.current||cancelled.current||!alive.current)break
   const item=batch[i];update(item.id,{status:'working',result:null,error:null});setActive(item.id);setMessage('Připravuji model…');setProgress(i/batch.length*100)
   try{
    const value=await new Promise((resolve,reject)=>{
     pendingReject.current=reject;const w=new Worker(new URL('./models.worker.js',import.meta.url));worker.current=w
     w.onmessage=({data})=>{if(data.progress){setMessage(data.progress);return}w.terminate();worker.current=null;data.error?reject(Error(data.error)):resolve(data.result)}
     w.onerror=()=>{w.terminate();worker.current=null;reject(Error('Výpočet se přerušil. Zkuste menší dávku.'))}
     const copy=item.buffer.slice(0);w.postMessage({buffer:copy,settings:{...config,tag:config.tag.replaceAll('{name}',item.name.replace(/\.stl$/i,''))}},[copy])
    })
    if(ticket===runId.current&&!cancelled.current&&alive.current)update(item.id,{status:'ready',result:value})
   }catch(err){if(ticket===runId.current&&!cancelled.current&&alive.current)update(item.id,{status:'error',error:err.message})}
   if(ticket===runId.current)setProgress((i+1)/batch.length*100)
  }
  if(ticket===runId.current&&alive.current&&!cancelled.current){setBusy(false);setMessage('Dávka zpracována')}
 }
 async function downloadAll(){
  const ready=items.filter(item=>item.result);if(!ready.length)return
  const files={},report=[]
  ready.forEach((item,i)=>{const name=`${String(i+1).padStart(2,'0')}-${safeName(item.name)}`;files[name]=new Uint8Array(item.result.stl);report.push({file:name,...item.result.report})})
  files['kontrola-modelu.json']=strToU8(JSON.stringify(report,null,2))
  zip(files,{level:1},(err,bytes)=>err?setError('ZIP se nepodařilo připravit. Stáhněte modely jednotlivě.'):save(bytes,'ARTHETIC-modely.zip'))
 }
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
   {items.some(item=>item.result)&&<button type="button" disabled={busy} onClick={downloadAll}>Stáhnout ZIP ({items.filter(item=>item.result).length})</button>}
  </aside>
  <section className={styles.scene} aria-label="Náhled modelu">
   {result?<><div className={styles.viewButtons}><button type="button" aria-pressed={view==='result'} onClick={()=>setView('result')}>Výsledek</button><button type="button" aria-pressed={view==='original'} onClick={()=>setView('original')}>Původní model</button></div><Preview key={`${active}-${view}`} result={result} original={view==='original'?selected.buffer:null}/></>:<div className={styles.empty}><svg width="68" height="68" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M8 34V21C8 5 40 5 40 21v13h-7V22c0-9-18-9-18 0v12Z"/><path d="M8 38h32" strokeDasharray="3 3"/></svg><p>{selected?.error||'Nahrajte modely a spusťte úpravu.'}</p>{selected?.error&&<small>Model nebyl exportován. Změňte nastavení a spusťte převod znovu.</small>}</div>}
   {result&&!busy&&<div className={styles.review}><p>Uzavřený model · dosedací plocha {result.report.contactAfter.toFixed(1)} mm²</p><button type="button" className={styles.primary} onClick={()=>save(result.stl,safeName(selected.name))}>Stáhnout STL</button></div>}
   <AnimatedSceneLoader visible={presence.visible} exiting={presence.exiting} status={message} progress={progress} progressLabel="Zpracování dávky"/>
  </section>
  <aside className={styles.right}>
   <h2>Nastavení úpravy</h2>{toggle('Upravit spodek báze','convertBase')}
   {settings.convertBase&&<>{toggle('Najít souvislou dutinu','autoHeight')}{number('Minimální pás úpravy (mm)','replaceHeight',1,6)}<small>Mění se pouze spodní část. Automat může najít vhodné napojení až v 5,5 mm.</small>{number('Bevel a dosedací lem (mm)','bevel',0,1.5)}{toggle('Odtokové otvory','holes')}{settings.holes&&number('Průměr otvorů (mm)','diameter',2,6)}</>}
   <div className={styles.divider}/>{toggle('Designed by ARTHETIC','logo')}{settings.logo&&<>{number('Velikost podpisu (mm)','logoSize',1,6)}<small>Automaticky na skutečnou vnitřní stěnu dutiny.</small></>}
   <div className={styles.divider}/><label className={styles.field}>Vnější tag<input value={settings.tag} maxLength={60} placeholder="Volitelné · např. {name}" disabled={busy} onChange={e=>change('tag',e.target.value)}/></label>{settings.tag&&number('Velikost tagu (mm)','tagSize',1,12)}
   <p className={styles.note}>Nastavení se použije při dalším zpracování. Před tiskem zkontrolujte náhled i výsledek ve sliceru.</p>
  </aside>
  {error&&<div role="alert" className={styles.toast}><span>{error}</span><button type="button" aria-label="Zavřít upozornění" onClick={()=>setError('')}>×</button></div>}
 </main>
}
function Preview({result,original}){
 const [data,setData]=useState(result)
 useEffect(()=>{let live=true;if(original)import('./stl.mjs').then(async({readSTL})=>{const p=readSTL(original),{indexed}=await import('../model-builder/engine.mjs');let base=Infinity;for(let i=2;i<p.length;i+=3)base=Math.min(base,p[i]);const local=p.slice();for(let i=0;i<p.length;i+=3){local[i+1]=p[i+2]-base;local[i+2]=-p[i+1]}const mesh=indexed(local,{exact:true});if(live)setData({positions:Float32Array.from(mesh.vertices),indices:Uint32Array.from(mesh.faces)})});return()=>{live=false}},[original])
 return <Canvas camera={{position:[0,45,90],fov:35}} dpr={[1,1.5]}><ambientLight intensity={.8}/><directionalLight position={[40,60,50]} intensity={3}/><directionalLight position={[-40,20,-40]} intensity={2}/><Bounds fit clip observe margin={1.35}><Model data={data}/></Bounds><OrbitControls makeDefault enableDamping dampingFactor={.12}/></Canvas>
}
