'use client'

import { Canvas, useLoader, useThree, useFrame } from '@react-three/fiber'
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader'
import * as THREE from 'three'
import { Suspense, useEffect, useRef, useState } from 'react'
import { Html, useProgress } from '@react-three/drei'

function Model({ url, color, opacity, visible, onLoaded }) {
  const obj = useLoader(OBJLoader, url)

  useEffect(() => {
    if (obj && onLoaded) onLoaded(obj)
  }, [obj, onLoaded])

  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    transparent: opacity < 1,
    opacity,
    metalness: 0.5,
    roughness: 0.5,
    side: THREE.DoubleSide,
    depthWrite: opacity === 1,
  })

  obj.traverse((child) => {
    if (child.isMesh) child.material = material
  })

  return visible ? <primitive object={obj} /> : null
}

function TouchTrackballControls() {
  const { camera, gl } = useThree()
  const controlsRef = useRef(null)

  useEffect(() => {
    const controls = new TrackballControls(camera, gl.domElement)
    controls.rotateSpeed = 5.0
    controls.zoomSpeed = 1.2
    controls.panSpeed = 1.0
    controls.staticMoving = true
    controlsRef.current = controls

    const handleTouchStart = (event) => {
      event.preventDefault()
      controls.handleTouchStart(event)
    }
    const handleTouchMove = (event) => {
      event.preventDefault()
      controls.handleTouchMove(event)
    }

    gl.domElement.addEventListener('touchstart', handleTouchStart, { passive: false })
    gl.domElement.addEventListener('touchmove', handleTouchMove, { passive: false })

    return () => {
      gl.domElement.removeEventListener('touchstart', handleTouchStart)
      gl.domElement.removeEventListener('touchmove', handleTouchMove)
      controls.dispose()
    }
  }, [camera, gl])

  useFrame(() => {
    if (controlsRef.current && camera.isOrthographicCamera) {
      controlsRef.current.panSpeed = camera.zoom * 0.4
      controlsRef.current.update()
    }
  })

  return null
}

function Loader() {
  const { progress } = useProgress()
  return (
    <Html center>
      <div
        style={{
          background: 'rgba(0,0,0,0.7)',
          padding: '20px 40px',
          borderRadius: '10px',
          color: 'white',
          fontFamily: 'sans-serif',
          fontSize: '18px',
        }}
      >
        ⏳ Načítání modelů: {Math.round(progress)} %
      </div>
    </Html>
  )
}

/** Auto-fit kamery jednou po načtení všech objektů. */
function FitCameraOnLoad({
  objects,
  expectedCount = 3,
  margin = 1.2,
  isMobile = false,
  desktopScale = 0.40,
  mobileScale = 1.0,
}) {
  const { camera, size } = useThree()
  const fitted = useRef(false)

  useEffect(() => {
    if (fitted.current) return
    if (!objects || objects.length < expectedCount) return

    const box = new THREE.Box3()
    objects.forEach((obj) => box.expandByObject(obj))
    if (box.isEmpty()) return

    const center = new THREE.Vector3()
    const dims = new THREE.Vector3()
    box.getCenter(center)
    box.getSize(dims)

    camera.position.set(center.x, center.y, camera.position.z)

    const objW = Math.max(dims.x, 1e-6)
    const objH = Math.max(dims.y, 1e-6)
    const zoomX = size.width / (objW * margin)
    const zoomY = size.height / (objH * margin)
    let newZoom = Math.min(zoomX, zoomY)

    newZoom *= isMobile ? mobileScale : desktopScale
    camera.zoom = Math.max(newZoom, 0.01)
    camera.updateProjectionMatrix()

    fitted.current = true
  }, [objects, expectedCount, margin, isMobile, desktopScale, mobileScale, camera, size.width, size.height])

  return null
}

