import * as THREE from 'three'
import {smoothMarginPoints,applySurfacePositions,surfaceGraph,surfacePositionKey} from './surface-edit.mjs'

import {patchSpacing,remeshPatch} from './patch-remesh.mjs'
import {assertPatchClear} from './patch-collision.mjs'

const key = (a, b) => a < b ? `${a}:${b}` : `${b}:${a}`
export function paintedEdgeSelection(loops, painted) {
  let best=[]
  loops.forEach((loop,l)=>{
    const ids=loop.boundary.map((_,i)=>i).filter(i=>painted.has(`${l}:${i}`))
    if(ids.length<2||ids.length<=best.length)return
    let gap=-1,start=0,end=0
    ids.forEach((id,i)=>{const next=ids[(i+1)%ids.length],length=(next-id+loop.boundary.length)%loop.boundary.length;if(length>gap){gap=length;start=next;end=id}})
    if(loop.boundary.length-gap<loop.boundary.length*.65)best=ids.map(index=>({loop:l,index,start,end}))
  })
  return best.length?[{loop:best[0].loop,index:best[0].start},{loop:best[0].loop,index:best[0].end}]:[]
}
export function selectEdgeArc(loop, first, last, alternate = false) {
  const n = loop.boundary.length, walk = step => {
    const out = []
    for (let i = first, guard = 0; guard <= n; guard++, i = (i + step + n) % n) {
      out.push(loop.boundary[i]); if (i === last) break
    }
    return out
  }
  const length = arc => arc.slice(1).reduce((sum, s, i) => sum + s.position.distanceTo(arc[i].position), 0)
  const arcs = [walk(1), walk(-1)].sort((a, b) => length(a) - length(b))
  return arcs[alternate ? 1 : 0]
}

