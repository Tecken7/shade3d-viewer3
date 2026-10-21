import * as THREE from 'three'

const key=p=>`${p.x.toFixed(5)}|${p.y.toFixed(5)}|${p.z.toFixed(5)}`

// Non-indexed repair triangles still share geometric vertices. Recalculate
// smooth normals at those vertices, retaining the original shading elsewhere.
export function refreshLocalNormals(geometry, changed) {
  const position=geometry.attributes.position, index=geometry.index
  const keys=Array.from({length:position.count},(_,i)=>key(new THREE.Vector3().fromBufferAttribute(position,i)))
  const dirty=new Set(),sums=new Map(),a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3()
  const ids=index?Array.from(index.array):Array.from({length:position.count},(_,i)=>i)
  for(let f=0;f<ids.length;f+=3){
    const face=ids.slice(f,f+3)
    if(face.some(i=>changed.has(i)))face.forEach(i=>dirty.add(keys[i]))
    a.fromBufferAttribute(position,face[0]);b.fromBufferAttribute(position,face[1]);c.fromBufferAttribute(position,face[2])
    const normal=b.sub(a).cross(c.sub(a))
    for(const i of face){if(!sums.has(keys[i]))sums.set(keys[i],new THREE.Vector3());sums.get(keys[i]).add(normal)}
  }
  if(!geometry.attributes.normal){geometry.setAttribute('normal',new THREE.BufferAttribute(new Float32Array(position.count*3),3));keys.forEach(k=>dirty.add(k))}
  const normals=geometry.attributes.normal
  for(let i=0;i<position.count;i++)if(dirty.has(keys[i])){const n=sums.get(keys[i]).clone().normalize();normals.setXYZ(i,n.x,n.y,n.z)}
  normals.needsUpdate=true
}

export function applySurfacePositions(context,targets) {
  const pending=[]
  try {
    for(const [,meta]of context.childMeta){
      const mesh=meta.mesh,original=mesh.userData._baseGeom?.isBufferGeometry?mesh.userData._baseGeom:mesh.geometry
      const geometry=original.clone(),position=geometry.attributes.position,p=new THREE.Vector3(),changed=new Set()
      for(let i=0;i<position.count;i++){
        p.fromBufferAttribute(position,i).applyMatrix4(meta.childToSource)
        const target=targets.get(key(p))
        if(target&&p.distanceToSquared(target)>1e-20){p.copy(target).applyMatrix4(meta.sourceToChild);position.setXYZ(i,p.x,p.y,p.z);changed.add(i)}
      }
      if(!changed.size){geometry.dispose();continue}
      pending.push({mesh,geometry,backup:{mesh,geometry:mesh.geometry,visible:mesh.visible,baseGeom:mesh.userData._baseGeom,derivedGeom:mesh.userData._derivedGeom,originalColors:mesh.userData._originalColors}})
      refreshLocalNormals(geometry,changed);geometry.computeBoundingBox();geometry.computeBoundingSphere();geometry.boundsTree=null;geometry.computeBoundsTree?.({indirect:true})
    }
  }catch(error){pending.forEach(p=>p.geometry.dispose());throw error}
  for(const {mesh,geometry}of pending){mesh.geometry=geometry;mesh.userData._baseGeom=geometry;mesh.userData._derivedGeom=geometry;mesh.userData._originalColors=geometry.attributes.color?.clone()||null}
  return pending.map(p=>p.backup)
}

export function surfaceGraph(context) {
  const neighbors=context.nodes.map(()=>new Set())
  for(const t of context.triangles)for(let i=0;i<3;i++){const a=t.nodeIds[i],b=t.nodeIds[(i+1)%3];neighbors[a].add(b);neighbors[b].add(a)}
  return neighbors
}

export function smoothMarginPoints(boundary,passes=3,radius=1.2) {
  let points=boundary.map(s=>s.position.clone())
  for(let pass=0;pass<passes;pass++)points=points.map((p,i)=>{
    const sum=new THREE.Vector3();let weight=0
    for(const direction of [-1,1]){
      let distance=0,previous=i
      for(let step=0;step<points.length/2;step++){
        const next=(previous+direction+points.length)%points.length,length=points[previous].distanceTo(points[next])
        const d=distance+length/2;if(d>radius)break
        const w=Math.exp(-4*d*d/(radius*radius))*length
        sum.addScaledVector(points[previous].clone().add(points[next]).multiplyScalar(.5),w);weight+=w
        distance+=length;previous=next
      }
    }
    if(!weight)return p.clone()
    const delta=sum.multiplyScalar(1/weight).sub(p).multiplyScalar(.85)
    if(delta.length()>.45)delta.setLength(.45)
    return p.clone().add(delta)
  })
  return points
}

