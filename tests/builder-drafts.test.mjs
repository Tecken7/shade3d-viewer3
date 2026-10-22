import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
const source = fs.readFileSync(new URL('../app/ClientPage.jsx', import.meta.url), 'utf8')
const start = source.indexOf('  const changeBuilderOptions = useCallback(')
const body = source.slice(start, source.indexOf('\n  }, [])', start)).split('useCallback(')[1] + '\n  }'

test('editing a confirmed hole restores the uncut base once and requires a new confirmation', () => {
  let options = { cutHoles:true, holes:[] }, dirty = false, disposed = 0, cloned = 0
  const original = { dispose() { disposed++ } }, restored = {}
  let geometry = original
  const environment = {
    builderHasCutPreviewRef:{current:true},
    builderUncutRef:{current:{clone(){cloned++;return restored}}},
    setCadPreviewGeometry(update){geometry=update(geometry)},
    setBuilderOptions(update){options=update(options)},
    setBuilderDirty(value){dirty=value},
  }
  const change = new Function(...Object.keys(environment), `return (${body})`)(...Object.values(environment))
  change({holes:[{diameter:3}]})
  assert.equal(options.cutHoles,false)
  assert.equal(geometry,restored)
  assert.equal(dirty,true)
  assert.equal(disposed,1)
  change({holes:[{diameter:4}]})
  assert.equal(cloned,1,'drag updates must not clone the whole mesh every frame')
})
