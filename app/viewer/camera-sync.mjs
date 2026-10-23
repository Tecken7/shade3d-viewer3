export function cameraChanged(previous, next, epsilon = 1e-6) {
  if (!previous) return true
  for (const key of ["matrix", "up", "target", "canvasSize"]) {
    if (!next[key] || !previous[key] || next[key].length !== previous[key].length) return true
    if (next[key].some((value, i) => Math.abs(value - previous[key][i]) > epsilon)) return true
  }
  return Math.abs(next.zoom - previous.zoom) > epsilon
}
