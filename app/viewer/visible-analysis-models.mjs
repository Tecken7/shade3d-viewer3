export function visibleAnalysisModels(files, visibles, opacities, inferExt) {
  return files.filter((file, index) => visibles[index] !== false && (opacities[index] ?? 1) > 0 &&
    ['stl', 'ply', 'obj'].includes(inferExt(file.rawName || file.name || file.url)))
}

export function visibleAnalysisSelection(selection, visibleFiles, {computed = false, sceneFiles = visibleFiles} = {}) {
  // Once measured, visibility is a viewing preference, not a change to the pair.
  // Removed files still invalidate the result; hidden files cannot be newly picked.
  const urls = new Set((computed ? sceneFiles : visibleFiles).map(file => file.url))
  const [a, b] = selection
  if (!a || !urls.has(a)) return []
  return b && b !== a && urls.has(b) ? [a, b] : [a]
}

export function analysisCalculationAvailability(selection, visibleFiles) {
  const ready = selection.length === 2 && visibleAnalysisSelection(selection, visibleFiles).length === 2
  return {ready, reason: ready ? '' : visibleFiles.length < 2
    ? 'Na scéně musí být alespoň dva viditelné modely.'
    : selection.length === 2 ? 'Oba vybrané modely musí být na scéně viditelné.' : 'Vyberte dva viditelné modely.'}
}
