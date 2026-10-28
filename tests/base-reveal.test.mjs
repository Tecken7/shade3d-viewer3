import test from 'node:test'
import assert from 'node:assert/strict'
import {baseRevealProgress,baseGuideBlend,installBaseRevealShader,advanceBaseReveal} from '../app/model-builder/base-reveal.mjs'
test('reveal is bounded, smooth and monotonic; guide blends only as base arrives',()=>{
 assert.equal(baseRevealProgress(0),0);assert.equal(baseRevealProgress(1500),1);assert.equal(baseRevealProgress(3000),1)
 let previous=0;for(let ms=0;ms<=1500;ms+=10){const p=baseRevealProgress(ms);assert.ok(p>=previous);previous=p}
 assert.equal(baseGuideBlend(.6),0);assert.equal(baseGuideBlend(1),1)
 for(const direction of [-1,1]){const from=direction*10,to=direction*30;const front=from+(to-from)*baseRevealProgress(750);assert.equal(front,direction*20)}
})
test('reveal shader clips local height with shared uniforms, preserving other clipping',()=>{
 const shader={uniforms:{},vertexShader:'#include <begin_vertex>',fragmentShader:'#include <clipping_planes_fragment>'},uniforms={uBaseRevealEnabled:{value:1}}
 installBaseRevealShader(shader,uniforms);assert.equal(shader.uniforms.uBaseRevealEnabled,uniforms.uBaseRevealEnabled)
 assert.match(shader.vertexShader,/vBaseHeight = position.y/);assert.match(shader.fragmentShader,/#include <clipping_planes_fragment>/);assert.match(shader.fragmentShader,/uBaseRevealProgress < 1.0/)
})

test('first revealed layer starts at zero and long frames cannot skip the opening animation',()=>{
 const clock={},key={}
 assert.equal(advanceBaseReveal(clock,key,2),0)
 const afterCompile=advanceBaseReveal(clock,key,2)
 assert.equal(clock.elapsed,32);assert.ok(afterCompile<.002)
 advanceBaseReveal(clock,key,.016);assert.equal(clock.elapsed,48)
 assert.equal(advanceBaseReveal(clock,{},3),0)
})
