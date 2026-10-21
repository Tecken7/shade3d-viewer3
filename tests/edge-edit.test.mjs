import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { buildEdgePatch } from '../app/model-builder/edge-edit.mjs'

const edge=(a,b)=>a<b?`${a}:${b}`:`${b}:${a}`
function fixture(points=[[0,0],[2,0],[2,2],[4,2],[4,0],[6,0],[6,5],[0,5]]) {
  const faces=THREE.ShapeUtils.triangulateShape(points.map(p=>new THREE.Vector2(...p)),[])
  const context={triangles:faces.map(nodeIds=>({nodeIds})),edgeTriangles:new Map()}
  faces.forEach((f,i)=>f.forEach((a,j)=>{const k=edge(a,f[(j+1)%3]);context.edgeTriangles.set(k,[...(context.edgeTriangles.get(k)||[]),i])}))
  const loop={childUuid:'scan',materialIndex:0,boundary:points.map((p,nodeId)=>({nodeId,position:new THREE.Vector3(...p,0),color:[.3,.5,.7],uv:p}))}
  return {context,loop,points,faces}
}
test('edge notch patch shares each rim edge with opposite winding and retains the open scan boundary',()=>{
  const {context,loop,points,faces}=fixture(),snapshot=JSON.stringify(loop)
  const patch=buildEdgePatch(context,loop,1,4,0.6)
  assert.equal(JSON.stringify(loop),snapshot)
  const vertices=points.map(p=>[...p,0]), ids=new Map(vertices.map((p,i)=>[p.join(','),i]))
  const patchFaces=patch.triangles.map(t=>t.map(c=>{const k=c.sourcePos.join(',');if(!ids.has(k)){ids.set(k,vertices.length);vertices.push(c.sourcePos)}return ids.get(k)}))
  const edges=new Map()
  for(const f of [...faces,...patchFaces])for(let i=0;i<3;i++){const a=f[i],b=f[(i+1)%3],k=edge(a,b);edges.set(k,[...(edges.get(k)||[]),[a,b]])}
  for(const list of edges.values()){assert.ok(list.length<=2);if(list.length===2)assert.deepEqual(list[0],list[1].slice().reverse())}
  for(const [a,b] of [[1,2],[2,3],[3,4]])assert.equal(edges.get(edge(a,b)).length,2)
  const boundary=[...edges.values()].filter(l=>l.length===1)
  assert.ok(boundary.length>0)
  const degree=new Map();boundary.flat().forEach(e=>e.forEach(i=>degree.set(i,(degree.get(i)||0)+1)))
  assert.ok([...degree.values()].every(d=>d===2))
  assert.ok(patch.triangles.every(t=>t.every(c=>c.color.every((v,i)=>Math.abs(v-[.3,.5,.7][i])<1e-9))))
  assert.ok(patch.triangles.every(t=>t.every(c=>c.sourceNormal[2]>0.99)))
})
test('edge patch rejects coincident endpoints and crossing free edge',()=>{
 const {context,loop}=fixture()
 assert.throws(()=>buildEdgePatch(context,loop,1,1),/různé/)
 assert.throws(()=>buildEdgePatch(context,loop,1,4,-4),/kříží/)
})
test('collinear rim vertices remain attached without collapsed patch faces',()=>{
 const {context,loop}=fixture([[0,0],[2,0],[2,1],[2,2],[3,2],[4,2],[4,1],[4,0],[6,0],[6,5],[0,5]])
 const patch=buildEdgePatch(context,loop,1,7,.5)
 const directed=new Map()
 patch.triangles.forEach(t=>t.forEach((c,i)=>{const k=[c.sourcePos.join(','),t[(i+1)%3].sourcePos.join(',')].sort().join('|');directed.set(k,(directed.get(k)||0)+1)}))
 for(let i=1;i<7;i++){const k=[loop.boundary[i].position.toArray().join(','),loop.boundary[i+1].position.toArray().join(',')].sort().join('|');assert.equal(directed.get(k),1)}
 for(const t of patch.triangles){const [a,b,c]=t.map(p=>new THREE.Vector3(...p.sourcePos));assert.ok(b.sub(a).cross(c.sub(a)).lengthSq()>1e-20)}
})

test('painted keyhole expands its mouth to the healthy outside rim',async()=>{
 const {predictEdgePatch}=await import('../app/model-builder/edge-edit.mjs')
 const {context,loop}=fixture([[0,0],[3,0],[3,1],[2,1],[2,3],[5,3],[5,1],[4,1],[4,0],[7,0],[7,2],[7,4],[7,5],[5,5],[3,5],[0,5],[0,3],[0,1]])
 const patch=predictEdgePatch(context,loop,2,7)
 assert.deepEqual(patch.arc[0],[3,0,0]);assert.deepEqual(patch.arc.at(-1),[4,0,0])
 assert.ok(patch.triangles.length>0)
})

