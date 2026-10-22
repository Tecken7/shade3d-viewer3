import * as THREE from 'three'

const missing='Text přesahuje souvislý povrch. Posuňte jej nebo zmenšete písmo.'
const sharp='Na této hraně by se písmena zlomila nebo deformovala. Posuňte text na oblejší část povrchu.'

// A small intrinsic chart: horizontal distance is travelled along the surface,
// then vertical columns are transported with the local normal. Unlike a single
// view-axis projection, millimetres of type remain millimetres on a cylinder.
export function createTextSurfaceChart(surface,anchor,normal,right,up,bounds,visibleOffset=0){
 const step=.2,tree=surface.boundsTree,ray=new THREE.Ray(),rotation=new THREE.Quaternion()
 const normalAt=hit=>{
  const positions=surface.attributes.position,normals=surface.attributes.normal,index=surface.index
  if(!normals||!Number.isInteger(hit.faceIndex))return hit.face.normal.clone()
  const ids=[0,1,2].map(corner=>index?index.getX(hit.faceIndex*3+corner):hit.faceIndex*3+corner),triangle=new THREE.Triangle(...ids.map(id=>new THREE.Vector3().fromBufferAttribute(positions,id)))
  const bary=triangle.getBarycoord(hit.point,new THREE.Vector3())
  return ids.reduce((normal,id,i)=>normal.addScaledVector(new THREE.Vector3().fromBufferAttribute(normals,id),bary.getComponent(i)),new THREE.Vector3()).normalize()
 }
 const advance=(frame,direction,distance)=>{
  let point=frame.point.clone(),n=frame.normal.clone(),geometricNormal=(frame.faceNormal||frame.normal).clone(),tangent=direction.clone(),remaining=distance
  while(remaining>1e-7){
   let length=Math.min(step,remaining),accepted=null
   while(length>=.0125){
    let proposal=length,hit=null
    for(let attempt=0;attempt<3;attempt++){
     const candidate=point.clone().addScaledVector(tangent,proposal)
     ray.origin.copy(candidate).addScaledVector(n,.8);ray.direction.copy(n).negate()
     const hits=tree.raycast(ray,THREE.DoubleSide).filter(h=>h.face.normal.dot(n)>.35&&h.point.distanceTo(point)<length*2.5+.005)
     hits.sort((a,b)=>a.point.distanceToSquared(candidate)-b.point.distanceToSquared(candidate))
     hit=hits[0]
     // A ray can land exactly on a shared triangle edge and miss both faces
     // through roundoff. Only snap a very nearby point; never bridge a gap.
     if(!hit){
      const closest=tree.closestPointToPoint(candidate)
      if(closest&&closest.distance<Math.max(1e-6,length*.1)){
       const positions=surface.attributes.position,index=surface.index,triangle=new THREE.Triangle()
       for(const [corner,key]of [[0,'a'],[1,'b'],[2,'c']])triangle[key].fromBufferAttribute(positions,index?index.getX(closest.faceIndex*3+corner):closest.faceIndex*3+corner)
       const faceNormal=triangle.getNormal(new THREE.Vector3())
       if(faceNormal.dot(n)>.35)hit={point:closest.point,faceIndex:closest.faceIndex,face:{normal:faceNormal}}
      }
     }
     if(!hit)break
     hit.surfaceNormal=normalAt(hit)
     const chord=hit.point.clone().addScaledVector(hit.surfaceNormal,visibleOffset).distanceTo(point.clone().addScaledVector(n,visibleOffset))
     if(chord<1e-8){hit=null;break}
     if(Math.abs(chord-length)<length*.003)break
     proposal*=length/chord
    }
    if(hit&&hit.surfaceNormal.dot(n)>Math.cos(Math.PI/7)&&hit.face.normal.dot(geometricNormal)>Math.cos(Math.PI/4)){
     accepted=hit;break
    }
    length/=2
   }
   if(!accepted)throw new Error(sharp)
   const nextNormal=accepted.surfaceNormal.clone().normalize()
   rotation.setFromUnitVectors(n,nextNormal)
   tangent.applyQuaternion(rotation).addScaledVector(nextNormal,-tangent.dot(nextNormal)).normalize()
   point.copy(accepted.point);n.copy(nextNormal);geometricNormal.copy(accepted.face.normal);remaining-=length
  }
  return {point,normal:n,tangent,faceNormal:geometricNormal}
 }
 const lowX=Math.floor(bounds.min.x/step),highX=Math.ceil(bounds.max.x/step),lowY=Math.floor(bounds.min.y/step),highY=Math.ceil(bounds.max.y/step)
 if((highX-lowX+1)*(highY-lowY+1)>60000)throw new Error('Text je pro obalení povrchu příliš velký. Zmenšete jej.')
 const columns=new Map(),baseline=new Map([[0,{point:anchor.clone(),normal:normal.clone(),tangent:right.clone()}]])
 for(const sign of [-1,1])for(let x=sign;sign<0?x>=lowX:x<=highX;x+=sign){
  const previous=baseline.get(x-sign),frame=advance(previous,previous.tangent.clone().multiplyScalar(sign),step)
  frame.tangent.multiplyScalar(sign);baseline.set(x,frame)
 }
 for(let x=lowX;x<=highX;x++){
  const base=baseline.get(x),vertical=new THREE.Vector3().crossVectors(base.normal,base.tangent).normalize()
  if(vertical.dot(up)<0)vertical.negate()
  const column=new Map([[0,{...base,tangent:vertical}]])
  for(const sign of [-1,1])for(let y=sign;sign<0?y>=lowY:y<=highY;y+=sign){
   const previous=column.get(y-sign),frame=advance(previous,previous.tangent.clone().multiplyScalar(sign),step)
   frame.tangent.multiplyScalar(sign);column.set(y,frame)
  }
  columns.set(x,column)
 }
 // Curved sheets cannot always accept flat lettering without strain (e.g. a
 // large word on a tiny spherical cusp). Reject it instead of stretching ink.
 for(let x=lowX;x<highX;x++)for(let y=lowY;y<highY;y++){
  const visible=frame=>frame.point.clone().addScaledVector(frame.normal,visibleOffset)
  const p=visible(columns.get(x).get(y)),dx=visible(columns.get(x+1).get(y)).sub(p),dy=visible(columns.get(x).get(y+1)).sub(p)
  if(Math.abs(dx.length()/step-1)>.1||Math.abs(dy.length()/step-1)>.1||Math.abs(dx.dot(dy))/(dx.length()*dy.length())>.12)throw new Error('Zakřivení by změnilo proporce písmen. Zmenšete text nebo vyberte rovnoměrnější povrch.')
 }
 return (x,y)=>{
  const fx=Math.max(lowX,Math.min(highX,x/step)),fy=Math.max(lowY,Math.min(highY,y/step)),ix=Math.min(highX-1,Math.floor(fx)),iy=Math.min(highY-1,Math.floor(fy)),tx=fx-ix,ty=fy-iy
  const a=columns.get(ix)?.get(iy),b=columns.get(ix+1)?.get(iy),c=columns.get(ix)?.get(iy+1),d=columns.get(ix+1)?.get(iy+1)
  if(!a||!b||!c||!d)throw new Error(missing)
  const blend=key=>a[key].clone().multiplyScalar((1-tx)*(1-ty)).addScaledVector(b[key],tx*(1-ty)).addScaledVector(c[key],(1-tx)*ty).addScaledVector(d[key],tx*ty)
  return {point:blend('point'),normal:blend('normal').normalize()}
 }
}

