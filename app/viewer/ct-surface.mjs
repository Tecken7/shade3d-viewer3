import { edgeTable, triTable } from 'three/examples/jsm/objects/MarchingCubes.js'

export { ctIsoLevel } from './ct-surface-options.mjs'

// Work only on a rendering copy. Original voxel samples and patient coordinates are immutable.
export function prepareCtField(volume,maxDimension=256) {
  const ratio=Math.min(1,maxDimension/Math.max(volume.width,volume.height,volume.depth))
  const dims=[volume.width,volume.height,volume.depth].map(n=>Math.max(2,Math.round(n*ratio)))
  const [nx,ny,nz]=dims,n=nx*ny*nz,field=new Float32Array(n)
  const source=volume.data,sw=volume.width,sh=volume.height,sd=volume.depth
  for(let z=0;z<nz;z++){
    const sz=Math.min(sd-1,Math.max(0,(z+.5)*sd/nz-.5)),z0=Math.floor(sz),z1=Math.min(sd-1,z0+1),fz=sz-z0
    for(let y=0;y<ny;y++){
      const sy=Math.min(sh-1,Math.max(0,(y+.5)*sh/ny-.5)),y0=Math.floor(sy),y1=Math.min(sh-1,y0+1),fy=sy-y0
      for(let x=0;x<nx;x++){
        const sx=Math.min(sw-1,Math.max(0,(x+.5)*sw/nx-.5)),x0=Math.floor(sx),x1=Math.min(sw-1,x0+1),fx=sx-x0
        const a=(z0*sh+y0)*sw,b=(z0*sh+y1)*sw,c=(z1*sh+y0)*sw,d=(z1*sh+y1)*sw
        field[(z*ny+y)*nx+x]=((source[a+x0]*(1-fx)+source[a+x1]*fx)*(1-fy)+(source[b+x0]*(1-fx)+source[b+x1]*fx)*fy)*(1-fz)+((source[c+x0]*(1-fx)+source[c+x1]*fx)*(1-fy)+(source[d+x0]*(1-fx)+source[d+x1]*fx)*fy)*fz
      }
    }
  }
  // A gentle separable [1, 6, 1]/8 filter, smaller than a full-voxel Gaussian.
  let input=field,output=new Float32Array(n)
  const strides=[1,nx,nx*ny]
  for(let axis=0;axis<3;axis++){
    const stride=strides[axis],length=dims[axis]
    for(let i=0;i<n;i++){
      const coordinate=Math.floor(i/stride)%length
      output[i]=(input[coordinate?i-stride:i]+6*input[i]+input[coordinate+1<length?i+stride:i])/8
    }
    const swap=input;input=output;output=swap
  }
  return {data:input,dims,size:[...volume.size],voxelSize:volume.size.map((v,i)=>v/dims[i])}
}

export function removeTinyCtIslands(prepared,iso,minVolume=.1) {
  const [nx,ny,nz]=prepared.dims,data=prepared.data.slice(),n=data.length,plane=nx*ny
  const minimum=Math.max(2,Math.ceil(minVolume/prepared.voxelSize.reduce((a,b)=>a*b,1)))
  const visited=new Uint8Array(n),queue=new Uint32Array(n)
  let removed=0,components=0
  for(let seed=0;seed<n;seed++){
    if(visited[seed]||data[seed]<iso)continue
    let read=0,write=1;queue[0]=seed;visited[seed]=1;components++
    while(read<write){
      const i=queue[read++],x=i%nx,y=Math.floor(i/nx)%ny,z=Math.floor(i/plane)
      const visit=j=>{if(!visited[j]&&data[j]>=iso){visited[j]=1;queue[write++]=j}}
      if(x)visit(i-1);if(x+1<nx)visit(i+1);if(y)visit(i-nx);if(y+1<ny)visit(i+nx);if(z)visit(i-plane);if(z+1<nz)visit(i+plane)
    }
    if(write<minimum){for(let i=0;i<write;i++)data[queue[i]]=0;removed+=write}
  }
  return {...prepared,data,removed,components}
}

