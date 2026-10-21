import * as THREE from 'three'

// Follow the intersection of the mesh and the local cutting plane. Unlike a
// centroid route, this crosses faces at the intended curve without stair steps.
export function trimPlaneSurfacePath(context,startHit,endHit){
 const start=new THREE.Vector3(...startHit.point),end=new THREE.Vector3(...endHit.point),direction=end.clone().sub(start),length=direction.length()
 if(length<1e-8)return null
 const faceNormal=index=>{const t=context.triangles[index],p=t.nodeIds.map(id=>context.nodes[id]);return p[1].clone().sub(p[0]).cross(p[2].clone().sub(p[0])).normalize()}
 const normal=faceNormal(startHit.triangleIndex).add(faceNormal(endHit.triangleIndex)).normalize(),planeNormal=direction.clone().cross(normal).normalize()
 if(planeNormal.lengthSq()<.5)return null
 const plane=new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal,start),line=new THREE.Line3(start,end),maxDeviation=Math.max(.4,length*.5)
 const previous=new Map([[startHit.triangleIndex,null]]),portals=new Map(),queue=[startHit.triangleIndex]
 const crossing=(one,two)=>{
  const pair=one<two?one+':'+two:two+':'+one,edge=context.sharedEdgeByPair.get(pair)
  if(!edge)return null
  const [a,b]=edge.split(':').map(id=>context.nodes[Number(id)]),da=plane.distanceToPoint(a),db=plane.distanceToPoint(b)
  // Vertex/coplanar degeneracies use the general surface-path fallback.
  if(Math.abs(da)<1e-9||Math.abs(db)<1e-9||da*db>=0)return null
  const p=a.clone().lerp(b,da/(da-db))
  return p.distanceTo(line.closestPointToPoint(p,true,new THREE.Vector3()))<=maxDeviation?p:null
 }
 for(let i=0;i<queue.length&&i<20000;i++){
  const current=queue[i];if(current===endHit.triangleIndex)break
  for(const next of context.triangleNeighbors[current]||[]){
   if(previous.has(next))continue
   const p=crossing(current,next);if(!p)continue
   previous.set(next,current);portals.set(next,p);queue.push(next)
  }
 }
 if(!previous.has(endHit.triangleIndex))return null
 const faces=[];let id=endHit.triangleIndex
 while(id!==null){faces.push(id);id=previous.get(id)}faces.reverse()
 const points=[start,...faces.slice(1).map(id=>portals.get(id)),end],distance=points.slice(1).reduce((sum,p,i)=>sum+p.distanceTo(points[i]),0)
 if(distance>length*2+1)return null
 return {points:points.map(p=>p.toArray()),pieces:faces.map((triangleIndex,i)=>({triangleIndex,a:points[i].toArray(),b:points[i+1].toArray()}))}
}
