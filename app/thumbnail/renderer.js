import * as THREE from "three"
import { inferSceneOrientation } from "../viewer/scan-orientation.mjs"
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js"
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js"
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js"

// Independent from the editable scene: no camera, patient metadata or model state is changed.
export async function renderAttachmentThumbnail(buffer, fileName, turntable = false, thumbnailVersion = 2) {
    const extension = String(fileName).split(".").pop().toLowerCase()
    if (!["ply", "stl", "obj"].includes(extension)) throw new Error("Unsupported model format")
    if (!(buffer instanceof ArrayBuffer) || !buffer.byteLength || buffer.byteLength > 80 * 1024 * 1024) throw new Error("Model exceeds thumbnail limits")
    let object, renderer
    const geometries = new Set(), materials = new Set()
    try {
        if (extension === "obj") {
            object = new OBJLoader().parse(new TextDecoder().decode(buffer))
        } else {
            const geometry = extension === "ply" ? new PLYLoader().parse(buffer) : new STLLoader().parse(buffer)
            const plyHeader = extension === "ply" ? new TextDecoder().decode(buffer.slice(0, 4096)).split("end_header")[0] : ""
            object = extension === "ply" && !/element\s+face\s+[1-9]\d*/.test(plyHeader)
                ? new THREE.Points(geometry) : new THREE.Mesh(geometry)
        }
        let vertexCount = 0
        object.traverse(child => {
            if (!child.isMesh && !child.isPoints) return
            const geometry = child.geometry
            geometries.add(geometry)
            const position = geometry.getAttribute("position")
            if (!position?.count) throw new Error("Empty model")
            vertexCount += position.count
            if (vertexCount > 5000000) throw new Error("Model is too complex for a thumbnail")
            for (let i = 0; i < position.array.length; i++) {
                if (!Number.isFinite(position.array[i])) throw new Error("Invalid model coordinates")
            }
            if (child.isMesh && !geometry.getAttribute("normal")) geometry.computeVertexNormals()
            const oldMaterials = Array.isArray(child.material) ? child.material : [child.material]
            oldMaterials.filter(Boolean).forEach(material => materials.add(material))
            child.material = child.isPoints
                ? new THREE.PointsMaterial({ color: geometry.getAttribute("color") ? "#ffffff" : "#AFA28A", size: .012, vertexColors: !!geometry.getAttribute("color") })
                : new THREE.MeshStandardMaterial({ color: geometry.getAttribute("color") ? "#ffffff" : "#AFA28A", vertexColors: !!geometry.getAttribute("color"), roughness: geometry.getAttribute("color") ? .75 : .42, metalness: geometry.getAttribute("color") ? 0 : .51, side: THREE.DoubleSide })
            materials.add(child.material)
        })
        if (!vertexCount) throw new Error("No renderable geometry")
        object.userData.scanName = fileName
        const orientation = inferSceneOrientation(object)
        const box = new THREE.Box3().setFromObject(object)
        const size = box.getSize(new THREE.Vector3())
        const largest = Math.max(size.x, size.y, size.z)
        if (!Number.isFinite(largest) || largest <= 0) throw new Error("Invalid model bounds")
        const center = box.getCenter(new THREE.Vector3())
        object.position.sub(center)
        const root = new THREE.Group()
        root.add(object)
        root.scale.setScalar(2 / largest)
        // Look toward the broad surface of a scan, avoiding an edge-on thumbnail.
        const thinAxis = [size.x, size.y, size.z].indexOf(Math.min(size.x, size.y, size.z))
        const up = orientation?.up || new THREE.Vector3(...[[1,0,0],[0,1,0],[0,0,1]][thinAxis])
        const direction = orientation ? orientation.front.clone().addScaledVector(up, .12).normalize() : [new THREE.Vector3(1, .35, .45), new THREE.Vector3(.35, 1, .45), new THREE.Vector3(.35, .45, 1)][thinAxis].normalize()
        const scene = new THREE.Scene()
        scene.background = new THREE.Color("#111112")
        scene.add(root, new THREE.HemisphereLight(0xffffff, 0x444450, 2.5))
        const light = new THREE.DirectionalLight(0xffffff, 3)
        light.position.copy(direction).multiplyScalar(5)
        scene.add(light)
        const camera = new THREE.PerspectiveCamera(35, 1, .01, 100)
        const radius = new THREE.Box3().setFromObject(root).getBoundingSphere(new THREE.Sphere()).radius
        camera.position.copy(direction).multiplyScalar(radius / Math.sin(THREE.MathUtils.degToRad(17.5)) * 1.12)
        if (orientation) camera.up.copy(up)
        else if (thinAxis === 1) camera.up.set(0, 0, -1)
        camera.lookAt(0, 0, 0)
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true, powerPreference: "low-power" })
        renderer.setPixelRatio(1)
        const resolution = turntable && thumbnailVersion >= 3 ? 768 : 256
        renderer.setSize(resolution, resolution)
        renderer.outputColorSpace = THREE.SRGBColorSpace
        renderer.toneMapping = THREE.ACESFilmicToneMapping
        const frames = turntable ? 24 : 1
        const atlas = document.createElement("canvas")
        const columns = turntable && thumbnailVersion >= 3 ? 6 : frames
        const rows = Math.ceil(frames / columns)
        atlas.width = resolution * columns; atlas.height = resolution * rows
        const smallAtlas = thumbnailVersion === 4 && turntable ? document.createElement("canvas") : null
        if (smallAtlas) { smallAtlas.width = columns * 192; smallAtlas.height = rows * 192 }
        const smallContext = smallAtlas?.getContext("2d")
        if (smallAtlas && !smallContext) throw new Error("Small atlas canvas unavailable")
        const context = atlas.getContext("2d")
        if (!context) throw new Error("Canvas unavailable")
        const rotationAxis = up
        for (let frame = 0; frame < frames; frame++) {
            root.quaternion.setFromAxisAngle(rotationAxis, frame * Math.PI * 2 / frames)
            renderer.render(scene, camera)
            context.drawImage(renderer.domElement, (frame % columns) * resolution, Math.floor(frame / columns) * resolution)
            smallContext?.drawImage(renderer.domElement, (frame % columns) * 192, Math.floor(frame / columns) * 192, 192, 192)
            await new Promise(resolve => setTimeout(resolve, 0))
        }
        const blob = await new Promise(resolve => atlas.toBlob(resolve, "image/jpeg", .92))
        if (!blob || blob.size > 2 * 1024 * 1024) throw new Error("Thumbnail export failed")
        if (smallAtlas) {
            const smallBlob = await new Promise(resolve => smallAtlas.toBlob(resolve, "image/jpeg", .82))
            if (!smallBlob || smallBlob.size > 512 * 1024) throw new Error("Small thumbnail export failed")
            return { thumbnail: smallBlob, preview: blob }
        }
        return blob
    } finally {
        geometries.forEach(geometry => geometry.dispose())
        materials.forEach(material => material.dispose())
        renderer?.dispose()
        renderer?.forceContextLoss()
    }
}
