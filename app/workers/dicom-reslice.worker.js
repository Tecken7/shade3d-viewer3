import { resliceDicom } from '../viewer/dicom-reslice.mjs'
let volume = null
self.onmessage = async ({ data }) => {
 if (data.type === 'init') { volume = data.volume; return }
 try {
  const result = resliceDicom(volume, data.settings, data.planeMatrix, data.dicomMatrix, data.resolution)
  if (!result) { self.postMessage({ id: data.id, result: null }); return }
  if (typeof OffscreenCanvas !== 'undefined') {
   const canvas = new OffscreenCanvas(result.width, result.height), context = canvas.getContext('2d')
   context.putImageData(new ImageData(result.pixels, result.width, result.height), 0, 0)
   const blob = await canvas.convertToBlob({ type: 'image/png' })
   const { pixels, ...metadata } = result
   self.postMessage({ id: data.id, result: { ...metadata, blob } })
  } else self.postMessage({ id: data.id, result }, [result.pixels.buffer])
 } catch (error) { self.postMessage({ id: data.id, error: error.message || String(error) }) }
}
