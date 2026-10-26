import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as THREE from 'three'
import {computeBoundsTree,disposeBoundsTree,SAH} from 'three-mesh-bvh'
import {indexed,meshTopology} from '../app/model-builder/engine.mjs'
import {trimPlaneSurfacePath} from '../app/model-builder/trim-surface-path.mjs'
import {buildTrimRegions} from '../app/model-builder/trim-regions.mjs'
import {refreshLocalNormals} from '../app/model-builder/surface-edit.mjs'
import {buildEdgePatch,patchWithCollar} from '../app/model-builder/edge-edit.mjs'
THREE.BufferGeometry.prototype.computeBoundsTree=computeBoundsTree
THREE.BufferGeometry.prototype.disposeBoundsTree=disposeBoundsTree
const source=fs.readFileSync(new URL('../app/ClientPage.jsx',import.meta.url),'utf8'),section=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)))
const options=new Function('SAH',source.match(/const ALIGNMENT_BVH_OPTIONS = [^\r\n]+/)[0]+';return ALIGNMENT_BVH_OPTIONS')(SAH)
const helpers=new Function('THREE','ALIGNMENT_BVH_OPTIONS','buildTrimRegions','trimPlaneSurfacePath',section('const trimEdgeKey =','const repairWaitForBusyPaint')+section('function buildTrimMeshContext(','function TrimRegionPreview(')+section('function collectTrimBoundaryPoints(','function TrimBoundaryTube(')+';return {buildTrimSurfaceSplineSamples,buildTrimSurfaceSplineSegments,collectTrimBoundaryPoints,makeTrimPolylineCurve,buildTrimMeshContext,projectTrimPointToSurface,trimTriangleSurfacePath,buildTrimBoundaryPlan,resolveTrimComponentFromHit,buildTrimmedGeometryForChild,interpolateTrimCorner}')(THREE,options,buildTrimRegions,trimPlaneSurfacePath)
import {applyRepairPatchesToObject as applyPatches} from '../app/model-builder/repair-geometry.mjs'
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


function unevenTrimGrid(){
 const nodes=[],positions=[],n=40,step=.5
 for(let y=0;y<=n;y++)for(let x=0;x<=n;x++)nodes.push([x*step+(x&&x<n?Math.sin(x*19+y*7)*.16:0),y*step+(y&&y<n?Math.cos(y*17+x*11)*.16:0),0])
 for(let y=0;y<n;y++)for(let x=0;x<n;x++){const a=y*(n+1)+x,b=a+1,c=a+n+1,d=c+1;for(const ids of (x+y)%2?[[a,b,d],[a,d,c]]:[[a,b,c],[b,d,c]])ids.forEach(id=>positions.push(...nodes[id]))}
 const geometry=new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.computeVertexNormals();const mesh=new THREE.Mesh(geometry)
 return {mesh,context:helpers.buildTrimMeshContext(mesh)}
}

test('surface cut stays straight across an irregular triangle grid instead of following triangle corridors',()=>{
 const {context}=unevenTrimGrid(),a=helpers.projectTrimPointToSurface(context,[.61,1.13,0]),b=helpers.projectTrimPointToSurface(context,[18.83,17.45,0]),path=helpers.trimTriangleSurfacePath(context,a,b),line=new THREE.Line3(new THREE.Vector3(...a.point),new THREE.Vector3(...b.point))
 assert.ok(path.pieces.length>30)
 for(const p of path.points){const point=new THREE.Vector3(...p);assert.ok(point.distanceTo(line.closestPointToPoint(point,true,new THREE.Vector3()))<1e-7)}
 const length=path.points.slice(1).reduce((sum,p,i)=>sum+new THREE.Vector3(...p).distanceTo(new THREE.Vector3(...path.points[i])),0)
 assert.ok(Math.abs(length-line.distance())<1e-7)
})

