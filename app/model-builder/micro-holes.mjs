import * as THREE from 'three'

const edgeKey = (a, b) => a < b ? `${a}:${b}` : `${b}:${a}`

// Only sub-millimetre defects, on the same connected surface as the main rim.
// The original scan is never changed; larger/anatomical openings need review.
export function closeBaseMicroHoles(vertices, faces, loops) {
  const report = { faces, closedMicroHoles: 0, microHoleArea: 0 }
  if (loops.length < 2) return report
  const point = id => new THREE.Vector3().fromArray(vertices, id * 3)
  const perimeter = loop => loop.reduce((sum, id, i) => sum + point(id).distanceTo(point(loop[(i + 1) % loop.length])), 0)
  const main = loops.reduce((a, b) => perimeter(a) >= perimeter(b) ? a : b)
  const mainLength = perimeter(main)
  const candidates = loops.filter(loop => loop !== main && loop.length >= 3 && loop.length <= 128 && perimeter(loop) <= Math.min(1.5, mainLength / 20))
  if (!candidates.length) return report

  const parents = Int32Array.from({length: vertices.length / 3}, (_, i) => i)
  const root = id => { while (parents[id] !== id) { parents[id] = parents[parents[id]]; id = parents[id] } return id }
  for (let i = 0; i < faces.length; i += 3) {
    const a = root(faces[i]); parents[root(faces[i + 1])] = a; parents[root(faces[i + 2])] = a
  }
  const component = root(main[0])
  let output = faces
  for (const loop of candidates) {
    if (report.closedMicroHoles >= 32 || loop.some(id => root(id) !== component)) continue
    const points = loop.map(point), origin = points[0]
    const box = new THREE.Box3().setFromPoints(points)
    const diameter = box.getSize(new THREE.Vector3()).length()
    if (diameter > .35) continue
    const normal = new THREE.Vector3()
    for (let i = 0; i < points.length; i++) normal.add(points[i].clone().sub(origin).cross(points[(i + 1) % points.length].clone().sub(origin)))
    const area = normal.length() / 2
    if (area < 1e-10 || area > .04 || report.microHoleArea + area > .2) continue
    normal.normalize()
    if (points.some(p => Math.abs(p.clone().sub(origin).dot(normal)) > Math.min(.06, diameter * .25))) continue
    const u = points.reduce((a, p) => p.distanceToSquared(origin) > a.distanceToSquared(origin) ? p : a).clone().sub(origin)
    u.addScaledVector(normal, -u.dot(normal)).normalize()
    const v = normal.clone().cross(u)
    const projected = points.map(p => { const q = p.clone().sub(origin); return new THREE.Vector2(q.dot(u), q.dot(v)) })
    const cross = (a, b, c) => (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x)
    // Reject folded/self-touching contours rather than inventing their surface.
    let simple = true
    const on = (a,b,p) => Math.abs(cross(a,b,p)) < 1e-12 && p.x >= Math.min(a.x,b.x)-1e-12 && p.x <= Math.max(a.x,b.x)+1e-12 && p.y >= Math.min(a.y,b.y)-1e-12 && p.y <= Math.max(a.y,b.y)+1e-12
    for (let i=0;i<projected.length;i++) for (let j=i+1;j<projected.length;j++) {
      if (j===i+1 || (i===0 && j===projected.length-1)) continue
      const a=projected[i],b=projected[(i+1)%projected.length],c=projected[j],d=projected[(j+1)%projected.length]
      if ((cross(a,b,c)*cross(a,b,d)<0 && cross(c,d,a)*cross(c,d,b)<0) || on(a,b,c) || on(a,b,d) || on(c,d,a) || on(c,d,b)) simple=false
    }
    if (!simple) continue
    const triangles = THREE.ShapeUtils.triangulateShape(projected, [])
    // Restore contour samples omitted by Earcut on a straight edge.
    const used = new Set(triangles.flat())
    for (let id=0;id<loop.length;id++) {
      if (used.has(id)) continue
      let inserted=false
      for (let i=0;i<triangles.length && !inserted;i++) for (let k=0;k<3;k++) {
        const [a,b,c]=[triangles[i][k],triangles[i][(k+1)%3],triangles[i][(k+2)%3]]
        if (on(projected[a],projected[b],projected[id]) && projected[id].distanceToSquared(projected[a])>1e-18 && projected[id].distanceToSquared(projected[b])>1e-18) {
          triangles[i]=[a,id,c]; triangles.push([id,b,c]); used.add(id); inserted=true; break
        }
      }
    }
    if (used.size !== loop.length || triangles.length !== loop.length-2) continue
    const patch = triangles.map(t => cross(...t.map(id=>projected[id])) > 0 ? [t[0],t[2],t[1]] : t.slice()).map(t=>t.map(id=>loop[id]))
    if (patch.some(t=>point(t[1]).sub(point(t[0])).cross(point(t[2]).sub(point(t[0]))).lengthSq()<1e-20)) continue
    const edges=new Map()
    for (const t of patch) for (let k=0;k<3;k++) {
      const a=t[k],b=t[(k+1)%3],key=edgeKey(a,b)
      if (!edges.has(key)) edges.set(key,{count:0,balance:0,sourceCount:0})
      const edge=edges.get(key);edge.count++;edge.balance+=a<b?1:-1
    }
    for (let i=0;i<output.length;i+=3) for (let k=0;k<3;k++) {
      const a=output[i+k],b=output[i+(k+1)%3],edge=edges.get(edgeKey(a,b))
      if (edge) {edge.count++;edge.sourceCount++;edge.balance+=a<b?1:-1}
    }
    if ([...edges.values()].some(e=>e.count!==2 || e.balance!==0)) continue
    if (loop.some((id,i)=>edges.get(edgeKey(id,loop[(i+1)%loop.length]))?.sourceCount!==1)) continue
    if (output===faces) output=faces.slice()
    for (const t of patch) output.push(...t)
    report.closedMicroHoles++;report.microHoleArea+=area
  }
  return {...report,faces:output}
}
