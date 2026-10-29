import * as THREE from 'three'
import {createTextSurfaceChart} from './text-surface-chart.mjs'

// The moving preview samples a small surface grid, then scatters the cached
// glyph vertices with plain typed-array arithmetic. Exact validation/booleans
// remain in the worker; movement never tessellates type or checks every edge.
export function updateLiveTextPreview(geometry,options,placement,surface){
 const local=geometry?.attributes.textLocal?.array,positions=geometry?.attributes.position
 if(!local||!placement||!surface?.boundsTree)return false
 let bounds=geometry.userData.textLocalBounds
 if(!bounds){bounds=new THREE.Box3().setFromBufferAttribute(geometry.attributes.textLocal);geometry.userData.textLocalBounds=bounds}
 const n=new THREE.Vector3(...placement.normal).normalize(),up=new THREE.Vector3(0,-(options.baseDirection??1),0),right=new THREE.Vector3().crossVectors(up,n)
 if(right.lengthSq()<.04)right.set(1,0,0).addScaledVector(n,-n.x)
 right.normalize();up.crossVectors(n,right).normalize()
 const angle=(options.textRotation??0)*Math.PI/180,co=Math.cos(angle),si=Math.sin(angle),width=bounds.max.x-bounds.min.x,height=bounds.max.y-bounds.min.y
 if(width<=0||height<=0||width>100)return false
 const nx=Math.min(128,Math.max(4,Math.ceil(width/.6))),ny=Math.min(32,Math.max(4,Math.ceil(height/.6))),grid=new Float32Array((nx+1)*(ny+1)*6)
 try{
  const chart=createTextSurfaceChart(surface,new THREE.Vector3(...placement.position),n,right.clone().multiplyScalar(co).addScaledVector(up,si),up.clone().multiplyScalar(co).addScaledVector(right,-si),bounds,options.textMode==='engrave'?0:options.textDepth,true,{step:.6,validate:false})
  for(let y=0;y<=ny;y++)for(let x=0;x<=nx;x++){
   const frame=chart(bounds.min.x+width*x/nx,bounds.min.y+height*y/ny),offset=(y*(nx+1)+x)*6
   frame.point.toArray(grid,offset);frame.normal.toArray(grid,offset+3)
  }
 }catch{return false}
 const out=positions.array,min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity]
 for(let i=0;i<local.length;i+=3){
  const u=Math.max(0,Math.min(nx,(local[i]-bounds.min.x)/width*nx)),v=Math.max(0,Math.min(ny,(local[i+1]-bounds.min.y)/height*ny)),x=Math.min(nx-1,Math.floor(u)),y=Math.min(ny-1,Math.floor(v)),tx=u-x,ty=v-y
  const a=(y*(nx+1)+x)*6,b=a+6,c=a+(nx+1)*6,d=c+6,wa=(1-tx)*(1-ty),wb=tx*(1-ty),wc=(1-tx)*ty,wd=tx*ty
  const normalX=grid[a+3]*wa+grid[b+3]*wb+grid[c+3]*wc+grid[d+3]*wd,normalY=grid[a+4]*wa+grid[b+4]*wb+grid[c+4]*wc+grid[d+4]*wd,normalZ=grid[a+5]*wa+grid[b+5]*wb+grid[c+5]*wc+grid[d+5]*wd
  const length=Math.hypot(normalX,normalY,normalZ)||1,z=options.textMode==='engrave'?.02+(local[i+2]+options.textDepth)/(options.textDepth+.2)*.02:local[i+2]+.015
  for(let axis=0;axis<3;axis++){
   const value=grid[a+axis]*wa+grid[b+axis]*wb+grid[c+axis]*wc+grid[d+axis]*wd+(axis===0?normalX:axis===1?normalY:normalZ)/length*z
   out[i+axis]=value;min[axis]=Math.min(min[axis],value);max[axis]=Math.max(max[axis],value)
  }
 }
 positions.needsUpdate=true
 geometry.boundingBox??=new THREE.Box3();geometry.boundingBox.min.fromArray(min);geometry.boundingBox.max.fromArray(max)
 geometry.boundingSphere??=new THREE.Sphere();geometry.boundingBox.getBoundingSphere(geometry.boundingSphere)
 return true
}

export function isTextPlacementClick(start,event){
 return !!start&&!start.moved&&event.button===0&&!event.altKey&&!event.ctrlKey&&!event.shiftKey&&Math.hypot(event.clientX-start.x,event.clientY-start.y)<=4
}
