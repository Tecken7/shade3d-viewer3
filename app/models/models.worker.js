import {getRuntime} from '../model-builder/manifold-runtime.mjs'
import {processFinishedModel} from './process.mjs'
self.onmessage=async({data})=>{
 try{
  const M=await getRuntime(),fonts={}
  if(data.settings.logo||data.settings.tag?.trim()){
   const load=async name=>{const response=await fetch('/wasm/model-builder/'+name);if(!response.ok)throw Error('Nepodařilo se načíst písmo.');return response.json()}
   const [regular,logo]=await Promise.all([load('inter-500-font.json'),load('arthetic-logo-font.json')]);fonts[500]=regular;fonts.logo=logo
  }
  const result=await processFinishedModel(M,data.buffer,data.settings,fonts,message=>self.postMessage({progress:message}))
  self.postMessage({result},[result.stl,result.positions.buffer,result.indices.buffer])
 }catch(error){self.postMessage({error:error.message||'Převod se nezdařil.'})}
}
