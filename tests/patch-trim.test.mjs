import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as THREE from 'three'
import {computeBoundsTree,disposeBoundsTree,SAH} from 'three-mesh-bvh'
import {indexed,meshTopology} from '../app/model-builder/engine.mjs'
import {buildTrimRegions} from '../app/model-builder/trim-regions.mjs'
import {refreshLocalNormals} from '../app/model-builder/surface-edit.mjs'
import {buildEdgePatch,patchWithCollar} from '../app/model-builder/edge-edit.mjs'
THREE.BufferGeometry.prototype.computeBoundsTree=computeBoundsTree
THREE.BufferGeometry.prototype.disposeBoundsTree=disposeBoundsTree
const source=fs.readFileSync(new URL('../app/ClientPage.jsx',import.meta.url),'utf8'),section=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)))
const options=new Function('SAH',source.match(/const ALIGNMENT_BVH_OPTIONS = [^\r\n]+/)[0]+';return ALIGNMENT_BVH_OPTIONS')(SAH)
const helpers=new Function('THREE','ALIGNMENT_BVH_OPTIONS','buildTrimRegions',section('const trimEdgeKey =','const repairWaitForBusyPaint')+section('function buildTrimMeshContext(','function TrimRegionPreview(')+';return {buildTrimMeshContext,projectTrimPointToSurface,trimTriangleSurfacePath,buildTrimBoundaryPlan,resolveTrimComponentFromHit,buildTrimmedGeometryForChild,interpolateTrimCorner}')(THREE,options,buildTrimRegions)
const applyPatches=new Function('THREE','ALIGNMENT_BVH_OPTIONS','refreshLocalNormals',section('const trimEdgeKey =','const repairWaitForBusyPaint')+section('function applyRepairPatchesToObject(','function collectRepairBrushTriangles(')+';return applyRepairPatchesToObject')(THREE,options,refreshLocalNormals)
export {helpers,options,applyPatches}

test('creating the trim search tree preserves face IDs of repaired non-indexed geometry',()=>{
 const positions=[]
 for(let i=0;i<80;i++){const x=(i*37)%80;positions.push(x,0,0,x+.5,0,0,x,.5,0)}
 const geometry=new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(positions,3)),mesh=new THREE.Mesh(geometry),context=helpers.buildTrimMeshContext(mesh)
 for(let i=0;i<80;i++){
  const p=context.triangles[i].centroid.clone(),hit=helpers.projectTrimPointToSurface(context,p)
  assert.equal(hit.triangleIndex,i);assert.ok(new THREE.Vector3(...hit.point).distanceTo(p)<1e-5)
 }
 assert.equal(geometry.index,null)
})

