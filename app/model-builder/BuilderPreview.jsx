'use client'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useThree, useFrame } from '@react-three/fiber'
import {baseRevealProgress,BASE_REVEAL_MS,installBaseRevealShader} from './base-reveal.mjs'
import * as THREE from 'three'
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { MeshBVH } from 'three-mesh-bvh'
import { FontLoader } from 'three/examples/jsm/loaders/FontLoader.js'
import { Html, useCursor } from '@react-three/drei'
import { useBuilderGestureGuard } from './useBuilderGestureGuard'
import { projectSurfaceText } from './surface-text.mjs'
import { beginSurfaceTextDrag,moveSurfaceTextDrag } from './text-drag.mjs'
import { createTextPreviewCache,createTextFrameQueue } from './text-preview-cache.mjs'

let fontRequest
function TextShape({result,handlers,hovered}){
 const geometry=result?.geometry
 if(!geometry)return null
 const center=geometry.boundingBox.getCenter(new THREE.Vector3()),size=geometry.boundingBox.getSize(new THREE.Vector3()).addScalar(.15)
 return <group {...handlers}>
  <mesh geometry={geometry} dispose={null} raycast={handlers?undefined:()=>null}><meshBasicMaterial color={!result.valid?'#f87171':hovered?'#93c5fd':'#60a5fa'} depthTest depthWrite/></mesh>
  {handlers&&<mesh position={center}><boxGeometry args={size.toArray()}/><meshBasicMaterial colorWrite={false} depthWrite={false} depthTest/></mesh>}
 </group>
}
export function BuilderPreview({roughness=.42,metalness=.51,geometry,placing,onSurfaceClick,overlayDragging=false,options,select,change,dragging,controlsRef,onDragEnd,editable=true,onTextStatus,reveal=null,onRevealComplete}){
 const mesh=useRef(),textRoot=useRef(),textDrag=useRef(null)
 const [textHovered,setTextHovered]=useState(false),[candidate,setCandidate]=useState(null),[notice,setNotice]=useState(''),[font,setFont]=useState(null)
 useCursor(textHovered,'grab')
 useBuilderGestureGuard(textRoot,controlsRef,editable&&!placing)
 const {camera,gl}=useThree()
 useEffect(()=>{
  let live=true
  fontRequest??=fetch('/wasm/model-builder/font.json').then(r=>{if(!r.ok)throw new Error('font');return r.json()}).then(data=>new FontLoader().parse(data)).catch(()=>{fontRequest=null;return null})
  fontRequest.then(value=>{if(live)setFont(value)})
  return()=>{live=false}
 },[])
 const revealClock=useRef({key:null,start:0,done:false})
 const revealUniforms=useMemo(()=>({uBaseRevealEnabled:{value:0},uBaseRevealProgress:{value:1},uBaseRevealFrom:{value:0},uBaseRevealTo:{value:0},uBaseRevealDirection:{value:1}}),[])
 const compileReveal=useCallback(shader=>installBaseRevealShader(shader,revealUniforms),[revealUniforms])
 useFrame(()=>{
  revealUniforms.uBaseRevealEnabled.value=reveal?1:0
  if(!reveal)return
  const now=performance.now(),clock=revealClock.current
  if(clock.key!==reveal){clock.key=reveal;clock.start=now;clock.done=false}
  const elapsed=now-clock.start
  reveal.progress.value=reveal.reducedMotion?1:baseRevealProgress(elapsed)
  revealUniforms.uBaseRevealProgress.value=reveal.progress.value
  revealUniforms.uBaseRevealFrom.value=reveal.from
  revealUniforms.uBaseRevealTo.value=reveal.to
  revealUniforms.uBaseRevealDirection.value=reveal.direction
  if((reveal.reducedMotion||elapsed>=BASE_REVEAL_MS)&&!clock.done){clock.done=true;onRevealComplete?.()}
 })
 const display=useMemo(()=>{
  if(!geometry)return null
  const result=toCreasedNormals(geometry,Math.PI/6);result.boundsTree=new MeshBVH(result);return result
 },[geometry])
 useEffect(()=>()=>{display?.dispose();if(display)display.boundsTree=null},[display])
 const committed=useMemo(()=>options?.textPosition&&options?.textNormal?{position:options.textPosition,normal:options.textNormal}:null,[options?.textPosition,options?.textNormal])
 const placement=candidate||(placing?null:committed)
 const previewCache=useMemo(()=>createTextPreviewCache(point=>projectSurfaceText(font,options,point,display,{preview:true})),[font,options?.text,options?.textSize,options?.textDepth,options?.textRotation,options?.textMode,options?.baseDirection,display])
 const project=useCallback(point=>previewCache.get(point),[previewCache])
 useEffect(()=>()=>previewCache.dispose(),[previewCache])
 const result=useMemo(()=>project(placement),[project,placement])
 const hasCandidate=!!candidate
 const previous=useMemo(()=>hasCandidate&&!result.valid&&committed?project(committed):null,[hasCandidate,result.valid,committed,project])
 const error=notice||result.error
 useEffect(()=>{onTextStatus?.({valid:!!result.valid&&!notice,error})},[result.valid,notice,error,onTextStatus])
 useEffect(()=>{if(overlayDragging&&!textDrag.current)setTextHovered(false)},[overlayDragging])
 useEffect(()=>setNotice(''),[options?.text,options?.textSize,options?.textDepth,options?.textRotation,options?.textMode,font])
 useEffect(()=>{if(!placing&&!textDrag.current)setCandidate(null)},[placing])
 const validate=useCallback(point=>{
  if(!font){setNotice('Načítám písmo. Zkuste umístění za okamžik.');return false}
  const check=project(point);setNotice(check.error)
  return check.valid
 },[font,project])
 const dragQueue=useMemo(()=>createTextFrameQueue(point=>{
  setCandidate(point)
  if(validate(point))change?.({textPosition:point.position,textNormal:point.normal})
 },callback=>requestAnimationFrame(callback),id=>cancelAnimationFrame(id)),[validate,change])
 const finishText=useCallback(()=>{
  const gesture=textDrag.current;if(!gesture)return
  dragQueue.flush()
  textDrag.current=null;setTextHovered(false);setCandidate(null)
  try{gesture.target.releasePointerCapture?.(gesture.pointerId)}catch{}
  if(controlsRef?.current)controlsRef.current.enabled=false
  dragging?.(false);onDragEnd?.()
 },[controlsRef,dragging,onDragEnd,dragQueue])
 useEffect(()=>{
  window.addEventListener('pointerup',finishText,true);window.addEventListener('pointercancel',finishText,true);window.addEventListener('blur',finishText,true)
  return()=>{window.removeEventListener('pointerup',finishText,true);window.removeEventListener('pointercancel',finishText,true);window.removeEventListener('blur',finishText,true);dragQueue.clear();finishText()}
 },[finishText])
 const textHandlers={
  onPointerOver:event=>{event.stopPropagation();if(!textDrag.current&&!overlayDragging)setTextHovered(true)},
  onPointerOut:event=>{event.stopPropagation();if(!textDrag.current)setTextHovered(false)},
  onPointerDown:event=>{
   if(event.button!==0||!editable||placing||overlayDragging||!change||!committed)return
   event.stopPropagation()
   mesh.current.updateWorldMatrix(true,false)
   const ray=event.ray.clone().applyMatrix4(mesh.current.matrixWorld.clone().invert()),grab=beginSurfaceTextDrag(display,ray,committed)
   if(!grab)return
   textDrag.current={...grab,target:event.target,pointerId:event.pointerId};select?.('text')
   if(controlsRef?.current)controlsRef.current.enabled=false
   dragging?.(true);event.target.setPointerCapture?.(event.pointerId)
  },
  onPointerMove:event=>{
   const gesture=textDrag.current;if(!gesture)return
   event.stopPropagation();mesh.current.updateWorldMatrix(true,false)
   const ray=event.ray.clone().applyMatrix4(mesh.current.matrixWorld.clone().invert()),point=moveSurfaceTextDrag(display,ray,gesture)
   if(!point){dragQueue.clear();setNotice('Kurzor je mimo souvislý povrch. Poslední platná poloha textu zůstala zachovaná.');return}
   dragQueue.push(point)
  },
  onPointerUp:finishText,onPointerCancel:finishText,
 }
 useEffect(()=>{
  if(!editable||!placing||!display)return
  const raycaster=new THREE.Raycaster(),pointer=new THREE.Vector2();raycaster.firstHitOnly=true
  let frame=0
  const hitAt=event=>{
   if(!mesh.current)return null
   const rect=gl.domElement.getBoundingClientRect()
   pointer.set((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1)
   mesh.current.updateWorldMatrix(true,false);raycaster.setFromCamera(pointer,camera)
   return raycaster.intersectObject(mesh.current,false)[0]
  }
  const pointAt=hit=>({position:mesh.current.worldToLocal(hit.point.clone()).toArray(),normal:hit.face.normal.toArray()})
  const move=event=>{
   if(event.buttons)return
   cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{const hit=hitAt(event);setNotice('');setCandidate(hit?pointAt(hit):null)})
  }
  const leave=()=>setCandidate(null)
  const pick=event=>{
   if(event.button!==0)return
   const hit=hitAt(event);if(!hit)return
   event.preventDefault();event.stopPropagation()
   const point=pointAt(hit);setCandidate(point)
   if(!validate(point))return
   onSurfaceClick?.({...hit,stopPropagation(){}});setCandidate(null)
  }
  gl.domElement.addEventListener('pointerdown',pick,true);gl.domElement.addEventListener('pointermove',move,true);gl.domElement.addEventListener('pointerleave',leave)
  return()=>{cancelAnimationFrame(frame);gl.domElement.removeEventListener('pointerdown',pick,true);gl.domElement.removeEventListener('pointermove',move,true);gl.domElement.removeEventListener('pointerleave',leave)}
 },[editable,placing,display,gl,camera,onSurfaceClick,validate])
 if(!display)return null
 const blockHidden=event=>{if(!overlayDragging)event.stopPropagation()}
 const badge=placement?new THREE.Vector3(...placement.position).addScaledVector(new THREE.Vector3(...placement.normal),1.5).toArray():null
 return <>
  <mesh ref={mesh} geometry={display} dispose={null} renderOrder={50} onPointerOver={blockHidden} onPointerMove={blockHidden} onPointerDown={blockHidden} onClick={event=>{blockHidden(event);if(editable&&!placing&&!overlayDragging&&event.delta<=4)select(null)}}>
   <meshStandardMaterial onBeforeCompile={compileReveal} customProgramCacheKey={()=>"builder-base-reveal-v1"} color="#AAA08E" roughness={roughness} metalness={metalness} side={THREE.DoubleSide}/>
  </mesh>
  <group ref={textRoot}>{editable&&options&&<TextShape result={result} handlers={textHandlers} hovered={textHovered}/>}</group>
  {editable&&previous?.valid&&<TextShape result={previous}/>}
  {editable&&candidate&&!result.valid&&result.error&&badge&&<Html center position={badge} occlude style={{pointerEvents:'none',width:200,background:'rgba(35,12,12,.94)',border:'1px solid #a34a4a',borderRadius:7,padding:7,color:'#fecaca',fontSize:11,lineHeight:1.4}}>Tady nelze text umístit. Posuňte jej nebo zmenšete písmo.</Html>}
 </>
}
