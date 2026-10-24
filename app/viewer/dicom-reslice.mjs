import * as THREE from 'three'
import { sampleDicomTrilinear } from './dicom-sampling.mjs'
const clamp01 = value => Math.max(0, Math.min(1, value))
// Pure voxel resampling. Executed exclusively by the CT image worker.
export function resliceDicom(volume, settings, planeMatrix, dicomWorldMatrix, maxResolution = 640) {
 const planeMatrixWorld = new THREE.Matrix4().fromArray(planeMatrix)
 const dicomMatrix = new THREE.Matrix4().fromArray(dicomWorldMatrix)
 maxResolution = Math.max(48, Math.min(640, Math.round(maxResolution)))
  const inversePlane = planeMatrixWorld.clone().invert()
  const planeToDicom = dicomMatrix.clone().invert().multiply(planeMatrixWorld)
  const half = new THREE.Vector3(volume.size[0] / 2, volume.size[1] / 2, volume.size[2] / 2)

  const corners = []
  for (let z = -1; z <= 1; z += 2) {
    for (let y = -1; y <= 1; y += 2) {
      for (let x = -1; x <= 1; x += 2) {
        corners.push(
          new THREE.Vector3(x * half.x, y * half.y, z * half.z)
            .applyMatrix4(dicomMatrix)
            .applyMatrix4(inversePlane)
        )
      }
    }
  }
  const edges = [
    [0, 1], [0, 2], [0, 4], [1, 3], [1, 5], [2, 3],
    [2, 6], [3, 7], [4, 5], [4, 6], [5, 7], [6, 7],
  ]
  const intersections = []
  edges.forEach(([aIndex, bIndex]) => {
    const a = corners[aIndex], b = corners[bIndex]
    if (Math.abs(a.z) < 1e-5) intersections.push(a.clone())
    if (a.z * b.z < 0) {
      const t = a.z / (a.z - b.z)
      intersections.push(a.clone().lerp(b, t))
    }
  })
  if (intersections.length < 3) return null

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  intersections.forEach((point) => {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x)
    minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y)
  })
  const physicalWidth = maxX - minX
  const physicalHeight = maxY - minY
  if (!(physicalWidth > 0.01 && physicalHeight > 0.01)) return null

  const largestSide = Math.max(physicalWidth, physicalHeight)
  const width = Math.max(48, Math.round(maxResolution * physicalWidth / largestSide))
  const height = Math.max(48, Math.round(maxResolution * physicalHeight / largestSide))
  const pixels = new Uint8ClampedArray(width * height * 4)
  const elements = planeToDicom.elements
  const huSpan = 4095
  const densitySpan = Math.max(10, settings.densityMax - settings.densityMin)

  for (let py = 0; py < height; py++) {
    const planeY = maxY - ((py + 0.5) / height) * physicalHeight
    for (let px = 0; px < width; px++) {
      const planeX = minX + ((px + 0.5) / width) * physicalWidth
      const localX = elements[0] * planeX + elements[4] * planeY + elements[12]
      const localY = elements[1] * planeX + elements[5] * planeY + elements[13]
      const localZ = elements[2] * planeX + elements[6] * planeY + elements[14]
      const tx = localX / volume.size[0] + 0.5
      const ty = localY / volume.size[1] + 0.5
      const tz = localZ / volume.size[2] + 0.5
      const outputIndex = (py * width + px) * 4
      if (tx < 0 || tx > 1 || ty < 0 || ty > 1 || tz < 0 || tz > 1 || tz < settings.cropMin || tz > settings.cropMax) {
        pixels[outputIndex + 3] = 0
        continue
      }
      const encoded = sampleDicomTrilinear(volume, tx, ty, tz)
      const hu = -1024 + (encoded / 255) * huSpan
      const normalized = clamp01((hu - settings.densityMin) / densitySpan)
      const gray = Math.round(Math.pow(normalized, 0.72) * 255)
      pixels[outputIndex] = gray
      pixels[outputIndex + 1] = gray
      pixels[outputIndex + 2] = gray
      pixels[outputIndex + 3] = 255
    }
  }
  return { pixels, width, height, bounds: { minX, minY, width: physicalWidth, height: physicalHeight } }
}
