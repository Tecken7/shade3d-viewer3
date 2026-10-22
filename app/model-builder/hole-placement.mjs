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

export function holeDirection(contour, position, yawDegrees = 0) {
  if (!contour?.length) return [0,0,1]
  let perimeter=0,area=0
  for(let i=0;i<contour.length;i++){
    const a=contour[i],b=contour[(i+1)%contour.length]
    perimeter+=Math.hypot(b[0]-a[0],b[2]-a[2]);area+=a[0]*b[2]-b[0]*a[2]
  }
  if(perimeter<1e-9)return [0,0,1]
  const fraction=nearestContourPosition(contour,position).fraction
  const offset=Math.min(.5,perimeter*.01)/perimeter
  const before=contourPosition(contour,(fraction-offset+1)%1),after=contourPosition(contour,(fraction+offset)%1)
  const dx=after[0]-before[0],dz=after[2]-before[2],length=Math.hypot(dx,dz)
  if(length<1e-9)return [0,0,1]
  const sign=area>=0?1:-1,x=sign*dz/length,z=-sign*dx/length,yaw=yawDegrees*Math.PI/180
  return [x*Math.cos(yaw)+z*Math.sin(yaw),0,z*Math.cos(yaw)-x*Math.sin(yaw)]
}

export function seatHoleOnContour(contour, hole, point = hole.position) {
 const position=nearestContourPosition(contour,point).position
 const offset=hole.heightOffset ?? .5
 position[1]-=(hole.baseDirection ?? 1)*offset
 return position
}
