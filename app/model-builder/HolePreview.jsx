'use client'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Edges, Line, useCursor } from '@react-three/drei'
import * as THREE from 'three'
import { nearestContourPosition, holeDirection } from './hole-placement.mjs'

const clamp=value=>Math.round(Math.max(.5,Math.min(50,value))*100)/100
export function HolePreview({ options, selected, select, change, dragging, controlsRef, onDragEnd }) {
  const root=useRef(),active=useRef(null)
  const [hovered,setHovered]=useState(null)
  useCursor(hovered!==null,'grab')
  const hover=(event,key)=>{event.stopPropagation();setHovered(key)}
  const unhover=(event,key)=>{event.stopPropagation();setHovered(previous=>previous===key?null:previous)}
  const finish=useCallback(event=>{
    const gesture=active.current
    if(!gesture)return
    active.current=null
    event?.stopPropagation?.();event?.stopImmediatePropagation?.()
    try{gesture.target.releasePointerCapture?.(gesture.pointerId)}catch{}
    if(controlsRef.current)controlsRef.current.enabled=true
    dragging(false);onDragEnd?.()
  },[controlsRef,dragging,onDragEnd])
  useEffect(()=>{
    window.addEventListener('pointerup',finish,true)
    window.addEventListener('pointercancel',finish,true)
    window.addEventListener('blur',finish,true)
    return()=>{
      window.removeEventListener('pointerup',finish,true)
      window.removeEventListener('pointercancel',finish,true)
      window.removeEventListener('blur',finish,true)
      if(active.current)finish()
    }
  },[finish])
  const contour=options.bottomContour
  if(!contour?.length||options.cutHoles)return null
  const localRay=event=>{
    root.current.updateWorldMatrix(true,false)
    return event.ray.clone().applyMatrix4(root.current.matrixWorld.clone().invert())
  }
  const begin=(event,index,side,hole,normal)=>{
    if(event.button!==0)return
    event.stopPropagation();event.nativeEvent?.preventDefault?.();event.nativeEvent?.stopImmediatePropagation?.()
    const ray=localRay(event),anchor=new THREE.Vector3().fromArray(hole.position)
    const planeNormal=side==='body'?new THREE.Vector3(0,1,0):ray.direction.clone().addScaledVector(normal,-ray.direction.dot(normal)).normalize()
    if(planeNormal.lengthSq()<.1)return
    const plane=new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal,anchor),hit=ray.intersectPlane(plane,new THREE.Vector3())
    if(!hit)return
    active.current={index,side,plane,anchor,normal,offset:anchor.clone().sub(hit),start:hit.dot(normal),length:hole.length,outer:hole.outerLength??hole.length,target:event.target,pointerId:event.pointerId}
    select(`hole:${index}`)
    if(controlsRef.current)controlsRef.current.enabled=false
    dragging(true);event.target.setPointerCapture?.(event.pointerId)
  }
  const move=event=>{
    const gesture=active.current;if(!gesture)return
    event.stopPropagation()
    const hit=localRay(event).intersectPlane(gesture.plane,new THREE.Vector3());if(!hit)return
    let patch
    if(gesture.side==='body')patch={position:nearestContourPosition(contour,hit.add(gesture.offset).toArray()).position}
    else{
      const delta=hit.dot(gesture.normal)-gesture.start
      patch=gesture.side==='outer'?{outerLength:clamp(gesture.outer+delta)}:{length:clamp(gesture.length-delta),autoDepth:false}
    }
    change({holes:options.holes.map((hole,i)=>i===gesture.index?{...hole,...patch,autoPosition:false,warning:null}:hole)})
  }
  return <group ref={root}>
    <Line points={[...contour,contour[0]]} color="#60a5fa" transparent opacity={.35} lineWidth={1} depthTest depthWrite={false}/>
    {options.holes.map((hole,index)=>{
      if(!hole.enabled||!hole.position)return null
      const normal=new THREE.Vector3().fromArray(holeDirection(contour,hole.position,options.holeYaw??0)),outer=hole.outerLength??hole.length
      const anchor=new THREE.Vector3().fromArray(hole.position),center=anchor.clone().addScaledVector(normal,(outer-hole.length)/2)
      const rotation=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),normal.clone().negate())
      return <group key={index}>
        <mesh position={center} quaternion={rotation} renderOrder={80} onPointerOver={e=>hover(e,`${index}:body`)} onPointerOut={e=>unhover(e,`${index}:body`)} onPointerDown={e=>begin(e,index,'body',hole,normal)} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish}>
          <cylinderGeometry args={[hole.diameter/2,hole.diameter/2,hole.length+outer,48]}/>
          <meshBasicMaterial color={hovered===`${index}:body`?'#93c5fd':selected===`hole:${index}`?'#60a5fa':'#2563eb'} depthTest depthWrite/>
          <Edges color="#93c5fd" threshold={20} raycast={()=>null}/>
        </mesh>
        {[['outer',outer,1],['inner',hole.length,-1]].map(([side,length,sign])=>{
          const endpoint=anchor.clone().addScaledVector(normal,sign*(length+.8)),axis=normal.clone().multiplyScalar(sign)
          const quaternion=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),axis)
          const key=`${index}:${side}`,lit=hovered===key
          return <group key={side} position={endpoint} quaternion={quaternion} scale={lit?1.18:1}>
            <mesh renderOrder={82} onPointerOver={e=>hover(e,key)} onPointerOut={e=>unhover(e,key)} onPointerDown={e=>begin(e,index,side,hole,normal)} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish}>
              <coneGeometry args={[.65,1.6,16]}/><meshBasicMaterial color={lit?'#ffffff':'#bfdbfe'} depthTest depthWrite/>
            </mesh>
            <mesh position={[0,-1,0]} renderOrder={81} onPointerOver={e=>hover(e,key)} onPointerOut={e=>unhover(e,key)} onPointerDown={e=>begin(e,index,side,hole,normal)} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish}>
              <cylinderGeometry args={[.18,.18,1.2,12]}/><meshBasicMaterial color={lit?'#ffffff':'#93c5fd'} depthTest depthWrite/>
            </mesh>
          </group>
        })}
      </group>
    })}
  </group>
}
