import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { unzipSync, strFromU8 } from 'fflate'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { createDebugSnapshot } from '../app/model-builder/debug-snapshot.mjs'
import { collectTrianglesInRoot } from '../app/model-builder/scene-input.mjs'

test('snapshot preserves edited source geometry, orientation, both arches and the current error', () => {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0,2,0,0,0,3,0],3))
  geometry.attributes.position.setZ(2,1)
  const root=new THREE.Group(),mesh=new THREE.Mesh(geometry)
  root.add(mesh);mesh.position.set(10,20,30)
  const positions=collectTrianglesInRoot(mesh,root),before=geometry.attributes.position.array.slice()
  const archive=unzipSync(createDebugSnapshot([
    {arch:'upper',name:'upper.ply',positions},
    {arch:'lower',name:'lower.ply',positions},
  ],null,{stage:'repair',messages:{modelBuilder:'Hranice skenu se větví.'},previewDirty:true}))
  const stl=archive['upper_rozpracovany_scan.stl']
  const restored=new STLLoader().parse(stl.buffer.slice(stl.byteOffset,stl.byteOffset+stl.byteLength))
  assert.deepEqual(Array.from(restored.attributes.position.array),positions)
  assert.ok(archive['lower_rozpracovany_scan.stl'])
  const state=JSON.parse(strFromU8(archive['stav_model_builderu.json']))
  assert.equal(state.stage,'repair')
  assert.match(state.messages.modelBuilder,/větví/)
  assert.equal(state.scans[0].triangles,1)
  assert.equal(state.previewIncluded,false)
  assert.deepEqual(geometry.attributes.position.array,before)
  geometry.dispose();mesh.material.dispose();restored.dispose()
})

test('a stale base preview is included separately and explicitly marked', () => {
  const preview=new THREE.BoxGeometry(2,3,4),before=preview.attributes.position.array.slice()
  const archive=unzipSync(createDebugSnapshot([],preview,{stage:'base',previewDirty:true,options:{holes:[{diameter:4.5,length:8}]}}))
  assert.ok(archive['posledni_nahled_zakladny.stl'])
  const state=JSON.parse(strFromU8(archive['stav_model_builderu.json']))
  assert.equal(state.previewDirty,true)
  assert.equal(state.options.holes[0].length,8)
  assert.deepEqual(preview.attributes.position.array,before)
  assert.match(strFromU8(archive['CTETE_ME.txt']),/starší/)
  preview.dispose()
})

test('empty snapshots report that the scan is not loaded',()=>{
  assert.throws(()=>createDebugSnapshot([],null,{stage:'scan'}),/ještě není načtený/)
})
