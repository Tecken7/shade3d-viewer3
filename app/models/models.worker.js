import {getRuntime} from '../model-builder/manifold-runtime.mjs'
import {processFinishedModel,finishManualLabels} from './process.mjs'
self.onmessage=async({data})=>{
 try{
  const M=await getRuntime(),fonts={}
  if(data.settings.logo||data.settings.tag?.trim()){
   const load=async name=>{const response=await fetch('/wasm/model-builder/'+name);if(!response.ok)throw Error('Nepodařilo se načíst písmo.');return response.json()}
   const [regular,logo]=await Promise.all([load('inter-500-font.json'),load('arthetic-logo-font.json')]);fonts[500]=regular;fonts.logo=logo
  }
  const progress=message=>self.postMessage({progress:message}),result=data.manual?await finishManualLabels(M,data.manual,data.pending,fonts,progress):await processFinishedModel(M,data.buffer,data.settings,fonts,progress)
  self.postMessage({result},[result.stl,result.positions.buffer,result.indices.buffer].filter(Boolean))
 }catch(error){self.postMessage({error:error.message||'Převod se nezdařil.'})}
}
