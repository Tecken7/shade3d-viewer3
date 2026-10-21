import * as THREE from 'three'

const edge=(a,b)=>a<b?`${a}:${b}`:`${b}:${a}`
const cross=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x)
function edgesOf(faces){
 const edges=new Map()
 faces.forEach((f,i)=>f.forEach((a,e)=>{const b=f[(e+1)%3],key=edge(a,b);if(!edges.has(key))edges.set(key,[]);edges.get(key).push({face:i,a,b,c:f[(e+2)%3]})}))
 return edges
}
export function patchSpacing(context,arc){
 const ids=new Set(arc.map(s=>s.nodeId)),lengths=[]
 for(const t of context.triangles){if(!t.nodeIds.some(id=>ids.has(id)))continue
  for(let e=0;e<3;e++){
   const a=t.corners?.[e]?.sourcePos,b=t.corners?.[(e+1)%3]?.sourcePos
   if(a&&b){const d=Math.hypot(...a.map((v,k)=>v-b[k]));if(d>1e-5)lengths.push(d)}
  }
 }
 if(!lengths.length)for(let i=1;i<arc.length;i++)lengths.push(arc[i].position.distanceTo(arc[i-1].position))
 lengths.sort((a,b)=>a-b)
 return Math.max(.06,Math.min(.3,lengths[Math.floor(lengths.length/2)]||.15))
}

