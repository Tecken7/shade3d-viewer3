// Preserve the original material state, including the diagnostic Ghost shader.
export function captureModelFade(object) {
  const entries=[], seen=new Set()
  object.traverse(child=>{
    if(!child.isMesh)return
    for(const material of Array.isArray(child.material)?child.material:[child.material]) {
      if(!material||seen.has(material))continue
      seen.add(material)
      entries.push({material,opacity:material.opacity,transparent:material.transparent,depthWrite:material.depthWrite,ghost:material.uniforms?.uGhostStrength?.value})
      if(!material.transparent){material.transparent=true;material.needsUpdate=true}
      material.depthWrite=false
    }
  })
  return entries
}
export function applyModelFade(entries, amount) {
  for(const entry of entries){entry.material.opacity=entry.opacity*amount;if(entry.ghost!=null)entry.material.uniforms.uGhostStrength.value=entry.ghost*amount}
}
export function restoreModelFade(entries) {
  for(const entry of entries){
    const material=entry.material
    material.opacity=entry.opacity
    if(entry.ghost!=null)material.uniforms.uGhostStrength.value=entry.ghost
    if(material.transparent!==entry.transparent)material.needsUpdate=true
    material.transparent=entry.transparent;material.depthWrite=entry.depthWrite
  }
}
