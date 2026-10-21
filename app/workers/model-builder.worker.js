import { buildModel } from '../model-builder/engine.mjs'

let runtime
async function getRuntime() {
  if (!runtime) runtime = (async () => {
    const url = new URL('/wasm/model-builder/manifold.js', self.location.origin).href
    const { default: createModule } = await import(/* webpackIgnore: true */ url)
    const M = await createModule({ locateFile: file => new URL('/wasm/model-builder/' + file, self.location.origin).href })
    M.setup()
    return M
  })()
  return runtime
}
self.onmessage = async ({ data }) => {
  try {
    const M = await getRuntime()
    const result = await buildModel(M, data.positions, data.options, data.font, message => self.postMessage(typeof message === 'string' ? { progress: message } : message))
    self.postMessage({ result }, [result.positions.buffer, result.indices.buffer])
  } catch (error) { self.postMessage({ error: error?.message || 'Výpočet modelu se nezdařil.' }) }
}