// Harmonic fairing uses the healthy, unselected surface as a fixed boundary.
// Unlike the gentle sculpt brush, it also moves selected open-border vertices.
export function fairArtifact(context,selected) {
  const neighbors=surfaceGraph(context),ids=new Set()
  for(const face of selected)context.triangles[face]?.nodeIds.forEach(id=>ids.add(id))
  if(!ids.size)throw new Error('Nejprve štětcem označte výstupek a malé okolí.')
  if(ids.size>20000)throw new Error('Označte menší oblast kolem jednoho artefaktu.')
  if(![...ids].some(id=>[...neighbors[id]].some(n=>!ids.has(n))))throw new Error('Označte menší oblast s okolním zdravým povrchem.')
  let edges=context.edgeTriangles
  if(!edges){edges=new Map();for(const t of context.triangles)for(let i=0;i<3;i++){const a=t.nodeIds[i],b=t.nodeIds[(i+1)%3],k=a<b?`${a}:${b}`:`${b}:${a}`;edges.set(k,[...(edges.get(k)||[]),0])}}
  const boundary=context.nodes.map(()=>new Set())
  for(const [key,faces]of edges)if(faces.length===1){const [a,b]=key.split(':').map(Number);boundary[a].add(b);boundary[b].add(a)}
  const solved=new Map(),lambda=.003
  const solve=(active,links)=>{
    if(!active.length)return
    const lookup=new Map(active.map((id,i)=>[id,i])),rows=active.map(id=>[...links[id]]),linked=rows.map(row=>row.filter(id=>lookup.has(id)).map(id=>lookup.get(id))),diagonal=rows.map(row=>row.length+lambda)
    const apply=x=>active.map((id,i)=>diagonal[i]*x[i]-linked[i].reduce((sum,n)=>sum+x[n],0))
    const coordinates=[]
    for(const axis of ['x','y','z']){
      const rhs=active.map((id,i)=>rows[i].reduce((sum,n)=>sum+(!lookup.has(n)?(solved.get(n)||context.nodes[n])[axis]:0),lambda*context.nodes[id][axis]))
      const x=active.map(id=>context.nodes[id][axis]),ax=apply(x),r=rhs.map((v,i)=>v-ax[i]);let direction=r.slice(),rr=r.reduce((sum,v)=>sum+v*v,0)
      for(let iteration=0;iteration<220&&rr>1e-12;iteration++){
        const ad=apply(direction),den=direction.reduce((sum,v,i)=>sum+v*ad[i],0);if(den<=0)break
        const alpha=rr/den;x.forEach((_,i)=>{x[i]+=alpha*direction[i];r[i]-=alpha*ad[i]})
        const next=r.reduce((sum,v)=>sum+v*v,0),beta=next/rr;direction=r.map((v,i)=>v+beta*direction[i]);rr=next
      }
      coordinates.push(x)
    }
    active.forEach((id,i)=>solved.set(id,new THREE.Vector3(...coordinates.map(c=>c[i]))))
  }
  // Solve the selected rim along the rim first. Letting a free rim follow
  // interior neighbors can pull it across its own faces and fold the surface.
  const seen=new Set()
  for(const id of ids)if(boundary[id].size&&!seen.has(id)){
    const component=[id];seen.add(id)
    for(let i=0;i<component.length;i++)for(const next of boundary[component[i]])if(ids.has(next)&&!seen.has(next)){seen.add(next);component.push(next)}
    if(component.some(n=>[...boundary[n]].some(next=>!ids.has(next))))solve(component,boundary)
  }
  solve([...ids].filter(id=>!boundary[id].size),neighbors)
  const active=[...solved.keys()],targets=new Map(active.map(id=>[key(context.nodes[id]),solved.get(id)]))
  // Avoid collapsing a thin tip into zero-area faces. Back off the entire
  // operation consistently so all copies of a vertex keep their connectivity.
  for(let attempt=0;attempt<10;attempt++){
    const valid=context.triangles.every(t=>{
      if(!t.nodeIds.some(id=>ids.has(id)))return true
      const p=t.nodeIds.map(id=>targets.get(key(context.nodes[id]))||context.nodes[id])
      const normal=p[1].clone().sub(p[0]).cross(p[2].clone().sub(p[0]))
      return normal.lengthSq()>1e-22
    })
    if(valid)return targets
    active.forEach(id=>targets.get(key(context.nodes[id])).lerp(context.nodes[id],.5))
  }
  throw new Error('Tato oblast je příliš tenká. Označte i širší okolí výstupku.')
}

export const surfacePositionKey=key
