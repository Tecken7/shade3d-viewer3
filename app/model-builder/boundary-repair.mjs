import * as THREE from 'three'

const edgeKey=(a,b)=>a<b?`${a}:${b}`:`${b}:${a}`
const unsafe='Hranice vyžaduje větší úpravu. Drobné vyhlazení nestačí; upravte ořez nebo síť.'

// Opt-in cleanup for tiny pinched rim fans. Removing a local fan opens a notch
// rather than welding unrelated surfaces or capping the intended base opening.
// Work on copies: both failure and disabling the option retain the source scan.
export function repairBaseBoundary(vertices,faces){
 const point=id=>new THREE.Vector3().fromArray(vertices,id*3)
 const triangles=[],area=t=>point(t[1]).sub(point(t[0])).cross(point(t[2]).sub(point(t[0]))).length()/2
 let removedDegenerate=0,removedFans=0,removedArea=0
 for(let i=0;i<faces.length;i+=3){
  const t=faces.slice(i,i+3),a=area(t)
  if(a<=1e-12){removedDegenerate++;continue}
  triangles.push(t)
 }
 let current=triangles
 for(let pass=0;pass<16;pass++){
  const edges=new Map(),incident=new Map()
  current.forEach((t,i)=>{
   for(const id of t){if(!incident.has(id))incident.set(id,[]);incident.get(id).push(i)}
   for(let k=0;k<3;k++){const a=t[k],b=t[(k+1)%3],key=edgeKey(a,b);if(!edges.has(key))edges.set(key,{a,b,faces:[]});edges.get(key).faces.push(i)}
  })
  const degree=new Map()
  for(const e of edges.values()){
   if(e.faces.length>2)throw new Error(unsafe)
   if(e.faces.length===1)for(const id of [e.a,e.b])degree.set(id,(degree.get(id)||0)+1)
  }
  const branches=[...degree].filter(([,n])=>n>2)
  if(!branches.length){
   // Compact too: deleted slivers must not contribute to model height/bounds.
   const ids=new Map(),outVertices=[],outFaces=[]
   for(const t of current)for(const id of t){if(!ids.has(id)){ids.set(id,ids.size);outVertices.push(...vertices.slice(id*3,id*3+3))}outFaces.push(ids.get(id))}
   return {vertices:outVertices,faces:outFaces,removedDegenerate,removedFans,removedArea}
  }
  const remove=new Set()
  for(const [id]of branches){
   const unseen=new Set(incident.get(id)),fans=[]
   while(unseen.size){
    const fan=[unseen.values().next().value];unseen.delete(fan[0])
    for(let j=0;j<fan.length;j++)for(const neighbor of current[fan[j]])if(neighbor!==id){
     for(const face of edges.get(edgeKey(id,neighbor)).faces)if(unseen.delete(face))fan.push(face)
    }
    fans.push(fan)
   }
   if(fans.length<2)throw new Error(unsafe)
   fans.sort((a,b)=>b.reduce((sum,i)=>sum+area(current[i]),0)-a.reduce((sum,i)=>sum+area(current[i]),0))
   const small=fans.slice(1).flat(),origin=point(id)
   if(small.length>32||small.reduce((sum,i)=>sum+area(current[i]),0)>.25||small.some(i=>current[i].some(v=>point(v).distanceTo(origin)>1)))throw new Error(unsafe)
   for(const i of small)remove.add(i)
  }
  removedFans+=remove.size;removedArea+=[...remove].reduce((sum,i)=>sum+area(current[i]),0)
  if(removedFans>128||removedArea>1)throw new Error(unsafe)
  current=current.filter((_,i)=>!remove.has(i))
 }
 throw new Error(unsafe)
}
