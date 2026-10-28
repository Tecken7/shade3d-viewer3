"use client"
import React,{useEffect,useRef,useState} from 'react'
import * as THREE from 'three'
import AnimatedSceneLoader from '../AnimatedSceneLoader'
import {orientationViewCamera} from './orientation-view-camera.mjs'
const views=[['top','Shora · směr FRONT'],['side-left','Levý bok'],['front','Frontální'],['side-right','Pravý bok']]
// All four demand-rendered views share one context, GPU buffers and shader cache.
export default function CadOrientationViews({sourceObject,modelMatrix,planeCenter,planeY,planeSize,frontSign=1,onDrag,intensity=1}){
 const root=useRef(),canvas=useRef(),panels=useRef([]),engine=useRef(),gesture=useRef(),config=useRef()
 config.current={modelMatrix,planeCenter,planeY,planeSize,frontSign}
 const [loading,setLoading]=useState(true),[error,setError]=useState('')
 useEffect(()=>{
  if(!sourceObject)return
  let renderer,frame=0,disposed=false,ready=false,observer
  const entries=[]
  setLoading(true);setError('')
  const draw=()=>{
   frame=0;if(disposed||!ready)return
   const rect=root.current.getBoundingClientRect(),width=Math.max(1,Math.round(rect.width)),height=Math.max(1,Math.round(rect.height))
   renderer.setSize(width,height,false);renderer.setScissorTest(false);renderer.setClearColor('#0b0b0b',1);renderer.clear();renderer.setScissorTest(true)
   const options=config.current
   for(let i=0;i<entries.length;i++){
    const item=entries[i],panel=panels.current[i];if(!panel)continue
    item.model.matrix.fromArray(options.modelMatrix || new THREE.Matrix4().toArray());item.model.updateMatrixWorld(true)
    const box=new THREE.Box3().setFromObject(item.model),panelRect=panel.getBoundingClientRect()
    orientationViewCamera(item.camera,box,views[i][0],panelRect.width/panelRect.height,options.planeCenter,options.planeSize,options.frontSign)
    item.grid.position.set(options.planeCenter?.[0]||0,options.planeY||0,options.planeCenter?.[2]||0)
    item.grid.scale.setScalar(Math.max(1,options.planeSize||80)/80)
    item.headlight.position.copy(item.camera.position);item.headlight.target.position.copy(box.getCenter(new THREE.Vector3()))
    renderer.setViewport(panelRect.left-rect.left,rect.bottom-panelRect.bottom,panelRect.width,panelRect.height)
    renderer.setScissor(panelRect.left-rect.left,rect.bottom-panelRect.bottom,panelRect.width,panelRect.height)
    renderer.render(item.scene,item.camera)
   }
   renderer.setScissorTest(false)
  }
  const schedule=()=>{if(!disposed&&!frame)frame=requestAnimationFrame(draw)}
  ;(async()=>{try{
   // Let the loading logo paint before initializing the single GPU context.
   await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))
   if(disposed)return
   renderer=new THREE.WebGLRenderer({canvas:canvas.current,antialias:false,alpha:false,powerPreference:'low-power'})
   renderer.setPixelRatio(1);renderer.autoClear=false
   for(const [view] of views){
    const scene=new THREE.Scene(),model=sourceObject.clone(true),camera=new THREE.OrthographicCamera(-50,50,50,-50,.01,100000)
    model.matrixAutoUpdate=false;scene.add(model)
    scene.add(new THREE.AmbientLight('white',.35*intensity))
    for(const [position,power] of [[[0,5,5],1.2],[[-10,0,0],.9],[[10,0,0],1],[[0,-5,-5],.7]]){const light=new THREE.DirectionalLight('white',power*intensity);light.position.set(...position);scene.add(light)}
    const headlight=new THREE.DirectionalLight('white',2*intensity);scene.add(headlight,headlight.target)
    const grid=new THREE.GridHelper(80,8,'#93c5fd','#2563eb');grid.material.transparent=true;grid.material.opacity=.18;grid.material.depthWrite=false;scene.add(grid)
    entries.push({scene,model,camera,grid,headlight})
   }
   engine.current={schedule}
   await renderer.compileAsync(entries[0].scene,entries[0].camera)
   if(disposed)return
   ready=true;draw();setLoading(false)
   observer=new ResizeObserver(schedule);observer.observe(root.current)
  }catch(e){if(!disposed){setError('Kontrolní pohledy se nepodařilo připravit. Orientaci lze ověřit v hlavní scéně.');setLoading(false)}}})()
  return()=>{disposed=true;cancelAnimationFrame(frame);observer?.disconnect();engine.current=null;for(const item of entries){item.grid.geometry.dispose();item.grid.material.dispose()}renderer?.dispose();renderer?.forceContextLoss()}
 },[sourceObject,intensity])
 useEffect(()=>{engine.current?.schedule()},[modelMatrix,planeCenter,planeY,planeSize,frontSign])
 const end=event=>{gesture.current=null;try{event.currentTarget.releasePointerCapture(event.pointerId)}catch{}}
 return <div ref={root} style={{position:'relative',display:'grid',gap:10}}>
  <canvas ref={canvas} aria-label="Kontrolní pohledy orientace" style={{position:'absolute',inset:0,width:'100%',height:'100%',pointerEvents:'none'}}/>
  {views.map(([view,label],index)=><div key={view} ref={element=>panels.current[index]=element} className="artheticCadOrthoView" role="img" aria-label={label} style={{position:'relative',height:'clamp(150px,18vh,205px)',borderRadius:14,border:'1px solid #ffffff18',overflow:'hidden',cursor:'grab',touchAction:'none'}}
   onPointerDown={event=>{event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);gesture.current={view,x:event.clientX,y:event.clientY,id:event.pointerId}}}
   onPointerMove={event=>{const drag=gesture.current;if(!drag||drag.id!==event.pointerId)return;const dx=event.clientX-drag.x,dy=event.clientY-drag.y;drag.x=event.clientX;drag.y=event.clientY;onDrag?.(view,dx,dy)}} onPointerUp={end} onPointerCancel={end}>
    <span style={{position:'absolute',left:8,top:7,padding:'4px 6px',borderRadius:7,background:'#0009',color:'#ddd',fontSize:8,fontWeight:700,pointerEvents:'none'}}>{label}</span>
    <span style={{position:'absolute',left:8,bottom:7,color:'#777',fontSize:8,pointerEvents:'none'}}>tažením doladit</span>
  </div>)}
  <AnimatedSceneLoader visible={loading} status="Připravuji pohledy…" progress={loading?50:100} progressLabel="Příprava orientace"/>
  {error&&<div role="status" style={{position:'absolute',inset:0,background:'#111e',padding:16,color:'#bbb',fontSize:11}}>{error}</div>}
 </div>
}
