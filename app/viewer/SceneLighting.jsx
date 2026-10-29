'use client'
import {useRef} from 'react'
import {useFrame,useThree} from '@react-three/fiber'
import * as THREE from 'three'
import {DEFAULT_LIGHTING} from './scene-lighting.mjs'

export default function SceneLighting({value=DEFAULT_LIGHTING,intensity=1,highlightIntensity=1,headlight={enabled:true,intensity:2}}){
 const {camera}=useThree(),light=useRef(),brightness=intensity*value.brightness,soft=.65+value.softness,detail=1.35-value.softness
 useFrame(()=>{if(light.current)light.current.position.copy(camera.position)})
 return <>
  <ambientLight intensity={.35*brightness*soft}/>
  <group rotation={[0,THREE.MathUtils.degToRad(value.azimuth),0]}>
   <directionalLight position={[0,Math.sin(THREE.MathUtils.degToRad(value.elevation))*7,Math.cos(THREE.MathUtils.degToRad(value.elevation))*7]} intensity={1.2*brightness*detail}/>
   <directionalLight position={[-10,0,0]} intensity={.9*brightness*soft}/>
   <directionalLight position={[10,0,0]} intensity={brightness*soft}/>
   <directionalLight position={[0,-5,-5]} intensity={.7*brightness*soft}/>
  </group>
  <pointLight ref={light} color="#ffffff" intensity={headlight.enabled?headlight.intensity*highlightIntensity*value.brightness*detail:0} distance={0} decay={0}/>
 </>
}
