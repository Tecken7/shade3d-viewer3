'use client'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { MeshBVH } from 'three-mesh-bvh'
import { FontLoader } from 'three/examples/jsm/loaders/FontLoader.js'
import { TextGeometry } from 'three/examples/jsm/geometries/TextGeometry.js'
import { useCursor } from '@react-three/drei'
import { useBuilderGestureGuard } from './useBuilderGestureGuard'

let fontRequest
function TextPreview({ options, placement, surface, handlers, hovered }) {
  const [font,setFont]=useState(null)
  useEffect(()=>{
    let live=true
    fontRequest ??= fetch('/wasm/model-builder/font.json').then(response=>{if(!response.ok)throw new Error('font');return response.json()}).then(data=>new FontLoader().parse(data)).catch(()=>{fontRequest=null;return null})
    fontRequest.then(value=>{if(live)setFont(value)})
    return()=>{live=false}
  },[])
  const geometry=useMemo(()=>{
    if(!font||!placement||!options.text?.trim()||!surface?.boundsTree)return null
    if([...options.text].some(char=>!font.data.glyphs[char]))return null
    const text=new TextGeometry(options.text.slice(0,60),{font,size:options.textSize,depth:Math.max(.08,options.textDepth),curveSegments:5,bevelEnabled:false})
    text.computeBoundingBox()
    text.translate(-(text.boundingBox.min.x+text.boundingBox.max.x)/2,-(text.boundingBox.min.y+text.boundingBox.max.y)/2,.04)
    const n=new THREE.Vector3(...placement.normal).normalize(),up=new THREE.Vector3(0,-(options.baseDirection??options.holes?.[0]?.baseDirection??1),0)
    const right=new THREE.Vector3().crossVectors(up,n).normalize();up.crossVectors(n,right).normalize()
    const anchor=new THREE.Vector3(...placement.position),angle=(options.textRotation??0)*Math.PI/180,co=Math.cos(angle),si=Math.sin(angle)
    const ray=new THREE.Ray(),v=new THREE.Vector3(),plane=new THREE.Vector3(),attr=text.attributes.position,projected=new Map()
    for(let i=0;i<attr.count;i++){
      v.fromBufferAttribute(attr,i)
      plane.copy(anchor).addScaledVector(right,co*v.x-si*v.y).addScaledVector(up,si*v.x+co*v.y)
      const key=`${v.x}:${v.y}`
      let point=projected.get(key)
      if(!point){
        ray.origin.copy(plane).addScaledVector(n,15);ray.direction.copy(n).negate()
        const hits=surface.boundsTree.raycast(ray,THREE.DoubleSide).filter(hit=>hit.face.normal.dot(n)>.25)
        hits.sort((a,b)=>a.point.distanceToSquared(plane)-b.point.distanceToSquared(plane))
        if(!hits[0]||hits[0].point.distanceTo(plane)>8){text.dispose();return null}
        point=hits[0].point;projected.set(key,point)
      }
      plane.copy(point).addScaledVector(n,v.z)
      attr.setXYZ(i,plane.x,plane.y,plane.z)
    }
    text.computeVertexNormals();text.computeBoundingBox();text.computeBoundingSphere();return text
  },[font,options.text,options.textSize,options.textDepth,options.textRotation,options.baseDirection,options.holes,placement,surface])
  useEffect(()=>()=>geometry?.dispose(),[geometry])
  if(!geometry)return null
  const center=geometry.boundingBox.getCenter(new THREE.Vector3()),size=geometry.boundingBox.getSize(new THREE.Vector3()).addScalar(.15)
  return <group {...handlers}>
    <mesh geometry={geometry} dispose={null}><meshBasicMaterial color={hovered?'#93c5fd':'#60a5fa'} depthTest depthWrite /></mesh>
    <mesh position={center}><boxGeometry args={size.toArray()}/><meshBasicMaterial colorWrite={false} depthWrite={false} depthTest /></mesh>
  </group>
}

