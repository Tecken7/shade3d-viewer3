// Loading an editor snapshot is restoration, not a request to convert its CT.
// Keep this decision separate from the download URL, which may be re-signed.
export function dicomPreparationKey(source) {
  if (!source?.u) return null
  try {
    const url = new URL(source.u)
    for (const key of [...url.searchParams.keys()]) {
      if (/^(token|signature|expires|x-amz-.+|x-goog-.+)$/i.test(key)) url.searchParams.delete(key)
    }
    return url.toString()
  } catch { return source.u }
}

export function createDicomPreparationTracker({ restoreInitial = false } = {}) {
  let restoringInitial = restoreInitial
  let current = null
  const prepared = new Set()
  return {
    receive(source, { restored = false } = {}) {
      const key = dicomPreparationKey(source)
      const initial = restoringInitial && !!key
      if (key || restored) restoringInitial = false
      const changed = key !== current
      current = key
      if (!key) return false
      if (initial || restored || source.prepareSurface === false || source.settings?.surfacePrepared === true) prepared.add(key)
      return changed && !prepared.has(key) && source.prepareSurface !== false
    },
    confirm(source) {
      const key = dicomPreparationKey(source)
      if (key) prepared.add(key)
    },
  }
}
