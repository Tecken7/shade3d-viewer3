// One bounded worker, one latest pending threshold, and two cached final surfaces.
export function createCtSurfaceEngine(volume,{workerFactory=()=>new Worker(new URL('../workers/ct-surface.worker.js',import.meta.url),{type:'module'})}={}){
 let worker=null,active=null,pending=null,current=null,serial=0,disposed=false,failed=false
 const cache=new Map()
 function deliver(job,surface,final){if(current?.id===job.id || (job.progressive && current?.progressive))job.onSurface(surface,final)}
 function finish(){active=null;pump()}
 function fail(error){failed=true;worker?.terminate();worker=null;if(current)current.onError(error);active=null;pending=null}
 function pump(){
  if(disposed||failed||active||!pending)return
  const job=pending;pending=null
  if(cache.has(job.key)){const value=cache.get(job.key);cache.delete(job.key);cache.set(job.key,value);deliver(job,value,true);return}
  active=job
  try{
   if(!worker){
    worker=workerFactory()
    worker.onmessage=({data})=>{
     if(disposed||data.id!==active?.id)return
     if(data.type==='error'){fail(new Error(data.error));return}
     if(data.type==='surface'){
      if(data.final){cache.set(active.key,data.surface);while(cache.size>2)cache.delete(cache.keys().next().value)}
      deliver(active,data.surface,data.final)
      if(data.final)finish()
     }
    }
    worker.onerror=()=>fail(new Error('CT surface worker unavailable'))
    const copy=volume.data.slice()
    worker.postMessage({type:'init',volume:{data:copy,width:volume.width,height:volume.height,depth:volume.depth,size:[...volume.size]}},[copy.buffer])
   }
   worker.postMessage({type:'build',id:job.id,iso:job.iso,detail:job.detail})
  }catch(error){fail(error)}
 }
 return {
  request({iso,detail=256,progressive=false,onSurface,onError=()=>{}}){
   if(disposed)return()=>{}
   const job={id:++serial,key:`${iso.toFixed(5)}:${detail}`,iso,detail,progressive,onSurface,onError}
   current=job;pending=job
   if(failed){pending=null;onError(new Error('CT surface worker unavailable'))}else pump()
   return()=>{if(current?.id===job.id)current=null;if(pending?.id===job.id)pending=null}
  },
  dispose(){disposed=true;worker?.terminate();worker=null;current=active=pending=null;cache.clear()},
 }
}
