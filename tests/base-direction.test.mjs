import test from 'node:test'
import assert from 'node:assert/strict'
import {baseDirection} from '../app/model-builder/base-direction.mjs'
test('base extends away from the anatomy even when the arch label suggests the opposite sign',()=>{
  const boundary=[0,1,2,3]
  for(const side of [-1,1]){
    const vertices=[-2,0,-2, 2,0,-2, 2,0,2, -2,0,2]
    for(let i=0;i<20;i++)vertices.push(i*.1,side*(3+i*.1),i*.1)
    for(const arch of ['upper','lower']){
      assert.equal(baseDirection(vertices,boundary,arch),-side)
      assert.equal(baseDirection(vertices,boundary,arch,true),side)
    }
  }
})
test('flat or inconclusive scans retain the selected arch convention',()=>{
  const vertices=[0,0,0,1,0,0,1,0,1,0,0,1]
  assert.equal(baseDirection(vertices,[0,1,2,3],'upper'),1)
  assert.equal(baseDirection(vertices,[0,1,2,3],'lower'),-1)
})
