import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import {fairArtifact,applySurfacePositions,refreshLocalNormals,smoothMarginPoints,surfacePositionKey} from '../app/model-builder/surface-edit.mjs'

function grid(edge=false){
 const n=21,nodes=[],triangles=[]
 for(let y=0;y<n;y++)for(let x=0;x<n;x++){
  const d=Math.hypot((x-10)*.2,(y-(edge?0:10))*.2)
  nodes.push(new THREE.Vector3(x*.2,y*.2,1.2*Math.max(0,1-d/.45)))
 }
 for(let y=0;y<n-1;y++)for(let x=0;x<n-1;x++){const a=y*n+x;for(const nodeIds of [[a,a+1,a+n],[a+1,a+n+1,a+n]])triangles.push({nodeIds})}
 const geometry=new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(nodes.flatMap(p=>p.toArray()),3));geometry.setIndex(triangles.flatMap(t=>t.nodeIds));geometry.computeVertexNormals()
 const mesh=new THREE.Mesh(geometry),matrix=new THREE.Matrix4(),context={nodes,triangles,childMeta:new Map([[mesh.uuid,{mesh,childToSource:matrix,sourceToChild:matrix}]])}
 const center=new THREE.Vector3(2,edge?0:2,0),selected=new Set()
 triangles.forEach((t,i)=>{if(t.nodeIds.some(id=>Math.hypot(nodes[id].x-center.x,nodes[id].y-center.y)<.8))selected.add(i)})
 return{context,geometry,mesh,selected,tip:edge?10:220}
}
for(const edge of [false,true])test(`artifact removal flattens ${edge?'open-rim':'interior'} spike using healthy surroundings, retaining topology and undo`,()=>{
 const {context,geometry,mesh,selected,tip}=grid(edge),before=Array.from(geometry.attributes.position.array)
 const targets=fairArtifact(context,selected)
 assert.ok(targets.get(surfacePositionKey(context.nodes[tip])).z<.12)
 const backup=applySurfacePositions(context,targets)
 assert.equal(backup[0].geometry,geometry);assert.deepEqual(Array.from(geometry.attributes.position.array),before)
 assert.deepEqual(Array.from(mesh.geometry.index.array),Array.from(geometry.index.array))
 for(const triangle of context.triangles){const points=triangle.nodeIds.map(id=>targets.get(surfacePositionKey(context.nodes[id]))||context.nodes[id]);assert.ok(points[1].clone().sub(points[0]).cross(points[2].clone().sub(points[0])).z>0)}
 assert.deepEqual(Array.from(mesh.geometry.attributes.position.array).slice(-3),before.slice(-3))
})
test('artifact removal rejects an unanchored entire mesh and empty selection',()=>{
 const {context}=grid();assert.throws(()=>fairArtifact(context,new Set()),/Nejprve/)
 assert.throws(()=>fairArtifact(context,new Set(context.triangles.map((_,i)=>i))),/menší/)
})
test('non-indexed patch normals are smooth at shared positions, remote scan normals remain exact',()=>{
 const g=new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute([0,0,0,1,0,0,0,1,0, 1,0,0,1,1,.2,0,1,0, 10,0,0,11,0,0,10,1,0],3))
 g.setAttribute('normal',new THREE.Float32BufferAttribute(Array.from({length:9},()=>[.1,.2,.9]).flat(),3))
 const remote=Array.from(g.attributes.normal.array).slice(18)
 refreshLocalNormals(g,new Set([0,1,2,3,4,5]))
 const normal=i=>new THREE.Vector3().fromBufferAttribute(g.attributes.normal,i)
 assert.ok(normal(1).distanceTo(normal(3))<1e-9);assert.ok(normal(2).distanceTo(normal(5))<1e-9)
 assert.deepEqual(Array.from(g.attributes.normal.array).slice(18),remote)
})
test('margin smoothing uses millimetres rather than mesh density',()=>{
 const create=n=>Array.from({length:n},(_,i)=>{const a=2*Math.PI*i/n,r=4+.12*Math.sin(a*32);return{position:new THREE.Vector3(r*Math.cos(a),r*Math.sin(a),0)}})
 const a=smoothMarginPoints(create(256)),b=smoothMarginPoints(create(512))
 const rough=points=>Math.max(...points.map(p=>p.length()))-Math.min(...points.map(p=>p.length()))
 assert.ok(rough(a)<.03);assert.ok(rough(b)<.03)
 assert.ok(Math.max(...a.map((p,i)=>p.distanceTo(b[i*2])))<.02)
})
