'use client'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useThree, useFrame } from '@react-three/fiber'
import {advanceBaseReveal,BASE_REVEAL_MS,installBaseRevealShader} from './base-reveal.mjs'
import * as THREE from 'three'
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { MeshBVH } from 'three-mesh-bvh'
import { FontLoader } from 'three/examples/jsm/loaders/FontLoader.js'
import { Html, useCursor } from '@react-three/drei'
import { useBuilderGestureGuard } from './useBuilderGestureGuard'
import { beginSurfaceTextDrag,moveSurfaceTextDrag } from './text-drag.mjs'
import {updateLiveTextPreview,isTextPlacementClick} from './text-live-preview.mjs'
import {textFontUrl} from './text-font.mjs'
import {useTextProjection} from './useTextProjection'


const fontRequests=new Map()
function TextShape({result,handlers,hovered}){
 const geometry=result?.geometry
 if(!geometry)return null
 const center=geometry.boundingBox.getCenter(new THREE.Vector3()),size=geometry.boundingBox.getSize(new THREE.Vector3()).addScalar(.15)
 return <group {...handlers}>
  <mesh geometry={geometry} dispose={null} raycast={handlers?undefined:()=>null}><meshBasicMaterial color={!result.valid?'#f87171':hovered?'#93c5fd':'#60a5fa'} depthTest depthWrite/></mesh>
  {handlers&&<mesh position={center}><boxGeometry args={size.toArray()}/><meshBasicMaterial colorWrite={false} depthWrite={false} depthTest/></mesh>}
 </group>
}
export function BuilderPreview({overlayOnly=false,fontUrlOverride=null,interactionLocked=false,textSurfaceGeometry=null,showTextPreview=true,roughness=.42,metalness=.51,geometry,placing,onSurfaceClick,overlayDragging=false,options,select,change,dragging,controlsRef,onDragEnd,editable=true,onTextStatus,reveal=null,onRevealComplete}){
 const mesh=useRef(),textRoot=useRef(),textDrag=useRef(null),placementRequest=useRef(false),livePoint=useRef(null),liveTimer=useRef(0),liveApplied=useRef(null)
 const [textHovered,setTextHovered]=useState(false),[candidate,setCandidate]=useState(null),[notice,setNotice]=useState(''),[font,setFont]=useState(null),[moving,setMoving]=useState(false),[fastValid,setFastValid]=useState(null)
 useCursor(textHovered,'grab')
 useBuilderGestureGuard(textRoot,controlsRef,editable&&!placing&&!interactionLocked)
 const {camera,gl}=useThree()
 useEffect(()=>{
  let live=true
  const url=fontUrlOverride||textFontUrl(options?.textWeight)
  setFont(null)
  if(!fontRequests.has(url))fontRequests.set(url,fetch(url).then(r=>{if(!r.ok)throw new Error('font');return r.json()}).then(data=>new FontLoader().parse(data)).catch(()=>{fontRequests.delete(url);return null}))
  fontRequests.get(url).then(value=>{if(live)setFont(value)})
  return()=>{live=false}
 },[options?.textWeight,fontUrlOverride])
 const revealClock=useRef({key:null,start:0,done:false})
 const revealUniforms=useMemo(()=>({uBaseRevealHasStart:{value:0},uBaseRevealEnabled:{value:0},uBaseRevealProgress:{value:1},uBaseRevealFrom:{value:0},uBaseRevealTo:{value:0},uBaseRevealDirection:{value:1}}),[])
 const compileReveal=useCallback(shader=>installBaseRevealShader(shader,revealUniforms),[revealUniforms])
 useFrame((_,delta)=>{
  revealUniforms.uBaseRevealEnabled.value=reveal?1:0
  if(!reveal)return
  const clock=revealClock.current
  const progress=advanceBaseReveal(clock,reveal,delta)
  reveal.progress.value=reveal.reducedMotion?1:progress
  revealUniforms.uBaseRevealHasStart.value=geometry?.hasAttribute('baseRevealStart')?1:0
  revealUniforms.uBaseRevealProgress.value=reveal.progress.value
  revealUniforms.uBaseRevealFrom.value=reveal.from
  revealUniforms.uBaseRevealTo.value=reveal.to
  revealUniforms.uBaseRevealDirection.value=reveal.direction
  if((reveal.reducedMotion||clock.elapsed>=BASE_REVEAL_MS)&&!clock.done){clock.done=true;onRevealComplete?.()}
 })
 const display=useMemo(()=>{
  if(!geometry)return null
  const result=toCreasedNormals(geometry,Math.PI/6);result.boundsTree=new MeshBVH(result);return result
 },[geometry])
 useEffect(()=>()=>{display?.dispose();if(display)display.boundsTree=null},[display])
 // Keep label projection on the unlabelled base when a committed label is edited again.
 const labelProjection=useMemo(()=>{
  if(!textSurfaceGeometry)return null
  const result=toCreasedNormals(textSurfaceGeometry,Math.PI/6);result.boundsTree=new MeshBVH(result);return result
 },[textSurfaceGeometry])
 useEffect(()=>()=>{labelProjection?.dispose();if(labelProjection)labelProjection.boundsTree=null},[labelProjection])
 const textSurface=labelProjection||display
 const committed=useMemo(()=>options?.textPosition&&options?.textNormal?{position:options.textPosition,normal:options.textNormal}:null,[options?.textPosition,options?.textNormal])
 const placement=candidate||(placing?null:committed)
 const {result,pending,project}=useTextProjection(editable&&showTextPreview&&options?.text?.trim()?textSurface:null,font,options)
 useEffect(()=>{project(placement)},[project,placement,font,textSurface,options?.text,options?.textSize,options?.textDepth,options?.textRotation,options?.textMode,options?.textWeight,options?.baseDirection,editable,showTextPreview])
 const liveGeometry=useMemo(()=>{const copy=result.geometry?.clone();copy?.attributes.position.setUsage(THREE.DynamicDrawUsage);return copy||null},[result.geometry])
 useEffect(()=>()=>liveGeometry?.dispose(),[liveGeometry])
 const resultRef=useRef(result);resultRef.current=result
 useFrame(()=>{
  const point=livePoint.current
  if(!point||!liveGeometry||liveApplied.current?.point===point&&liveApplied.current?.geometry===liveGeometry)return
  liveApplied.current={point,geometry:liveGeometry}
  const valid=updateLiveTextPreview(liveGeometry,options,point,textSurface)
  setFastValid(valid?true:null)
 })
 const settleLive=useCallback((point,check)=>{
  if(livePoint.current===point){livePoint.current=null;setMoving(false);setFastValid(null);setNotice(check.error||'')}
 },[])
 const queueLive=useCallback(point=>{
  livePoint.current=point;setMoving(true);setNotice('');clearTimeout(liveTimer.current)
  if(!resultRef.current.geometry)project(point,check=>settleLive(point,check))
  liveTimer.current=setTimeout(()=>project(point,check=>settleLive(point,check)),120)
 },[project,settleLive])
 useEffect(()=>()=>clearTimeout(liveTimer.current),[])
 const shownResult=moving&&liveGeometry?{...result,geometry:liveGeometry,valid:fastValid??result.valid}:result
 const error=notice||result.error
 useEffect(()=>{onTextStatus?.({valid:!!font&&!placing&&!moving&&!pending&&!!result.valid,error:!font?'Načítám písmo…':moving||pending?'Přizpůsobuji text povrchu…':error})},[font,placing,moving,pending,result.valid,error,onTextStatus])
 useEffect(()=>{if(overlayDragging&&!textDrag.current)setTextHovered(false)},[overlayDragging])
 useEffect(()=>{placementRequest.current=false;livePoint.current=null;clearTimeout(liveTimer.current);setMoving(false);setFastValid(null);setNotice('')},[options?.text,options?.textSize,options?.textDepth,options?.textRotation,options?.textMode,options?.textWeight,font])
 const finishText=useCallback(()=>{
  const gesture=textDrag.current;if(!gesture)return
  textDrag.current=null;setTextHovered(false);clearTimeout(liveTimer.current)
  if(gesture.nextPoint){
   const point=gesture.nextPoint;setCandidate(point)
   project(point,check=>{settleLive(point,check);if(check.valid){change?.({textPosition:point.position,textNormal:point.normal});setCandidate(null)}else setNotice(check.error)})
  }else{livePoint.current=null;setMoving(false);setCandidate(null);project(committed)}
  try{gesture.target.releasePointerCapture?.(gesture.pointerId)}catch{}
  if(controlsRef?.current)controlsRef.current.enabled=false
  dragging?.(false);onDragEnd?.()
 },[controlsRef,dragging,onDragEnd,project,change,committed,settleLive])
 const finishRef=useRef(finishText);finishRef.current=finishText
 useEffect(()=>{
  const finish=()=>finishRef.current()
  window.addEventListener('pointerup',finish,true);window.addEventListener('pointercancel',finish,true);window.addEventListener('blur',finish,true)
  return()=>{window.removeEventListener('pointerup',finish,true);window.removeEventListener('pointercancel',finish,true);window.removeEventListener('blur',finish,true)}
 },[])
 useEffect(()=>{if(!placing)placementRequest.current=false},[placing])
 const textHandlers={
  onPointerOver:event=>{event.stopPropagation();if(!interactionLocked&&!textDrag.current&&!overlayDragging)setTextHovered(true)},
  onPointerOut:event=>{event.stopPropagation();if(!textDrag.current)setTextHovered(false)},
  onPointerDown:event=>{
   if(event.button!==0||!editable||interactionLocked||placing||overlayDragging||pending||!font||!change||!committed)return
   event.stopPropagation()
   mesh.current.updateWorldMatrix(true,false)
   const ray=event.ray.clone().applyMatrix4(mesh.current.matrixWorld.clone().invert()),grab=beginSurfaceTextDrag(textSurface,ray,candidate||committed)
   if(!grab)return
   textDrag.current={...grab,target:event.target,pointerId:event.pointerId};select?.('text')
   if(controlsRef?.current)controlsRef.current.enabled=false
   dragging?.(true);event.target.setPointerCapture?.(event.pointerId)
  },
  onPointerMove:event=>{
   const gesture=textDrag.current;if(!gesture)return
   event.stopPropagation();mesh.current.updateWorldMatrix(true,false)
   const ray=event.ray.clone().applyMatrix4(mesh.current.matrixWorld.clone().invert()),point=moveSurfaceTextDrag(textSurface,ray,gesture)
   if(!point){gesture.nextPoint=null;setNotice('Kurzor je mimo souvislý povrch. Poslední platná poloha textu zůstala zachovaná.');return}
   gesture.nextPoint=point;queueLive(point)
  },
  onPointerUp:finishText,onPointerCancel:finishText,
 }
 useEffect(()=>{
  if(!editable||interactionLocked||!placing||!display)return
  const raycaster=new THREE.Raycaster(),pointer=new THREE.Vector2();raycaster.firstHitOnly=true
  let frame=0,start=null
  const hitAt=event=>{
   if(!mesh.current)return null
   const rect=gl.domElement.getBoundingClientRect()
   pointer.set((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1)
   mesh.current.updateWorldMatrix(true,false);raycaster.setFromCamera(pointer,camera)
   return raycaster.intersectObject(mesh.current,false)[0]
  }
  const pointAt=hit=>({position:mesh.current.worldToLocal(hit.point.clone()).toArray(),normal:hit.face.normal.toArray()})
  const move=event=>{
   if(start&&Math.hypot(event.clientX-start.x,event.clientY-start.y)>4)start.moved=true
   if(!font||event.buttons||placementRequest.current)return
   cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{
    const hit=hitAt(event)
    if(!hit){leave();return}
    const point=pointAt(hit)
    queueLive(point)
   })
  }
  const leave=()=>{start=null;if(!placementRequest.current){clearTimeout(liveTimer.current);livePoint.current=null;setMoving(false);setCandidate(null);project(null)}}
  const down=event=>{start=event.button===0&&!event.altKey&&!event.ctrlKey&&!event.shiftKey?{x:event.clientX,y:event.clientY}:null}
  const cancel=()=>{start=null}
  const pick=event=>{
   const click=isTextPlacementClick(start,event);start=null
   if(!click||placementRequest.current)return
   if(!font){setNotice('Načítám písmo. Zkuste umístění za okamžik.');return}
   clearTimeout(liveTimer.current);cancelAnimationFrame(frame);const hit=hitAt(event);if(!hit)return
   const point=pointAt(hit);livePoint.current=point;setMoving(true);setCandidate(point)
   placementRequest.current=true
   project(point,check=>{if(!placementRequest.current)return;placementRequest.current=false;settleLive(point,check);if(check.valid){onSurfaceClick?.({...hit,stopPropagation(){}});setCandidate(null)}else setNotice(check.error)})
  }
  gl.domElement.addEventListener('pointerdown',down,true);gl.domElement.addEventListener('pointerup',pick,true);gl.domElement.addEventListener('pointercancel',cancel,true);gl.domElement.addEventListener('pointermove',move,true);gl.domElement.addEventListener('pointerleave',leave)
  return()=>{cancelAnimationFrame(frame);gl.domElement.removeEventListener('pointerdown',down,true);gl.domElement.removeEventListener('pointerup',pick,true);gl.domElement.removeEventListener('pointercancel',cancel,true);gl.domElement.removeEventListener('pointermove',move,true);gl.domElement.removeEventListener('pointerleave',leave)}
 },[editable,interactionLocked,placing,display,gl,camera,onSurfaceClick,project,font,queueLive,settleLive])
 if(!display)return null
 const blockHidden=event=>{if(!overlayDragging)event.stopPropagation()}
 const proposal=result.point||placement
 const badge=proposal?new THREE.Vector3(...proposal.position).addScaledVector(new THREE.Vector3(...proposal.normal),1.5).toArray():null
 return <>
  <mesh ref={mesh} geometry={display} dispose={null} renderOrder={50} visible={!overlayOnly} {...(!overlayOnly?{onPointerOver:blockHidden,onPointerMove:blockHidden,onPointerDown:blockHidden,onClick:event=>{blockHidden(event);if(editable&&!placing&&!overlayDragging&&event.delta<=4)select(null)}}:{})}>
   <meshStandardMaterial onBeforeCompile={compileReveal} customProgramCacheKey={()=>"builder-base-reveal-v2"} color="#AAA08E" roughness={roughness} metalness={metalness} side={THREE.DoubleSide}/>
  </mesh>
  <group ref={textRoot}>{editable&&showTextPreview&&options&&<TextShape result={shownResult} handlers={interactionLocked?undefined:textHandlers} hovered={textHovered}/>}</group>
  {editable&&candidate&&!shownResult.valid&&result.error&&badge&&<Html center position={badge} occlude style={{pointerEvents:'none',width:200,background:'rgba(35,12,12,.94)',border:'1px solid #a34a4a',borderRadius:7,padding:7,color:'#fecaca',fontSize:11,lineHeight:1.4}}>Tady nelze text umístit. Posuňte jej nebo zmenšete písmo.</Html>}
 </>
}