test('trim crosses a locally remeshed patch and keeps a connected, correctly oriented region',()=>{
 const positions=[]
 for(let y=0;y<20;y++)for(let x=0;x<24;x++){
  if(x>=8&&x<16&&y<8)continue
  const a=[x*.25,y*.25,0],b=[(x+1)*.25,y*.25,0],c=[x*.25,(y+1)*.25,0],d=[(x+1)*.25,(y+1)*.25,0];positions.push(...a,...b,...c,...b,...d,...c)
 }
 let geometry=new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.computeVertexNormals()
 const mesh=new THREE.Mesh(geometry),context=helpers.buildTrimMeshContext(mesh),neighbors=new Map()
 for(const [key,list]of context.edgeTriangles)if(list.length===1){const[a,b]=key.split(':').map(Number);for(const [u,v]of [[a,b],[b,a]]){if(!neighbors.has(u))neighbors.set(u,[]);neighbors.get(u).push(v)}}
 const ordered=[],start=neighbors.keys().next().value;let id=start,previous=-1
 do{ordered.push(id);const next=neighbors.get(id).find(n=>n!==previous);previous=id;id=next}while(id!==start)
 const loop={childUuid:mesh.uuid,materialIndex:0,boundary:ordered.map(nodeId=>({nodeId,position:context.nodes[nodeId]}))},first=loop.boundary.findIndex(s=>s.position.x===2&&s.position.y===0),last=loop.boundary.findIndex(s=>s.position.x===4&&s.position.y===0)
 const patch=patchWithCollar(context,loop,first,last,0)
 assert.ok(patch.removeFaces.length>0)
 const backup=applyPatches(context,[patch]);assert.equal(backup[0].geometry,geometry)
 assert.equal(mesh.geometry.attributes.position.count/3,context.triangles.length-patch.removeFaces.length+patch.triangles.length)
 const welded=indexed(mesh.geometry.attributes.position.array),topology=meshTopology(welded.vertices,welded.faces)
 assert.equal(topology.nonManifold,0);assert.equal(topology.loops.length,1)
 const repaired=helpers.buildTrimMeshContext(mesh),corners=[[.575,1.075,0],[5.425,1.075,0],[5.425,3.925,0],[.575,3.925,0]].map(p=>helpers.projectTrimPointToSurface(repaired,p))
 assert.ok(corners.every(Boolean))
 const segments=corners.map((p,i)=>helpers.trimTriangleSurfacePath(repaired,p,corners[(i+1)%4]));assert.ok(segments.every(Boolean))
 const plan=helpers.buildTrimBoundaryPlan(repaired,segments),center=helpers.projectTrimPointToSurface(repaired,[3,3,0]),component=helpers.resolveTrimComponentFromHit(repaired,plan,center)
 assert.ok(component>=0)
 const result=helpers.buildTrimmedGeometryForChild(repaired,plan,component,mesh.uuid),attribute=result.attributes.position
 let area=0
 for(let i=0;i<attribute.count;i+=3){const p=[0,1,2].map(j=>new THREE.Vector3().fromBufferAttribute(attribute,i+j)),n=p[1].clone().sub(p[0]).cross(p[2].clone().sub(p[0]));assert.ok(n.z>0);area+=n.z*.5;assert.ok(p.every(v=>v.x>=.56&&v.x<=5.44&&v.y>=1.06&&v.y<=3.94))}
 const outline=segments.flatMap(s=>s.points.slice(0,-1)),expected=Math.abs(outline.reduce((sum,p,i)=>{const q=outline[(i+1)%outline.length];return sum+p[0]*q[1]-p[1]*q[0]},0))*.5
 const cutIndexed=indexed(attribute.array),cutTopology=meshTopology(cutIndexed.vertices,cutIndexed.faces);assert.equal(cutTopology.nonManifold,0);assert.equal(cutTopology.loops.length,1)
 assert.ok(Math.abs(area-expected)<1e-4,`area ${area} expected ${expected}`)
})



test('replacement collar consumes a detached peninsula interior without leaving tiny open loops',()=>{
 const polygon=[[0,0],[2,0],[2,1],[2.2,1],[2.2,.7],[3.2,.7],[3.2,1.7],[2.2,1.7],[2.2,1.3],[2,1.3],[2,3],[4,3],[4,0],[6,0],[6,5],[0,5]]
 const inside=(x,y)=>{let on=false;for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){const a=polygon[i],b=polygon[j];if((a[1]>y)!==(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])on=!on}return on}
 const positions=[]
 for(let y=0;y<50;y++)for(let x=0;x<60;x++)if(inside((x+.5)*.1,(y+.5)*.1)){
  const a=[x*.1,y*.1,0],b=[(x+1)*.1,y*.1,0],c=[x*.1,(y+1)*.1,0],d=[(x+1)*.1,(y+1)*.1,0];positions.push(...a,...b,...c,...b,...d,...c)
 }
 const geometry=new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.computeVertexNormals()
 const mesh=new THREE.Mesh(geometry),context=helpers.buildTrimMeshContext(mesh),neighbors=new Map()
 for(const [key,list]of context.edgeTriangles)if(list.length===1){const[a,b]=key.split(':').map(Number);for(const[u,v]of[[a,b],[b,a]]){if(!neighbors.has(u))neighbors.set(u,[]);neighbors.get(u).push(v)}}
 const ordered=[],start=neighbors.keys().next().value;let id=start,previous=-1
 do{ordered.push(id);const next=neighbors.get(id).find(n=>n!==previous);previous=id;id=next}while(id!==start)
 const loop={childUuid:mesh.uuid,materialIndex:0,boundary:ordered.map(nodeId=>({nodeId,position:context.nodes[nodeId],normal:new THREE.Vector3(0,0,1)}))},first=loop.boundary.findIndex(s=>Math.abs(s.position.x-2)<1e-5&&s.position.y===0),last=loop.boundary.findIndex(s=>Math.abs(s.position.x-4)<1e-5&&s.position.y===0)
 const patch=patchWithCollar(context,loop,first,last,0)
 applyPatches(context,[patch])
 const welded=indexed(mesh.geometry.attributes.position.array),topology=meshTopology(welded.vertices,welded.faces)
 assert.equal(topology.nonManifold,0);assert.equal(topology.loops.length,1)
 const faces=new Set(patch.removeFaces.map(f=>f.faceIndex));assert.equal(faces.size,patch.removeFaces.length)
})