export function BuilderPreview({ geometry, placing, onSurfaceClick, overlayDragging=false, options, selected, select, change, dragging, controlsRef, onDragEnd, editable=true }) {
  const mesh = useRef()
  const textRoot=useRef(),textDrag=useRef(null)
  const [textHovered,setTextHovered]=useState(false)
  useCursor(textHovered,'grab')
  useBuilderGestureGuard(textRoot,controlsRef,editable&&!placing)
  useEffect(()=>{if(overlayDragging&&!textDrag.current)setTextHovered(false)},[overlayDragging])
  const [hoverPlacement,setHoverPlacement]=useState(null)
  const { camera, gl } = useThree()
  const display = useMemo(() => {
    if (!geometry) return null
    // Blender-style Auto Smooth: blend small surface facets, preserve the
    // deliberate 45-degree bevel boundary, text and the rims of drain cuts.
    const result = toCreasedNormals(geometry, Math.PI / 6)
    result.boundsTree = new MeshBVH(result)
    return result
  }, [geometry])
  useEffect(() => () => { display?.dispose(); if (display) display.boundsTree = null }, [display])
  const finishText=useCallback(()=>{
    const gesture=textDrag.current;if(!gesture)return
    textDrag.current=null;setTextHovered(false)
    try{gesture.target.releasePointerCapture?.(gesture.pointerId)}catch{}
    if(controlsRef?.current)controlsRef.current.enabled=false
    dragging?.(false);onDragEnd?.()
  },[controlsRef,dragging,onDragEnd])
  useEffect(()=>{
    window.addEventListener('pointerup',finishText,true);window.addEventListener('pointercancel',finishText,true);window.addEventListener('blur',finishText,true)
    return()=>{window.removeEventListener('pointerup',finishText,true);window.removeEventListener('pointercancel',finishText,true);window.removeEventListener('blur',finishText,true);finishText()}
  },[finishText])
  const textHandlers={
    onPointerOver:event=>{event.stopPropagation();if(!textDrag.current&&!overlayDragging)setTextHovered(true)},
    onPointerOut:event=>{event.stopPropagation();if(!textDrag.current)setTextHovered(false)},
    onPointerDown:event=>{
      if(event.button!==0||!editable||placing||overlayDragging||!change||!options.textPosition)return
      event.stopPropagation()
      const offset=new THREE.Vector3(...options.textPosition).sub(mesh.current.worldToLocal(event.point.clone())),n=new THREE.Vector3(...options.textNormal).normalize()
      offset.addScaledVector(n,-offset.dot(n))
      textDrag.current={offset,target:event.target,pointerId:event.pointerId}
      select?.('text')
      if(controlsRef?.current)controlsRef.current.enabled=false
      dragging?.(true);event.target.setPointerCapture?.(event.pointerId)
    },
    onPointerMove:event=>{
      const gesture=textDrag.current;if(!gesture)return
      event.stopPropagation()
      mesh.current.updateWorldMatrix(true,false)
      const ray=event.ray.clone().applyMatrix4(mesh.current.matrixWorld.clone().invert()),hit=display.boundsTree.raycastFirst(ray,THREE.DoubleSide)
      if(!hit||Math.abs(hit.face.normal.y)>.8)return
      const closest=display.boundsTree.closestPointToPoint(hit.point.clone().add(gesture.offset))
      if(closest)change({textPosition:closest.point.toArray(),textNormal:hit.face.normal.toArray()})
    },
    onPointerUp:finishText,onPointerCancel:finishText,
  }
  useEffect(() => {
    if (!editable || !placing || !display) return
    const raycaster = new THREE.Raycaster()
    raycaster.firstHitOnly = true
    const pointer = new THREE.Vector2()
    let frame=0
    const hitAt = event => {
      if (!mesh.current) return null
      const rect = gl.domElement.getBoundingClientRect()
      pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1)
      mesh.current.updateWorldMatrix(true, false)
      raycaster.setFromCamera(pointer, camera)
      return raycaster.intersectObject(mesh.current, false)[0]
    }
    const move=event=>{
      if(event.buttons)return
      cancelAnimationFrame(frame)
      frame=requestAnimationFrame(()=>{
        const hit=hitAt(event)
        setHoverPlacement(hit&&Math.abs(hit.face.normal.y)<=.8?{position:mesh.current.worldToLocal(hit.point.clone()).toArray(),normal:hit.face.normal.toArray()}:null)
      })
    }
    const leave=()=>setHoverPlacement(null)
    const pick = event => {
      if(event.button!==0)return
      const hit=hitAt(event)
      if (!hit) return
      event.preventDefault()
      event.stopPropagation()
      onSurfaceClick?.({ ...hit, stopPropagation() {} })
    }
    gl.domElement.addEventListener('pointerdown', pick, true)
    gl.domElement.addEventListener('pointermove',move,true)
    gl.domElement.addEventListener('pointerleave',leave)
    return () => {cancelAnimationFrame(frame);gl.domElement.removeEventListener('pointerdown', pick, true);gl.domElement.removeEventListener('pointermove',move,true);gl.domElement.removeEventListener('pointerleave',leave)}
  }, [editable, placing, display, gl, camera, onSurfaceClick])
  if (!display) return null
  const blockHidden = event => { if (!overlayDragging) event.stopPropagation() }
  const textPlacement=placing?hoverPlacement:options?.textPosition&&options?.textNormal?{position:options.textPosition,normal:options.textNormal}:null
  return <><mesh ref={mesh} geometry={display} dispose={null} renderOrder={50}
    onPointerOver={blockHidden} onPointerMove={blockHidden} onPointerDown={blockHidden} onClick={blockHidden}>
    <meshStandardMaterial color="#AAA08E" roughness={0.55} metalness={0} side={THREE.DoubleSide} />
  </mesh><group ref={textRoot}>{editable&&options&&<TextPreview options={options} placement={textPlacement} surface={display} handlers={textHandlers} hovered={textHovered}/>}</group></>
}
