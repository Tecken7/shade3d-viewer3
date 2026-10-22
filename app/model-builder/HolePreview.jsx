'use client'
import React, { useEffect, useRef } from 'react'
import { Edges, Line } from '@react-three/drei'
import * as THREE from 'three'
import { nearestContourPosition, holeDirection } from './hole-placement.mjs'

export function HolePreview({ options, selected, select, change, dragging, controlsRef }) {
  const root = useRef(), active = useRef(null)
  useEffect(() => () => {
    if (active.current) {
      if (controlsRef.current) controlsRef.current.enabled = true
      dragging(false)
    }
  }, [controlsRef, dragging])
  const contour = options.bottomContour
  if (!contour?.length || options.cutHoles) return null
  const localHit = (event, y) => {
    root.current.updateWorldMatrix(true, false)
    const ray = event.ray.clone().applyMatrix4(root.current.matrixWorld.clone().invert())
    return ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), new THREE.Vector3())
  }
  const stop = event => {
    if (!active.current) return
    event.stopPropagation()
    event.target.releasePointerCapture?.(event.pointerId)
    active.current = null
    if (controlsRef.current) controlsRef.current.enabled = true
    dragging(false)
  }
  return <group ref={root}>
    <Line points={[...contour, contour[0]]} color="#60a5fa" transparent opacity={0.35} lineWidth={1} depthTest={false} />
    {options.holes.map((hole, index) => {
      if (!hole.enabled || !hole.position) return null
      const normal = new THREE.Vector3().fromArray(holeDirection(contour,hole.position,options.holeYaw ?? 0))
      const center = new THREE.Vector3().fromArray(hole.position).addScaledVector(normal, (1 - hole.length) / 2)
      const rotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal.clone().negate())
      return <mesh key={index} position={center} quaternion={rotation} renderOrder={80}
        onPointerDown={event => {
          if (event.button !== 0) return
          event.stopPropagation()
          const hit = localHit(event, hole.baseY)
          if (!hit) return
          active.current = { index, offset: new THREE.Vector3().fromArray(hole.position).sub(hit) }
          select(`hole:${index}`)
          if (controlsRef.current) controlsRef.current.enabled = false
          dragging(true)
          event.target.setPointerCapture?.(event.pointerId)
        }}
        onPointerMove={event => {
          if (active.current?.index !== index) return
          event.stopPropagation()
          const hit = localHit(event, hole.baseY)
          if (!hit) return
          const position = nearestContourPosition(contour, hit.add(active.current.offset).toArray()).position
          change({ holes: options.holes.map((item, i) => i === index ? { ...item, position, autoPosition: false, warning: null } : item) })
        }} onPointerUp={stop} onPointerCancel={stop}>
        <cylinderGeometry args={[hole.diameter / 2, hole.diameter / 2, hole.length + 1, 48]} />
        <meshBasicMaterial color={selected === `hole:${index}` ? '#60a5fa' : '#2563eb'} transparent opacity={0.48} depthTest={false} depthWrite={false} />
        <Edges color="#93c5fd" threshold={20} raycast={() => null} />
      </mesh>
    })}
  </group>
}
