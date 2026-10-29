import {useCallback,useEffect,useRef,useState} from 'react'
import * as THREE from 'three'
import {createTextProjectionQueue} from './text-projection-queue.mjs'

// One in-flight wrap plus the latest pointer position; never build up a queue
// of obsolete projections or commit a result from an earlier pointer location.
export function useTextProjection(surface,font,options){
 const state=useRef(null),[result,setResult]=useState({valid:false,error:'',geometry:null}),[pending,setPending]=useState(false)
 const send=useCallback((point,complete)=>{
  const s=state.current;if(!s)return
  s.queue.request(point,complete)
 },[])
 useEffect(()=>{
  if(!surface||!font)return
  const worker=new Worker(new URL('./text-preview.worker.js',import.meta.url)),s={worker,queue:null};state.current=s
  const positions=surface.attributes.position.array.slice(),normals=surface.attributes.normal?.array.slice(),index=surface.index?.array.slice()
  worker.postMessage({type:'init',positions,normals,index,font:font.data,options},[positions.buffer,normals?.buffer,index?.buffer].filter(Boolean))
  s.queue=createTextProjectionQueue(job=>{setPending(true);worker.postMessage(job)},(data,point)=>{
   if(state.current!==s)return
   let geometry=null
   if(data.positions){geometry=new THREE.BufferGeometry().setAttribute('position',new THREE.BufferAttribute(data.positions,3));if(data.normals)geometry.setAttribute('normal',new THREE.BufferAttribute(data.normals,3));geometry.computeBoundingBox();geometry.computeBoundingSphere()}
   setResult({geometry,valid:data.valid,error:data.error,point});setPending(false)
  })
  worker.onmessage=({data})=>s.queue.receive(data)
  worker.onerror=()=>{if(state.current===s){setPending(false);setResult({geometry:null,valid:false,error:'Náhled textu se nepodařilo připravit. Zkuste umístění znovu.'})}}
  return()=>{state.current=null;s.queue.close();worker.terminate()}
 },[surface,font,options.text,options.textSize,options.textDepth,options.textMode,options.textRotation,options.baseDirection])
 useEffect(()=>()=>result.geometry?.dispose(),[result.geometry])
 return {result,pending,project:send}
}
