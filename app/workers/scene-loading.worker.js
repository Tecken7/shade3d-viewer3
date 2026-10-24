import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js"
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js"
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js"
import { autoSmoothGeometry, packGeometry, packObject, modelTransferables } from "../viewer/model-preparation.mjs"
self.onmessage=async ({data:{url,ext,autoSmooth,smoothAngle}})=>{
 try {
  self.postMessage({type:'progress',progress:0,stage:'downloading'})
  const response=await fetch(url)
  if(!response.ok)throw new Error(`Model HTTP ${response.status}`)
  const total=Number(response.headers.get('content-length'))||0
  const reader=response.body?.getReader();let buffer
  if(reader){const chunks=[];let received=0,last=0;while(true){const {value,done}=await reader.read();if(done)break;chunks.push(value);received+=value.byteLength;const now=performance.now();if(now-last>100){self.postMessage({type:'progress',progress:total?Math.min(.88,received/total*.88):0,stage:'downloading'});last=now}}
   const bytes=new Uint8Array(received);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}buffer=bytes.buffer
  } else buffer=await response.arrayBuffer()
  self.postMessage({type:'progress',progress:.9,stage:'parsing'})
  let result
  if(ext==='stl'||ext==='ply'){
   const geometry=(ext==='stl'?new STLLoader():new PLYLoader()).parse(buffer)
   self.postMessage({type:'progress',progress:.94,stage:'optimizing'})
   if(!geometry.attributes.normal||ext==='stl'&&!autoSmooth)geometry.computeVertexNormals()
   const base=autoSmooth?autoSmoothGeometry(geometry,smoothAngle):geometry
   geometry.computeBoundingBox();geometry.computeBoundingSphere();base.computeBoundingBox();base.computeBoundingSphere()
   result={geometry:packGeometry(geometry),base:base===geometry?null:packGeometry(base)}
  }else{
   const object=new OBJLoader().parse(new TextDecoder().decode(buffer))
   self.postMessage({type:'progress',progress:.94,stage:'optimizing'})
   object.traverse(child=>{if(child.geometry){child.geometry.computeBoundingBox();child.geometry.computeBoundingSphere()}})
   result={object:packObject(object)}
  }
  self.postMessage({type:'progress',progress:.95,stage:'finalizing'})
  self.postMessage({type:'result',result},modelTransferables(result))
 }catch(error){self.postMessage({type:'error',error:error.message||String(error)})}
}
