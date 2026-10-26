import test from 'node:test'
import assert from 'node:assert/strict'
import {visibleAnalysisModels, visibleAnalysisSelection} from '../app/viewer/visible-analysis-models.mjs'

const ext = name => name.split('.').pop().toLowerCase()
const files = ['ct.zip','upper.obj','hidden.stl','lower.ply','transparent.obj'].map(name => ({name, url: '/'+name}))
test('model pickers use original scene indices and exclude hidden, transparent and non-mesh files', () => {
  const models = visibleAnalysisModels(files, [true,true,false,true,true], [1,1,1,.2,0], ext)
  assert.deepEqual(models.map(file => file.name), ['upper.obj','lower.ply'])
  assert.equal(models[0], files[1]); assert.equal(models[1], files[3])
})
test('unset visibility and opacity retain the normal scene defaults', () => {
  assert.deepEqual(visibleAnalysisModels(files, [], [], ext).map(file => file.name), ['upper.obj','hidden.stl','lower.ply','transparent.obj'])
})
test('a selected model disappearing from the scene cannot remain in an analysis pair', () => {
  const available = [files[1], files[3]]
  assert.deepEqual(visibleAnalysisSelection(['/upper.obj','/lower.ply'],available), ['/upper.obj','/lower.ply'])
  assert.deepEqual(visibleAnalysisSelection(['/upper.obj','/hidden.stl'],available), ['/upper.obj'])
  assert.deepEqual(visibleAnalysisSelection(['/hidden.stl','/lower.ply'],available), [])
  assert.deepEqual(visibleAnalysisSelection(['/upper.obj','/upper.obj'],available), ['/upper.obj'])
})
