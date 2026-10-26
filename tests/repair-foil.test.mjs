import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import {setRepairFoilMaterial} from '../app/viewer/repair-foil.mjs'

// Model the renderer's per-material program cache: a cached shader variant does
// not invoke onBeforeCompile again and retains the last installed uniform map.
function renderer() {
  const materials = new Map(), gpu = {amount: 0}
  return {
    draw(material, variant = 'base') {
      let state = materials.get(material)
      if (!state) {state = {programs: new Map()}; materials.set(material, state)}
      const key = material.customProgramCacheKey() + '|' + variant
      let program = state.programs.get(key)
      if (!program) {
        const shader = {uniforms: {}, vertexShader: '#include <begin_vertex>', fragmentShader: '#include <opaque_fragment>'}
        material.onBeforeCompile(shader)
        program = {foil: shader.fragmentShader.includes('uRepairFoilAmount')}
        state.programs.set(key, program)
        state.uniforms = shader.uniforms
      }
      if (state.uniforms.uRepairFoilAmount) gpu.amount = state.uniforms.uRepairFoilAmount.value
      return program.foil ? gpu.amount : 0
    },
  }
}
test('reopening repair and hovering one scan does not leak its foil amount into a neighboring scan', () => {
  const a = new THREE.MeshStandardMaterial(), b = new THREE.MeshStandardMaterial()
  const ua = {amount: {value: 0}, time: {value: 0}}, ub = {amount: {value: 0}, time: {value: 0}}
  const view = renderer()
  for (let session = 0; session < 4; session++) {
    setRepairFoilMaterial(a, ua, true); setRepairFoilMaterial(b, ub, true)
    ua.amount.value = 1
    // A newly built repaired mesh may use a fresh geometry/material variant,
    // while its untouched neighbor reuses its original cached program.
    assert.equal(view.draw(a, `repaired-${session}`), 1)
    assert.equal(view.draw(b), 0, `unhovered neighbor must remain neutral in session ${session}`)
    ua.amount.value = 0; ub.amount.value = 1
    assert.equal(view.draw(b), 1); assert.equal(view.draw(a), 0)
    // Selection/Back changes both materials to their normal scene rendering.
    ua.amount.value = 0; ub.amount.value = 0
    setRepairFoilMaterial(a, ua, false); setRepairFoilMaterial(b, ub, false)
    assert.equal(view.draw(a), 0); assert.equal(view.draw(b), 0)
  }
})
test('deactivating foil resets it immediately without changing material appearance or stacking shader patches', () => {
  const material = new THREE.MeshStandardMaterial({color: '#a29c90', roughness: .42, metalness: .52})
  const baseColor = material.color.clone(), uniforms = {amount: {value: 1}, time: {value: 0}}
  setRepairFoilMaterial(material, uniforms, true)
  const compiled = material.onBeforeCompile, key = material.customProgramCacheKey()
  setRepairFoilMaterial(material, uniforms, false)
  assert.equal(uniforms.amount.value, 0)
  assert.equal(material.customProgramCacheKey(), key)
  setRepairFoilMaterial(material, uniforms, true)
  assert.equal(material.onBeforeCompile, compiled)
  assert(material.color.equals(baseColor)); assert.equal(material.roughness,.42); assert.equal(material.metalness,.52)
})
