import test from 'node:test'
import assert from 'node:assert/strict'
import {visibleAnalysisModels, visibleAnalysisSelection, analysisCalculationAvailability} from '../app/viewer/visible-analysis-models.mjs'

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

test('a computed map retains a hidden antagonist for viewing, but never a removed file', () => {
  const selection = ['/upper.obj','/lower.ply'], visible = [files[1]], sceneFiles = [files[1],files[3]]
  assert.deepEqual(visibleAnalysisSelection(selection,visible,{computed:true,sceneFiles}),selection)
  assert.deepEqual(visibleAnalysisSelection(selection,visible,{computed:false,sceneFiles}),['/upper.obj'])
  assert.deepEqual(visibleAnalysisSelection(selection,visible,{computed:true,sceneFiles:[files[1]]}),['/upper.obj'])
  assert.equal(analysisCalculationAvailability(selection,visible).ready,false)
  assert.match(analysisCalculationAvailability(selection,visible).reason,/alespoň dva viditelné/)
  assert.equal(analysisCalculationAvailability(selection,sceneFiles).ready,true)
})

test('a hidden selected reference blocks recalculation even when other visible scans exist',()=>{
  const state = analysisCalculationAvailability(['/upper.obj','/hidden.stl'],[files[1],files[3]])
  assert.equal(state.ready,false);assert.match(state.reason,/Oba vybrané modely/)
})
