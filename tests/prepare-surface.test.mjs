import test from 'node:test'
import assert from 'node:assert/strict'
import { indexed, meshTopology } from '../app/model-builder/engine.mjs'
import { prepareSurface } from '../app/model-builder/prepare-surface.mjs'

test('a reversed rim face is repaired without moving any vertices', () => {
  const vertices = [0,0,0, 1,0,0, 1,0,1, 0,0,1, .5,0,.5]
  const faces = [0,1,4, 1,2,4, 2,3,4, 3,4,0]
  assert.throws(() => meshTopology(vertices, faces), /větví/)
  const prepared = prepareSurface(vertices, faces)
  assert.equal(prepared.vertices, vertices)
  const topology = meshTopology(prepared.vertices, prepared.faces)
  assert.equal(topology.loops.length, 1)
  assert.equal(topology.nonManifold, 0)
})

test('duplicate faces are removed and a reversed first face does not reverse the rest of the scan', () => {
  const vertices = [0,0,0, 1,0,0, 1,0,1, 0,0,1, .5,0,.5]
  const original = [0,1,4, 1,2,4, 2,3,4, 3,0,4]
  const damaged = [0,4,1, ...original.slice(3), 0,1,4]
  const prepared = prepareSurface(vertices, damaged)
  assert.deepEqual(prepared.faces, original)
  assert.equal(meshTopology(vertices, prepared.faces).nonManifold, 0)
  assert.deepEqual(prepareSurface(vertices, prepared.faces), prepared)
})

test('exact indexing preserves distinct near-touching cut vertices', () => {
  // Two lobes connected by a very narrow strip: rounding pinches their rims.
  const vertices = [0,0,0, -1,0,-1, 1,0,-1, .000003,0,0, 1,0,1, -1,0,1]
  const points = [0,1,2, 0,2,3, 0,3,4, 0,4,5].flatMap(id => vertices.slice(id * 3, id * 3 + 3))
  const rounded = indexed(points), exact = indexed(points, { exact: true })
  assert.equal(rounded.vertices.length / 3, 5)
  assert.equal(exact.vertices.length / 3, 6)
  assert.throws(() => meshTopology(rounded.vertices, rounded.faces), /větví/)
  assert.equal(meshTopology(exact.vertices, exact.faces).loops.length, 1)
})

test('genuine branching is not hidden by the winding repair', () => {
  const vertices = [0,0,0, 1,0,0, 0,0,1, -1,0,0, 0,0,-1]
  const prepared = prepareSurface(vertices, [0,1,2, 0,3,4])
  assert.throws(() => meshTopology(vertices, prepared.faces), /větví/)
})
