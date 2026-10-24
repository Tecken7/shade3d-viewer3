import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_LIGHTING, LIGHTING_PRESETS, normalizeLighting } from '../app/viewer/scene-lighting.mjs'
test('older scenes and malformed lighting retain safe defaults',()=>{
 assert.deepEqual(normalizeLighting(),DEFAULT_LIGHTING)
 assert.deepEqual(normalizeLighting(null),DEFAULT_LIGHTING)
 const value=normalizeLighting({brightness:Infinity,azimuth:999,elevation:-20,softness:5,preset:'invalid'})
 assert.deepEqual(value,{brightness:1,azimuth:180,elevation:5,softness:1,preset:'custom'})
})
test('lighting survives a saved-scene JSON round trip without altering presets',()=>{
 for(const preset of Object.values(LIGHTING_PRESETS))assert.deepEqual(normalizeLighting(JSON.parse(JSON.stringify(preset))),preset)
 const original={...DEFAULT_LIGHTING},custom=normalizeLighting({...DEFAULT_LIGHTING,brightness:1.8,azimuth:-65,preset:'custom'})
 assert.equal(custom.brightness,1.8);assert.deepEqual(DEFAULT_LIGHTING,original)
})