// The original boundary arc stays exact. Only the new free edge and the
// interior are created; the remainder of the scan's open boundary is retained.
export function buildEdgePatch(context, loop, first, last, bulge = 0, alternate = false) {
  if (first === last) throw new Error('Označte dva různé body okraje.')
  const arc = selectEdgeArc(loop, first, last, alternate)
  if (arc.length < 3) throw new Error('Mezi body musí být zářez s alespoň jedním vrcholem.')
  const a = arc[0].position, b = arc.at(-1).position, chord = b.clone().sub(a)
  const span = chord.length()
  if (span < 0.05) throw new Error('Body jsou příliš blízko sebe.')
  if (arc.length > loop.boundary.length * 0.65) throw new Error('Vyberte kratší úsek okraje kolem jednoho zářezu.')
  const axis = chord.clone().normalize(), center = a.clone().add(b).multiplyScalar(0.5)
  let inward = new THREE.Vector3()
  arc.forEach(s => inward.add(s.position.clone().sub(center)))
  inward.addScaledVector(axis, -inward.dot(axis))
  if (inward.lengthSq() < 1e-10) throw new Error('Vybraný okraj je rovný; není zde plocha k doplnění.')
  inward.normalize()
  // A gingival rim often curls in three dimensions. Choose a local projection
  // around the chord that unfolds the rim, instead of treating every apparent
  // overlap in one arbitrary camera-independent plane as a true crossing.
  const originalInward = inward.clone(),guideNormal=new THREE.Vector3()
  arc.forEach(sample=>{if(sample.normal)guideNormal.add(sample.normal)})
  if(guideNormal.lengthSq()<1e-12){
    const ids=new Set(arc.map(s=>s.nodeId)),lookup=new Map(loop.boundary.map(s=>[s.nodeId,s.position]))
    for(const t of context.triangles)if(t.nodeIds.some(id=>ids.has(id))){const p=t.nodeIds.map(id=>context.nodes?.[id]||lookup.get(id));if(p.every(Boolean))guideNormal.add(p[1].clone().sub(p[0]).cross(p[2].clone().sub(p[0])))}
  }
  guideNormal.normalize()
  const guideInward=guideNormal.clone().cross(axis).normalize()
  if(guideInward.dot(originalInward)<0)guideInward.negate()
  const projectedCross = (p,q,r)=>(q.x-p.x)*(r.y-p.y)-(q.y-p.y)*(r.x-p.x)
  let bestScore = Infinity
  for(const degrees of [null,0,-15,15,-30,30,-45,45,-60,60,-75,75,-90,90]) {
    if(degrees===null&&guideInward.lengthSq()<.5)continue
    const candidate=degrees===null?guideInward:originalInward.clone().applyAxisAngle(axis,degrees*Math.PI/180)
    if(guideNormal.lengthSq()>.5&&Math.abs(axis.clone().cross(candidate).dot(guideNormal))<.3)continue
    const points=arc.map(s=>{const p=s.position.clone().sub(a);return new THREE.Vector2(p.dot(axis),p.dot(candidate))})
    const count=Math.max(2,Math.min(80,Math.ceil(span/.35)))
    for(let i=1;i<count;i++)points.push(new THREE.Vector2(span*(1-i/count),-4*(i/count)*(1-i/count)*bulge))
    let crossings=0,area=0
    for(let i=0;i<points.length;i++) {
      const p=points[i],q=points[(i+1)%points.length];area+=p.x*q.y-q.x*p.y
      for(let j=i+2;j<points.length;j++) {
        if(i===0&&j===points.length-1)continue
        const r=points[j],s=points[(j+1)%points.length]
        if(projectedCross(p,q,r)*projectedCross(p,q,s)<-1e-12&&projectedCross(r,s,p)*projectedCross(r,s,q)<-1e-12)crossings++
      }
    }
    const alignment=Math.abs(axis.clone().cross(candidate).dot(guideNormal))
    const score=crossings*1e6-Math.abs(area)*(1+alignment*.5)+Math.abs(degrees||0)*1e-4
    if(score<bestScore){bestScore=score;inward=candidate}
  }
  const normal = axis.clone().cross(inward).normalize()
  const spacing=patchSpacing(context,arc)
  const samples = arc.map(s => ({ ...s, position: s.position.clone() }))
  const bridge = [b.toArray()]
  const count = Math.max(2, Math.min(1200, Math.ceil(span / spacing)))
  for (let i = 1; i < count; i++) {
    const t = i / count
    const position = b.clone().lerp(a, t).addScaledVector(inward, -4 * t * (1 - t) * bulge)
    const blend = name => arc.at(-1)[name] && arc[0][name] ? arc.at(-1)[name].map((v, j) => v * (1-t) + arc[0][name][j] * t) : null
    samples.push({ position, color: blend('color'), uv: blend('uv') })
    bridge.push(position.toArray())
  }
  bridge.push(a.toArray())
  // Use exact analytic coordinates for the straight free lip. Projecting its
  // interpolated 3D positions introduces 1e-16 zigzags; earcut otherwise creates
  // zero-area ears along that line and triggers expensive false fallbacks.
  const projected = samples.map((s,i) => {
    if(i===0)return new THREE.Vector2(0,0)
    if(i===arc.length-1)return new THREE.Vector2(span,0)
    if(i>=arc.length){const t=(i-arc.length+1)/count;return new THREE.Vector2(span*(1-t),-4*t*(1-t)*bulge)}
    const p=s.position.clone().sub(a);return new THREE.Vector2(p.dot(axis),p.dot(inward))
  })
  const cross = (p, q, r) => (q.x-p.x)*(r.y-p.y)-(q.y-p.y)*(r.x-p.x)
  const n = projected.length
  for (let i=0;i<n;i++) for(let j=i+2;j<n;j++) {
    if (i===0 && j===n-1) continue
    const p=projected[i],q=projected[(i+1)%n],r=projected[j],s=projected[(j+1)%n]
    if (cross(p,q,r)*cross(p,q,s)<-1e-12 && cross(r,s,p)*cross(r,s,q)<-1e-12) throw new Error('Nová hrana kříží okraj scanu. Posuňte ji směrem ven nebo vyberte menší zářez.')
  }
  let faces = THREE.ShapeUtils.triangulateShape(projected, [])
  if (!faces.length) throw new Error('Tuto oblast se nepodařilo vyplnit. Zvolte menší úsek.')
  // Earcut can omit collinear boundary vertices. Restore them so every original
  // edge is shared exactly and no T junction is introduced at the attachment.
  let changed = true
  while(changed) {
    changed=false
    const used=new Set(faces.flat())
    outer: for(let f=0;f<faces.length;f++) for(let e=0;e<3;e++) {
      const u=faces[f][e],v=faces[f][(e+1)%3],w=faces[f][(e+2)%3]
      for(const step of [1,-1]) {
        const chain=[u]; let j=(u+step+n)%n
        while(j!==v && !used.has(j) && chain.length<n) { chain.push(j);j=(j+step+n)%n }
        if(j!==v || chain.length===1) continue
        chain.push(v)
        faces.splice(f,1,...chain.slice(1).map((id,k)=>[chain[k],id,w]));changed=true;break outer
      }
    }
  }
  const directed = context._edgePatchDirected || new Map()
  if(!context._edgePatchDirected) context.triangles.forEach(t => t.nodeIds.forEach((id,i)=> {
    const next=t.nodeIds[(i+1)%3], k=key(id,next)
    if(context.edgeTriangles.get(k)?.length===1) directed.set(k,[id,next])
  }))
  context._edgePatchDirected=directed
  let flip = null
  for(let i=0;i<arc.length-1;i++) {
    const source=directed.get(key(arc[i].nodeId,arc[i+1].nodeId))
    const hits=faces.flatMap(f=>f.map((u,e)=>[u,f[(e+1)%3]]).filter(([u,v])=>key(u,v)===key(i,i+1)))
    if(!source || hits.length!==1) throw new Error('Doplnění nenavazuje na všechny hrany scanu.')
    const same=source[0]===arc[hits[0][0]].nodeId
    if(flip!==null && flip!==same) throw new Error('Okraj má nekonzistentní orientaci. Nejprve opravte síť.')
    flip=same
  }
  if(flip) faces=faces.map(([u,v,w])=>[u,w,v])
  const areaSq = f => samples[f[1]].position.clone().sub(samples[f[0]].position).cross(samples[f[2]].position.clone().sub(samples[f[0]].position)).lengthSq()
  // Preserve collinear rim samples by flipping the interior diagonal, rather
  // than removing them (which would leave a T junction against the source).
  for(let guard=0;guard<faces.length*2;guard++) {
    const index=faces.findIndex(f=>areaSq(f)<1e-24)
    if(index<0)break
    const f=faces[index]
    const candidates=f.map((u,e)=>({u,v:f[(e+1)%3],w:f[(e+2)%3]})).sort((p,q)=>samples[q.u].position.distanceToSquared(samples[q.v].position)-samples[p.u].position.distanceToSquared(samples[p.v].position))
    let fixed=false
    for(const {u,v,w} of candidates) {
      const other=faces.findIndex((t,i)=>i!==index&&t.includes(u)&&t.includes(v))
      if(other<0)continue
      const x=faces[other].find(id=>id!==u&&id!==v), first=[u,x,w],second=[x,v,w]
      if(areaSq(first)<1e-24||areaSq(second)<1e-24)continue
      faces[index]=first;faces[other]=second;fixed=true;break
    }
    if(!fixed)throw new Error('Doplnění obsahuje zkolabovanou plochu. Upravte výběr.')
  }
  assertPatchClear(context,loop,samples,faces,spacing,false,!!context.patchCollar)
  const refined=remeshPatch(samples,faces,n,spacing,axis,inward,normal,arc.length);faces=refined.faces
  assertPatchClear(context,loop,samples,faces,refined.targetEdgeLength,true,!!context.patchCollar)
  const normals=samples.map(()=>new THREE.Vector3())
  faces.forEach(([u,v,w])=> { const face=samples[v].position.clone().sub(samples[u].position).cross(samples[w].position.clone().sub(samples[u].position));if(face.lengthSq()<1e-28) throw new Error('Doplnění obsahuje zkolabovanou plochu. Upravte výběr.');[u,v,w].forEach(id=>normals[id].add(face)) })
  const corners=samples.map((s,i)=>({sourcePos:s.position.toArray(),sourceNormal:normals[i].normalize().toArray(),color:s.color,uv:s.uv}))
  return { targetEdgeLength:refined.targetEdgeLength, childUuid:loop.childUuid, materialIndex:loop.materialIndex, triangles:faces.map(f=>f.map(i=>corners[i])), bridge, arc:arc.map(s=>s.position.toArray()), normal:normal.toArray() }
}

