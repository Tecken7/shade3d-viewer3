export function sampleDicomTrilinear(volume, tx, ty, tz) {
  const x = Math.max(0, Math.min(volume.width - 1, tx * volume.width - .5))
  const y = Math.max(0, Math.min(volume.height - 1, ty * volume.height - .5))
  const z = Math.max(0, Math.min(volume.depth - 1, tz * volume.depth - .5))
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z)
  const x1 = Math.min(volume.width - 1, x0 + 1)
  const y1 = Math.min(volume.height - 1, y0 + 1)
  const z1 = Math.min(volume.depth - 1, z0 + 1)
  const fx = x - x0, fy = y - y0, fz = z - z0
  const row = volume.width
  const layer = volume.width * volume.height
  const data = volume.data
  const value = (ix, iy, iz) => data[iz * layer + iy * row + ix]
  const c00 = value(x0, y0, z0) * (1 - fx) + value(x1, y0, z0) * fx
  const c10 = value(x0, y1, z0) * (1 - fx) + value(x1, y1, z0) * fx
  const c01 = value(x0, y0, z1) * (1 - fx) + value(x1, y0, z1) * fx
  const c11 = value(x0, y1, z1) * (1 - fx) + value(x1, y1, z1) * fx
  const c0 = c00 * (1 - fy) + c10 * fy
  const c1 = c01 * (1 - fy) + c11 * fy
  return c0 * (1 - fz) + c1 * fz
}

