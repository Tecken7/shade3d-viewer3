import * as THREE from 'three'

// Sample the whole circular cutter, not just its centre ray. A long side-wall
// trench can be invisible on the centre line of an otherwise open drain.
export function inspectDrainPassage(surface,point,outward,radius,outerLength=4){
 const across=new THREE.Vector3(-outward.y,outward.x,0),profiles=[],samples=[[0,0],[-.95,0],[.95,0],[-.5,0],[.5,0],[0,.85],[-.65,.55],[.65,.55]]
 const low=.2-point.z
 if(Math.abs(low)<radius){const half=Math.sqrt(radius*radius-low*low)*.9;samples.push([-half/radius,low/radius],[0,low/radius],[half/radius,low/radius])}
 let missed=0
 for(const [u,v]of samples){
  if(point.z+v*radius<.1)continue
  const origin=point.clone().addScaledVector(outward,outerLength).addScaledVector(across,u*radius);origin.z+=v*radius
  const ray=new THREE.Ray(origin,outward.clone().negate()),hits=surface.boundsTree.raycast(ray,THREE.DoubleSide,0,35).sort((a,b)=>a.distance-b.distance)
  const entry=hits.find(h=>h.face.normal.dot(ray.direction)<-.15),exit=entry&&hits.find(h=>h.distance>entry.distance+.08&&h.face.normal.dot(ray.direction)>.15)
  if(!exit){missed++;continue}
  const next=hits.find(h=>h.distance>exit.distance+.08&&h.face.normal.dot(ray.direction)<-.15)
  profiles.push({entry:entry.distance,exit:exit.distance,next:next?.distance??Infinity})
 }
 if(!profiles.length)return {confident:false,score:1000,length:10,missed:samples.length,entrySpread:Infinity,exitSpread:Infinity}
 const entries=profiles.map(p=>p.entry),exits=profiles.map(p=>p.exit),entrySpread=Math.max(...entries)-Math.min(...entries),exitSpread=Math.max(...exits)-Math.min(...exits),wall=Math.max(...profiles.map(p=>p.exit-p.entry)),desired=Math.max(...exits)+Math.max(.65,radius*.25),limit=Math.min(...profiles.map(p=>p.next))-.45
 const length=Math.max(outerLength+.5,Math.min(desired,limit)),confident=missed===0&&entrySpread<radius*.65&&exitSpread<radius*.9&&wall<Math.max(4.5,radius*1.8)&&desired<=limit
 return {confident,score:missed*35+entrySpread*2+exitSpread*2+wall*.8+(desired>limit?40:0),length,missed,entrySpread,exitSpread,wall}
}
