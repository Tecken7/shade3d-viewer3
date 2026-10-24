import test from "node:test"
import assert from "node:assert/strict"
import * as THREE from "three"
import { planeFromScreenStroke } from "../app/viewer/slice-drawing.mjs"
const viewport = { width: 800, height: 600 }
const anchor = new THREE.Vector3(0,0,0)
const ortho = () => { const camera = new THREE.OrthographicCamera(-40,40,30,-30,.1,1000); camera.position.set(0,0,100); camera.lookAt(anchor); camera.updateProjectionMatrix(); return camera }
const stroke = (start,end,camera=ortho(),center=anchor) => planeFromScreenStroke({start,end,camera,anchor:center,viewport})
test("horizontal and vertical strokes define different planes through the view",()=>{
 const h=stroke({x:100,y:300},{x:700,y:300}),v=stroke({x:400,y:50},{x:400,y:550})
 assert(Math.abs(h.normal.y)>.999);assert(Math.abs(v.normal.x)>.999)
 assert(Math.abs(h.plane.distanceToPoint(new THREE.Vector3(15,0,-30)))<1e-8)
 assert(Math.abs(v.plane.distanceToPoint(new THREE.Vector3(0,15,-30)))<1e-8)
})
test("plane follows the camera rather than a fixed world axis",()=>{
 const camera=ortho();camera.position.set(80,40,100);camera.lookAt(anchor)
 const result=stroke({x:150,y:120},{x:650,y:480},camera)
 assert(Math.abs(result.normal.dot(camera.getWorldDirection(new THREE.Vector3())))<1e-8)
 const x=new THREE.Vector3().setFromMatrixColumn(result.matrix,0),y=new THREE.Vector3().setFromMatrixColumn(result.matrix,1)
 assert(Math.abs(x.dot(y))<1e-8);assert(Math.abs(result.matrix.determinant()-1)<1e-8)
})
test("perspective plane contains both screen rays and the camera",()=>{
 const camera=new THREE.PerspectiveCamera(45,4/3,.1,1000);camera.position.set(25,10,100);camera.lookAt(anchor);camera.updateProjectionMatrix()
 const result=stroke({x:200,y:150},{x:600,y:450},camera)
 assert(Math.abs(result.plane.distanceToPoint(camera.position))<1e-7)
 for(const point of [{x:200,y:150},{x:600,y:450}]){ const ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2(point.x/800*2-1,1-point.y/600*2),camera);assert(Math.abs(result.normal.dot(ray.ray.direction))<1e-7) }
})
test("reversing a gesture preserves the geometric plane",()=>{
 const a={x:150,y:100},b={x:650,y:500};const forward=stroke(a,b),backward=stroke(b,a)
 assert(Math.abs(Math.abs(forward.normal.dot(backward.normal))-1)<1e-8);assert(Math.abs(forward.plane.distanceToPoint(backward.center))<1e-8)
})
test("clicks and near-zero drags never create a cut",()=>{assert.equal(stroke({x:100,y:100},{x:105,y:102}),null)})