// Infer the mouth from the outside envelope of the painted rim. Painting a
// healthy shoulder beyond a notch must not force a chord through that shoulder.
export function inferredNotchMouth(context,loop,first,last){
 const arc=selectEdgeArc(loop,first,last),normal=new THREE.Vector3()
 arc.forEach(s=>{if(s.normal)normal.add(s.normal)})
 if(normal.lengthSq()<1e-12)return null
 normal.normalize()
 const axis=arc.at(-1).position.clone().sub(arc[0].position).normalize(),up=normal.clone().cross(axis).normalize()
 if(up.lengthSq()<.5)return null
 const points=arc.map((s,i)=>({x:s.position.dot(axis),y:s.position.dot(up),i})).sort((a,b)=>a.x-b.x||a.y-b.y)
 const cross=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x),half=pts=>{const h=[];for(const p of pts){while(h.length>1&&cross(h.at(-2),h.at(-1),p)<=0)h.pop();h.push(p)}return h}
 const lower=half(points),upper=half(points.slice().reverse()),hull=[...lower.slice(0,-1),...upper.slice(0,-1)]
 let best=null
 for(let i=0;i<hull.length;i++){
  let a=hull[i].i,b=hull[(i+1)%hull.length].i;if(a>b)[a,b]=[b,a]
  if(b-a<3||a===0&&b===arc.length-1)continue
  const source=context.edgeTriangles.get(key(arc[a].nodeId,arc[a+1].nodeId))?.[0],t=context.triangles[source]
  if(!t)continue
  const offset=t.nodeIds.indexOf(arc[a].nodeId),direction=t.nodeIds[(offset+1)%3]===arc[a+1].nodeId?-1:1
  const area=new THREE.Vector3(),origin=arc[a].position
  for(let j=a;j<b;j++)area.add(arc[j].position.clone().sub(origin).cross(arc[j+1].position.clone().sub(origin)))
  const score=area.dot(normal)*direction*.5
  if(score>.015&&(!best||score>best.score))best={first:loop.boundary.indexOf(arc[a]),last:loop.boundary.indexOf(arc[b]),score}
 }
 return best
}

