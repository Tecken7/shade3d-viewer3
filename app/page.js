'use client'

import { Canvas, useLoader, useFrame } from '@react-three/fiber'
import { TrackballControls, Html } from '@react-three/drei'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader'
import * as THREE from 'three'
import { Suspense, useRef, useState } from 'react'

function TransparentModel({ url, color, opacity, visible, camera }) {
    const obj = useLoader(OBJLoader, url)
    const meshRef = useRef()

    const material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(color),
        transparent: true,
        opacity: opacity,
        metalness: 0.5,
        roughness: 0.2,
        side: THREE.DoubleSide,
        depthWrite: false,
    })

    obj.traverse((child) => {
        if (child.isMesh) {
            child.material = material
            meshRef.current = child
        }
    })

    useFrame(() => {
        if (meshRef.current && camera.current) {
            const distance = meshRef.current.getWorldPosition(new THREE.Vector3()).distanceTo(camera.current.position)
            meshRef.current.renderOrder = -distance
        }
    })

    return visible ? <primitive object={obj} /> : null
}

function Loader() {
    return (
        <Html center>
            <div style={{ color: 'white', fontSize: '1.5em' }}>Načítání modelů...</div>
        </Html>
    )
}

export default function Page() {
    const [colorUpper, setColorUpper] = useState('#f5f5dc')
    const [colorLower, setColorLower] = useState('#f5f5dc')
    const [colorCrown, setColorCrown] = useState('#ffffff')

    const [visibleUpper, setVisibleUpper] = useState(true)
    const [visibleLower, setVisibleLower] = useState(true)
    const [visibleCrown, setVisibleCrown] = useState(true)

    const [opacityUpper, setOpacityUpper] = useState(1)
    const [opacityLower, setOpacityLower] = useState(1)
    const [opacityCrown, setOpacityCrown] = useState(1)

    const [lightIntensity, setLightIntensity] = useState(1)
    const [showLights, setShowLights] = useState(false)

    const cameraRef = useRef()

    return (
        <>
            <div style={{ position: 'absolute', zIndex: 1, padding: 10, color: 'white' }}>
                <div>
                    Upper:
                    <input type="color" value={colorUpper} onChange={(e) => setColorUpper(e.target.value)} />
                    <input type="range" min={0} max={1} step={0.01} value={opacityUpper} onChange={(e) => setOpacityUpper(parseFloat(e.target.value))} />
                    <button onClick={() => setVisibleUpper(!visibleUpper)}>{visibleUpper ? '👁️' : '🚫'}</button>
                </div>
                <div>
                    Lower:
                    <input type="color" value={colorLower} onChange={(e) => setColorLower(e.target.value)} />
                    <input type="range" min={0} max={1} step={0.01} value={opacityLower} onChange={(e) => setOpacityLower(parseFloat(e.target.value))} />
                    <button onClick={() => setVisibleLower(!visibleLower)}>{visibleLower ? '👁️' : '🚫'}</button>
                </div>
                <div>
                    Crown21:
                    <input type="color" value={colorCrown} onChange={(e) => setColorCrown(e.target.value)} />
                    <input type="range" min={0} max={1} step={0.01} value={opacityCrown} onChange={(e) => setOpacityCrown(parseFloat(e.target.value))} />
                    <button onClick={() => setVisibleCrown(!visibleCrown)}>{visibleCrown ? '👁️' : '🚫'}</button>
                </div>

                <div style={{ marginTop: '10px' }}>
                    <button onClick={() => setShowLights(!showLights)}>💡 Světla {showLights ? '▲' : '▼'}</button>
                    {showLights && (
                        <div style={{ marginTop: '5px' }}>
                            <div>Intenzita světla:</div>
                            <input type="range" min={0} max={5} step={0.1} value={lightIntensity} onChange={(e) => setLightIntensity(parseFloat(e.target.value))} />
                        </div>
                    )}
                </div>
            </div>

            <Canvas camera={{ position: [0, 0, 120], fov: 45 }}>
                <Suspense fallback={<Loader />}>
                    <ambientLight intensity={0.2} />
                    <directionalLight position={[30, 30, 30]} intensity={lightIntensity} castShadow />
                    <directionalLight position={[-30, -30, -30]} intensity={lightIntensity / 2} />

                    <TransparentModel url="/Upper.obj" color={colorUpper} opacity={opacityUpper} visible={visibleUpper} camera={cameraRef} />
                    <TransparentModel url="/Lower.obj" color={colorLower} opacity={opacityLower} visible={visibleLower} camera={cameraRef} />
                    <TransparentModel url="/Crown21.obj" color={colorCrown} opacity={opacityCrown} visible={visibleCrown} camera={cameraRef} />
                </Suspense>

                <perspectiveCamera ref={cameraRef} makeDefault position={[0, 0, 120]} />
                <TrackballControls
                    noZoom={false}
                    noPan={false}
                    panSpeed={20}
                    rotateSpeed={5}
                    zoomSpeed={1.5}
                    staticMoving={true}
                />
            </Canvas>
        </>
    )
}
