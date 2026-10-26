import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
const source = fs.readFileSync(new URL('../app/ClientPage.jsx',import.meta.url),'utf8')
const start = source.indexOf('  const updateReferenceDisplay = '), end = source.indexOf('  const referenceDisplayFor = ',start)
const definition = source.slice(start,end)
function fixture() {
  const files = [{url:'a'},{url:'b'}], state = {opacities:[.8,.4],visibles:[true,true]}
  return {state, update(url,change) {
    new Function('files','opacities','clamp01','setOpacities','setVisibles','url','change',definition+';updateReferenceDisplay(url,change)')(
      files,state.opacities,v=>Math.max(0,Math.min(1,v)),fn=>state.opacities=fn(state.opacities),fn=>state.visibles=fn(state.visibles),url,change)
  }}
}
test('hiding the antagonist retains its opacity, and showing it restores the same appearance',()=>{
  const {state,update}=fixture()
  update('b',{visible:false});assert.deepEqual(state.visibles,[true,false]);assert.deepEqual(state.opacities,[.8,.4])
  update('b',{visible:true});assert.deepEqual(state.visibles,[true,true]);assert.deepEqual(state.opacities,[.8,.4])
})
test('the opacity control updates the antagonist live and can restore a fully transparent scan',()=>{
  const {state,update}=fixture()
  update('b',{opacity:0});assert.deepEqual(state.visibles,[true,false]);assert.deepEqual(state.opacities,[.8,0])
  update('b',{visible:true});assert.deepEqual(state.visibles,[true,true]);assert.deepEqual(state.opacities,[.8,1])
  update('b',{opacity:.25});assert.deepEqual(state.opacities,[.8,.25])
  update('missing',{opacity:0});assert.deepEqual(state.opacities,[.8,.25])
})
