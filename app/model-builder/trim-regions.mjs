import * as THREE from 'three'
const pointKey=p=>p.map(v=>Number(v.toFixed(6))).join('|')
const edgeKey=(a,b)=>{const x=pointKey(a),y=pointKey(b);return x<y?`${x}/${y}`:`${y}/${x}`}
const vector=p=>new THREE.Vector3(...p)
const clean=points=>points.filter((p,i)=>!i||vector(p).distanceToSquared(vector(points[i-1]))>1e-16)
// A chain that follows the triangle perimeter through a corner can produce
// an out-and-back polygon. It encloses no surface and has no region to label.
// Use cancellation-relative roundoff, rather than a minimum patch area, so
// genuinely small cut fragments are retained.
function hasSurfaceArea(polygon){
 if(polygon.length<3)return false
 const origin=vector(polygon[0]),area=new THREE.Vector3();let magnitude=0
 for(let i=1;i<polygon.length-1;i++){
  const cross=vector(polygon[i]).sub(origin).cross(vector(polygon[i+1]).sub(origin))
  area.add(cross);magnitude+=cross.length()
 }
 return area.length()>magnitude*Number.EPSILON*64
}
function chains(pieces){
 const edges=new Map(),points=new Map()
 for(const piece of pieces){const a=pointKey(piece.a),b=pointKey(piece.b);if(a===b)continue;points.set(a,piece.a);points.set(b,piece.b);for(const [u,v]of [[a,b],[b,a]]){if(!edges.has(u))edges.set(u,new Set());edges.get(u).add(v)}}
 const result=[]
 while([...edges.values()].some(s=>s.size)){
  const start=[...edges].find(([,s])=>s.size===1)?.[0]
  if(!start)throw new Error('Ořezová křivka tvoří smyčku uvnitř jedné plochy. Posuňte její body.')
  const chain=[points.get(start)];let current=start
  while(edges.get(current)?.size){const next=edges.get(current).values().next().value;edges.get(current).delete(next);edges.get(next).delete(current);current=next;chain.push(points.get(current))}
  result.push(clean(chain))
 }
 return result
}
function insert(poly,point){
 const p=vector(point)
 for(let i=0;i<poly.length;i++)if(p.distanceToSquared(vector(poly[i]))<1e-12){poly[i]=point;return i}
 let best=null
 for(let i=0;i<poly.length;i++){const line=new THREE.Line3(vector(poly[i]),vector(poly[(i+1)%poly.length])),distance=line.closestPointToPoint(p,true,new THREE.Vector3()).distanceToSquared(p);if(!best||distance<best.distance)best={i,distance}}
 if(best.distance>1e-10)return -1
 poly.splice(best.i+1,0,point);return best.i+1
}
function split(poly,chain){
 const copy=poly.slice();if(insert(copy,chain[0])<0||insert(copy,chain.at(-1))<0)return null
 const start=copy.findIndex(p=>pointKey(p)===pointKey(chain[0])),end=copy.findIndex(p=>pointKey(p)===pointKey(chain.at(-1)))
 if(start===end)return null
 const walk=(a,b)=>{const result=[copy[a]];for(let i=(a+1)%copy.length;i!==b;i=(i+1)%copy.length)result.push(copy[i]);result.push(copy[b]);return result}
 const a=clean([...chain,...walk(end,start).slice(1)]),b=clean([...chain].reverse().concat(walk(start,end).slice(1)))
 const trim=p=>pointKey(p[0])===pointKey(p.at(-1))?p.slice(0,-1):p
 return [trim(a),trim(b)].filter(hasSurfaceArea)
}

// A curve may enter the same triangle more than once, especially after a
// repair. Partition all its independent chains instead of dropping that face.
export function buildTrimRegions(context,plan){
 const regions=new Map(),all=[],links=new Map(),cutEdges=new Set()
 for(const [id,pieces]of plan.piecesByTriangle){
  const triangle=context.triangles[id];let polygons=[triangle.corners.map(c=>c.sourcePos)]
  for(const piece of pieces)if(pointKey(piece.a)!==pointKey(piece.b))cutEdges.add(edgeKey(piece.a,piece.b))
  try{
  for(const chain of chains(pieces)){
   let found=false
   for(let i=0;i<polygons.length;i++){const parts=split(polygons[i],chain);if(parts){polygons.splice(i,1,...parts);found=true;break}}
   if(!found)throw new Error('Ořezová křivka se v této oblasti kříží. Posuňte její body.')
  }
  }catch(error){error.triangleIndex=id;throw error}
  const records=polygons.map(polygon=>({polygon,triangleIndex:id,component:null,neighbors:new Set()}));regions.set(id,records)
  for(const record of records){
   all.push(record)
   for(let i=0;i<record.polygon.length;i++){
    const a=record.polygon[i],b=record.polygon[(i+1)%record.polygon.length],key=edgeKey(a,b)
    if(cutEdges.has(key))continue
    if(!links.has(key))links.set(key,[]);links.get(key).push(record)
    const middle=vector(a).add(vector(b)).multiplyScalar(.5)
    for(let e=0;e<3;e++){
     const u=vector(triangle.corners[e].sourcePos),v=vector(triangle.corners[(e+1)%3].sourcePos)
     if(new THREE.Line3(u,v).closestPointToPoint(middle,true,new THREE.Vector3()).distanceToSquared(middle)>1e-12)continue
     for(const next of context.edgeTriangles.get(triangle.edgeKeys[e])||[]){const component=plan.componentIds[next];if(component>=0){if(record.component!==null&&record.component!==component)throw new Error('Ořezová křivka nevytváří jednoznačnou hranici.');record.component=component}}
    }
   }
  }
 }
 for(const list of links.values())for(const a of list)for(const b of list)if(a!==b){a.neighbors.add(b);b.neighbors.add(a)}
 const queue=all.filter(r=>r.component!==null)
 for(let i=0;i<queue.length;i++)for(const next of queue[i].neighbors){if(next.component===null){next.component=queue[i].component;queue.push(next)}else if(next.component!==queue[i].component)throw new Error('Ořezová křivka obsahuje nejednoznačné propojení.')}
 if(all.some(r=>r.component===null))throw new Error('Část ořezu nemá návaznost. Posuňte křivku dále od vrcholů sítě.')
 return regions
}
