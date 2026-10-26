import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../app/ClientPage.jsx', import.meta.url), 'utf8')
const start = source.indexOf('  const finishRepair = useCallback(')
const body = source.slice(start, source.indexOf('  const flushPendingDerivedModelsForScene', start))
function fixture(overrides = {}) {
  const events = [], values = {
    useCallback: fn => fn, repairSelection: '/model.obj', repairBusy: false, repairExportBusyUrl: '',
    repairFinishPendingRef: {current: false}, editorCapabilities: {canSaveRepairedToCase: true}, repairedExportsByUrl: {'/model.obj': {saveRequested: false}},
    setRepairMode: value => events.push(['mode', value]), setRepairFocusUrl: value => events.push(['focus', value]),
    repairWaitForBusyPaint: async () => events.push(['paint']),
    saveRepairedModelToCase: async (url, options) => events.push(['save', url, options]),
    clearRepairWorkingState: () => events.push(['clear']), setRepairMessage: text => events.push(['error', text]),
    ...overrides,
  }
  const finish = new Function(...Object.keys(values), body + ';return finishRepair')(...Object.values(values))
  return {finish, events, values}
}
test('Done restores the scene before handing the repaired file to the existing case uploader', async () => {
  const {finish, events, values} = fixture()
  await finish()
  assert.deepEqual(events, [['mode',false], ['focus',''], ['paint'], ['save','/model.obj',{silent:true}], ['clear']])
  assert.equal(values.repairFinishPendingRef.current, false)
})
test('standalone previews and files already handed to the case do not upload again', async () => {
  for (const overrides of [{editorCapabilities:{canSaveRepairedToCase:false}}, {repairedExportsByUrl:{'/model.obj':{saveRequested:true}}}]) {
    const {finish, events} = fixture(overrides)
    await finish(); assert.deepEqual(events, [['mode',false], ['focus',''], ['paint'], ['clear']])
  }
})
test('a failed file export restores the completed repair so it can be retried or downloaded', async () => {
  const {finish, events, values} = fixture({saveRepairedModelToCase: async () => {throw new Error('Export selhal')}})
  await finish()
  assert.deepEqual(events, [['mode',false], ['focus',''], ['paint'], ['mode',true], ['focus','/model.obj'], ['error','Export selhal']])
  assert.equal(values.repairFinishPendingRef.current, false)
})
test('double clicks cannot enqueue the same completed repair twice', async () => {
  let release, saves = 0
  const {finish} = fixture({saveRepairedModelToCase: () => {saves++; return new Promise(resolve => {release=resolve})}})
  const first = finish(); await Promise.resolve()
  await finish(); assert.equal(saves,1)
  release(); await first
})
