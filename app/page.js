'use client'

import {
  Canvas,
  useLoader,
  useFrame,
  extend,
} from '@react-three/fiber'
import {
  TrackballControls,
  Html,
} from '@react-three/drei'
import * as THREE from 'three'
import { Suspense, useRef, useState, useEffect } from 'react'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader'
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader'

extend({ TrackballControls })

function Model({ url, color, opacity, visible }) {
  const obj = useLoader(OBJLoader, url)
  const ref = useRef()

  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    transparent: true,
    opacity: opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
  })

  useEffect(() => {
    obj.traverse((child) => {
      if (child.isMesh) {
        child.material = material
      }
    })
  }, [opacity, color])

  useFrame(({ camera }) => {
    if (ref.current) {
      ref.current.children.sort((a, b) => {
        const aDist = camera.position.distanceTo(a.position)
        const bDist = camera.position.distanceTo(b.position)
        return bDist - aDist
      })
    }
  })

  return visible ? <group ref={ref}><primitive object={obj} /></group> : null
}

function Lights({ intensity, position1, position2 }) {
  return (
    <>
      <directionalLight
        position={position1}
        intensity={intensity}
        castShadow
      />
      <directionalLight
        position={position2}
        intensity={intensity * 0.6}
      />
    </>
  )
}

function Controls() {
  const ref = useRef()
  useFrame(() => ref.current?.update())
  return <trackballControls ref={ref} args={[null, document]} panSpeed={30} />
}

export default function Page() {
  const [colorUpper, setColorUpper] = useState('#f5f5dc')
  const [colorLower, setColorLower] = useState('#f5f5dc')
  const [colorCrown, setColorCrown] = useState('#ffffff')

  const [opacityUpper, setOpacityUpper] = useState(1)
  const [opacityLower, setOpacityLower] = useState(1)
  const [opacityCrown, setOpacityCrown] = useState(1)

  const [visibleUpper, setVisibleUpper] = useState(true)
  const [visibleLower, setVisibleLower] = useState(true)
  const [visibleCrown, setVisibleCrown] = useState(true)

  const [lightIntensity, setLightIntensity] = useState(1)
  const [light1Position, setLight1Position] = useState([10, 10, 10])
  const [light2Position, setLight2Position] = useState([-10, -10, -10])

  const [showLightControls, setShowLightControls] = useState(false)
  const [loadingProgress, setLoadingProgress] = useState(0)

  return (
    <>
      <div style={{ position: 'absolute', top: 10, left: 10, zIndex: 1 }}>
        <label>Upper:</label>
        <input type="color" value={colorUpper} onChange={(e) => setColorUpper(e.target.value)} />
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={opacityUpper}
          onChange={(e) => setOpacityUpper(parseFloat(e.target.value))}
        />
        <button onClick={() => setVisibleUpper(!visibleUpper)}>
          {visibleUpper ? '👁️' : '🚫'}
        </button>
        <br />
        <label>Lower:</label>
        <input type="color" value={colorLower} onChange={(e) => setColorLower(e.target.value)} />
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={opacityLower}
          onChange={(e) => setOpacityLower(parseFloat(e.target.value))}
        />
        <button onClick={() => setVisibleLower(!visibleLower)}>
          {visibleLower ? '👁️' : '🚫'}
        </button>
        <br />
        <label>Crown21:</label>
        <input type="color" value={colorCrown} onChange={(e) => setColorCrown(e.target.value)} />
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={opacityCrown}
          onChange={(e) => setOpacityCrown(parseFloat(e.target.value))}
        />
        <button onClick={() => setVisibleCrown(!visibleCrown)}>
          {visibleCrown ? '👁️' : '🚫'}
        </button>
        <br />
        <label>💡 Light Intensity:</label>
        <input
          type="range"
          min={0}
          max={5}
          step={0.1}
          value={lightIntensity}
          onChange={(e) => setLightIntensity(parseFloat(e.target.value))}
        />
        <br />
        <label>
          <input
            type="checkbox"
            checked={showLightControls}
            onChange={() => setShowLightControls(!showLightControls)}
          />
          Světla
        </label>
        {showLightControls && (
          <div>
            <p>🔦 Light 1 Position:</p>
            {['X', 'Y', 'Z'].map((axis, i) => (
              <div key={`l1-${axis}`}>
                {axis}:
                <input
                  type="range"
                  min={-20}
                  max={20}
                  step={0.1}
                  value={light1Position[i]}
                  onChange={(e) =>
                    setLight1Position((prev) => {
                      const newPos = [...prev]
                      newPos[i] = parseFloat(e.target.value)
                      return newPos
                    })
                  }
                />
              </div>
            ))}
            <p>🔦 Light 2 Position:</p>
            {['X', 'Y', 'Z'].map((axis, i) => (
              <div key={`l2-${axis}`}>
                {axis}:
                <input
                  type="range"
                  min={-20}
                  max={20}
                  step={0.1}
                  value={light2Position[i]}
                  onChange={(e) =>
                    setLight2Position((prev) => {
                      const newPos = [...prev]
                      newPos[i] = parseFloat(e.target.value)
                      return newPos
                    })
                  }
                />
              </div>
            ))}
          </div>
        )}
      </div>
      <Canvas
        camera={{ position: [0, 0, 50], fov: 30 }}
        onCreated={({ gl }) => {
          gl.setClearColor(new THREE.Color('#000000'))
        }}
      >
        <Suspense fallback={<Html center><progress value={loadingProgress} max={100} /></Html>}>
          <Lights
            intensity={lightIntensity}
            position1={light1Position}
            position2={light2Position}
          />
          <Model
            url="/models/Upper.obj"
            color={colorUpper}
            opacity={opacityUpper}
            visible={visibleUpper}
            setLoadingProgress={setLoadingProgress}
          />
          <Model
            url="/models/Lower.obj"
            color={colorLower}
            opacity={opacityLower}
            visible={visibleLower}
            setLoadingProgress={setLoadingProgress}
          />
          <Model
            url="/models/Crown21.obj"
            color={colorCrown}
            opacity={opacityCrown}
            visible={visibleCrown}
            setLoadingProgress={setLoadingProgress}
          />
        </Suspense>
        <ambientLight intensity={0.2} />
        <Controls />
      </Canvas>
    </>
  )
}
