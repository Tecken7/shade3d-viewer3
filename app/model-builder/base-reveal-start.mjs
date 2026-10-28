import * as THREE from 'three'
import {MeshBVH} from 'three-mesh-bvh'

// A tiny flat ribbon provides accelerated nearest-segment lookup in the worker.
// Local starting heights follow the wavy scan rim, instead of one global plane
// which would reveal already-tall wall segments on the very first frame.
export function baseRevealStarts(positions,boundary){
  const vertices=[],indices=[]
  for(let i=0;i<boundary.length;i++){
    const a=boundary[i],b=boundary[(i+1)%boundary.length],dx=b[0]-a[0],dz=b[2]-a[2]
    const length=Math.hypot(dx,dz),nx=length>1e-10?-dz/length*.0001:.0001,nz=length>1e-10?dx/length*.0001:0
    vertices.push(a[0]+nx,0,a[2]+nz,a[0]-nx,0,a[2]-nz,b[0]+nx,0,b[2]+nz,b[0]-nx,0,b[2]-nz)
    const k=i*4;indices.push(k,k+1,k+2,k+1,k+3,k+2)
  }
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));geometry.setIndex(indices)
  try{
    const tree=new MeshBVH(geometry),point=new THREE.Vector3(),hit={},result=new Float32Array(positions.length/3)
    for(let i=0;i<result.length;i++){
      point.set(positions[i*3],0,positions[i*3+2]);tree.closestPointToPoint(point,hit)
      const segment=Math.floor(geometry.index.getX(hit.faceIndex*3)/4),a=boundary[segment],b=boundary[(segment+1)%boundary.length]
      const dx=b[0]-a[0],dz=b[2]-a[2],t=Math.max(0,Math.min(1,((point.x-a[0])*dx+(point.z-a[2])*dz)/Math.max(1e-20,dx*dx+dz*dz)))
      result[i]=a[1]+(b[1]-a[1])*t
    }
    return result
  }finally{geometry.dispose()}
}
