import test from 'node:test'
import assert from 'node:assert/strict'
import {baseRevealProgress,baseGuideBlend,installBaseRevealShader} from '../app/model-builder/base-reveal.mjs'
import {makeBaseGuideGeometry} from '../app/model-builder/base-guide-geometry.mjs'
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
test('guide bevel has an inset foot and preserves input for either winding',()=>{
 const points=[[0,5,0],[20,5,0],[20,5,10],[0,5,10]],original=JSON.stringify(points)
 for(const contour of [points,[...points].reverse()])for(const bevel of [0,1,2]){
  const geometry=makeBaseGuideGeometry(contour,bevel),p=geometry.attributes.position
  assert.equal(geometry.boundingBox.max.y,0);assert.ok(Math.abs(geometry.boundingBox.min.y+Math.max(.8,bevel))<1e-6)
  for(let i=0;i<p.count;i++)if(p.getY(i)===0){assert.ok(p.getX(i)>=bevel&&p.getX(i)<=20-bevel);assert.ok(p.getZ(i)>=bevel&&p.getZ(i)<=10-bevel)}
  geometry.dispose()
 }
 assert.equal(JSON.stringify(points),original)
})

