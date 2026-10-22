import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as THREE from 'three'
import {MeshBVH} from 'three-mesh-bvh'
import {FontLoader} from 'three/examples/jsm/loaders/FontLoader.js'
import {beginSurfaceTextDrag,moveSurfaceTextDrag} from '../app/model-builder/text-drag.mjs'
import {projectSurfaceText} from '../app/model-builder/surface-text.mjs'

const radius=10,surface=new THREE.CylinderGeometry(radius,radius,20,256)
surface.boundsTree=new MeshBVH(surface)
const rayAt=angle=>new THREE.Ray(new THREE.Vector3(Math.sin(angle)*20,0,Math.cos(angle)*20),new THREE.Vector3(-Math.sin(angle),0,-Math.cos(angle)))
const anchor=surface.boundsTree.raycastFirst(rayAt(0),THREE.DoubleSide)
const placement={position:anchor.point.toArray(),normal:anchor.face.normal.toArray()}
const font=new FontLoader().parse(JSON.parse(fs.readFileSync(new URL('../public/wasm/model-builder/font.json',import.meta.url))))

test('off-centre grab does not move the label before the pointer moves',()=>{
 const ray=rayAt(.35),gesture=beginSurfaceTextDrag(surface,ray,placement),next=moveSurfaceTextDrag(surface,ray,gesture)
 assert.ok(new THREE.Vector3(...next.position).distanceTo(anchor.point)<1e-6)
})

test('drag transports the grab around a curve and uses the normal at the actual label anchor',()=>{
 const gesture=beginSurfaceTextDrag(surface,rayAt(.35),placement)
 for(let i=0;i<=10;i++){
  const angle=.35+i*.08,next=moveSurfaceTextDrag(surface,rayAt(angle),gesture)
  assert.ok(next)
  const point=new THREE.Vector3(...next.position),normal=new THREE.Vector3(...next.normal),radial=new THREE.Vector3(point.x,0,point.z).normalize()
  assert.ok(normal.dot(radial)>.999)
  assert.ok(Math.abs(Math.atan2(point.x,point.z)-(angle-.35))<.025)
  // A cursor-face normal would be rotated by ~20 degrees at this anchor.
  const cursorNormal=surface.boundsTree.raycastFirst(rayAt(angle),THREE.DoubleSide).face.normal
  assert.ok(normal.dot(cursorNormal)<.97)
  const preview=projectSurfaceText(font,{text:'Novák',textSize:2,textDepth:.5,textMode:'emboss',baseDirection:-1},next,surface,{preview:true})
  assert.equal(preview.valid,true,preview.error);preview.geometry.dispose()
 }
})

test('leaving the surface produces no replacement placement or mutation of the gesture',()=>{
 const gesture=beginSurfaceTextDrag(surface,rayAt(.35),placement),before=gesture.offset.clone()
 const away=new THREE.Ray(new THREE.Vector3(0,30,20),new THREE.Vector3(0,0,-1))
 assert.equal(moveSurfaceTextDrag(surface,away,gesture),null)
 assert.deepEqual(gesture.offset,before)
})
