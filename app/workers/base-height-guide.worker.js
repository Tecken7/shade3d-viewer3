import {prepareBaseHeightGuide} from '../model-builder/base-height-guide.mjs'
self.onmessage=({data})=>{
  try{self.postMessage({result:prepareBaseHeightGuide(data.positions,data.arch)})}
  catch(error){self.postMessage({error:error.message||'Náhled výšky báze se nepodařilo připravit.'})}
}