// Extend a painted notch to nearby healthy rim, trying the smallest local
// extension first. A failed chord is not presented as a user geometry error.
export function predictEdgePatch(context,loop,first,last,bulge=0) {
  const arc=selectEdgeArc(loop,first,last),n=loop.boundary.length
  const start=loop.boundary.indexOf(arc[0]),end=loop.boundary.indexOf(arc.at(-1))
  const step=loop.boundary[(start+1)%n]===arc[1]?1:-1
  const extend=(id,direction)=>{
    const options=[{id,d:0}];let d=0,previous=id,nextMark=.3
    for(let guard=0;guard<Math.min(n*.1,500);guard++){
      const next=(previous+direction+n)%n;d+=loop.boundary[next].position.distanceTo(loop.boundary[previous].position);previous=next
      if(d>3)break
      if(d>=nextMark){options.push({id:next,d});nextMark+=.3}
    }
    return options
  }
  const tangent=(id,direction)=>{
    let next=id,d=0
    for(let i=0;i<80&&d<.6;i++){const j=(next+direction+n)%n;d+=loop.boundary[next].position.distanceTo(loop.boundary[j].position);next=j}
    return loop.boundary[next].position.clone().sub(loop.boundary[id].position).normalize()
  }
  const candidates=extend(start,-step).flatMap(a=>extend(end,step).map(b=>{
    const axis=loop.boundary[b.id].position.clone().sub(loop.boundary[a.id].position).normalize()
    const turn=2+tangent(a.id,-step).dot(axis)-tangent(b.id,step).dot(axis)
    return {a,b,score:(a.d+b.d)*.3+Math.abs(a.d-b.d)*.1+turn*2}
  })).sort((a,b)=>a.score-b.score)
  let error
  const tried=new Set(),attempt=(a,b,bow,collar=false)=>{
    const id=[a,b,bow,collar].join(':');if(tried.has(id))return null;tried.add(id)
    try{return collar?patchWithCollar(context,loop,a,b,bow):buildEdgePatch(context,loop,a,b,bow)}catch(e){error=e;return null}
  }
  const mouth=inferredNotchMouth(context,loop,first,last)
  const mouths=mouth?[{a:{id:mouth.first},b:{id:mouth.last}}]:[]
  const ends=[...candidates.slice(0,2),{a:{id:start},b:{id:end}}].filter(({a,b})=>arc.every(sample=>selectEdgeArc(loop,a.id,b.id).includes(sample)))
  for(const {a,b} of [...mouths,...ends]){const patch=attempt(a.id,b.id,bulge);if(patch)return patch}
  // Rebuild a curled lip once, before spending time refining several outward
  // bows that still intersect that same lip. This also repairs pinched collars.
  if(context.nodes)for(const {a,b} of [...mouths,{a:{id:first},b:{id:last}}])for(const bow of bulge===0?[0,1]:[bulge]){
    const patch=attempt(a.id,b.id,bow,true);if(patch)return patch
  }
  if(bulge===0)for(const bow of [.5,1,2])for(const {a,b} of [ends[0],ends.at(-1)].filter(Boolean)){
    const patch=attempt(a.id,b.id,bow);if(patch)return {...patch,automaticBow:bow}
  }
  if(context.nodes&&bulge===0){const patch=attempt(first,last,2,true);if(patch)return patch}
  throw error||new Error('Označte okolí jednoho zářezu včetně jeho ústí.')
}

