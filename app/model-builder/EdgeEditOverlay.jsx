"use client"
import { useMemo, useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'

function EdgeLine({ points, color, closed = false }) {
  const geometry = useMemo(() => new THREE.BufferGeometry().setFromPoints((closed ? [...points, points[0]] : points).map(p=>new THREE.Vector3(...p))), [points, closed])
  useEffect(()=>()=>geometry.dispose(),[geometry])
  return <line geometry={geometry} raycast={()=>null} renderOrder={2000}><lineBasicMaterial color={color} depthTest={false} transparent opacity={0.85}/></line>
}
export function EdgeEditOverlay({ context, loops, selection, patch, onPick }) {
  const {camera,gl}=useThree()
  useEffect(()=>{
    if(!context?.sourceObject) return
    let down=null
    const start=e=>{if(e.button===0)down=[e.clientX,e.clientY]}
    const finish=e=>{
      if(!down) return
      const movement=Math.hypot(e.clientX-down[0],e.clientY-down[1]);down=null
      if(movement>4||e.button!==0||e.ctrlKey) return
      const box=gl.domElement.getBoundingClientRect(),ray=new THREE.Raycaster()
      ray.setFromCamera(new THREE.Vector2((e.clientX-box.left)/box.width*2-1,-(e.clientY-box.top)/box.height*2+1),camera)
      const hit=ray.intersectObject(context.sourceObject,true)[0]
      if(hit)onPick({point:hit.point,button:0,delta:0})
    }
    gl.domElement.addEventListener('pointerdown',start)
    gl.domElement.addEventListener('pointerup',finish)
    return()=>{gl.domElement.removeEventListener('pointerdown',start);gl.domElement.removeEventListener('pointerup',finish)}
  },[context,camera,gl,onPick])
  const geometry=useMemo(()=>{
    if(!patch) return null
    const g=new THREE.BufferGeometry()
    g.setAttribute('position',new THREE.Float32BufferAttribute(patch.triangles.flatMap(t=>t.flatMap(c=>c.sourcePos)),3))
    g.computeVertexNormals();return g
  },[patch])
  useEffect(()=>()=>geometry?.dispose(),[geometry])
  if(!context?.sourceObject) return null
  return <group matrix={context.sourceObject.matrix} matrixAutoUpdate={false}>
    {loops.map((loop,i)=><EdgeLine key={i} points={loop.points.map(p=>p.toArray())} color="#398b95" closed/>)}
    {selection.map((s,i)=><mesh key={i} position={loops[s.loop].boundary[s.index].position} raycast={()=>null} renderOrder={2001}><sphereGeometry args={[Math.max(0.18,context.diagonal*0.003),12,8]}/><meshBasicMaterial color={i?'#fbbf24':'#38bdf8'} depthTest={false}/></mesh>)}
    {patch&&<><mesh geometry={geometry} raycast={()=>null} renderOrder={1999}><meshStandardMaterial color="#49dbb1" side={THREE.DoubleSide} transparent opacity={0.8} polygonOffset polygonOffsetFactor={-2}/></mesh><EdgeLine points={patch.bridge} color="#a7f3d0"/><EdgeLine points={patch.arc} color="#fbbf24"/></>}
  </group>
}
