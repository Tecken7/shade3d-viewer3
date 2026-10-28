import { buildModel } from '../model-builder/engine.mjs'

import {getRuntime} from '../model-builder/manifold-runtime.mjs'
self.onmessage = async ({ data }) => {
  try {
    const M = await getRuntime()
    const result = await buildModel(M, data.positions, data.options, data.font, message => self.postMessage(typeof message === 'string' ? { progress: message } : message))
    self.postMessage({ result }, [result.positions.buffer, result.indices.buffer])
  } catch (error) { self.postMessage({ error: error?.message || 'Výpočet modelu se nezdařil.' }) }
}
