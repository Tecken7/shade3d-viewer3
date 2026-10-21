import {sculptMesh,sculptDab,sculptGeometry} from '../model-builder/sculpt.mjs'
let mesh=null,lastDetail=null
self.onmessage=event=>{
  const {id,type,payload}=event.data
  try{
    if(type==='start'){mesh=sculptMesh(...payload);lastDetail=null;self.postMessage({id,type:'ready'});return}
    let stats={changed:0,split:0,collapsed:0}
    for(let i=0;i<payload.dabs.length;i++){
      if(lastDetail)lastDetail.age++
      const dab=payload.dabs[i],adapt=dab.options.dyntopo&&i===0&&(!lastDetail||lastDetail.age>=12||lastDetail.resolution!==dab.options.resolution||Math.hypot(...dab.point.map((v,k)=>v-lastDetail.point[k]))>dab.options.radius*.4)
      const r=sculptDab(mesh,dab.point,{...dab.options,dyntopo:adapt})
      if(adapt)lastDetail={point:dab.point,resolution:dab.options.resolution,age:0}
      Object.keys(stats).forEach(k=>stats[k]+=r[k])
    }
    const geometry=sculptGeometry(mesh)
    self.postMessage({id,type:'result',geometry,stats},[geometry.positions.buffer,geometry.indices.buffer,...(geometry.colors?[geometry.colors.buffer]:[]),...(geometry.uvs?[geometry.uvs.buffer]:[])])
  }catch(error){self.postMessage({id,type:'error',error:error.message})}
}
