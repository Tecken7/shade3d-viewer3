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
