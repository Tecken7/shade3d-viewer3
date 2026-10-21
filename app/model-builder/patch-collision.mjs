import * as THREE from 'three'
import {MeshBVH,ExtendedTriangle} from 'three-mesh-bvh'

function collisionTree(context,loop){
 if(context._patchCollision)return context._patchCollision
 const nodes=context.nodes||[]
 if(!nodes.length)loop.boundary.forEach(s=>nodes[s.nodeId]=s.position)
 const geometry=new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(nodes.flatMap(p=>p.toArray()),3))
 geometry.setIndex(context.triangles.flatMap(t=>t.nodeIds))
 context._patchCollision=new MeshBVH(geometry,{indirect:true,maxLeafTris:8})
 return context._patchCollision
}
const cross=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x)
function overlapArea(one,two,normal){
 const drop=Math.abs(normal.x)>Math.abs(normal.y)?(Math.abs(normal.x)>Math.abs(normal.z)?0:2):(Math.abs(normal.y)>Math.abs(normal.z)?1:2)
 const project=p=>new THREE.Vector2(...p.toArray().filter((_,i)=>i!==drop))
 let polygon=[one.a,one.b,one.c].map(project);const clip=[two.a,two.b,two.c].map(project),sign=Math.sign(cross(...clip))
 for(let i=0;i<3;i++){
  const a=clip[i],b=clip[(i+1)%3],next=[]
  for(let j=0;j<polygon.length;j++){
   const p=polygon[j],q=polygon[(j+1)%polygon.length],dp=cross(a,b,p)*sign,dq=cross(a,b,q)*sign
   if(dp>=-1e-12)next.push(p)
   if((dp<0&&dq>0)||(dp>0&&dq<0))next.push(p.clone().lerp(q,dp/(dp-dq)))
  }
  polygon=next;if(polygon.length<3)return 0
 }
 return Math.abs(polygon.reduce((sum,p,i)=>{const q=polygon[(i+1)%polygon.length];return sum+p.x*q.y-p.y*q.x},0))*.5
}

// Contacts on the welded attachment edge are expected. Positive-area overlap,
// crossings away from that edge, and a second near-parallel skin are rejected.
export function assertPatchClear(context,loop,samples,faces,spacing,checkNear=true){
 const tree=collisionTree(context,loop),triangle=new ExtendedTriangle(),normal=new THREE.Vector3(),sourceNormal=new THREE.Vector3(),line=new THREE.Line3(),closest=new THREE.Vector3(),bary=new THREE.Vector3(),epsilon=2e-5
 const clearance=Math.min(.025,spacing*.12)
 for(const face of faces){
  const points=face.map(id=>samples[id].position);triangle.set(...points);triangle.needsUpdate=true;triangle.getNormal(normal)
  const box=new THREE.Box3().setFromPoints(points).expandByScalar(clearance),center=triangle.getMidpoint(new THREE.Vector3())
  const collision=tree.shapecast({intersectsBounds:bounds=>bounds.intersectsBox(box),intersectsTriangle:source=>{
   source.getNormal(sourceNormal)
   const parallel=Math.abs(sourceNormal.dot(normal)),planeDistance=Math.abs(sourceNormal.dot(triangle.a.clone().sub(source.a)))
   if(parallel>1-1e-6&&planeDistance<epsilon){
    return overlapArea(triangle,source,normal)>Math.max(1e-11,Math.min(source.getArea(),triangle.getArea())*1e-5)
   }
   if(triangle.intersectsTriangle(source,line,true)&&line.distance()>epsilon){
    const seam=face.map((id,i)=>[samples[id],samples[face[(i+1)%3]]]).filter(([a,b])=>a.nodeId!==undefined&&b.nodeId!==undefined&&context.edgeTriangles.get(a.nodeId<b.nodeId?`${a.nodeId}:${b.nodeId}`:`${b.nodeId}:${a.nodeId}`)?.length===1)
    if(seam.some(([a,b])=>{const edge=new THREE.Line3(a.position,b.position);return [line.start,line.end].every(p=>edge.closestPointToPoint(p,true,new THREE.Vector3()).distanceTo(p)<.001)}))return false
    const shared=points.filter(p=>[source.a,source.b,source.c].some(q=>p.distanceToSquared(q)<epsilon*epsilon))
    if(shared.length<2)return true
    const rim=new THREE.Line3(shared[0],shared[1])
    if(rim.closestPointToPoint(line.start,true,new THREE.Vector3()).distanceTo(line.start)>epsilon||rim.closestPointToPoint(line.end,true,new THREE.Vector3()).distanceTo(line.end)>epsilon)return true
   }
   if(checkNear&&parallel>.9&&!points.some(p=>[source.a,source.b,source.c].some(q=>p.distanceToSquared(q)<epsilon*epsilon))){
    source.closestPointToPoint(center,closest)
    if(center.distanceTo(closest)<clearance){source.getBarycoord(closest,bary);if(Math.min(bary.x,bary.y,bary.z)>1e-4)return true}
   }
   return false
  }})
  if(collision)throw new Error('Doplnění by překrývalo existující povrch. Pro výstupek použijte Odstranit artefakt, nebo upravte označení zářezu.')
 }
}
