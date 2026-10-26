import test from 'node:test'
import assert from 'node:assert/strict'
import {captureModelFade,applyModelFade,restoreModelFade} from '../app/viewer/model-fade.mjs'
test('temporary isolation preserves original transparency and Ghost strength',()=>{
  const solid={opacity:.65,transparent:true,depthWrite:false},opaque={opacity:1,transparent:false,depthWrite:true},ghost={opacity:1,transparent:true,depthWrite:false,uniforms:{uGhostStrength:{value:.42}}}
  const object={traverse(fn){fn({isMesh:true,material:[solid,opaque,ghost]});fn({isMesh:true,material:solid})}}
  const entries=captureModelFade(object)
  assert.equal(entries.length,3)
  assert.equal(opaque.transparent,true);assert.equal(opaque.depthWrite,false)
  applyModelFade(entries,0);assert.equal(solid.opacity,0);assert.equal(ghost.uniforms.uGhostStrength.value,0)
  applyModelFade(entries,.5);assert.equal(solid.opacity,.325);assert.equal(ghost.uniforms.uGhostStrength.value,.21)
  restoreModelFade(entries)
  assert.equal(solid.opacity,.65);assert.equal(solid.transparent,true);assert.equal(solid.depthWrite,false)
  assert.equal(opaque.opacity,1);assert.equal(opaque.transparent,false);assert.equal(opaque.depthWrite,true)
  assert.equal(ghost.uniforms.uGhostStrength.value,.42)
})
