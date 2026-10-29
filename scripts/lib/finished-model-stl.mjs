import * as THREE from 'three'
import {indexed,meshTopology} from '../../app/model-builder/engine.mjs'
export function readBinarySTL(bytes){
 if(bytes.length<84)throw Error('STL je příliš krátké.')
 const count=bytes.readUInt32LE(80)
 if(!count||84+count*50>bytes.length)throw Error('Je potřeba binární STL.')
 const expanded=new Float32Array(count*9)
 for(let i=0;i<count;i++)for(let k=0;k<9;k++){const value=bytes.readFloatLE(84+i*50+12+k*4);if(!Number.isFinite(value))throw Error('STL obsahuje neplatné souřadnice.');expanded[i*9+k]=value}
 return expanded
}
export function encodeClosedSTL(positions,indices,header='ARTHETIC / Inter model labels'){
 // STL stores Float32 coordinates, so discard collapsed zero-area faces and
 // pairs that become exactly coincident with opposite orientation after export.
 const expanded=new Float32Array(indices.length*3)
 indices.forEach((id,i)=>expanded.set(positions.slice(id*3,id*3+3),i*3))
 const {vertices,faces}=indexed(expanded,{exact:true}),seen=new Map()
 for(let i=0;i<faces.length;i+=3){
  const triangle=faces.slice(i,i+3),key=triangle.slice().sort((a,b)=>a-b).join(':'),previous=seen.get(key)
  if(previous){const same=previous.some((_,shift)=>triangle.every((id,j)=>id===previous[(j+shift)%3]));if(same)throw Error('Export obsahuje zdvojenou plochu.');seen.delete(key)}else seen.set(key,triangle)
 }
 const clean=Array.from(seen.values()).flat(),topology=meshTopology(vertices,clean)
 if(topology.openEdges||topology.nonManifold)throw Error('Výsledné STL není uzavřené. Export byl zastaven.')
 const bytes=Buffer.alloc(84+clean.length/3*50);bytes.write(header.slice(0,80));bytes.writeUInt32LE(clean.length/3,80)
 for(let i=0;i<clean.length;i+=3){
  const a=new THREE.Vector3().fromArray(vertices,clean[i]*3),b=new THREE.Vector3().fromArray(vertices,clean[i+1]*3),c=new THREE.Vector3().fromArray(vertices,clean[i+2]*3),normal=b.clone().sub(a).cross(c.clone().sub(a)).normalize()
  ;[...normal.toArray(),...a.toArray(),...b.toArray(),...c.toArray()].forEach((value,k)=>bytes.writeFloatLE(value,84+i/3*50+k*4))
 }
 return {bytes,triangles:clean.length/3,openEdges:0,nonManifold:0}
}