// Smooth only the longest open margin per mesh; enclosed holes and anatomy
// away from that margin stay exact. Update every copy of a shared vertex.
export function smoothScanBorder(context,loops,passes=3) {
  const chosen=new Map(),targets=new Map(),deltas=new Map()
  for(const loop of loops){const prior=chosen.get(loop.childUuid);if(!prior||loop.perimeter>prior.perimeter)chosen.set(loop.childUuid,loop)}
  for(const loop of chosen.values()){
    const points=smoothMarginPoints(loop.boundary,passes)
    loop.boundary.forEach((sample,i)=>{targets.set(surfacePositionKey(sample.position),points[i]);deltas.set(sample.nodeId,points[i].clone().sub(sample.position))})
  }
  // Blend the contour displacement into a narrow surface collar, avoiding a
  // crease immediately inside the newly rounded margin. Teeth stay unchanged.
  if(context.nodes&&context.triangles){
    const neighbors=surfaceGraph(context),distance=new Map(),owner=new Map(),queue=[]
    for(const id of deltas.keys()){distance.set(id,0);owner.set(id,id);queue.push(id)}
    for(let i=0;i<queue.length;i++){
      const id=queue[i],d=distance.get(id)
      for(const next of neighbors[id]){
        const nd=d+context.nodes[id].distanceTo(context.nodes[next])
        if(nd>=.8||nd>=(distance.get(next)??Infinity))continue
        distance.set(next,nd);owner.set(next,owner.get(id));queue.push(next)
      }
    }
    for(const [id,d]of distance)if(d>0){const p=context.nodes[id];targets.set(surfacePositionKey(p),p.clone().addScaledVector(deltas.get(owner.get(id)),(1-d/.8)**2))}
  }
  return applySurfacePositions(context,targets)
}

