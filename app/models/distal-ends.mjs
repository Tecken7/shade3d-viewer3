import * as THREE from 'three'
import {estimateArchOrientation} from '../viewer/scan-orientation.mjs'
import {sampleContour} from '../model-builder/transition.mjs'
import {distalHolePositions} from '../model-builder/hole-placement.mjs'
export function finishedModelEnds(contour){
 const points=sampleContour(contour.map(p=>[p[0],p[2]]),.5).map(p=>new THREE.Vector3(p[0],0,p[1])),up=new THREE.Vector3(0,1,0),orientation=estimateArchOrientation(points,up)
 if(!orientation)throw Error('Nelze spolehlivě určit konce oblouku. Vypněte automatické otvory a zkontrolujte model.')
 const front=orientation.front.clone();front.y=0;front.normalize()
 const right=new THREE.Vector3().crossVectors(up,front).normalize(),center=new THREE.Vector3()
 points.forEach(p=>center.add(p));center.divideScalar(points.length)
 const aligned=contour.map(p=>{const d=new THREE.Vector3(...p).sub(center);return [d.dot(right),p[1],d.dot(front)]})
 return distalHolePositions(aligned,-1).map(p=>right.clone().multiplyScalar(p[0]).addScaledVector(front,p[2]).add(center).setY(p[1]).toArray())
}
