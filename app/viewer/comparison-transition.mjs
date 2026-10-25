export function advanceComparisonBlend(current, visible, delta, duration = .38) {
 const next = visible ? Math.min(1,current + delta/duration) : Math.max(0,current - delta/duration)
 return {position:next,value:next*next*(3-2*next)}
}
export function setComparisonBlendMaterial(material, uniform, enabled) {
 if (!material) return
 const key='_artheticComparisonBlend'
 if (!enabled) {
  const previous=material.userData[key]
  if(previous){material.onBeforeCompile=previous.compile;material.customProgramCacheKey=previous.cache;delete material.userData[key];material.needsUpdate=true}
  return
 }
 if(material.userData[key])return
 const previous={compile:material.onBeforeCompile,cache:material.customProgramCacheKey,cacheValue:material.customProgramCacheKey()}
 material.userData[key]=previous
 material.onBeforeCompile=function(shader,...args){
  previous.compile.call(this,shader,...args)
  shader.uniforms.uArtheticComparisonBlend=uniform
  shader.vertexShader='attribute vec3 artheticComparisonColor;\nvarying vec3 vArtheticComparisonColor;\n'+shader.vertexShader.replace(/void main\s*\(\s*\)\s*\{/, '$&\nvArtheticComparisonColor = artheticComparisonColor;')
  shader.fragmentShader='uniform float uArtheticComparisonBlend;\nvarying vec3 vArtheticComparisonColor;\n'+shader.fragmentShader
  if(shader.fragmentShader.includes('#include <color_fragment>'))shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>','#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, vArtheticComparisonColor, uArtheticComparisonBlend);')
  else shader.fragmentShader=shader.fragmentShader.replace('sourceColor = clamp(sourceColor, 0.0, 1.0);','sourceColor = mix(sourceColor, vArtheticComparisonColor, uArtheticComparisonBlend);\nsourceColor = clamp(sourceColor, 0.0, 1.0);')
 }
 material.customProgramCacheKey=function(){return previous.cacheValue+'|arthetic-comparison-blend-v1'}
 material.needsUpdate=true
}