function healRemovedFans(context,removedIds,incident){
 const initialSize=removedIds.size
 for(let pass=0;pass<16;pass++){
  const rim=new Set();removedIds.forEach(i=>context.triangles[i].nodeIds.forEach(id=>rim.add(id)))
  const add=new Set()
  for(const id of rim){
   const remaining=new Set(incident[id].filter(i=>!removedIds.has(i))),fans=[]
   while(remaining.size){const seed=remaining.values().next().value,fan=[seed];remaining.delete(seed)
    for(let j=0;j<fan.length;j++){const t=context.triangles[fan[j]];for(const next of t.nodeIds)if(next!==id)for(const i of context.edgeTriangles.get(key(id,next))||[])if(remaining.delete(i))fan.push(i)}
    fans.push(fan)
   }
   fans.sort((a,b)=>b.length-a.length);fans.slice(1).flat().forEach(i=>add.add(i))
  }
  if(!add.size)break
  add.forEach(i=>removedIds.add(i))
  if(removedIds.size>Math.max(initialSize*4,initialSize+2000))throw new Error('Označte menší okolí jednoho zářezu.')
 }
}

function retainAttachedRemoval(context,removedIds,arc){
 const reached=new Set(),queue=[]
 for(let i=1;i<arc.length;i++)for(const face of context.edgeTriangles.get(key(arc[i-1].nodeId,arc[i].nodeId))||[])if(removedIds.has(face)&&!reached.has(face)){reached.add(face);queue.push(face)}
 for(let i=0;i<queue.length;i++){const t=context.triangles[queue[i]];t.nodeIds.forEach((a,j)=>{for(const face of context.edgeTriangles.get(key(a,t.nodeIds[(j+1)%3]))||[])if(removedIds.has(face)&&!reached.has(face)){reached.add(face);queue.push(face)}})}
 for(const face of removedIds)if(!reached.has(face))removedIds.delete(face)
}

