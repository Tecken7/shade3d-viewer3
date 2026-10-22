import test from 'node:test'
import assert from 'node:assert/strict'
import { contourPosition, nearestContourPosition, holeDirection, seatHoleOnContour } from '../app/model-builder/hole-placement.mjs'

const contour = [[0,25,0], [10,25,0], [10,25,10], [0,25,10]]
test('cylinder centres keep their requested rim offset for both base directions while moving',()=>{
 for(const baseDirection of [-1,1]){
  const hole={diameter:4.5,baseDirection,position:[5,25,0]}
  const seated=seatHoleOnContour(contour,hole)
  assert.equal(seated[1],25-baseDirection*.5)
  assert.deepEqual(seatHoleOnContour(contour,{...hole,position:seated}),seated)
  assert.deepEqual(seatHoleOnContour(contour,{...hole,heightOffset:4},[10,100,5]),[10,25-baseDirection*4,5])
 }
})
test('hole dragging stays on the bottom perimeter regardless of cursor height', () => {
  assert.deepEqual(nearestContourPosition(contour, [4,-100,-3]), { position:[4,25,0], fraction:0.1 })
  assert.deepEqual(nearestContourPosition(contour, [14,100,8]), { position:[10,25,8], fraction:0.45 })
})

test('cylinder direction follows the local wall on every side and ignores contour winding',()=>{
  for(const [point,normal] of [[[5,25,0],[0,0,-1]],[[10,25,5],[1,0,0]],[[5,25,10],[0,0,1]],[[0,25,5],[-1,0,0]]]){
    for(const ring of [contour,contour.slice().reverse()]){
      const actual=holeDirection(ring,point)
      assert.ok(actual.every((v,i)=>Math.abs(v-normal[i])<1e-10))
    }
  }
})

test('local rotation is smooth through corners and includes the optional angular offset',()=>{
  const n=holeDirection(contour,[10,25,0])
  assert.ok(Math.abs(n[0]-Math.SQRT1_2)<1e-10)
  assert.ok(Math.abs(n[2]+Math.SQRT1_2)<1e-10)
  const rotated=holeDirection(contour,[10,25,5],30)
  assert.ok(Math.abs(rotated[0]-Math.cos(Math.PI/6))<1e-10)
  assert.ok(Math.abs(rotated[2]+.5)<1e-10)
})
test('perimeter slider follows arc length and closes without a jump', () => {
  assert.deepEqual(contourPosition(contour, .375), [10,25,5])
  assert.deepEqual(contourPosition(contour, 1), contourPosition(contour, 0))
  for (const fraction of [.1,.35,.7,.9]) {
    assert.ok(Math.abs(nearestContourPosition(contour, contourPosition(contour, fraction)).fraction - fraction) < 1e-10)
  }
})
