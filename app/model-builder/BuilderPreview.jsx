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
import {useTextProjection} from './useTextProjection'


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
export function BuilderPreview({textSurfaceGeometry=null,showTextPreview=true,roughness=.42,metalness=.51,geometry,placing,onSurfaceClick,overlayDragging=false,options,select,change,dragging,controlsRef,onDragEnd,editable=true,onTextStatus,reveal=null,onRevealComplete}){
 const mesh=useRef(),textRoot=useRef(),textDrag=useRef(null),placementRequest=useRef(false)
 const [textHovered,setTextHovered]=useState(false),[candidate,setCandidate]=useState(null),[notice,setNotice]=useState(''),[font,setFont]=useState(null)
 useCursor(textHovered,'grab')
 useBuilderGestureGuard(textRoot,controlsRef,editable&&!placing)
 const {camera,gl}=useThree()
 useEffect(()=>{
  let live=true
  fontRequest??=fetch('/wasm/model-builder/inter-font.json').then(r=>{if(!r.ok)throw new Error('font');return r.json()}).then(data=>new FontLoader().parse(data)).catch(()=>{fontRequest=null;return null})
  fontRequest.then(value=>{if(live)setFont(value)})
  return()=>{live=false}
 },[])
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
 useEffect(()=>{project(placement)},[project,placement,font,textSurface,options?.text,options?.textSize,options?.textDepth,options?.textRotation,options?.textMode,options?.baseDirection,editable,showTextPreview])
 const error=notice||result.error
 useEffect(()=>{onTextStatus?.({valid:!pending&&!!result.valid,error:pending?'Přizpůsobuji text povrchu…':error})},[pending,result.valid,error,onTextStatus])
 useEffect(()=>{if(overlayDragging&&!textDrag.current)setTextHovered(false)},[overlayDragging])
 useEffect(()=>{placementRequest.current=false;setNotice('')},[options?.text,options?.textSize,options?.textDepth,options?.textRotation,options?.textMode,font])
 const finishText=useCallback(()=>{
  const gesture=textDrag.current;if(!gesture)return
  textDrag.current=null;setTextHovered(false)
  if(gesture.nextPoint){
   const point=gesture.nextPoint;setCandidate(point)
   project(point,check=>{if(check.valid){change?.({textPosition:point.position,textNormal:point.normal});setCandidate(null)}else setNotice(check.error)})
  }
  try{gesture.target.releasePointerCapture?.(gesture.pointerId)}catch{}
  if(controlsRef?.current)controlsRef.current.enabled=false
  dragging?.(false);onDragEnd?.()
 },[controlsRef,dragging,onDragEnd,project,change])
 const finishRef=useRef(finishText);finishRef.current=finishText
 useEffect(()=>{
  const finish=()=>finishRef.current()
  window.addEventListener('pointerup',finish,true);window.addEventListener('pointercancel',finish,true);window.addEventListener('blur',finish,true)
  return()=>{window.removeEventListener('pointerup',finish,true);window.removeEventListener('pointercancel',finish,true);window.removeEventListener('blur',finish,true)}
 },[])
 const textHandlers={
  onPointerOver:event=>{event.stopPropagation();if(!textDrag.current&&!overlayDragging)setTextHovered(true)},
  onPointerOut:event=>{event.stopPropagation();if(!textDrag.current)setTextHovered(false)},
  onPointerDown:event=>{
   if(event.button!==0||!editable||placing||overlayDragging||pending||!change||!committed)return
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
   gesture.nextPoint=point;setNotice('');project(point)
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
   if(event.buttons||placementRequest.current)return
   cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{
    const hit=hitAt(event)
    if(!hit){setCandidate(null);return}
    const point=pointAt(hit)
    setNotice('');setCandidate(point)
   })
  }
  const leave=()=>{if(!placementRequest.current)setCandidate(null)}
  const pick=event=>{
   if(event.button!==0||placementRequest.current)return
   cancelAnimationFrame(frame);const hit=hitAt(event);if(!hit)return
   event.preventDefault();event.stopPropagation()
   const point=pointAt(hit);setCandidate(point)
   placementRequest.current=true
   project(point,check=>{placementRequest.current=false;if(check.valid){onSurfaceClick?.({...hit,stopPropagation(){}});setCandidate(null)}else setNotice(check.error)})
  }
  gl.domElement.addEventListener('pointerdown',pick,true);gl.domElement.addEventListener('pointermove',move,true);gl.domElement.addEventListener('pointerleave',leave)
  return()=>{cancelAnimationFrame(frame);gl.domElement.removeEventListener('pointerdown',pick,true);gl.domElement.removeEventListener('pointermove',move,true);gl.domElement.removeEventListener('pointerleave',leave)}
 },[editable,placing,display,gl,camera,onSurfaceClick,project])
 if(!display)return null
 const blockHidden=event=>{if(!overlayDragging)event.stopPropagation()}
 const proposal=result.point||placement
 const badge=proposal?new THREE.Vector3(...proposal.position).addScaledVector(new THREE.Vector3(...proposal.normal),1.5).toArray():null
 return <>
  <mesh ref={mesh} geometry={display} dispose={null} renderOrder={50} onPointerOver={blockHidden} onPointerMove={blockHidden} onPointerDown={blockHidden} onClick={event=>{blockHidden(event);if(editable&&!placing&&!overlayDragging&&event.delta<=4)select(null)}}>
   <meshStandardMaterial onBeforeCompile={compileReveal} customProgramCacheKey={()=>"builder-base-reveal-v2"} color="#AAA08E" roughness={roughness} metalness={metalness} side={THREE.DoubleSide}/>
  </mesh>
  <group ref={textRoot}>{editable&&showTextPreview&&options&&<TextShape result={result} handlers={textHandlers} hovered={textHovered}/>}</group>
  {editable&&candidate&&!result.valid&&result.error&&badge&&<Html center position={badge} occlude style={{pointerEvents:'none',width:200,background:'rgba(35,12,12,.94)',border:'1px solid #a34a4a',borderRadius:7,padding:7,color:'#fecaca',fontSize:11,lineHeight:1.4}}>Tady nelze text umístit. Posuňte jej nebo zmenšete písmo.</Html>}
 </>
}
