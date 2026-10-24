import test from 'node:test'
import assert from 'node:assert/strict'
import { stableSceneValue, sameSceneValue } from '../app/viewer/stable-scene-value.mjs'
test('replayed CaseCloud arrays and CT settings keep their state identity',()=>{
 const previous={u:'ct.zip',settings:{densityMin:350,position:[0,0,0],visible:true}}
 assert.equal(stableSceneValue(previous,structuredClone(previous)),previous)
 const scans=[{url:'upper.stl',v:true}, {url:'lower.stl',v:false}]
 assert.equal(stableSceneValue(scans,structuredClone(scans)),scans)
 const changed=structuredClone(previous);changed.settings.densityMin=400
 assert.equal(stableSceneValue(previous,changed),changed)
 assert(!sameSceneValue([true,false],[false,true]));assert(!sameSceneValue({},[]));assert(!sameSceneValue(null,{}))
})
