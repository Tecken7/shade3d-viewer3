import * as THREE from 'three'
import {STLLoader} from 'three/examples/jsm/loaders/STLLoader.js'
import {indexed,meshTopology} from '../model-builder/engine.mjs'
export function readSTL(buffer){
 if(buffer.byteLength>150*1024*1024)throw Error('Jeden STL může mít nejvýše 150 MB.')
 const geometry=new STLLoader().parse(buffer),p=geometry.attributes.position?.array
 if(!p?.length||p.length%9||p.some(value=>!Number.isFinite(value)))throw Error('STL neobsahuje platné trojúhelníky.')
 const positions=Float32Array.from(p);geometry.dispose();return positions
}
export function encodeSTL(positions,indices){
 const expanded=new Float32Array(indices.length*3)
 indices.forEach((id,i)=>expanded.set(positions.subarray(id*3,id*3+3),i*3))
 const {vertices,faces}=indexed(expanded,{exact:true}),seen=new Map()
 for(let i=0;i<faces.length;i+=3){const t=faces.slice(i,i+3),key=t.slice().sort((a,b)=>a-b).join(':'),previous=seen.get(key);if(previous){if(previous.some((_,shift)=>t.every((id,j)=>id===previous[(j+shift)%3])))throw Error('Výsledek obsahuje zdvojenou plochu.');seen.delete(key)}else seen.set(key,t)}
 const clean=Array.from(seen.values()).flat(),topology=meshTopology(vertices,clean)
 if(topology.openEdges||topology.nonManifold)throw Error('Kontrola uzavřenosti STL neprošla. Výsledek není určen k exportu.')
 const buffer=new ArrayBuffer(84+clean.length/3*50),view=new DataView(buffer)
 new Uint8Array(buffer,0,80).set(new TextEncoder().encode('ARTHETIC Models'));view.setUint32(80,clean.length/3,true)
 for(let i=0;i<clean.length;i+=3){const a=new THREE.Vector3().fromArray(vertices,clean[i]*3),b=new THREE.Vector3().fromArray(vertices,clean[i+1]*3),c=new THREE.Vector3().fromArray(vertices,clean[i+2]*3),n=b.clone().sub(a).cross(c.clone().sub(a)).normalize();[...n.toArray(),...a.toArray(),...b.toArray(),...c.toArray()].forEach((value,k)=>view.setFloat32(84+i/3*50+k*4,value,true))}
 return buffer
}
