import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as THREE from 'three'

// Exercise the actual session reset used by AnyModel, including stale pointer hits.
const source=fs.readFileSync(new URL('../app/ClientPage.jsx',import.meta.url),'utf8')
const start=source.indexOf('  const resetRepairHoverVisual = '),end=source.indexOf('  // A new repair session',start)
const expression=source.slice(start,end).split(' = ').slice(1).join(' = ').trim()
test('repair session reset clears stale pointer, foil uniform and all material overrides',()=>{
  const material={color:new THREE.Color('#3b82f6'),emissive:new THREE.Color('#3b82f6'),emissiveIntensity:1,roughness:.28,metalness:.62}
  const base={color:new THREE.Color('#a29c90'),emissive:new THREE.Color('#000000'),intensity:0,roughness:.42,metalness:.52}
  const state={repairPointerHover:{current:true},repairHoverTarget:{current:true},repairHoverPosition:{current:1},repairFoilUniforms:{current:{amount:{value:1}}},repairHoverMaterials:{current:[{material,...base}]}}
  const reset=new Function(...Object.keys(state),`return (${expression})`)(...Object.values(state))
  reset()
  assert.equal(state.repairPointerHover.current,false)
  assert.equal(state.repairHoverTarget.current,false)
  assert.equal(state.repairHoverPosition.current,0)
  assert.equal(state.repairFoilUniforms.current.amount.value,0)
  assert.deepEqual(state.repairHoverMaterials.current,[])
  assert(material.color.equals(base.color));assert(material.emissive.equals(base.emissive))
  assert.equal(material.emissiveIntensity,0);assert.equal(material.roughness,.42);assert.equal(material.metalness,.52)
  reset();assert(material.color.equals(base.color))
})
