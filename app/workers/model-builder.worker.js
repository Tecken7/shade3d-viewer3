import { buildModel, applyModelText } from '../model-builder/engine.mjs'
import {baseRevealStarts} from '../model-builder/base-reveal-start.mjs'

import {getRuntime} from '../model-builder/manifold-runtime.mjs'
self.onmessage = async ({ data }) => {
  try {
    const M = await getRuntime()
    const progress=message=>self.postMessage(typeof message==='string'?{progress:message}:message)
    const result = data.operation==='text'
      ? await applyModelText(M,data.base,data.options,data.font,progress)
      : await buildModel(M,data.positions,data.options,data.font,progress)
    const transfer=[result.positions.buffer,result.indices.buffer]
    if(data.options.revealBase){
      self.postMessage({progress:'Připravuji plynulé zobrazení báze…'})
      result.revealStarts=baseRevealStarts(result.positions,result.placement.boundary);transfer.push(result.revealStarts.buffer)
    }
    self.postMessage({ result }, transfer)
  } catch (error) { self.postMessage({ error: error?.message || 'Výpočet modelu se nezdařil.' }) }
}