test('whole border smoothing keeps interior vertices and geometry history intact',async()=>{
 const {smoothScanBorder}=await import('../app/model-builder/edge-edit.mjs')
 const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0,2,0,0,2,2,0,0,2,0,1,1,1],3));geometry.setIndex([0,1,4,1,2,4,2,3,4,3,0,4]);geometry.computeVertexNormals()
 const mesh=new THREE.Mesh(geometry),matrix=new THREE.Matrix4(),boundary=[0,1,2,3].map(nodeId=>({nodeId,position:new THREE.Vector3().fromBufferAttribute(geometry.attributes.position,nodeId)}))
 const context={childMeta:new Map([[mesh.uuid,{mesh,childToSource:matrix,sourceToChild:matrix}]])}
 const snapshot=Array.from(geometry.attributes.position.array),backup=smoothScanBorder(context,[{childUuid:mesh.uuid,boundary,perimeter:8}],3)
 assert.equal(backup[0].geometry,geometry);assert.deepEqual(Array.from(geometry.attributes.position.array),snapshot)
 assert.deepEqual(Array.from(mesh.geometry.attributes.position.array).slice(12),[1,1,1]);assert.deepEqual(Array.from(mesh.geometry.index.array),Array.from(geometry.index.array))
 assert.ok(mesh.geometry.attributes.position.getX(0)>0)
})

test('patch refinement removes long interior spans instead of only adding triangle centres',()=>{
 const {context,loop}=fixture(),patch=buildEdgePatch(context,loop,1,4,.6),triangles=patch.triangles.map(t=>t.map(c=>new THREE.Vector3(...c.sourcePos)))
 const lengths=triangles.flatMap(t=>t.map((p,i)=>p.distanceTo(t[(i+1)%3]))).sort((a,b)=>a-b)
 const qualities=triangles.map(([a,b,c])=>b.clone().sub(a).cross(c.clone().sub(a)).length()/(a.distanceToSquared(b)+b.distanceToSquared(c)+c.distanceToSquared(a))).sort((a,b)=>a-b)
 assert.ok(lengths[Math.floor(lengths.length*.9)]<patch.targetEdgeLength*1.8)
 assert.ok(qualities[Math.floor(qualities.length*.05)]>.02)
})

test('filling a protrusion cannot add a second skin over the existing scan',()=>{
 const {context,loop}=fixture([[0,0],[2,0],[3,-2],[4,0],[6,0],[6,5],[0,5]])
 assert.throws(()=>buildEdgePatch(context,loop,1,3),/překrývalo/)
})

test('collision check rejects both crossing triangles and a near-parallel duplicate layer',async()=>{
 const {assertPatchClear}=await import('../app/model-builder/patch-collision.mjs')
 const {context,loop}=fixture()
 const samples=points=>points.map(p=>({position:new THREE.Vector3(...p)}))
 assert.throws(()=>assertPatchClear(context,loop,samples([[.2,.2,.001],[1.5,.2,.001],[.2,1.5,.001]]),[[0,1,2]],.15),/překrývalo/)
 assert.throws(()=>assertPatchClear(context,loop,samples([[.2,.2,-1],[1.5,.2,1],[.2,1.5,1]]),[[0,1,2]],.15),/překrývalo/)
})


test('straight free lip remains valid after a rotated and translated scan projection',()=>{
 const {context,loop}=fixture([[0,0],[2,0],[2,3],[15,3],[15,0],[20,0],[20,8],[0,8]])
 const matrix=new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(.6,.3,1.4)),normal=new THREE.Vector3(0,0,1).transformDirection(matrix)
 loop.boundary.forEach(s=>{s.position.applyMatrix4(matrix).add(new THREE.Vector3(8.3,7.6,-3));s.normal=normal})
 context.nodes=loop.boundary.map(s=>s.position)
 const patch=buildEdgePatch(context,loop,1,4)
 assert.ok(patch.triangles.length>100)
 for(const t of patch.triangles){const [a,b,c]=t.map(c=>new THREE.Vector3(...c.sourcePos));assert.ok(b.sub(a).cross(c.sub(a)).dot(normal)>1e-12)}
})

test('interior patch budget adapts to area without discarding the sewn boundary',async()=>{
 const {remeshPatch}=await import('../app/model-builder/patch-remesh.mjs')
 const samples=[[0,0],[40,0],[40,10],[0,10]].map(p=>({position:new THREE.Vector3(...p,0)})),snapshot=samples.map(s=>s.position.toArray())
 const {faces}=remeshPatch(samples,[[0,1,2],[0,2,3]],4,.06,new THREE.Vector3(1,0,0),new THREE.Vector3(0,1,0),new THREE.Vector3(0,0,1),4)
 assert.ok(faces.length<12000);assert.ok(faces.length>1000)
 assert.deepEqual(samples.slice(0,4).map(s=>s.position.toArray()),snapshot)
 let area=0;const edges=new Map()
 for(const f of faces){const [a,b,c]=f.map(i=>samples[i].position);const n=b.clone().sub(a).cross(c.clone().sub(a));assert.ok(n.z>0);area+=n.z*.5;f.forEach((a,i)=>{const k=edge(a,f[(i+1)%3]);edges.set(k,(edges.get(k)||0)+1)})}
 assert.ok(Math.abs(area-400)<1e-6);assert.equal([...edges.values()].filter(n=>n===1).length,4);assert.ok([...edges.values()].every(n=>n<=2))
})

test('batched collision collection retains source face IDs and excludes only replaced faces',async()=>{
 const {assertPatchClear}=await import('../app/model-builder/patch-collision.mjs'),{context,loop,faces}=fixture(),samples=loop.boundary.map(s=>({position:s.position}))
 assert.throws(()=>assertPatchClear(context,loop,samples,faces,.15,false,true),error=>error.sourceTriangleIndices.length>1&&error.sourceTriangleIndices.every(i=>i>=0&&i<faces.length))
 const replacement={...context,collisionSource:context,excludedFaces:new Set(faces.map((_,i)=>i)),collisionFaceMap:new Map()}
 assert.doesNotThrow(()=>assertPatchClear(replacement,loop,samples,faces,.15,false,true))
})