test('smooth spline trim matches its displayed border and preserves a single clean boundary',()=>{
 const {mesh,context}=unevenTrimGrid(),controlPoints=[[3.12,4.28,0],[8.23,2.63,0],[15.42,4.13,0],[17.13,10.34,0],[14.76,16.23,0],[7.21,17.14,0],[2.82,11.37,0]],controls=controlPoints.map(p=>helpers.projectTrimPointToSurface(context,p)),segments=helpers.buildTrimSurfaceSplineSegments(context,controls,true,4)
 const boundary=helpers.collectTrimBoundaryPoints(segments,true),display=helpers.makeTrimPolylineCurve(boundary,true,true)
 boundary.forEach((p,i)=>assert.ok(display.getPointAt(i/boundary.length).distanceTo(new THREE.Vector3(...p))<1e-8))
 for(let i=0;i<boundary.length;i+=7){const expected=new THREE.Vector3(...boundary[i]).lerp(new THREE.Vector3(...boundary[(i+1)%boundary.length]),.5);assert.ok(display.getPointAt((i+.5)/boundary.length).distanceTo(expected)<1e-8)}
 const plan=helpers.buildTrimBoundaryPlan(context,segments),hit=helpers.projectTrimPointToSurface(context,[10,10,0]),component=helpers.resolveTrimComponentFromHit(context,plan,hit),result=helpers.buildTrimmedGeometryForChild(context,plan,component,mesh.uuid),welded=indexed(result.attributes.position.array),topology=meshTopology(welded.vertices,welded.faces)
 assert.equal(topology.nonManifold,0);assert.equal(topology.loops.length,1)
 const curve=new THREE.CatmullRomCurve3(controls.map(c=>new THREE.Vector3(...c.point)),true,'centripetal',.28),reference=curve.getPoints(12000)
 let worst=0
 for(const id of topology.loops[0]){const p=new THREE.Vector3().fromArray(welded.vertices,id*3);let nearest=Infinity;for(const q of reference)nearest=Math.min(nearest,p.distanceToSquared(q));worst=Math.max(worst,Math.sqrt(nearest))}
 assert.ok(worst<.012,'maximum border deviation '+worst+' mm')
})


test('curved horseshoe scan trims to a regular arch with a single boundary',()=>{
 const positions=[],rows=32,columns=180,point=(r,t)=>[r*Math.cos(t),r*Math.sin(t),.8*Math.sin(t*2)+.15*(r-24)]
 for(let j=0;j<rows;j++)for(let i=0;i<columns;i++){const r=18+j*12/rows,t=i*Math.PI/columns,a=point(r,t),b=point(r+12/rows,t),c=point(r,t+Math.PI/columns),d=point(r+12/rows,t+Math.PI/columns);positions.push(...a,...b,...c,...b,...d,...c)}
 const geometry=new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.computeVertexNormals();const mesh=new THREE.Mesh(geometry),context=helpers.buildTrimMeshContext(mesh),raw=[]
 for(let i=0;i<=12;i++)raw.push(point(28,.16+i*(Math.PI-.32)/12))
 for(let i=12;i>=0;i--)raw.push(point(20,.16+i*(Math.PI-.32)/12))
 const controls=raw.map(p=>helpers.projectTrimPointToSurface(context,p)),segments=helpers.buildTrimSurfaceSplineSegments(context,controls,true,4),plan=helpers.buildTrimBoundaryPlan(context,segments),hit=helpers.projectTrimPointToSurface(context,point(24,1.5)),component=helpers.resolveTrimComponentFromHit(context,plan,hit),result=helpers.buildTrimmedGeometryForChild(context,plan,component,mesh.uuid),welded=indexed(result.attributes.position.array),topology=meshTopology(welded.vertices,welded.faces)
 assert.equal(topology.nonManifold,0);assert.equal(topology.loops.length,1)
 const curve=new THREE.CatmullRomCurve3(controls.map(c=>new THREE.Vector3(...c.point)),true,'centripetal',.28),reference=curve.getPoints(14000)
 let worst=0
 for(const id of topology.loops[0]){const p=new THREE.Vector3().fromArray(welded.vertices,id*3);let nearest=Infinity;for(const q of reference)nearest=Math.min(nearest,p.distanceToSquared(q));worst=Math.max(worst,Math.sqrt(nearest))}
 assert.ok(worst<.035,'maximum curved border deviation '+worst+' mm')
})
