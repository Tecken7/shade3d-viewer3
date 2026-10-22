import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as THREE from 'three'
import {MeshBVH} from 'three-mesh-bvh'
import {FontLoader} from 'three/examples/jsm/loaders/FontLoader.js'
import {mergeGeometries} from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import {projectSurfaceText} from '../app/model-builder/surface-text.mjs'
const font=new FontLoader().parse(JSON.parse(fs.readFileSync(new URL('../public/wasm/model-builder/font.json',import.meta.url),'utf8')))
const options={text:'A',textSize:2,textDepth:.5,textMode:'emboss',textRotation:0,baseDirection:1}
const tree=geometry=>{geometry.boundsTree=new MeshBVH(geometry);return geometry}

test('wall text keeps the same projected footprint in preview and actual construction',()=>{
 const surface=tree(new THREE.PlaneGeometry(30,20)),placement={position:[0,0,0],normal:[0,0,1]}
 const actual=projectSurfaceText(font,options,placement,surface),preview=projectSurfaceText(font,options,placement,surface,{preview:true})
 assert.equal(actual.valid,true,actual.error);assert.equal(preview.valid,true,preview.error)
 const a=actual.geometry.attributes.position,b=preview.geometry.attributes.position
 for(let i=0;i<a.count;i++){assert.equal(a.getX(i),b.getX(i));assert.equal(a.getY(i),b.getY(i));assert.ok(Math.abs(b.getZ(i)-a.getZ(i)-.24)<1e-6)}
 actual.geometry.dispose();preview.geometry.dispose();surface.dispose()
})

test('text can wrap onto a crown top whose normal is parallel to the model vertical axis',()=>{
 const surface=tree(new THREE.SphereGeometry(6,64,48))
 const result=projectSurfaceText(font,options,{position:[0,6,0],normal:[0,1,0]},surface,{preview:true})
 assert.equal(result.valid,true,result.error)
 assert.ok([...result.geometry.attributes.position.array].every(Number.isFinite))
 assert.ok(result.geometry.boundingBox.max.y>6)
 result.geometry.dispose();surface.dispose()
})

test('a gap between sparse letter vertices is rejected with a visible diagnostic geometry',()=>{
 const surface=tree(mergeGeometries([new THREE.PlaneGeometry(30,10).translate(0,5.15,0),new THREE.PlaneGeometry(30,10).translate(0,-5.15,0)]))
 const result=projectSurfaceText(font,{...options,text:'I'},{position:[0,0,0],normal:[0,0,1]},surface,{preview:true})
 assert.equal(result.valid,false);assert.match(result.error,/povrch|mezeru/)
 assert.ok(result.geometry);assert.ok([...result.geometry.attributes.position.array].every(Number.isFinite))
 result.geometry.dispose();surface.dispose()
})
