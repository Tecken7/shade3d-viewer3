// Browser worker sculpting. All distances are mesh units (millimetres).
export function sculptMesh(positions, indices, colors=null, uvs=null, materials=null) {
  const vertices=[],faces=[],color=[],uv=[],map=new Map(),remap=[]
  for(let i=0;i<positions.length;i+=3){
    const k=positions.slice(i,i+3).map(v=>Math.round(v*1e6)).join(',')
    if(!map.has(k)){const id=vertices.length/3;map.set(k,id);vertices.push(...positions.slice(i,i+3));if(colors)color.push(...colors.slice(i,i+3));if(uvs)uv.push(...uvs.slice(i/3*2,i/3*2+2))}
    remap.push(map.get(k))
  }
  const input=indices||positions.map((_,i)=>i).filter(i=>i<positions.length/3)
  for(let i=0;i<input.length;i+=3)faces.push(remap[input[i]],remap[input[i+1]],remap[input[i+2]])
  return {vertices,faces,colors:colors?color:null,uvs:uvs?uv:null,materials:materials||Array(faces.length/3).fill(0)}
}
const edgeKey=(a,b)=>a<b?`${a}:${b}`:`${b}:${a}`
const point=(m,id)=>m.vertices.slice(id*3,id*3+3)
const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2])
function graph(m) {
  if(m._graph)return m._graph
  const n=m.vertices.length/3,neighbors=Array.from({length:n},()=>new Set()),facesAt=Array.from({length:n},()=>[]),edges=new Map(),normals=new Float64Array(n*3)
  for(let i=0;i<m.faces.length;i+=3){
    const ids=m.faces.slice(i,i+3),[a,b,c]=ids.map(id=>point(m,id)),ab=b.map((v,k)=>v-a[k]),ac=c.map((v,k)=>v-a[k]),normal=[ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]]
    ids.forEach((id,j)=>{facesAt[id].push(i/3);for(let k=0;k<3;k++)normals[id*3+k]+=normal[k];const next=ids[(j+1)%3];neighbors[id].add(next);neighbors[next].add(id);const key=edgeKey(id,next),list=edges.get(key)||[];list.push(i/3);edges.set(key,list)})
  }
  for(let i=0;i<n;i++){const length=Math.hypot(...normals.slice(i*3,i*3+3))||1;for(let k=0;k<3;k++)normals[i*3+k]/=length}
  const boundary=Array.from({length:n},()=>[])
  for(const [key,list]of edges)if(list.length===1){const [a,b]=key.split(':').map(Number);boundary[a].push(b);boundary[b].push(a)}
  return m._graph={neighbors,facesAt,edges,normals,boundary}
}
function brushVertices(m,g,center,radius) {
  let seed=-1,best=Infinity
  for(let id=0;id<m.vertices.length/3;id++){if(!g.neighbors[id].size)continue;const d=distance(point(m,id),center);if(d<best){best=d;seed=id}}
  if(best>radius)return new Map()
  const distances=new Map([[seed,best]]),queue=[seed],visited=new Map()
  for(let i=0;i<queue.length;i++){
    const id=queue[i],d=distances.get(id)
    if(d>radius||visited.has(id)&&visited.get(id)<=d)continue
    visited.set(id,d)
    for(const next of g.neighbors[id]){
      const nextDistance=d+distance(point(m,id),point(m,next))
      if(nextDistance<=radius && nextDistance<(distances.get(next)??Infinity)){distances.set(next,nextDistance);queue.push(next)}
    }
  }
  return visited
}
function subdivide(m,marked) {
  const midpoint=new Map()
  for(const key of marked){const[a,b]=key.split(':').map(Number),id=m.vertices.length/3;midpoint.set(key,id);for(let k=0;k<3;k++)m.vertices.push((m.vertices[a*3+k]+m.vertices[b*3+k])/2);if(m.colors)for(let k=0;k<3;k++)m.colors.push((m.colors[a*3+k]+m.colors[b*3+k])/2);if(m.uvs)for(let k=0;k<2;k++)m.uvs.push((m.uvs[a*2+k]+m.uvs[b*2+k])/2)}
  const faces=[],materials=[]
  for(let i=0;i<m.faces.length;i+=3){
    const [a,b,c]=m.faces.slice(i,i+3),ab=midpoint.get(edgeKey(a,b)),bc=midpoint.get(edgeKey(b,c)),ca=midpoint.get(edgeKey(c,a))
    const mask=(ab!==undefined?1:0)|(bc!==undefined?2:0)|(ca!==undefined?4:0)
    const tris=mask===0?[[a,b,c]]:mask===1?[[a,ab,c],[ab,b,c]]:mask===2?[[b,bc,a],[bc,c,a]]:mask===4?[[c,ca,b],[ca,a,b]]:mask===3?[[b,bc,ab],[a,ab,c],[ab,bc,c]]:mask===6?[[c,ca,bc],[b,bc,a],[bc,ca,a]]:mask===5?[[a,ab,ca],[c,ca,b],[ca,ab,b]]:[[a,ab,ca],[ab,b,bc],[ca,bc,c],[ab,bc,ca]]
    for(const tri of tris){faces.push(...tri);materials.push(m.materials[i/3]||0)}
  }
  m.faces=faces;m.materials=materials;m._graph=null
}
function collapseShortEdges(m,g,selected,target) {
  const removed=new Set(),locked=new Set(),replace=new Map()
  for(const [key,list]of g.edges){
    const[a,b]=key.split(':').map(Number)
    if(list.length!==2||locked.has(a)||locked.has(b)||g.boundary[a].length||g.boundary[b].length||!selected.has(a)||!selected.has(b)||distance(point(m,a),point(m,b))>target*.4)continue
    const common=[...g.neighbors[a]].filter(id=>g.neighbors[b].has(id))
    const opposite=list.map(f=>m.faces.slice(f*3,f*3+3).find(id=>id!==a&&id!==b))
    if(common.length!==2||!opposite.every(id=>common.includes(id)))continue
    const midpoint=point(m,a).map((v,k)=>(v+m.vertices[b*3+k])/2)
    let safe=true
    const affected=new Set([...g.facesAt[a],...g.facesAt[b]])
    for(const faceId of affected){const i=faceId*3
      const tri=m.faces.slice(i,i+3);if(!tri.includes(a)&&!tri.includes(b)||tri.includes(a)&&tri.includes(b))continue
      const before=tri.map(id=>point(m,id)),after=tri.map(id=>id===a||id===b?midpoint:point(m,id))
      const cross=ps=>{const u=ps[1].map((v,k)=>v-ps[0][k]),v=ps[2].map((v,k)=>v-ps[0][k]);return[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]]}
      const n=cross(before),nn=cross(after)
      if(n.reduce((s,v,k)=>s+v*nn[k],0)<=1e-20){safe=false;break}
    }
    if(!safe)continue
    const faceKeys=new Set()
    for(const faceId of affected){const i=faceId*3,tri=m.faces.slice(i,i+3).map(id=>id===b?a:id);if(new Set(tri).size<3)continue;const k=tri.slice().sort((x,y)=>x-y).join(':');if(faceKeys.has(k)){safe=false;break}faceKeys.add(k)}
    if(!safe)continue
    for(let k=0;k<3;k++)m.vertices[a*3+k]=midpoint[k]
    replace.set(b,a);removed.add(b);[a,b,...g.neighbors[a],...g.neighbors[b]].forEach(id=>locked.add(id))
    // Keep a dab bounded even on very dense input meshes.
    if(removed.size>=32)break
  }
  if(!removed.size)return 0
  const faces=[],materials=[]
  for(let i=0;i<m.faces.length;i+=3){const t=m.faces.slice(i,i+3).map(id=>replace.get(id)??id);if(new Set(t).size===3){faces.push(...t);materials.push(m.materials[i/3])}}
  m.faces=faces;m.materials=materials;m._graph=null
  return removed.size
}
export function sculptDab(m,center,{radius=2,strength=.25,tool='add',dyntopo=false,resolution=3,invert=false}={}) {
  if(!center.every(Number.isFinite)||!Number.isFinite(radius)||radius<=0||!Number.isFinite(strength)||strength<0||strength>1||!Number.isFinite(resolution)||resolution<.1||resolution>30)throw new Error('Neplatné nastavení štětce.')
  let g=graph(m),selected=brushVertices(m,g,center,radius),split=0,collapsed=0
  if(!selected.size)return {changed:0,split,collapsed}
  if(dyntopo&&!['edge','edgeFlatten'].includes(tool)){
    const target=1/resolution
    // All incident faces share the same midpoint, including those just beyond
    // the brush. No T junctions or new open edges are introduced.
    for(let pass=0;pass<5;pass++){
      const marked=new Set()
      for(const [key]of g.edges){const[a,b]=key.split(':').map(Number);if((selected.has(a)||selected.has(b))&&distance(point(m,a),point(m,b))>target*1.33)marked.add(key)}
      if(!marked.size)break
      if(m.faces.length/3+marked.size*2>750000)throw new Error('Rozlišení je pro tuto oblast příliš vysoké. Zmenšete štětec nebo rozlišení.')
      subdivide(m,marked);split+=marked.size;g=graph(m);selected=brushVertices(m,g,center,radius)
    }
    collapsed=collapseShortEdges(m,g,selected,target)
    if(collapsed){g=graph(m);selected=brushVertices(m,g,center,radius)}
  }
  const updates=[],edgeIds=[...selected.keys()].filter(id=>g.boundary[id].length===2),mean=[0,0,0]
  edgeIds.forEach(id=>point(m,id).forEach((v,k)=>mean[k]+=v/Math.max(1,edgeIds.length)))
  let axis=[1,1,1]
  if(tool==='edgeFlatten')for(let step=0;step<12;step++){
    const next=[0,0,0];edgeIds.forEach(id=>{const p=point(m,id).map((v,k)=>v-mean[k]),dot=p.reduce((s,v,k)=>s+v*axis[k],0);p.forEach((v,k)=>next[k]+=v*dot)});const len=Math.hypot(...next)||1;axis=next.map(v=>v/len)
  }
  for(const[id,d]of selected){
    const falloff=Math.pow(Math.max(0,1-(d/radius)**2),2),p=point(m,id)
    if(['edge','edgeFlatten'].includes(tool)){
      if(g.boundary[id].length!==2)continue
      const target=tool==='edge'?p.map((_,k)=>g.boundary[id].reduce((s,n)=>s+m.vertices[n*3+k],0)/2):mean.map((v,k)=>v+axis[k]*p.reduce((sum,x,j)=>sum+(x-mean[j])*axis[j],0))
      updates.push([id,p.map((v,k)=>v+(target[k]-v)*strength*falloff*.5)])
    }else if(tool==='smooth'){
      if(g.boundary[id].length)continue
      const neighbors=[...g.neighbors[id]]
      const delta=p.map((v,k)=>neighbors.reduce((s,n)=>s+m.vertices[n*3+k],0)/neighbors.length-v)
      // Tangential smoothing limits shrinkage of the original scan surface.
      const normal=g.normals.slice(id*3,id*3+3),dot=delta.reduce((s,v,k)=>s+v*normal[k],0)
      updates.push([id,p.map((v,k)=>v+(delta[k]-normal[k]*dot*.8)*strength*falloff*.6)])
    }else{
      const direction=(tool==='subtract'?-1:1)*(invert?-1:1),amount=radius*.08*strength*falloff*direction
      updates.push([id,p.map((v,k)=>v+g.normals[id*3+k]*amount)])
    }
  }
  updates.forEach(([id,p])=>p.forEach((v,k)=>{m.vertices[id*3+k]=v}))
  // Refresh normals only around the changed vertices. Connectivity is reused
  // between dabs until a split/collapse actually changes the topology.
  const dirty=new Set()
  updates.forEach(([id])=>{dirty.add(id);g.neighbors[id].forEach(n=>dirty.add(n))})
  dirty.forEach(id=>{
    const sum=[0,0,0]
    for(const f of g.facesAt[id]){const [a,b,c]=m.faces.slice(f*3,f*3+3).map(i=>point(m,i)),u=b.map((v,k)=>v-a[k]),v=c.map((v,k)=>v-a[k]);sum[0]+=u[1]*v[2]-u[2]*v[1];sum[1]+=u[2]*v[0]-u[0]*v[2];sum[2]+=u[0]*v[1]-u[1]*v[0]}
    const length=Math.hypot(...sum)||1;sum.forEach((v,k)=>g.normals[id*3+k]=v/length)
  })
  return {changed:updates.length,split,collapsed}
}
export function sculptGeometry(m) {
  return {positions:new Float32Array(m.vertices),indices:new Uint32Array(m.faces),colors:m.colors?new Float32Array(m.colors):null,uvs:m.uvs?new Float32Array(m.uvs):null,materials:m.materials}
}
