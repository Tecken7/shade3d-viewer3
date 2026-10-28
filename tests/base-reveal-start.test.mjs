import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import {toCreasedNormals} from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import {baseRevealStarts} from '../app/model-builder/base-reveal-start.mjs'

test('reveal begins locally along the wavy rim instead of showing a tall wall at time zero',()=>{
 const rim=[[0,2,0],[10,4,0],[10,8,10],[0,6,10]]
 const positions=new Float32Array([5,15,0,10,15,5,5,15,10,0,15,5]),original=positions.slice()
 const starts=baseRevealStarts(positions,rim)
 assert.deepEqual([...starts],[3,6,7,4]);assert.deepEqual(positions,original)
 for(let i=0;i<starts.length;i++){
  const firstFront=starts[i]+(20-starts[i])*.001
  assert.ok(firstFront-starts[i]<.02,'first frame exposes only a thin layer at every rim height')
 }
})
test('shading geometry preserves the local reveal heights',()=>{
 const raw=new THREE.BufferGeometry()
 raw.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0,10,0,0,0,0,10],3));raw.setIndex([0,1,2])
 raw.setAttribute('baseRevealStart',new THREE.Float32BufferAttribute([2,4,6],1))
 const display=toCreasedNormals(raw,Math.PI/6)
 assert.deepEqual([...display.attributes.baseRevealStart.array],[2,4,6])
 raw.dispose();display.dispose()
})