// Split all shared long edges together, so the wrapped solid stays conforming
// and straight strokes follow the curve rather than cutting a long chord.
export function tessellateText(geometry,maxEdge=.35){
 const points=[],ids=new Map(),faces=[],a=geometry.attributes.position
 for(let i=0;i<a.count;i++){
  const p=[a.getX(i),a.getY(i),a.getZ(i)],key=p.map(v=>v.toFixed(7)).join(':')
  if(!ids.has(key)){ids.set(key,points.length);points.push(p)}faces.push(ids.get(key))
 }
 let triangles=[];for(let i=0;i<faces.length;i+=3)triangles.push(faces.slice(i,i+3))
 for(let pass=0;pass<12;pass++){
  const edges=new Map(),key=(a,b)=>a<b?`${a}:${b}`:`${b}:${a}`
  for(const face of triangles)for(let i=0;i<3;i++){
   const a=face[i],b=face[(i+1)%3],k=key(a,b)
   if(edges.has(k)||new THREE.Vector3(...points[a]).distanceTo(new THREE.Vector3(...points[b]))<=maxEdge)continue
   edges.set(k,points.length);points.push(points[a].map((v,j)=>(v+points[b][j])/2))
  }
  if(!edges.size)break
  const next=[]
  for(const [a,b,c]of triangles){
   const ab=edges.get(key(a,b)),bc=edges.get(key(b,c)),ca=edges.get(key(c,a)),count=[ab,bc,ca].filter(v=>v!==undefined).length
   if(!count)next.push([a,b,c])
   else if(count===3)next.push([a,ab,ca],[ab,b,bc],[ca,bc,c],[ab,bc,ca])
   else if(count===1){
    if(ab!==undefined)next.push([a,ab,c],[ab,b,c])
    else if(bc!==undefined)next.push([b,bc,a],[bc,c,a])
    else next.push([c,ca,b],[ca,a,b])
   }else{
    if(ca===undefined)next.push([b,bc,ab],[a,ab,c],[ab,bc,c])
    else if(ab===undefined)next.push([c,ca,bc],[b,bc,a],[bc,ca,a])
    else next.push([a,ab,ca],[c,ca,b],[ca,ab,b])
   }
  }
  triangles=next
  if(triangles.length>250000)throw new Error('Text má příliš mnoho detailů. Zkraťte jej nebo zmenšete písmo.')
 }
 return new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(triangles.flatMap(face=>face.flatMap(id=>points[id])),3))
}
