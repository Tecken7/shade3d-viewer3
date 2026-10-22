import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'

// PLYLoader expands face UVs into separate corners, preserving texture seams.
export function bakePlyPixels(buffer, {width, height, data}) {
  const loader = new PLYLoader()
  loader.setPropertyNameMapping({texture_u: 's', texture_v: 't', u: 's', v: 't'})
  const geometry = loader.parse(buffer)
  try {
    const position = geometry.getAttribute('position'), uv = geometry.getAttribute('uv')
    if (position?.count && !uv && geometry.getAttribute('color')) return buffer
    if (!position?.count || !uv || uv.count !== position.count) throw new Error('PLY nemá platné UV souřadnice.')
    if (position.count > 5000000) throw new Error('PLY je příliš velké.')
    const index = geometry.index
    const count = index ? index.count : position.count
    if (count % 3) throw new Error('PLY neobsahuje trojúhelníkovou síť.')
    const header = new TextEncoder().encode(`ply\nformat binary_little_endian 1.0\ncomment Baked by Arthetic\nelement vertex ${position.count}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nelement face ${count / 3}\nproperty list uchar uint vertex_indices\nend_header\n`)
    const output = new Uint8Array(header.length + position.count * 15 + count / 3 * 13)
    output.set(header)
    const view = new DataView(output.buffer)
    let offset = header.length
    for (let i = 0; i < position.count; i++) {
      const values = [position.getX(i), position.getY(i), position.getZ(i), uv.getX(i), uv.getY(i)]
      if (!values.every(Number.isFinite)) throw new Error('Neplatné souřadnice PLY.')
      for (let axis = 0; axis < 3; axis++, offset += 4) view.setFloat32(offset, values[axis], true)
      const x = Math.min(width - 1, Math.max(0, Math.floor(values[3] * width)))
      const y = Math.min(height - 1, Math.max(0, Math.floor((1 - values[4]) * height)))
      const pixel = (y * width + x) * 4
      for (let channel = 0; channel < 3; channel++) view.setUint8(offset++, data[pixel + channel])
    }
    for (let i = 0; i < count; i += 3) {
      view.setUint8(offset++, 3)
      for (let corner = 0; corner < 3; corner++, offset += 4) view.setUint32(offset, index ? index.getX(i + corner) : i + corner, true)
    }
    return output.buffer
  } finally { geometry.dispose() }
}

export async function bakePlyTexture(buffer, imageBuffer, mime) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength > 80 * 1024 * 1024 || !(imageBuffer instanceof ArrayBuffer) || imageBuffer.byteLength > 40 * 1024 * 1024) throw new Error('Soubory překračují limit převodu.')
  const bitmap = await createImageBitmap(new Blob([imageBuffer], {type: mime}))
  try {
    if (bitmap.width * bitmap.height > 32000000) throw new Error('Textura je příliš velká.')
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width; canvas.height = bitmap.height
    const context = canvas.getContext('2d', {willReadFrequently: true})
    if (!context) throw new Error('Canvas není dostupný.')
    context.drawImage(bitmap, 0, 0)
    return bakePlyPixels(buffer, context.getImageData(0, 0, bitmap.width, bitmap.height))
  } finally { bitmap.close() }
}
