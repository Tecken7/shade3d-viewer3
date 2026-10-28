import * as THREE from 'three'
import {toCreasedNormals} from 'three/examples/jsm/utils/BufferGeometryUtils.js'

// Lightweight display profile: full outer rim toward the scan, a 45-degree
// inset at the terminal plane. It is never used for generation or export.
export function makeBaseGuideGeometry(points,bevel=0){
  const outline=points.map(p=>new THREE.Vector2(p[0],p[2]))
  const amount=Math.max(0,Math.min(2,Number(bevel)||0)),depth=Math.max(.8,amount)
  const area=THREE.ShapeUtils.area(outline),sign=area>=0?1:-1
  const foot=outline.map((p,i)=>{
    if(!amount)return p.clone()
    const prev=p.clone().sub(outline[(i+outline.length-1)%outline.length]).normalize()
    const next=outline[(i+1)%outline.length].clone().sub(p).normalize()
    const normal=new THREE.Vector2(-prev.y,prev.x).multiplyScalar(sign)
    const bisector=normal.clone().add(new THREE.Vector2(-next.y,next.x).multiplyScalar(sign)).normalize()
    const dot=bisector.dot(normal)
    return p.clone().addScaledVector(dot>.15?bisector:normal,dot>.15?Math.min(amount/dot,amount*4):amount)
  })
  const rings=[{points:outline,y:-depth}]
  if(amount&&depth>amount)rings.push({points:outline,y:-amount})
  rings.push({points:foot,y:0})
  const positions=[],indices=[],count=outline.length
  for(const ring of rings)for(const p of ring.points)positions.push(p.x,ring.y,p.y)
  for(let r=0;r<rings.length-1;r++)for(let i=0;i<count;i++){
    const j=(i+1)%count,a=r*count+i,b=r*count+j,c=(r+1)*count+i,d=(r+1)*count+j
    indices.push(a,c,d,a,d,b)
  }
  for(const [ring,reverse] of [[0,true],[rings.length-1,false]]){
    for(const tri of THREE.ShapeUtils.triangulateShape(rings[ring].points,[])){
      const face=tri.map(i=>ring*count+i);if(reverse)face.reverse();indices.push(...face)
    }
  }
  const raw=new THREE.BufferGeometry();raw.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));raw.setIndex(indices);raw.computeVertexNormals()
  const geometry=toCreasedNormals(raw,Math.PI/6);raw.dispose();geometry.computeBoundingBox();return geometry
}
