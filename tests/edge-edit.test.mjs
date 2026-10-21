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
