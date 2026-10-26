import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../app/ClientPage.jsx', import.meta.url), 'utf8')
const start = source.indexOf('  const finishTrim = useCallback(')
const body = source.slice(start, source.indexOf('  const resetCadBuilder', start))
function fixture(overrides = {}) {
  const events = [], values = {
    useCallback: fn => fn, trimSelection: '/model.obj', trimBusy: false, trimExportBusyUrl: '',
    trimFinishPendingRef: {current: false}, editorCapabilities: {canSaveTrimmedToCase: true}, trimmedExportsByUrl: {'/model.obj': {saveRequested: false}},
    setTrimMode: value => events.push(['mode', value]), setTrimFocusUrl: value => events.push(['focus', value]),
    repairWaitForBusyPaint: async () => events.push(['paint']),
    saveTrimmedModelToCase: async (url, options) => events.push(['save', url, options]),
    clearTrimWorkingState: () => events.push(['clear']), setTrimMessage: text => events.push(['error', text]),
    ...overrides,
  }
  const finish = new Function(...Object.keys(values), body + ';return finishTrim')(...Object.values(values))
  return {finish, events, values}
}
test('Done restores the scene before handing the trimmed file to the existing case uploader', async () => {
  const {finish, events, values} = fixture()
  await finish()
  assert.deepEqual(events, [['mode',false], ['focus',''], ['paint'], ['save','/model.obj',{silent:true}], ['clear']])
  assert.equal(values.trimFinishPendingRef.current, false)
})
test('standalone previews and files already handed to the case do not upload again', async () => {
  for (const overrides of [{editorCapabilities:{canSaveTrimmedToCase:false}}, {trimmedExportsByUrl:{'/model.obj':{saveRequested:true}}}]) {
    const {finish, events} = fixture(overrides)
    await finish(); assert.deepEqual(events, [['mode',false], ['focus',''], ['paint'], ['clear']])
  }
})
test('a failed file export restores the completed trim so it can be retried or downloaded', async () => {
  const {finish, events, values} = fixture({saveTrimmedModelToCase: async () => {throw new Error('Export selhal')}})
  await finish()
  assert.deepEqual(events, [['mode',false], ['focus',''], ['paint'], ['mode',true], ['focus','/model.obj'], ['error','Export selhal']])
  assert.equal(values.trimFinishPendingRef.current, false)
})
test('double clicks cannot enqueue the same completed trim twice', async () => {
  let release, saves = 0
  const {finish} = fixture({saveTrimmedModelToCase: () => {saves++; return new Promise(resolve => {release=resolve})}})
  const first = finish(); await Promise.resolve()
  await finish(); assert.equal(saves,1)
  release(); await first
})