// A narrow replacement collar removes the curled original lip before rebuilding
// it with the patch. The confirmed mesh contains one surface, not an overlay.
export function patchWithCollar(context,loop,first,last,bulge,forced=null,iteration=0){
 const cacheKey=[loop.childUuid,first,last].join(':'),cached=context._edgePatchCollar
 if(!forced&&cached?.key===cacheKey)return finishCollar(context,loop,first,last,bulge,cached,iteration)

 const arc=selectEdgeArc(loop,first,last),selected=new Set(arc.slice(1,-1).map(s=>s.nodeId)),area=new THREE.Vector3(),mean=new THREE.Vector3()
 arc.forEach((s,i)=>area.add(s.position.clone().cross(arc[(i+1)%arc.length].position)))
 const source=context.triangles.find(t=>t.nodeIds.includes(arc[0].nodeId)&&t.nodeIds.includes(arc[1].nodeId))
 if(!source)throw new Error('Doplnění nemá návaznost na okraj.')
 const offset=source.nodeIds.indexOf(arc[0].nodeId);if(source.nodeIds[(offset+1)%3]===arc[1].nodeId)area.negate()
 const near=new Map([...selected].map(id=>[id,0])),queue=[...selected],neighborsOf=context._edgePatchGraph||surfaceGraph(context)
 context._edgePatchGraph=neighborsOf
 for(let i=0;i<queue.length;i++){const id=queue[i];for(const next of neighborsOf[id]){const d=near.get(id)+context.nodes[id].distanceTo(context.nodes[next]);if(d>.3||d>=(near.get(next)??Infinity))continue;near.set(next,d);selected.add(next);queue.push(next)}}
 const removed=[],triangles=[],attributes=new Map(),removedIds=new Set()
 const incident=context._edgePatchIncident||context.nodes.map(()=>[])
 if(!context._edgePatchIncident){context.triangles.forEach((t,i)=>t.nodeIds.forEach(id=>incident[id].push(i)));context._edgePatchIncident=incident}
 selected.forEach(id=>incident[id].forEach(i=>removedIds.add(i)))
 if(forced)forced.forEach(i=>removedIds.add(i))
 healRemovedFans(context,removedIds,incident)
 retainAttachedRemoval(context,removedIds,arc)

 context.triangles.forEach((t,index)=>{
  if(removedIds.has(index)){
   const points=t.nodeIds.map(id=>context.nodes[id]);mean.add(points[1].clone().sub(points[0]).cross(points[2].clone().sub(points[0])));removed.push({childUuid:t.childUuid||loop.childUuid,faceIndex:t.faceIndex??index})
  }else triangles.push(t)
  t.nodeIds.forEach((id,i)=>{if(!attributes.has(id))attributes.set(id,t.corners[i])})
 })
 if(area.normalize().dot(mean.normalize())<.1)throw new Error('Označená oblast je výstupek. Použijte Odstranit artefakt.')
 let remaining=triangles,boundary,lastIndex,edgeTriangles
 for(let pass=0;pass<24;pass++){
  edgeTriangles=new Map();const neighbors=new Map(),faceMap=new Map()
  const faceIndex=context._edgePatchFaceIndex||new Map(context.triangles.map((t,i)=>[t,i]));context._edgePatchFaceIndex=faceIndex
  remaining.forEach((t,i)=>faceMap.set(faceIndex.get(t),i))
  const originalRim=context._edgePatchRim||[...context.edgeTriangles].filter(([,list])=>list.length===1).map(([k])=>k);context._edgePatchRim=originalRim
  const touched=new Set(originalRim)
  removedIds.forEach(i=>context.triangles[i].nodeIds.forEach((a,j)=>touched.add(key(a,context.triangles[i].nodeIds[(j+1)%3]))))
  for(const k of touched){const list=context.edgeTriangles.get(k).filter(i=>!removedIds.has(i));if(list.length===1)edgeTriangles.set(k,[faceMap.get(list[0])])}
  for(const [k,list]of edgeTriangles)if(list.length===1){const [a,b]=k.split(':').map(Number);for(const [u,v]of [[a,b],[b,a]]){if(!neighbors.has(u))neighbors.set(u,[]);neighbors.get(u).push(v)}}
  // A narrow cut can detach a tiny retained island inside its cavity. Replace
  // that island too, so it cannot leave a second skin or an unstitched hole.
  const oldRim=new Set(originalRim),checked=new Set(),islands=new Set(),groups=[]
  for(const seed of neighbors.keys()){
   if(checked.has(seed))continue
   const nodes=[seed];checked.add(seed);let changed=false
   for(let j=0;j<nodes.length;j++)for(const next of neighbors.get(nodes[j])){if(!oldRim.has(key(nodes[j],next)))changed=true;if(!checked.has(next)){checked.add(next);nodes.push(next)}}
   if(changed)groups.push(nodes)
  }
  groups.sort((a,b)=>b.length-a.length)
  // The main changed contour belongs to the scan body, even on a small mesh.
  // Secondary changed contours can surround detached retained islands.
  for(const nodes of groups.slice(1)){
   const seed=nodes[0],firstEdge=key(seed,neighbors.get(seed)[0]),t=remaining[edgeTriangles.get(firstEdge)[0]],sourceIndex=faceIndex.get(t),faces=[sourceIndex],seen=new Set(faces)
   for(let j=0;j<faces.length&&faces.length<=2000;j++){const t=context.triangles[faces[j]];t.nodeIds.forEach((a,e)=>{for(const i of context.edgeTriangles.get(key(a,t.nodeIds[(e+1)%3]))||[])if(!removedIds.has(i)&&!seen.has(i)){seen.add(i);faces.push(i)}})}
   if(faces.length<=2000)faces.forEach(i=>islands.add(i))
  }
  if(islands.size){islands.forEach(i=>removedIds.add(i));remaining=context.triangles.filter((_,i)=>!removedIds.has(i));continue}
  const closest=point=>[...neighbors.keys()].reduce((best,id)=>context.nodes[id].distanceToSquared(point)<context.nodes[best].distanceToSquared(point)?id:best,neighbors.keys().next().value)
  const start=closest(arc[0].position),end=closest(arc.at(-1).position)
  if(start===end||context.nodes[start].distanceTo(arc[0].position)>1||context.nodes[end].distanceTo(arc.at(-1).position)>1)throw new Error('Označte i zdravé okolí obou konců zářezu.')
  const ordered=[];let id=start,previous=-1
  do{if(neighbors.get(id)?.length!==2)throw new Error('Okraj vyžaduje nejprve opravu sítě.');ordered.push(id);const next=neighbors.get(id).find(n=>n!==previous);previous=id;id=next;if(ordered.length>neighbors.size)throw new Error('Okraj nelze jednoznačně spojit.')}while(id!==start)
  lastIndex=ordered.indexOf(end);if(lastIndex<0)throw new Error('Konce doplnění nejsou na stejném okraji.')
  boundary=ordered.map(nodeId=>{const a=attributes.get(nodeId);return{nodeId,position:context.nodes[nodeId],color:a?.color,uv:a?.uv,normal:a?.sourceNormal?new THREE.Vector3(...a.sourceNormal):null}})
  // Peel tiny remaining ears whose three vertices lie on the replacement rim.
  // Otherwise an ear can be triangulated backwards on top of the retained face.
  const rim=new Set(selectEdgeArc({boundary},0,lastIndex).map(s=>s.nodeId)),ears=remaining.filter(t=>t.nodeIds.every(id=>rim.has(id)))
  if(!ears.length)break
  if(pass===23)throw new Error('Zkuste označit menší okolí zářezu.')
  ears.forEach(t=>removedIds.add(faceIndex.get(t)))
  healRemovedFans(context,removedIds,incident)
 retainAttachedRemoval(context,removedIds,arc)
  remaining=context.triangles.filter((_,i)=>!removedIds.has(i))
 }
 removed.splice(0,removed.length,...[...removedIds].map(i=>({childUuid:context.triangles[i].childUuid||loop.childUuid,faceIndex:context.triangles[i].faceIndex??i})))
 const prepared={key:cacheKey,context:{nodes:context.nodes,triangles:remaining,edgeTriangles,patchCollar:true,collisionSource:context,excludedFaces:removedIds,collisionFaceMap:new Map(remaining.map((t,i)=>[context._edgePatchFaceIndex.get(t),i]))},loop:{...loop,boundary},lastIndex,removed,removedIds:[...removedIds]}
 context._edgePatchCollar=prepared
 return finishCollar(context,loop,first,last,bulge,prepared,iteration)

}

