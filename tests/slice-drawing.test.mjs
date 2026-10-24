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

test("vertical screen stroke produces an upright 2D section", () => {
 const camera=ortho(), result=stroke({x:400,y:50},{x:400,y:550},camera)
 const sectionUp=new THREE.Vector3().setFromMatrixColumn(result.matrix,1)
 assert(sectionUp.dot(new THREE.Vector3(0,1,0))>.999)
 assert(Math.abs(result.normal.x)>.999)
})

test("placing the drawn plane preserves the on-screen line through initialization", async () => {
 const {placeDrawnSlice}=await import("../app/viewer/slice-drawing.mjs")
 const camera=ortho(); camera.position.set(80,40,100); camera.up.set(.1,1,.2).normalize();camera.lookAt(anchor)
 const a={x:310,y:80}, b={x:330,y:520}, result=stroke(a,b,camera)
 const parent=new THREE.Group();parent.position.set(3,-7,9);parent.rotation.set(.3,.2,-.1)
 const rig=new THREE.Group(),plane=new THREE.Group();parent.add(rig);rig.add(plane)
 const saved=placeDrawnSlice({rig,plane,worldMatrix:result.matrix,center:anchor})
 // This is the same snapshot restore used when controls are mounted.
 saved.rigMatrix.decompose(rig.position,rig.quaternion,rig.scale)
 saved.planeMatrix.decompose(plane.position,plane.quaternion,plane.scale)
 parent.updateMatrixWorld(true)
 const n=new THREE.Vector3(0,0,1).transformDirection(plane.matrixWorld)
 const actual=new THREE.Plane().setFromNormalAndCoplanarPoint(n,new THREE.Vector3().setFromMatrixPosition(plane.matrixWorld))
 assert(Math.abs(Math.abs(actual.normal.dot(result.normal))-1)<1e-8)
 for(const point of [a,b]){
  const ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2(point.x/800*2-1,1-point.y/600*2),camera)
  assert(Math.abs(actual.normal.dot(ray.ray.direction))<1e-8)
  assert(Math.abs(actual.distanceToPoint(ray.ray.origin))<1e-8)
 }
})

test("repeated missing DICOM payloads never reset scan section matrices", async () => {
 const {sliceSourceChanged}=await import("../app/viewer/slice-drawing.mjs")
 assert.equal(sliceSourceChanged(null,null),false)
 assert.equal(sliceSourceChanged(undefined,null),false)
 assert.equal(sliceSourceChanged({u:"ct.zip"},{u:"ct.zip"}),false)
 assert.equal(sliceSourceChanged({u:"ct.zip"},null),true)
 assert.equal(sliceSourceChanged(null,{u:"ct.zip"}),true)
 assert.equal(sliceSourceChanged({u:"a.zip"},{u:"b.zip"}),true)
})

test("section surface follows offset and size without changing the plane", async () => {
 const {sliceSurfaceFit}=await import("../app/viewer/slice-drawing.mjs")
 const small=sliceSurfaceFit({minX:20,minY:-8,width:6,height:10},100)
 const large=sliceSurfaceFit({minX:-30,minY:-20,width:60,height:40},100)
 assert.equal(small.x,23);assert.equal(small.y,-3)
 assert(large.radius>small.radius)
 assert(small.radius>=Math.hypot(3,5))
 assert.equal(sliceSurfaceFit(null),null)
 assert.equal(sliceSurfaceFit({minX:NaN,minY:0,width:1,height:1}),null)
 assert(sliceSurfaceFit({minX:0,minY:0,width:0,height:0}).radius>0)
})
