import * as THREE from "three"
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js"
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js"
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js"

// Independent from the editable scene: no camera, patient metadata or model state is changed.
export async function renderAttachmentThumbnail(buffer, fileName) {
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
                ? new THREE.PointsMaterial({ color: "#d4d4d8", size: .012, vertexColors: !!geometry.getAttribute("color") })
                : new THREE.MeshStandardMaterial({ color: geometry.getAttribute("color") ? "#ffffff" : "#d4d4d8", vertexColors: !!geometry.getAttribute("color"), roughness: .75, metalness: 0, side: THREE.DoubleSide })
            materials.add(child.material)
        })
        if (!vertexCount) throw new Error("No renderable geometry")
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
        const direction = [new THREE.Vector3(1, .35, .45), new THREE.Vector3(.35, 1, .45), new THREE.Vector3(.35, .45, 1)][thinAxis].normalize()
        const scene = new THREE.Scene()
        scene.background = new THREE.Color("#111112")
        scene.add(root, new THREE.HemisphereLight(0xffffff, 0x444450, 2.5))
        const light = new THREE.DirectionalLight(0xffffff, 3)
        light.position.copy(direction).multiplyScalar(5)
        scene.add(light)
        const camera = new THREE.PerspectiveCamera(35, 1, .01, 100)
        const radius = new THREE.Box3().setFromObject(root).getBoundingSphere(new THREE.Sphere()).radius
        camera.position.copy(direction).multiplyScalar(radius / Math.sin(THREE.MathUtils.degToRad(17.5)) * 1.12)
        if (thinAxis === 1) camera.up.set(0, 0, -1)
        camera.lookAt(0, 0, 0)
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true, powerPreference: "low-power" })
        renderer.setPixelRatio(1)
        renderer.setSize(256, 256)
        renderer.outputColorSpace = THREE.SRGBColorSpace
        renderer.toneMapping = THREE.ACESFilmicToneMapping
        renderer.render(scene, camera)
        const blob = await new Promise(resolve => renderer.domElement.toBlob(resolve, "image/jpeg", .85))
        if (!blob || blob.size > 512 * 1024) throw new Error("Thumbnail export failed")
        return blob
    } finally {
        geometries.forEach(geometry => geometry.dispose())
        materials.forEach(material => material.dispose())
        renderer?.dispose()
        renderer?.forceContextLoss()
    }
}
