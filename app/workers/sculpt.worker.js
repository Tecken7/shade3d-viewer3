import {sculptMesh,sculptDab,sculptGeometry} from '../model-builder/sculpt.mjs'
let mesh=null
self.onmessage=event=>{
  const {id,type,payload}=event.data
  try{
    if(type==='start'){mesh=sculptMesh(...payload);self.postMessage({id,type:'ready'});return}
    let stats={changed:0,split:0,collapsed:0}
    for(let i=0;i<payload.dabs.length;i++){
      const dab=payload.dabs[i]
      const r=sculptDab(mesh,dab.point,{...dab.options,dyntopo:false})
      Object.keys(stats).forEach(k=>stats[k]+=r[k])
    }
    const geometry=sculptGeometry(mesh)
    self.postMessage({id,type:'result',geometry,stats},[geometry.positions.buffer,geometry.indices.buffer,...(geometry.colors?[geometry.colors.buffer]:[]),...(geometry.uvs?[geometry.uvs.buffer]:[])])
  }catch(error){self.postMessage({id,type:'error',error:error.message})}
}
