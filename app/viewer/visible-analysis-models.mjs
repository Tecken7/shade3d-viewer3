export function visibleAnalysisModels(files, visibles, opacities, inferExt) {
  return files.filter((file, index) => visibles[index] !== false && (opacities[index] ?? 1) > 0 &&
    ['stl', 'ply', 'obj'].includes(inferExt(file.rawName || file.name || file.url)))
}

export function visibleAnalysisSelection(selection, visibleFiles) {
  const urls = new Set(visibleFiles.map(file => file.url))
  const [a, b] = selection
  if (!a || !urls.has(a)) return []
  return b && b !== a && urls.has(b) ? [a, b] : [a]
}
