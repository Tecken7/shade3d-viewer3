'use client'

import { Canvas, useLoader } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader'
import * as THREE from 'three'
import { Suspense, useState, useRef } from 'react'

function Model({ url, color, opacity, visible }) {
    const obj = useLoader(OBJLoader, url)
    const material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(color),
        transparent: true,
        opacity,
        metalness: 0.5,
        roughness: 0.5,
        side: THREE.DoubleSide,
    })
    obj.traverse((child) => {
        if (child.isMesh) {
            child.material = material
        }
    })
    return visible ? <primitive object={obj} /> : null
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

    const dirLightRef1 = useRef()
    const dirLightRef2 = useRef()

    return (
        <div style={{ width: '100vw', height: '100vh' }}>
            <div style={{ position: 'absolute', top: 10, left: 10, zIndex: 1, color: 'white', fontFamily: 'sans-serif' }}>
                <div>Upper:</div>
                <input type="color" value={color1} onChange={(e) => setColor1(e.target.value)} />
                <input type="range" min={0} max={1} step={0.01} value={opacity1} onChange={(e) => setOpacity1(parseFloat(e.target.value))} />
                <button onClick={() => setVisible1(!visible1)} style={{ marginLeft: '8px' }}>
                    {visible1 ? '👁️' : '🚫'}
                </button>

                <div style={{ marginTop: '10px' }}>Lower:</div>
                <input type="color" value={color2} onChange={(e) => setColor2(e.target.value)} />
                <input type="range" min={0} max={1} step={0.01} value={opacity2} onChange={(e) => setOpacity2(parseFloat(e.target.value))} />
                <button onClick={() => setVisible2(!visible2)} style={{ marginLeft: '8px' }}>
                    {visible2 ? '👁️' : '🚫'}
                </button>

                <div style={{ marginTop: '10px' }}>Dental:</div>
                <input type="color" value={color3} onChange={(e) => setColor3(e.target.value)} />
                <input type="range" min={0} max={1} step={0.01} value={opacity3} onChange={(e) => setOpacity3(parseFloat(e.target.value))} />
                <button onClick={() => setVisible3(!visible3)} style={{ marginLeft: '8px' }}>
                    {visible3 ? '👁️' : '🚫'}
                </button>

                <div style={{ marginTop: '10px' }}>💡 Scene Light:</div>
                <input type="range" min={0} max={2} step={0.01} value={lightIntensity} onChange={(e) => setLightIntensity(parseFloat(e.target.value))} />
            </div>

            <Canvas orthographic camera={{ position: [0, 0, 100], zoom: 15 }}>
                <ambientLight intensity={lightIntensity * 0.4} />
                <directionalLight ref={dirLightRef1} position={[5, 5, 5]} intensity={lightIntensity * 1.5} />
                <directionalLight ref={dirLightRef2} position={[-5, -5, -5]} intensity={lightIntensity * 1.0} />

                <Suspense fallback={null}>
                    <Model url="/models/Upper.obj" color={color1} opacity={opacity1} visible={visible1} />
                    <Model url="/models/Lower.obj" color={color2} opacity={opacity2} visible={visible2} />
                    <Model url="/models/Crown21.obj" color={color3} opacity={opacity3} visible={visible3} />
                </Suspense>
                <OrbitControls />
            </Canvas>
        </div>
    )
}
