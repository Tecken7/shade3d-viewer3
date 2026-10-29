// A closed kernel mesh can contain distinct sheets that meet at one edge.
// STL loses their vertex identities. Open only those coincident fans by 3 µm;
// keep the printing plane exactly flat and validate the actual STL afterwards.
export function separateFloat32Contacts(positions,indices){
 const out=positions.slice(),groups=new Map(),welded=new Uint32Array(out.length/3)
 for(let i=0;i<out.length;i+=3){const key=Array.from(out.subarray(i,i+3)).join(',');if(!groups.has(key))groups.set(key,[]);const ids=groups.get(key);ids.push(i/3);welded[i/3]=ids[0]}
 const triangles=new Map()
 for(let i=0;i<indices.length;i+=3){const t=Array.from(indices.subarray(i,i+3),id=>welded[id]);if(new Set(t).size<3)continue;const key=t.slice().sort((a,b)=>a-b).join(':');if(triangles.has(key))triangles.delete(key);else triangles.set(key,t)}
 const edges=new Map(),affected=new Set()
 for(const t of triangles.values())for(let k=0;k<3;k++){const a=t[k],b=t[(k+1)%3],key=[Math.min(a,b),Math.max(a,b)].join(':');edges.set(key,(edges.get(key)||0)+1)}
 for(const [key,n]of edges)if(n!==2)key.split(':').forEach(id=>affected.add(Number(id)))
 if(!affected.size)return out
 const tangent=new Float64Array(out.length)
 for(let i=0;i<indices.length;i+=3){const ids=indices.subarray(i,i+3);for(const id of ids)if(affected.has(welded[id]))for(const other of ids)if(id!==other)for(let k=0;k<3;k++)tangent[id*3+k]+=out[other*3+k]-out[id*3+k]}
 for(const ids of groups.values())if(ids.length>1&&affected.has(ids[0]))for(const id of ids){const o=id*3,dx=tangent[o],dy=Math.abs(out[o+1])<.001?0:tangent[o+1],dz=tangent[o+2],length=Math.hypot(dx,dy,dz);if(length>1e-10){out[o]+=dx/length*.003;out[o+1]+=dy/length*.003;out[o+2]+=dz/length*.003}}
 return out
}
