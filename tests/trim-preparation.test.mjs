import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { runStepsAsync } from '../app/model-builder/cooperative-work.mjs'

const source = fs.readFileSync(new URL('../app/ClientPage.jsx', import.meta.url), 'utf8')
const start = source.indexOf('  const selectTrimModel = useCallback(')
const body = source.slice(start, source.indexOf('  const closeTrimLoop = ', start))

function fixture({ fail = false } = {}) {
  const states = {}, events = [], object = {}, context = {}
  let heartbeat = false
  const values = {
    useCallback: fn => fn, trimBusy: false, modelObjectsRef: {current: {'scan.obj': object}},
    repairWaitForBusyPaint: async () => { events.push('paint'); setTimeout(() => { heartbeat = true }, 0) },
    buildTrimMeshContextSteps: function* (value) {
      assert.equal(value, object)
      events.push('prepare')
      yield
      assert.equal(heartbeat, true, 'input/rendering gets a turn before topology preparation completes')
      if (fail) throw new Error('Preparation failed')
      return context
    },
    runStepsAsync: iterator => runStepsAsync(iterator, {budget: 0}),
    console: {error() {}},
  }
  for (const name of new Set(body.match(/\bset\w+(?=\()/g))) values[name] = value => { states[name] = value }
  const select = new Function(...Object.keys(values), body + ';return selectTrimModel')(...Object.values(values))
  return {select, states, events, context}
}

test('trim selection yields to rendering and input before committing the prepared surface', async () => {
  const {select, states, events, context} = fixture()
  const pending = select('scan.obj')
  assert.equal(states.setTrimBusy, true)
  assert.equal(states.setTrimFocusUrl, 'scan.obj')
  assert.equal(states.setTrimContext, undefined)
  await pending
  assert.deepEqual(events, ['paint', 'prepare'])
  assert.equal(states.setTrimContext, context)
  assert.equal(states.setTrimSelection, 'scan.obj')
  assert.equal(states.setTrimStage, 'boundary')
  assert.equal(states.setTrimBusy, false)
})

test('failed asynchronous preparation restores the model picker without a partial context', async () => {
  const {select, states} = fixture({fail: true})
  await select('scan.obj')
  assert.equal(states.setTrimBusy, false)
  assert.equal(states.setTrimFocusUrl, '')
  assert.equal(states.setTrimContext, undefined)
  assert.equal(states.setTrimSelection, undefined)
  assert.equal(states.setTrimMessage, 'Preparation failed')
})

test('camera stays enabled during preparation but retains the boundary-drag and geometry-commit locks', () => {
  const controls = source.slice(source.indexOf('<TouchTrackballControls key={`main-trackball-'))
  const expression = controls.match(/enabled=\{([^}]+)\}/)[1]
  const defaults = {sliceDrawing:false, builderDragging:false, builderPlacing:false, sliceOverlayInteracting:false, alignmentBusy:false, cadBusy:false, trimDraggingPoint:null, trimBusy:true, trimStage:'model'}
  const enabled = overrides => {
    const state = {...defaults, ...overrides}
    return new Function(...Object.keys(state), `return ${expression}`)(...Object.values(state))
  }
  assert.equal(enabled({}), true)
  assert.equal(enabled({trimStage:'region'}), false)
  assert.equal(enabled({trimBusy:false, trimStage:'boundary'}), true)
  assert.equal(enabled({trimDraggingPoint:0}), false)
  assert.equal(enabled({sliceOverlayInteracting:true}), false)
})
