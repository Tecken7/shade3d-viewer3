'use client'

import { Canvas, useLoader, useThree, useFrame } from '@react-three/fiber'
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader'
import * as THREE from 'three'
import { Suspense, useEffect, useRef, useState } from 'react'
import { Html, useProgress } from '@react-three/drei'

function extractNameFromURL(url) {
    const parts = url.split('/')
    const filename = parts[parts.length - 1]
    return filename.replace('.obj', '')
}

function Model({ url, color, opacity, visible }) {
    const obj = useLoader(OBJLoader, url)

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
        if (child.isMesh) {
            child.material = material
        }
    })

    return visible ? <primitive object={obj} /> : null
}

function TouchTrackballControls() {
    const { camera, gl } = useThree()
    const controlsRef = useRef()

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
            <div style={{
                background: 'rgba(0,0,0,0.7)',
                padding: '20px 40px',
                borderRadius: '10px',
                color: 'white',
                fontFamily: 'sans-serif',
                fontSize: '18px'
            }}>
                ⏳ Načítání modelů: {Math.round(progress)} %
            </div>
        </Html>
    )
}

function ModelControls({ url, color, setColor, opacity, setOpacity, visible, setVisible }) {
    const label = extractNameFromURL(url)

    return (
        <div style={{ marginTop: '10px' }}>
            <div>{label}:</div>
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
            <input type="range" min={0} max={1} step={0.01} value={opacity} onChange={(e) => setOpacity(parseFloat(e.target.value))} />
            <button onClick={() => setVisible(!visible)}>{visible ? '👁️' : '🚫'}</button>
        </div>
    )
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

    const upperUrl = "/models/Upper.obj"
    const lowerUrl = "/models/Lower.obj"
    const crownUrl = "/models/Crown21.obj"

    return (
        <div style={{ width: '100vw', height: '100vh' }}>
            <div style={{
                position: 'absolute', top: 10, left: 10, zIndex: 1,
                color: 'white', fontFamily: 'sans-serif'
            }}>
                <ModelControls
                    url={upperUrl}
                    color={color1}
                    setColor={setColor1}
                    opacity={opacity1}
                    setOpacity={setOpacity1}
                    visible={visible1}
                    setVisible={setVisible1}
                />

                <ModelControls
                    url={lowerUrl}
                    color={color2}
                    setColor={setColor2}
                    opacity={opacity2}
                    setOpacity={setOpacity2}
                    visible={visible2}
                    setVisible={setVisible2}
                />

                <ModelControls
                    url={crownUrl}
                    color={color3}
                    setColor={setColor3}
                    opacity={opacity3}
                    setOpacity={setOpacity3}
                    visible={visible3}
                    setVisible={setVisible3}
                />

                <div style={{ marginTop: '10px' }}>💡 Light Intensity:</div>
                <input type="range" min={0} max={2} step={0.01} value={lightIntensity} onChange={(e) => setLightIntensity(parseFloat(e.target.value))} />

                <div style={{ marginTop: '10px', cursor: 'pointer' }} onClick={() => setShowLights(!showLights)}>
                    {showLights ? '⬇️ Světla' : '➡️ Světla'}
                </div>

                {showLights && (
                    <div style={{ marginTop: '5px' }}>
                        <div>🔦 Light 1 Position:</div>
                        <div>X:</div>
                        <input type="range" min={-10} max={10} step={0.1} value={lightPos1.x} onChange={(e) => setLightPos1({ ...lightPos1, x: parseFloat(e.target.value) })} />
                        <div>Y:</div>
                        <input type="range" min={-10} max={10} step={0.1} value={lightPos1.y} onChange={(e) => setLightPos1({ ...lightPos1, y: parseFloat(e.target.value) })} />
                        <div>Z:</div>
                        <input type="range" min={-10} max={10} step={0.1} value={lightPos1.z} onChange={(e) => setLightPos1({ ...lightPos1, z: parseFloat(e.target.value) })} />

                        <div style={{ marginTop: '10px' }}>🔦 Light 2 Position:</div>
                        <div>X:</div>
                        <input type="range" min={-10} max={10} step={0.1} value={lightPos2.x} onChange={(e) => setLightPos2({ ...lightPos2, x: parseFloat(e.target.value) })} />
                        <div>Y:</div>
                        <input type="range" min={-10} max={10} step={0.1} value={lightPos2.y} onChange={(e) => setLightPos2({ ...lightPos2, y: parseFloat(e.target.value) })} />
                        <div>Z:</div>
                        <input type="range" min={-10} max={10} step={0.1} value={lightPos2.z} onChange={(e) => setLightPos2({ ...lightPos2, z: parseFloat(e.target.value) })} />

                        <div style={{ marginTop: '10px' }}>🔦 Light 3 Position (Right):</div>
                        <div>X:</div>
                        <input type="range" min={-10} max={10} step={0.1} value={lightPos3.x} onChange={(e) => setLightPos3({ ...lightPos3, x: parseFloat(e.target.value) })} />
                        <div>Y:</div>
                        <input type="range" min={-10} max={10} step={0.1} value={lightPos3.y} onChange={(e) => setLightPos3({ ...lightPos3, y: parseFloat(e.target.value) })} />
                        <div>Z:</div>
                        <input type="range" min={-10} max={10} step={0.1} value={lightPos3.z} onChange={(e) => setLightPos3({ ...lightPos3, z: parseFloat(e.target.value) })} />
                    </div>
                )}
            </div>

            <Canvas orthographic camera={{ position: [0, 0, 100], zoom: 15 }}>
                <ambientLight intensity={lightIntensity * 0.4} />
                <directionalLight position={[lightPos1.x, lightPos1.y, lightPos1.z]} intensity={lightIntensity * 1.5} />
                <directionalLight position={[lightPos2.x, lightPos2.y, lightPos2.z]} intensity={lightIntensity * 1.0} />
                <directionalLight position={[lightPos3.x, lightPos3.y, lightPos3.z]} intensity={lightIntensity * 1.2} />

                <Suspense fallback={<Loader />}>
                    <Model url={upperUrl} color={color1} opacity={opacity1} visible={visible1} />
                    <Model url={lowerUrl} color={color2} opacity={opacity2} visible={visible2} />
                    <Model url={crownUrl} color={color3} opacity={opacity3} visible={visible3} />
                </Suspense>

                <TouchTrackballControls />
            </Canvas>
        </div>
    )
}
