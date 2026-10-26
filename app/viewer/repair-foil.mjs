// Subtle view-dependent foil, evaluated on the GPU without textures or extra draws.
export function setRepairFoilMaterial(material, uniforms, enabled) {
  if (!material) return
  const key = '_artheticRepairFoil'
  const previous = material.userData[key]
  if (!enabled) {
    if (previous) {
      material.onBeforeCompile = previous.compile
      material.customProgramCacheKey = previous.cache
      delete material.userData[key]
      material.needsUpdate = true
    }
    return
  }
  if (previous || !material.isMeshStandardMaterial) return
  const saved = {compile: material.onBeforeCompile, cache: material.customProgramCacheKey, cacheValue: material.customProgramCacheKey()}
  material.userData[key] = saved
  material.onBeforeCompile = function(shader, ...args) {
    saved.compile.call(this, shader, ...args)
    shader.uniforms.uRepairFoilAmount = uniforms.amount
    shader.uniforms.uRepairFoilTime = uniforms.time
    shader.vertexShader = 'varying vec3 vRepairFoilPosition;\n' + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvRepairFoilPosition = transformed;')
    shader.fragmentShader = 'varying vec3 vRepairFoilPosition;\nuniform float uRepairFoilAmount;\nuniform float uRepairFoilTime;\n' + shader.fragmentShader.replace('#include <opaque_fragment>', `
      float foilFacing = clamp(abs(dot(normalize(normal), normalize(vViewPosition))), 0.0, 1.0);
      float foilRim = pow(1.0 - foilFacing, 2.0);
      float foilPhase = dot(vRepairFoilPosition, vec3(.09, .055, .035)) + foilFacing * 8.0 - uRepairFoilTime * .55;
      float foilSweep = pow(.5 + .5 * sin(foilPhase), 14.0);
      vec3 foilBlue = mix(vec3(.025, .12, .65), vec3(.035, .62, .85), .5 + .5 * sin(foilPhase * .65));
      foilBlue = mix(foilBlue, vec3(.23, .055, .65), .22 * (.5 + .5 * sin(foilPhase + 1.4)));
      outgoingLight += uRepairFoilAmount * foilBlue * (.035 + foilRim * .20 + foilSweep * .25);
      #include <opaque_fragment>
    `)
  }
  material.customProgramCacheKey = () => saved.cacheValue + '|arthetic-repair-foil-v1'
  material.needsUpdate = true
}