export function remeshPatch(samples,input,boundaryCount,target,axis,inward,normal,arcCount){
 let faces=input
 const coords=samples.map(s=>new THREE.Vector2(s.position.dot(axis),s.position.dot(inward)))
 const sign=Math.sign(cross(...faces[0].map(i=>coords[i])))
 const quality=f=>{const [a,b,c]=f.map(i=>coords[i]);return Math.abs(cross(a,b,c))/(a.distanceToSquared(b)+b.distanceToSquared(c)+c.distanceToSquared(a))}
 const improve=()=>{
  for(let pass=0;pass<5;pass++){
   const edges=edgesOf(faces),locked=new Set();let count=0
   for(const list of edges.values()){
    if(list.length!==2)continue
    const [one,two]=list,{a,b,c}=one,d=two.c
    if(locked.has(one.face)||locked.has(two.face)||c===d||edges.has(edge(c,d)))continue
    const next=[[c,d,b],[d,c,a]]
    if(next.some(f=>cross(...f.map(i=>coords[i]))*sign<1e-14))continue
    if(Math.min(...next.map(quality))<=Math.min(quality(faces[one.face]),quality(faces[two.face]))*1.001)continue
    faces[one.face]=next[0];faces[two.face]=next[1];locked.add(one.face);locked.add(two.face);count++
   }
   if(!count)break
  }
 }
 improve()
 for(let pass=0;pass<12;pass++){
  const marked=new Map()
  for(const [key,list]of edgesOf(faces))if(list.length===2){
   const {a,b}=list[0]
   if(coords[a].distanceTo(coords[b])<=target*1.45)continue
   const id=samples.length,blend=name=>samples[a][name]&&samples[b][name]?samples[a][name].map((v,k)=>(v+samples[b][name][k])/2):null
   samples.push({position:samples[a].position.clone().lerp(samples[b].position,.5),color:blend('color'),uv:blend('uv')});coords.push(coords[a].clone().lerp(coords[b],.5));marked.set(key,id)
  }
  if(!marked.size)break
  if(faces.length+marked.size*2>40000)throw new Error('Oblast doplnění je příliš velká. Označte menší zářez.')
  faces=faces.flatMap(([a,b,c])=>{
   const ab=marked.get(edge(a,b)),bc=marked.get(edge(b,c)),ca=marked.get(edge(c,a)),mask=(ab!==undefined?1:0)|(bc!==undefined?2:0)|(ca!==undefined?4:0)
   return mask===0?[[a,b,c]]:mask===1?[[a,ab,c],[ab,b,c]]:mask===2?[[b,bc,a],[bc,c,a]]:mask===4?[[c,ca,b],[ca,a,b]]:mask===3?[[b,bc,ab],[a,ab,c],[ab,bc,c]]:mask===6?[[c,ca,bc],[b,bc,a],[bc,ca,a]]:mask===5?[[a,ab,ca],[c,ca,b],[ca,ab,b]]:[[a,ab,ca],[ab,b,bc],[ca,bc,c],[ab,bc,ca]]
  })
  improve()
 }
 // Remove short interior edges left by the initial constrained triangulation.
 // The link condition and signed-area check preserve a single sewn disk.
 for(let pass=0;pass<4;pass++){
  const edges=edgesOf(faces),around=samples.map(()=>new Set()),at=samples.map(()=>[]),locked=new Set(),replace=new Map()
  faces.forEach((f,i)=>f.forEach((a,e)=>{around[a].add(f[(e+1)%3]);around[a].add(f[(e+2)%3]);at[a].push(i)}))
  const candidates=[...edges.values()].filter(list=>list.length===2).sort((a,b)=>coords[a[0].a].distanceToSquared(coords[a[0].b])-coords[b[0].a].distanceToSquared(coords[b[0].b]))
  for(const list of candidates){
   let {a,b}=list[0];if(a<boundaryCount&&b<boundaryCount||locked.has(a)||locked.has(b)||coords[a].distanceTo(coords[b])>target*.55)continue
   if(b<boundaryCount)[a,b]=[b,a]
   const common=[...around[a]].filter(id=>around[b].has(id));if(common.length!==2||!list.every(f=>common.includes(f.c)))continue
   const destination=a<boundaryCount?coords[a]:coords[a].clone().lerp(coords[b],.5),affected=new Set([...at[a],...at[b]])
   if([...affected].some(i=>{const f=faces[i];if(f.includes(a)&&f.includes(b))return false;return cross(...f.map(id=>id===a||id===b?destination:coords[id]))*sign<1e-14}))continue
   if(a>=boundaryCount){samples[a].position.lerp(samples[b].position,.5);coords[a]=destination;for(const name of ['color','uv'])if(samples[a][name]&&samples[b][name])samples[a][name]=samples[a][name].map((v,k)=>(v+samples[b][name][k])/2)}
   replace.set(b,a);[a,b,...around[a],...around[b]].forEach(id=>locked.add(id))
  }
  if(!replace.size)break
  faces=faces.map(f=>f.map(id=>replace.get(id)??id)).filter(f=>new Set(f).size===3);improve()
 }
 const used=new Set(faces.flat()),remap=new Map(),kept=[],keptCoords=[]
 samples.forEach((sample,id)=>{if(id<boundaryCount||used.has(id)){remap.set(id,kept.length);kept.push(sample);keptCoords.push(coords[id])}})
 samples.splice(0,samples.length,...kept);coords.splice(0,coords.length,...keptCoords);faces=faces.map(f=>f.map(id=>remap.get(id)))
 const neighbors=samples.map(()=>new Set()),incident=samples.map(()=>[])
 faces.forEach((f,index)=>f.forEach((id,e)=>{incident[id].push(index);neighbors[id].add(f[(e+1)%3]);neighbors[id].add(f[(e+2)%3])}))
 // Relax interior samples only, with a signed-area guard. The attachment rim
 // and free lip stay exact, so refinement never leaves a T junction.
 for(let pass=0;pass<5;pass++)for(let id=boundaryCount;id<samples.length;id++){
  const mean=new THREE.Vector2();for(const n of neighbors[id])mean.add(coords[n]);mean.multiplyScalar(1/neighbors[id].size).lerp(coords[id],.5)
  if(incident[id].some(f=>cross(...faces[f].map(i=>i===id?mean:coords[i]))*sign<1e-14))continue
  const delta=mean.clone().sub(coords[id]);samples[id].position.addScaledVector(axis,delta.x).addScaledVector(inward,delta.y);coords[id]=mean
 }
 const ids=Array.from({length:samples.length-boundaryCount},(_,i)=>i+boundaryCount),lookup=new Map(ids.map((id,i)=>[id,i])),heights=samples.map(s=>s.position.dot(normal))
 const rows=ids.map(id=>[...neighbors[id]]),weights=[],desired=[]
 for(const id of ids){
  let best=Infinity,guide=null
  for(let j=0;j<arcCount;j++){const d=coords[id].distanceToSquared(coords[j]);if(d<best){best=d;guide=j}}
  const n=samples[guide]?.normal,nz=n?.dot(normal)||0
  const influence=Math.max(0,1-Math.sqrt(best)/.8)**2
  weights.push(Math.abs(nz)>.25?.08*influence:0)
  const dx=coords[id].x-coords[guide].x,dy=coords[id].y-coords[guide].y
  desired.push(heights[guide]+Math.max(-.5,Math.min(.5,Math.abs(nz)>.25?-(n.dot(axis)*dx+n.dot(inward)*dy)/nz:0)))
 }
 const linked=rows.map(row=>row.filter(id=>lookup.has(id)).map(id=>lookup.get(id)))
 const apply=x=>rows.map((row,i)=>(row.length+weights[i])*x[i]-linked[i].reduce((sum,n)=>sum+x[n],0))
 const rhs=rows.map((row,i)=>row.reduce((sum,id)=>sum+(id<boundaryCount?heights[id]:0),weights[i]*desired[i]))
 const x=ids.map(id=>heights[id]),ax=apply(x),r=rhs.map((v,i)=>v-ax[i]);let direction=r.slice(),rr=r.reduce((s,v)=>s+v*v,0)
 for(let iter=0;iter<180&&rr>1e-12;iter++){
  const ad=apply(direction),den=direction.reduce((s,v,i)=>s+v*ad[i],0);if(den<=0)break
  const alpha=rr/den;x.forEach((_,i)=>{x[i]+=alpha*direction[i];r[i]-=alpha*ad[i]})
  const next=r.reduce((s,v)=>s+v*v,0),beta=next/rr;direction=r.map((v,i)=>v+beta*direction[i]);rr=next
 }
 ids.forEach((id,i)=>samples[id].position.addScaledVector(normal,x[i]-heights[id]))
 return faces
}