export default function Page() {
  const [color1, setColor1] = useState('#f5f5dc')
  const [color2, setColor2] = useState('#f5f5dc')
  const [color3, setColor3] = useState('#ffffff')
  const [opacity1, setOpacity1] = useState(1)
  const [opacity2, setOpacity2] = useState(1)
  const [opacity3, setOpacity3] = useState(1)
  const [visible1, setVisible1] = useState(true)
  const [visible2, setVisible2] = useState(true)
  const [visible3, setVisible3] = useState(true)
  const [lightIntensity, setLightIntensity] = useState(1)
  const [lightPos1, setLightPos1] = useState({ x: 0, y: 5, z: 5 })
  const [lightPos2, setLightPos2] = useState({ x: -5, y: -5, z: -5 })
  const [lightPos3, setLightPos3] = useState({ x: 10, y: 0, z: 0 })
  const [showLights, setShowLights] = useState(false)

  const [loadedObjects, setLoadedObjects] = useState([])

  // mobil/desktop kvůli scale v auto-fitu
  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    const uaMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    const coarse = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches
    const narrow = typeof window !== 'undefined' && window.innerWidth < 768
    setIsMobile(uaMobile || coarse || narrow)
  }, [])

  const handleModelLoaded = (obj) => {
    setLoadedObjects((prev) => (prev.includes(obj) ? prev : [...prev, obj]))
  }

  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      <div
        className="controls-panel"
        style={{
          position: 'absolute',
          top: 10,
          left: 10,
          zIndex: 1,
          color: 'white',
          fontFamily: 'sans-serif',
          fontSize: '14px',
        }}
      >
        <div>Upper:</div>
        <input type="color" value={color1} onChange={(e) => setColor1(e.target.value)} />
        <input
          className="slider"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={opacity1}
          onChange={(e) => setOpacity1(parseFloat(e.target.value))}
        />
        <button className="toggle" onClick={() => setVisible1(!visible1)}>
          {visible1 ? '👁️' : '🚫'}
        </button>

        <div style={{ marginTop: '10px' }}>Lower:</div>
        <input type="color" value={color2} onChange={(e) => setColor2(e.target.value)} />
        <input
          className="slider"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={opacity2}
          onChange={(e) => setOpacity2(parseFloat(e.target.value))}
        />
        <button className="toggle" onClick={() => setVisible2(!visible2)}>
          {visible2 ? '👁️' : '🚫'}
        </button>

        <div style={{ marginTop: '10px' }}>Waxup:</div>
        <input type="color" value={color3} onChange={(e) => setColor3(e.target.value)} />
        <input
          className="slider"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={opacity3}
          onChange={(e) => setOpacity3(parseFloat(e.target.value))}
        />
        <button className="toggle" onClick={() => setVisible3(!visible3)}>
          {visible3 ? '👁️' : '🚫'}
        </button>

        {/* Toggle pro menu světel */}
        <div style={{ marginTop: '10px', cursor: 'pointer' }} onClick={() => setShowLights(!showLights)}>
          {showLights ? '⬇️ Světla' : '➡️ Světla'}
        </div>

        {showLights && (
          <div style={{ marginTop: '8px' }}>
            {/* Přesunuto sem: Light Intensity */}
            <div style={{ marginBottom: '6px' }}>💡 Light Intensity:</div>
            <input
              className="slider"
              type="range"
              min={0}
              max={2}
              step={0.01}
              value={lightIntensity}
              onChange={(e) => setLightIntensity(parseFloat(e.target.value))}
            />

            {/* Pozice světel */}
            {[
              { label: 'Light 1 Position', pos: lightPos1, setPos: setLightPos1 },
              { label: 'Light 2 Position', pos: lightPos2, setPos: setLightPos2 },
              { label: 'Light 3 Position', pos: lightPos3, setPos: setLightPos3 },
            ].map((light, idx) => (
              <div key={idx} style={{ marginTop: '10px' }}>
                <div>🔦 {light.label}:</div>
                {['x', 'y', 'z'].map((axis) => (
                  <div key={axis}>
                    <div>{axis.toUpperCase()}:</div>
                    <input
                      className="slider"
                      type="range"
                      min={-10}
                      max={10}
                      step={0.1}
                      value={light.pos[axis]}
                      onChange={(e) => light.setPos({ ...light.pos, [axis]: parseFloat(e.target.value) })}
                    />
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      <Canvas orthographic camera={{ position: [0, 0, 100] }}>
        <ambientLight intensity={lightIntensity * 0.4} />
        <directionalLight position={[lightPos1.x, lightPos1.y, lightPos1.z]} intensity={lightIntensity * 1.5} />
        <directionalLight position={[lightPos2.x, lightPos2.y, lightPos2.z]} intensity={lightIntensity * 1.0} />
        <directionalLight position={[lightPos3.x, lightPos3.y, lightPos3.z]} intensity={lightIntensity * 1.2} />

        <Suspense fallback={<Loader />}>
          <Model url="/models/Upper.obj" color={color1} opacity={opacity1} visible={visible1} onLoaded={handleModelLoaded} />
          <Model url="/models/Lower.obj" color={color2} opacity={opacity2} visible={visible2} onLoaded={handleModelLoaded} />
          <Model url="/models/Crown21.obj" color={color3} opacity={opacity3} visible={visible3} onLoaded={handleModelLoaded} />
        </Suspense>

        <FitCameraOnLoad
          objects={loadedObjects}
          expectedCount={3}
          margin={1.2}
          isMobile={isMobile}
          desktopScale={0.40}
          mobileScale={1.0}
        />

        <TouchTrackballControls />
      </Canvas>

      {/* Globální styl ovládacích prvků */}
      <style jsx global>{`
        .slider {
          -webkit-appearance: none;
          -moz-appearance: none;
          appearance: none;
          width: 140px;
          height: 14px;
          background: transparent;
          margin: 5px 0;
          display: inline-block;
        }
        .slider::-webkit-slider-runnable-track {
          height: 4px;
          background: white;
          border-radius: 2px;
        }
        .slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: white;
          cursor: pointer;
          box-shadow: 0 0 2px black;
          margin-top: -5px;
        }
        .slider::-moz-range-track {
          height: 4px;
          background: white;
          border-radius: 2px;
        }
        .slider::-moz-range-thumb {
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: white;
          cursor: pointer;
          box-shadow: 0 0 2px black;
          border: none;
        }
        .toggle {
          background: transparent;
          border: 1px solid white;
          border-radius: 5px;
          padding: 3px 8px;
          color: white;
          cursor: pointer;
          font-size: 14px;
          margin-left: 5px;
        }
        .controls-panel {
          backdrop-filter: blur(3px);
          background: rgba(0,0,0,.25);
          border: 1px solid rgba(255,255,255,.15);
          border-radius: 8px;
          padding: 10px 12px;
        }
      `}</style>
    </div>
  )
}
