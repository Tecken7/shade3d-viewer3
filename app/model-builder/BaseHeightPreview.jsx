'use client'
import {useCallback,useEffect,useMemo,useRef,useState} from 'react'
import {Edges,Html,Line,useCursor} from '@react-three/drei'
import * as THREE from 'three'
import {useFrame} from '@react-three/fiber'
import {makeBaseGuideGeometry} from './base-guide-geometry.mjs'
import {baseGuideBlend} from './base-reveal.mjs'
import {useBuilderGestureGuard} from './useBuilderGestureGuard'
import {baseHeightGuideLayout,draggedBaseHeight} from './base-height-layout.mjs'

const noRaycast=()=>null
export default function BaseHeightPreview({data,height,min,max,flip,onChange,dragging,controlsRef,onDragEnd,busy=false,reveal=null,roughness=.42,metalness=.51}) {
  const root=useRef(),visual=useRef(),bodyMaterial=useRef(),opacityCache=useRef(new WeakMap()),active=useRef(null),[hovered,setHovered]=useState(false)
  useCursor(hovered,'ns-resize')
  useBuilderGestureGuard(root,controlsRef,!busy&&!reveal)
  const layout=baseHeightGuideLayout(data,height,flip)
  const geometry=useMemo(()=>makeBaseGuideGeometry(data.profile),[data])
  const colors=useMemo(()=>({blue:new THREE.Color('#3479dd'),model:new THREE.Color('#AAA08E')}),[])
  useFrame(()=>{
    const blend=baseGuideBlend(reveal?.progress.value||0)
    visual.current?.traverse(object=>{
      const materials=Array.isArray(object.material)?object.material:[object.material]
      for(const material of materials.filter(Boolean)){
        if(!opacityCache.current.has(material))opacityCache.current.set(material,material.opacity)
        material.transparent=true;material.opacity=opacityCache.current.get(material)*(1-blend)
      }
    })
    if(bodyMaterial.current){bodyMaterial.current.color.lerpColors(colors.blue,colors.model,blend);bodyMaterial.current.roughness=THREE.MathUtils.lerp(.3,roughness,blend);bodyMaterial.current.metalness=THREE.MathUtils.lerp(.28,metalness,blend)}
  })
  useEffect(()=>()=>geometry.dispose(),[geometry])
  const finish=useCallback(()=>{
    const gesture=active.current;if(!gesture)return
    active.current=null;setHovered(false)
    try{gesture.target.releasePointerCapture?.(gesture.pointerId)}catch{}
    if(controlsRef.current)controlsRef.current.enabled=false
    dragging(false);onDragEnd?.()
  },[controlsRef,dragging,onDragEnd])
  useEffect(()=>{
    window.addEventListener('pointerup',finish,true);window.addEventListener('pointercancel',finish,true);window.addEventListener('blur',finish,true)
    return()=>{window.removeEventListener('pointerup',finish,true);window.removeEventListener('pointercancel',finish,true);window.removeEventListener('blur',finish,true);finish()}
  },[finish])
  const rayAt=event=>{
    root.current.updateWorldMatrix(true,false)
    return event.ray.clone().applyMatrix4(root.current.matrixWorld.clone().invert())
  }
  const begin=event=>{
    if(event.button!==0||active.current||busy||reveal)return
    event.stopPropagation();event.nativeEvent?.preventDefault?.()
    const ray=rayAt(event),normal=ray.direction.clone();normal.y=0
    if(normal.lengthSq()<1e-5)return
    const plane=new THREE.Plane().setFromNormalAndCoplanarPoint(normal.normalize(),new THREE.Vector3(...layout.anchor))
    const hit=ray.intersectPlane(plane,new THREE.Vector3());if(!hit)return
    active.current={plane,startY:hit.y,height,direction:layout.direction,target:event.target,pointerId:event.pointerId}
    if(controlsRef.current)controlsRef.current.enabled=false
    dragging(true);event.target.setPointerCapture?.(event.pointerId)
  }
  const move=event=>{
    const gesture=active.current;if(!gesture)return
    event.stopPropagation()
    const hit=rayAt(event).intersectPlane(gesture.plane,new THREE.Vector3())
    if(hit)onChange(draggedBaseHeight(gesture.height,gesture.startY,hit.y,gesture.direction,min,max))
  }
  const handlers={onPointerDown:begin,onPointerMove:move,onPointerUp:finish,onPointerCancel:finish,
    onPointerOver:event=>{event.stopPropagation();setHovered(true)},onPointerOut:event=>{event.stopPropagation();if(!active.current)setHovered(false)}}
  return <group ref={visual}>
    <mesh geometry={geometry} position={[0,layout.y,0]} scale={[1,layout.direction,1]} raycast={noRaycast}>
      <meshStandardMaterial ref={bodyMaterial} color="#3479dd" roughness={.3} metalness={.28} transparent opacity={.65} depthWrite={false} side={THREE.DoubleSide}/>
      <Edges color="#93c5fd" threshold={25} raycast={noRaycast}/>
    </mesh>
    {data.points.filter((_,i)=>i%Math.max(1,Math.ceil(data.points.length/8))===0).map((p,i)=><Line key={i} points={[p,[p[0],layout.y,p[2]]]} color="#93c5fd" dashed dashSize={.6} gapSize={.5} transparent opacity={.25} lineWidth={1} raycast={noRaycast}/>)}
    <group ref={root} visible={!busy&&!reveal}>
      <group position={layout.anchor} rotation={layout.direction<0?[Math.PI,0,0]:[0,0,0]}>
        <mesh position={[0,2.5,0]} {...handlers}><cylinderGeometry args={[.35,.35,5,16]}/><meshBasicMaterial color={hovered?'#ffffff':'#93c5fd'} depthTest depthWrite/></mesh>
        <mesh position={[0,5.7,0]} {...handlers}><coneGeometry args={[1.05,2,24]}/><meshBasicMaterial color={hovered?'#ffffff':'#60a5fa'} depthTest depthWrite/></mesh>
      </group>
    </group>
    {!reveal&&<Html center occlude position={[layout.anchor[0],layout.y+layout.direction*8,layout.anchor[2]]} style={{pointerEvents:'none',whiteSpace:'nowrap',fontFamily:'Inter,system-ui,sans-serif',fontSize:11,color:'#eee',background:'#101010df',border:'1px solid #ffffff25',padding:'5px 8px',borderRadius:7}}><span>Celková výška {height.toLocaleString('cs-CZ',{maximumFractionDigits:2})} mm</span></Html>}
  </group>
}
