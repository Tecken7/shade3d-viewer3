export function contourPosition(contour, fraction) {
  if (!contour?.length) return null
  const lengths = contour.map((a, i) => Math.hypot(a[0] - contour[(i + 1) % contour.length][0], a[2] - contour[(i + 1) % contour.length][2]))
  const total = lengths.reduce((sum, length) => sum + length, 0)
  let remaining = Math.max(0, Math.min(1, fraction)) * total
  for (let i = 0; i < contour.length; i++) {
    if (remaining <= lengths[i] || i === contour.length - 1) {
      const t = lengths[i] ? remaining / lengths[i] : 0, a = contour[i], b = contour[(i + 1) % contour.length]
      return a.map((value, k) => value + (b[k] - value) * t)
    }
    remaining -= lengths[i]
  }
}

export function nearestContourPosition(contour, point) {
  if (!contour?.length) return { position: point.slice(), fraction: 0 }
  let best = Infinity, position = contour[0].slice(), along = 0, traversed = 0
  for (let i = 0; i < contour.length; i++) {
    const a = contour[i], b = contour[(i + 1) % contour.length], dx = b[0] - a[0], dz = b[2] - a[2]
    const length = Math.hypot(dx, dz), t = length ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[2] - a[2]) * dz) / (length * length))) : 0
    const candidate = a.map((value, k) => value + (b[k] - value) * t)
    const distance = (candidate[0] - point[0]) ** 2 + (candidate[2] - point[2]) ** 2
    if (distance < best) { best = distance; position = candidate; along = traversed + length * t }
    traversed += length
  }
  return { position, fraction: traversed ? along / traversed : 0 }
}
