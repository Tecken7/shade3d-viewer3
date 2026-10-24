import { unpackGeometry, unpackObject } from "./model-preparation.mjs"
// Limit parsing jobs to avoid exhausting memory when a scene has many scans.
const queue=[]
let active=0
function pump(){while(active<2&&queue.length){const job=queue.shift();if(job.signal?.aborted){job.reject(new DOMException('Cancelled','AbortError'));continue}active++;job.run().finally(()=>{active--;pump()})}}
export function loadPreparedSceneModel(options,onProgress,signal){
 if(typeof Worker==='undefined')return Promise.resolve(null)
 return new Promise((resolve,reject)=>{
  queue.push({signal,reject,run:()=>new Promise(done=>{
   let worker,finished=false
   const finish=(error,result)=>{if(finished)return;finished=true;worker?.terminate();signal?.removeEventListener('abort',abort);if(error)reject(error);else resolve(result);done()}
   const abort=()=>finish(new DOMException('Cancelled','AbortError'))
   try{
    worker=new Worker(new URL('../workers/scene-loading.worker.js',import.meta.url),{type:'module'})
    signal?.addEventListener('abort',abort,{once:true})
    worker.onmessage=({data})=>{
     if(data.type==='progress')onProgress?.(data.progress)
     else if(data.type==='error')finish(new Error(data.error))
     else if(data.type==='result'){try{const r=data.result;finish(null,r.object?{object:unpackObject(r.object)}:{geometry:unpackGeometry(r.geometry),base:r.base?unpackGeometry(r.base):null})}catch(e){finish(e)}}
    }
    worker.onerror=()=>finish(new Error('Scene preparation worker unavailable'))
    worker.postMessage(options)
   }catch(error){finish(error)}
  })});pump()
 })
}
