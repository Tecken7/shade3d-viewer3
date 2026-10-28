export const BASE_REVEAL_MS=1500
export function baseRevealProgress(elapsed,duration=BASE_REVEAL_MS){
  const t=Math.max(0,Math.min(1,elapsed/duration))
  return t*t*(3-2*t)
}
export function baseGuideBlend(progress){
  const t=Math.max(0,Math.min(1,(progress-.65)/.35))
  return t*t*(3-2*t)
}
export function installBaseRevealShader(shader,uniforms){
  Object.assign(shader.uniforms,uniforms)
  shader.vertexShader='varying float vBaseHeight;\n'+shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nvBaseHeight = position.y;')
  shader.fragmentShader='varying float vBaseHeight;\nuniform float uBaseRevealEnabled;\nuniform float uBaseRevealProgress;\nuniform float uBaseRevealFrom;\nuniform float uBaseRevealTo;\nuniform float uBaseRevealDirection;\n'+shader.fragmentShader.replace('#include <clipping_planes_fragment>',`#include <clipping_planes_fragment>
    if (uBaseRevealEnabled > 0.5 && uBaseRevealProgress < 1.0) {
      float front = mix(uBaseRevealFrom, uBaseRevealTo, uBaseRevealProgress);
      if (uBaseRevealDirection * (vBaseHeight - front) > 0.0) discard;
    }`)
}
