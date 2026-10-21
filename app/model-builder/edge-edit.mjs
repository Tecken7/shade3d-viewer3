import * as THREE from 'three'

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
  const originalInward = inward.clone()
  const projectedCross = (p,q,r)=>(q.x-p.x)*(r.y-p.y)-(q.y-p.y)*(r.x-p.x)
  let bestScore = Infinity
  for(const degrees of [0,-15,15,-30,30,-45,45,-60,60,-75,75]) {
    const candidate=originalInward.clone().applyAxisAngle(axis,degrees*Math.PI/180)
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
    const score=crossings*1e6-Math.abs(area)+Math.abs(degrees)*1e-4
    if(score<bestScore){bestScore=score;inward=candidate}
  }
  const normal = axis.clone().cross(inward).normalize()
  const samples = arc.map(s => ({ ...s, position: s.position.clone() }))
  const bridge = [b.toArray()]
  const count = Math.max(2, Math.min(80, Math.ceil(span / 0.35)))
  for (let i = 1; i < count; i++) {
    const t = i / count
    const position = b.clone().lerp(a, t).addScaledVector(inward, -4 * t * (1 - t) * bulge)
    const blend = name => arc.at(-1)[name] && arc[0][name] ? arc.at(-1)[name].map((v, j) => v * (1-t) + arc[0][name][j] * t) : null
    samples.push({ position, color: blend('color'), uv: blend('uv') })
    bridge.push(position.toArray())
  }
  bridge.push(a.toArray())
  const projected = samples.map(s => { const p = s.position.clone().sub(a); return new THREE.Vector2(p.dot(axis), p.dot(inward)) })
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
  const directed = new Map()
  context.triangles.forEach(t => t.nodeIds.forEach((id,i)=> {
    const next=t.nodeIds[(i+1)%3], k=key(id,next)
    if(context.edgeTriangles.get(k)?.length===1) directed.set(k,[id,next])
  }))
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
  // Add interior resolution without splitting or moving the existing rim.
  for(let pass=0;pass<2;pass++) faces=faces.flatMap(([u,v,w])=> {
    const points=[samples[u],samples[v],samples[w]], position=new THREE.Vector3()
    points.forEach(p=>position.add(p.position));position.multiplyScalar(1/3)
    const mean=name=>points.every(p=>p[name]) ? points[0][name].map((_,j)=>points.reduce((s,p)=>s+p[name][j],0)/3) : null
    const id=samples.length;samples.push({position,color:mean('color'),uv:mean('uv')})
    return [[u,v,id],[v,w,id],[w,u,id]]
  })
  const normals=samples.map(()=>new THREE.Vector3())
  faces.forEach(([u,v,w])=> { const face=samples[v].position.clone().sub(samples[u].position).cross(samples[w].position.clone().sub(samples[u].position));if(face.lengthSq()<1e-28) throw new Error('Doplnění obsahuje zkolabovanou plochu. Upravte výběr.');[u,v,w].forEach(id=>normals[id].add(face)) })
  const corners=samples.map((s,i)=>({sourcePos:s.position.toArray(),sourceNormal:normals[i].normalize().toArray(),color:s.color,uv:s.uv}))
  return { childUuid:loop.childUuid, materialIndex:loop.materialIndex, triangles:faces.map(f=>f.map(i=>corners[i])), bridge, arc:arc.map(s=>s.position.toArray()), normal:normal.toArray() }
}
