// One source transfer, one active job, latest pending request only.
export function createDicomResliceEngine(volume, { workerFactory = () => new Worker(new URL('../workers/dicom-reslice.worker.js', import.meta.url), { type: 'module' }) } = {}) {
 let worker = null, active = null, pending = null, serial = 0, epoch = 0, disposed = false
 function pump() {
  if (disposed || active || !pending) return
  active = pending; pending = null
  try {
   if (!worker) {
    worker = workerFactory()
    worker.onmessage = ({ data }) => {
     if (data.id !== active?.id) return
     const job = active; active = null
     if (job.epoch !== epoch) job.resolve(null)
     else if (data.error) job.reject(new Error(data.error))
     else job.resolve(data.result)
     pump()
    }
    worker.onerror = () => { active?.reject(new Error('CT image worker unavailable')); active = null; pending?.resolve(null); pending = null; worker?.terminate(); worker = null }
    const copy = volume.data.slice()
    worker.postMessage({ type: 'init', volume: { data: copy, width: volume.width, height: volume.height, depth: volume.depth, size: [...volume.size] } }, [copy.buffer])
   }
   worker.postMessage({ ...active.args, type: 'build', id: active.id })
  } catch (error) { active?.reject(error); active = null; pump() }
 }
 return {
  compute(args) {
   if (disposed) return Promise.resolve(null)
   epoch++; pending?.resolve(null)
   return new Promise((resolve, reject) => { pending = { id: ++serial, epoch, args, resolve, reject }; pump() })
  },
  cancel() { epoch++; active?.resolve(null); pending?.resolve(null); pending = null },
  dispose() { disposed = true; epoch++; worker?.terminate(); worker = null; active?.resolve(null); pending?.resolve(null); active = pending = null },
 }
}
export async function dicomResliceImage(result) {
 let blob = result.blob
 if (!blob) {
  const canvas = document.createElement('canvas'); canvas.width = result.width; canvas.height = result.height
  canvas.getContext('2d').putImageData(new ImageData(result.pixels, result.width, result.height), 0, 0)
  blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('CT image encoding failed')), 'image/png'))
 }
 return { url: URL.createObjectURL(blob), bounds: result.bounds }
}
