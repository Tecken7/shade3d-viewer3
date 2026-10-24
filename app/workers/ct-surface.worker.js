import {prepareCtField,removeTinyCtIslands,extractCtSurface} from '../viewer/ct-surface.mjs'
let volume=null
const fields=new Map()
self.onmessage=({data})=>{
 try {
  if(data.type==='init'){volume=data.volume;fields.clear();return}
  if(!volume)throw Error('CT volume unavailable')
  const started=performance.now(),levels=[data.detail]
  for(let i=0;i<levels.length;i++){
   let resolution=levels[i],surface
   while(true){
    if(!fields.has(resolution)){self.postMessage({type:'progress',id:data.id,phase:'prepare'});fields.set(resolution,prepareCtField(volume,resolution));while(fields.size>3)fields.delete(fields.keys().next().value)}
    const cleaned=removeTinyCtIslands(fields.get(resolution),data.iso)
    try{surface=extractCtSurface(cleaned,data.iso);break}catch(error){if(error.message!=='CT_SURFACE_BUDGET'||resolution<=96)throw error;resolution=Math.max(96,Math.floor(resolution*.8))}
   }
   const final=i===levels.length-1
   self.postMessage({type:'surface',id:data.id,final,surface:{...surface,elapsedMs:performance.now()-started}},[surface.positions.buffer,surface.normals.buffer,surface.index.buffer])
  }
 }catch(error){self.postMessage({type:'error',id:data.id,error:error.message||String(error)})}
}
