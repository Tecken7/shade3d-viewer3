import {prepareBaseHeightGuide} from './base-height-guide.mjs'
export function createBaseHeightGuideHandler(loadRuntime,post){
  return async({data})=>{
    try{const result=prepareBaseHeightGuide(await loadRuntime(),data.positions,data.arch,data.options);post({result},[result.profile.positions.buffer,result.profile.indices.buffer])}
    catch(error){post({error:error.message||'Náhled výšky báze se nepodařilo připravit.'})}
  }
}
