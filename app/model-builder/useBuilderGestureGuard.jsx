'use client'
import {useEffect} from 'react'
import {useThree} from '@react-three/fiber'
import * as THREE from 'three'

// Native Trackball listeners run before Fiber's bubbled mesh handlers. Disable
// them in capture phase, before a visible builder handle can start a gesture.
export function useBuilderGestureGuard(root, controlsRef, enabled=true) {
 const {camera,gl,scene}=useThree()
 useEffect(()=>{
  if(!enabled||!controlsRef)return
  const raycaster=new THREE.Raycaster(),pointer=new THREE.Vector2()
  let armed=null,frame=0
  const down=event=>{
   if(event.button!==0||!root.current)return
   const rect=gl.domElement.getBoundingClientRect()
   pointer.set((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1)
   scene.updateMatrixWorld(true);raycaster.setFromCamera(pointer,camera)
   const meshes=[]
   scene.traverseVisible(object=>{if(object.isMesh&&!object.isLine2&&!object.isLineSegments2)meshes.push(object)})
   const hit=raycaster.intersectObjects(meshes,false)[0]
   if(!hit)return
   let object=hit.object
   while(object&&object!==root.current)object=object.parent
   if(!object)return
   armed=controlsRef.current
   if(armed)armed.enabled=false
  }
  const up=()=>{
   const control=armed;armed=null
   cancelAnimationFrame(frame)
   frame=requestAnimationFrame(()=>{if(control&&controlsRef.current===control)control.enabled=true})
  }
  gl.domElement.addEventListener('pointerdown',down,true)
  window.addEventListener('pointerup',up,true)
  window.addEventListener('pointercancel',up,true)
  window.addEventListener('blur',up,true)
  return()=>{cancelAnimationFrame(frame);gl.domElement.removeEventListener('pointerdown',down,true);window.removeEventListener('pointerup',up,true);window.removeEventListener('pointercancel',up,true);window.removeEventListener('blur',up,true)}
 },[camera,gl,scene,root,controlsRef,enabled])
}
