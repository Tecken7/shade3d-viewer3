'use client'
import React, { useEffect, useMemo, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { MeshBVH } from 'three-mesh-bvh'

export function BuilderPreview({ geometry, placing, onSurfaceClick }) {
  const mesh = useRef()
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
  useEffect(() => {
    if (!placing || !display) return
    const raycaster = new THREE.Raycaster()
    raycaster.firstHitOnly = true
    const pointer = new THREE.Vector2()
    const pick = event => {
      if (event.button !== 0 || !mesh.current) return
      const rect = gl.domElement.getBoundingClientRect()
      pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1)
      mesh.current.updateWorldMatrix(true, false)
      raycaster.setFromCamera(pointer, camera)
      const hit = raycaster.intersectObject(mesh.current, false)[0]
      if (!hit) return
      event.preventDefault()
      event.stopPropagation()
      onSurfaceClick?.({ ...hit, stopPropagation() {} })
    }
    gl.domElement.addEventListener('pointerdown', pick, true)
    return () => gl.domElement.removeEventListener('pointerdown', pick, true)
  }, [placing, display, gl, camera, onSurfaceClick])
  if (!display) return null
  return <mesh ref={mesh} geometry={display} dispose={null} renderOrder={50}>
    <meshStandardMaterial color="#AAA08E" roughness={0.55} metalness={0} side={THREE.DoubleSide} />
  </mesh>
}
