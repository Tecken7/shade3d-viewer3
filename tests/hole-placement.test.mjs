import test from 'node:test'
import assert from 'node:assert/strict'
import { contourPosition, nearestContourPosition } from '../app/model-builder/hole-placement.mjs'

const contour = [[0,25,0], [10,25,0], [10,25,10], [0,25,10]]
test('hole dragging stays on the bottom perimeter regardless of cursor height', () => {
  assert.deepEqual(nearestContourPosition(contour, [4,-100,-3]), { position:[4,25,0], fraction:0.1 })
  assert.deepEqual(nearestContourPosition(contour, [14,100,8]), { position:[10,25,8], fraction:0.45 })
})
test('perimeter slider follows arc length and closes without a jump', () => {
  assert.deepEqual(contourPosition(contour, .375), [10,25,5])
  assert.deepEqual(contourPosition(contour, 1), contourPosition(contour, 0))
  for (const fraction of [.1,.35,.7,.9]) {
    assert.ok(Math.abs(nearestContourPosition(contour, contourPosition(contour, fraction)).fraction - fraction) < 1e-10)
  }
})
