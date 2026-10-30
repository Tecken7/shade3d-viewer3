import * as THREE from 'three'
import {sampleContour} from '../model-builder/transition.mjs'

export const polygonArea=p=>p.reduce((sum,a,i)=>{const b=p[(i+1)%p.length];return sum+a[0]*b[1]-b[0]*a[1]},0)/2
export function pointInPolygon(p,polygon){let inside=false;for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){const a=polygon[i],b=polygon[j];if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside}return inside}

// A tag is geometry in an STL. Detect departures from a straight/tapered wall,
// without OCR or assuming a particular font, language or export orientation.
export function detectBaseRelief(surface,contour,bevel){
 if(!(bevel>0))return []
 const points=sampleContour(contour,.3),sign=polygonArea(points)>=0?1:-1,heights=[...Array.from({length:Math.ceil((bevel+.5)/.15)},(_,i)=>.1+i*.15),bevel+1,bevel+1.5],marked=[]
 const ray=new THREE.Ray(),direction=new THREE.Vector3()
 for(let i=0;i<points.length;i++){
  const before=points[(i+points.length-2)%points.length],after=points[(i+2)%points.length],dx=after[0]-before[0],dy=after[1]-before[1],length=Math.hypot(dx,dy);if(length<1e-6)continue
  const normal=[sign*dy/length,-sign*dx/length],p=points[i],values=[]
  direction.set(-normal[0],-normal[1],0)
  for(const z of heights){ray.set(new THREE.Vector3(p[0]+normal[0]*2.5,p[1]+normal[1]*2.5,z),direction);const hits=surface.boundsTree.raycast(ray,THREE.DoubleSide,0,5).sort((a,b)=>a.distance-b.distance),hit=hits.find(h=>h.face.normal.x*normal[0]+h.face.normal.y*normal[1]>.25);if(hit)values.push({z,d:2.5-hit.distance})}
  if(values.length<5)continue
  let best=null
  for(let a=0;a<values.length;a++)for(let b=a+1;b<values.length;b++){
   if(values[b].z-values[a].z<.6)continue
   const slope=(values[b].d-values[a].d)/(values[b].z-values[a].z);if(Math.abs(slope)>.65)continue
   const intercept=values[a].d-slope*values[a].z,inliers=values.filter(v=>Math.abs(v.d-intercept-slope*v.z)<.045).length
   if(!best||inliers>best.inliers)best={slope,intercept,inliers}
  }
  if(best&&best.inliers>=Math.ceil(values.length*.5)&&values.some(v=>v.z<bevel+.4&&Math.abs(v.d-best.intercept-best.slope*v.z)>.075))marked.push(i)
 }
 // Merge nearby letters/spaces into a conservative region, with smooth round
 // ends. A false positive preserves extra original material, never deletes it.
 const expanded=new Set();for(const i of marked)for(let offset=-5;offset<=5;offset++)expanded.add((i+offset+points.length)%points.length)
 const groups=[];for(let i=0;i<points.length;i++)if(expanded.has(i)&&!expanded.has((i+points.length-1)%points.length))groups.push(i)
 if(expanded.size===points.length)return points.filter((_,i)=>i%4===0).map(center=>({center,radius:1.3,kind:'relief'}))
 const zones=[]
 for(const start of groups){let i=start,count=0;while(expanded.has(i)&&count<points.length){if(count%3===0)zones.push({center:points[i],radius:1.35,kind:'relief'});i=(i+1)%points.length;count++}}
 return zones
}

// The cavity edge wraps around implant bosses. A contact lip along that edge
// would enlarge the boss into a ring. Preserve its shoulder plus the entire
// possible 4 mm support band, rather than protecting only the central bore.
export function socketSupportRegion(bore,resinVoids){
 const xs=bore.map(p=>p[0]),ys=bore.map(p=>p[1]),center=[(Math.min(...xs)+Math.max(...xs))/2,(Math.min(...ys)+Math.max(...ys))/2]
 const boreRadius=Math.max(...bore.map(p=>Math.hypot(p[0]-center[0],p[1]-center[1]))),distances=[]
 for(let i=0;i<48;i++){
  const angle=i*Math.PI/24,dx=Math.cos(angle),dy=Math.sin(angle)
  for(let d=boreRadius+.1;d<=boreRadius+12;d+=.2){if(resinVoids.some(p=>pointInPolygon([center[0]+dx*d,center[1]+dy*d],p))){distances.push(d);break}}
 }
 distances.sort((a,b)=>a-b)
 const shoulder=distances.length>=8?distances[Math.floor(distances.length*.6)]:boreRadius+3
 return {center,radius:shoulder+4.5,kind:'socket-support'}
}
