// Validation and rendering consume the same projection. Keep a few recent
// placements (including the last valid one) rather than wrapping twice per move.
export function createTextPreviewCache(project,capacity=8){
 const entries=new Map()
 return {
  get(point){
   const key=point?JSON.stringify([point.position,point.normal]):'empty'
   if(entries.has(key)){const result=entries.get(key);entries.delete(key);entries.set(key,result);return result}
   const result=project(point);entries.set(key,result)
   while(entries.size>capacity){const oldest=entries.keys().next().value;entries.get(oldest).geometry?.dispose();entries.delete(oldest)}
   return result
  },
  dispose(){for(const result of entries.values())result.geometry?.dispose();entries.clear()},
 }
}

// Coalesce fast pointer events; release must still apply the final position.
export function createTextFrameQueue(apply,request,cancel){
 let frame=null,pending=null
 const flush=()=>{if(frame!==null)cancel(frame);frame=null;const point=pending;pending=null;if(point)apply(point)}
 return {
  push(point){pending=point;if(frame===null)frame=request(()=>{frame=null;flush()})},
  flush,
  clear(){if(frame!==null)cancel(frame);frame=null;pending=null},
 }
}