function finishCollar(context,loop,first,last,bulge,prepared,iteration){
 const remaining=prepared.context.triangles,removedIds=new Set(prepared.removedIds),incident=context._edgePatchIncident,arc=selectEdgeArc(loop,first,last)
 try{
  const patch=buildEdgePatch(prepared.context,prepared.loop,0,prepared.lastIndex,bulge)
  return {...patch,removeFaces:prepared.removed}
 }catch(error){
  const hits=(error.sourceTriangleIndices||[error.sourceTriangleIndex]).map(i=>remaining[i]).filter(Boolean)
  if(!hits.length||iteration>=4)throw error
  // Absorb only intersecting faces immediately beside the sewn rim. A curled
  // microtriangle is replaced in the same cavity; remote overlaps stay errors.
  const cut=selectEdgeArc(prepared.loop,0,prepared.lastIndex),distance=p=>Math.min(...cut.map(s=>s.position.distanceToSquared(p)))
  for(const hit of hits){
   const points=hit.nodeIds.map(id=>context.nodes[id]),center=points.reduce((sum,p)=>sum.add(p),new THREE.Vector3()).multiplyScalar(1/3)
   if(distance(center)>.18**2||Math.min(...arc.map(s=>s.position.distanceToSquared(center)))>.8**2)throw error
  }
  hits.forEach(hit=>hit.nodeIds.forEach(id=>incident[id].forEach(i=>removedIds.add(i))))
  context._edgePatchCollar=null
  return patchWithCollar(context,loop,first,last,bulge,removedIds,iteration+1)
 }
}
