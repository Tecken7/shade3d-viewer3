import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../app/ClientPage.jsx', import.meta.url), 'utf8')
const start = source.indexOf('function classifyRepairBoundaryLoops(')
const end = source.indexOf('function repairPointSegmentDistanceSq(', start)
const classify = new Function(source.slice(start, end) + ';return classifyRepairBoundaryLoops')()
const rim = { id: 'base', perimeter: 100, area: 870, likely: false }
const hole = { id: 'crown', perimeter: 11, area: 9.6, likely: true }

test('Model Builder keeps the trimmed base rim open even below the general size threshold', () => {
  const result = classify({ diagonal: 60 }, [hole, rim], { preserveMainBoundary: true })
  assert.deepEqual(result.visible, [hole])
  assert.equal(result.hiddenBottom.id, 'base')
})

test('base rim stays excluded after all other holes have been repaired', () => {
  const result = classify({ diagonal: 60 }, [rim], { preserveMainBoundary: true })
  assert.deepEqual(result.visible, [])
  assert.equal(result.hiddenBottom.id, 'base')
})

test('classification is independent of scan scale, rotation and boundary order', () => {
  for (const scale of [0.01, 1, 100]) {
    const loops = [rim, hole].map(loop => ({ ...loop, perimeter: loop.perimeter * scale }))
    const result = classify({ diagonal: 60 * scale }, loops, { preserveMainBoundary: true })
    assert.deepEqual(result.visible.map(loop => loop.id), ['crown'])
  }
})

test('general mesh repair still offers a lone real hole for closure', () => {
  const result = classify({ diagonal: 60 }, [hole])
  assert.deepEqual(result.visible, [hole])
  assert.equal(result.hiddenBottom, null)
})

test('closed scan and missing context remain safe', () => {
  assert.deepEqual(classify({ diagonal: 60 }, [], { preserveMainBoundary: true }), { visible: [], hiddenBottom: null })
  assert.deepEqual(classify(null, [hole]), { visible: [hole], hiddenBottom: null })
})

function callback(name, args, environment) {
  const start = source.indexOf(`  const ${name} = useCallback(`)
  const end = source.indexOf('\n  }, [', start)
  const expression = source.slice(start, end).split('useCallback(')[1] + '\n  }'
  return new Function(...Object.keys(environment), `return (${expression})`)(...Object.values(environment))(...args)
}

test('transition from trim explicitly protects the base rim before React updates the stage', () => {
  let options
  const environment = {
    cadStandalone: true, cadBusy: false, repairBusy: false,
    cadUpperUrl: 'upper', cadLowerUrl: '', cadUpperName: 'scan', cadLowerName: '',
    clearRepairWorkingState() {},
    window: { setTimeout(fn) { fn() } },
    selectRepairModel(url, value) { assert.equal(url, 'upper'); options = value },
  }
  for (const name of ['setCadActiveArch', 'setCadFileUrl', 'setCadFileName', 'setCadStage', 'setIsAutoRotating', 'setRepairVariant', 'setRepairMode', 'setCadMessage']) environment[name] = () => {}
  callback('startCadRepairForArch', ['upper'], environment)
  assert.equal(options.preserveMainBoundary, true)
})

test('orientation can follow repair with unfinished holes, but never during a calculation', () => {
  let stage, cleared = 0
  const environment = {
    cadUpperUrl: 'upper', cadLowerUrl: '', cadUpperName: 'scan', cadLowerName: '',
    cadActiveArch: 'upper', cadBusy: false, repairBusy: false,
    cadArchRepairDone: { upper: false, lower: false },
    clearRepairWorkingState() { cleared++ },
  }
  const body = source.slice(source.indexOf('  const continueCadAfterRepair ='), source.indexOf('  const changeRepairVariant ='))
  for (const name of body.match(/\bset\w+(?=\()/g)) environment[name] = () => {}
  environment.setCadStage = value => { stage = value }
  callback('continueCadAfterRepair', [], environment)
  assert.equal(stage, 'orient')
  assert.equal(cleared, 1)
  stage = null
  callback('continueCadAfterRepair', [], { ...environment, repairBusy: true })
  assert.equal(stage, null)
  assert.equal(cleared, 1)
})
