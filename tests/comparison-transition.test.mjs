import test from 'node:test';import assert from 'node:assert/strict'
import {advanceComparisonBlend,setComparisonBlendMaterial} from '../app/viewer/comparison-transition.mjs'
test('heatmap transition reaches both endpoints and reverses continuously',()=>{
 let position=0;for(let i=0;i<30;i++)position=advanceComparisonBlend(position,true,1/60).position;assert.equal(position,1)
 const off=advanceComparisonBlend(position,false,.1);const reversed=advanceComparisonBlend(off.position,true,0);assert.equal(reversed.value,off.value)
 for(let i=0;i<30;i++)position=advanceComparisonBlend(position,false,1/60).position;assert.equal(position,0)
})
test('comparison shader preserves base texture path and shares a single GPU uniform',()=>{
 const original=()=>{},cache=()=> 'base-shader',material={userData:{},onBeforeCompile:original,customProgramCacheKey:cache},uniform={value:.5}
 setComparisonBlendMaterial(material,uniform,true);const hook=material.onBeforeCompile;setComparisonBlendMaterial(material,uniform,true);assert.equal(material.onBeforeCompile,hook)
 const shader={uniforms:{},vertexShader:'void main() { gl_Position=vec4(0.); }',fragmentShader:'#include <map_fragment>\n#include <color_fragment>'};hook.call(material,shader)
 assert.equal(shader.uniforms.uArtheticComparisonBlend,uniform);assert(shader.fragmentShader.indexOf('mix(diffuseColor.rgb')>shader.fragmentShader.indexOf('#include <map_fragment>'))
 assert(shader.vertexShader.includes('artheticComparisonColor'));assert.equal(material.customProgramCacheKey(),'base-shader|arthetic-comparison-blend-v1')
 const ghost={uniforms:{},vertexShader:'void main() {}',fragmentShader:'sourceColor = clamp(sourceColor, 0.0, 1.0);'};hook.call(material,ghost);assert(ghost.fragmentShader.includes('sourceColor = mix'))
 setComparisonBlendMaterial(material,uniform,false);assert.equal(material.onBeforeCompile,original);assert.equal(material.customProgramCacheKey,cache)
})
