import test from 'node:test'
import assert from 'node:assert/strict'
import { createDicomPreparationTracker, dicomPreparationKey } from '../app/viewer/dicom-preparation.mjs'

const source = (token = 'first') => ({ u: `https://storage.example/ct.zip?token=${token}`, settings: { densityMin: 646, densityMax: 2200 } })

test('legacy saved CT restores without conversion, including refreshed download credentials', () => {
  const tracker = createDicomPreparationTracker({ restoreInitial: true })
  tracker.receive(null)
  assert.equal(tracker.receive(source()), false)
  assert.equal(tracker.receive(source('renewed')), false)
  tracker.receive(null)
  assert.equal(tracker.receive(source('later')), false)
})

test('a newly selected CT after the initial empty snapshot requests conversion', () => {
  const tracker = createDicomPreparationTracker()
  tracker.receive(null)
  assert.equal(tracker.receive(source()), true)
  tracker.confirm(source())
  tracker.receive(null)
  assert.equal(tracker.receive(source('renewed')), false)
  assert.equal(tracker.receive({ u: 'https://storage.example/another.zip' }), true)
})

test('saved viewer state and explicit prepared settings suppress conversion after delayed hydration', () => {
  for (const options of [{ restored: true }, {}]) {
    const tracker = createDicomPreparationTracker()
    tracker.receive(null)
    const ct = { ...source(), settings: { ...source().settings, surfacePrepared: !options.restored } }
    assert.equal(tracker.receive(ct, options), false)
  }
  const tracker = createDicomPreparationTracker()
  tracker.receive(null)
  assert.equal(tracker.receive({ ...source(), prepareSurface: false }), false)
})

test('source identity ignores expiring authentication but preserves resource-selecting query parameters', () => {
  assert.equal(dicomPreparationKey(source()), dicomPreparationKey(source('new')))
  assert.notEqual(dicomPreparationKey({ u: 'https://example/ct?file=a' }), dicomPreparationKey({ u: 'https://example/ct?file=b' }))
})

test('first CT in a fresh scene still requests preparation even before any empty payload', () => {
  assert.equal(createDicomPreparationTracker().receive(source()), true)
})

test('adding CT to a restored scene that had no CT still opens preparation', () => {
  const tracker = createDicomPreparationTracker({ restoreInitial: true })
  tracker.receive(null, { restored: true })
  assert.equal(tracker.receive(source()), true)
})