const corners=[[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]]
const edges=[[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]]
export function extractCtSurface(prepared,iso,{maxTriangles=700000}={}) {
  const [nx,ny,nz]=prepared.dims,[sx,sy,sz]=prepared.voxelSize,field=prepared.data,plane=nx*ny
  let positions=new Float32Array(32768*3),normals=new Float32Array(32768*3),indices=new Uint32Array(65536*3),vertices=0,triangles=0
  const cache=new Map(),ids=new Int32Array(8),values=new Float32Array(8),edgeVertices=new Int32Array(12)
  const gradient=(i,x,y,z)=>[(field[x+1<nx?i+1:i]-field[x?i-1:i])/(x&&x+1<nx?2*sx:sx),(field[y+1<ny?i+nx:i]-field[y?i-nx:i])/(y&&y+1<ny?2*sy:sy),(field[z+1<nz?i+plane:i]-field[z?i-plane:i])/(z&&z+1<nz?2*sz:sz)]
  let reverse=null
  const minimum=[Infinity,Infinity,Infinity],maximum=[-Infinity,-Infinity,-Infinity]
  for(let z=0;z<nz-1;z++)for(let y=0;y<ny-1;y++)for(let x=0;x<nx-1;x++){
    let cube=0
    for(let j=0;j<8;j++){const c=corners[j],i=((z+c[2])*ny+y+c[1])*nx+x+c[0];ids[j]=i;values[j]=field[i];if(values[j]<iso)cube|=1<<j}
    const mask=edgeTable[cube];if(!mask)continue
    for(let e=0;e<12;e++){
      if(!(mask&(1<<e)))continue
      const [a,b]=edges[e],ca=corners[a],cb=corners[b],axis=ca[0]!==cb[0]?0:ca[1]!==cb[1]?1:2,key=Math.min(ids[a],ids[b])*3+axis
      let vertex=cache.get(key)
      if(vertex===undefined){
        vertex=vertices++
        if(vertices*3>positions.length){const p=new Float32Array(positions.length*2),n=new Float32Array(normals.length*2);p.set(positions);n.set(normals);positions=p;normals=n}
        const t=(iso-values[a])/(values[b]-values[a]),g1=gradient(ids[a],x+ca[0],y+ca[1],z+ca[2]),g2=gradient(ids[b],x+cb[0],y+cb[1],z+cb[2])
        const gx=-(g1[0]+(g2[0]-g1[0])*t),gy=-(g1[1]+(g2[1]-g1[1])*t),gz=-(g1[2]+(g2[2]-g1[2])*t),length=Math.hypot(gx,gy,gz)||1,v=vertex*3
        positions[v]=(x+ca[0]+(cb[0]-ca[0])*t+.5)*sx-prepared.size[0]/2
        positions[v+1]=(y+ca[1]+(cb[1]-ca[1])*t+.5)*sy-prepared.size[1]/2
        positions[v+2]=(z+ca[2]+(cb[2]-ca[2])*t+.5)*sz-prepared.size[2]/2
        for(let axis=0;axis<3;axis++){minimum[axis]=Math.min(minimum[axis],positions[v+axis]);maximum[axis]=Math.max(maximum[axis],positions[v+axis])}
        normals[v]=gx/length;normals[v+1]=gy/length;normals[v+2]=gz/length;cache.set(key,vertex)
      }
      edgeVertices[e]=vertex
    }
    const offset=cube*16
    for(let j=0;triTable[offset+j]!==-1;j+=3){
      if(triangles>=maxTriangles)throw new Error('CT_SURFACE_BUDGET')
      let a=edgeVertices[triTable[offset+j]],b=edgeVertices[triTable[offset+j+1]],c=edgeVertices[triTable[offset+j+2]]
      if(reverse===null){const ia=a*3,ib=b*3,ic=c*3,ux=positions[ib]-positions[ia],uy=positions[ib+1]-positions[ia+1],uz=positions[ib+2]-positions[ia+2],vx=positions[ic]-positions[ia],vy=positions[ic+1]-positions[ia+1],vz=positions[ic+2]-positions[ia+2];const dot=(uy*vz-uz*vy)*normals[ia]+(uz*vx-ux*vz)*normals[ia+1]+(ux*vy-uy*vx)*normals[ia+2];if(Math.abs(dot)>1e-15)reverse=dot<0}
      if(reverse){const swap=b;b=c;c=swap}
      if((triangles+1)*3>indices.length){const next=new Uint32Array(indices.length*2);next.set(indices);indices=next}
      const i=triangles++*3;indices[i]=a;indices[i+1]=b;indices[i+2]=c
    }
  }
  return {bounds:vertices?{min:minimum,max:maximum}:null,positions:positions.slice(0,vertices*3),normals:normals.slice(0,vertices*3),index:indices.slice(0,triangles*3),triangles,vertices,removedVoxels:prepared.removed||0,dims:[...prepared.dims]}
}
