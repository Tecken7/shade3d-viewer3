export function isClosingPointPress(previous, press) {
  return !!previous && press.time >= previous.time && press.time - previous.time <= 600 && Math.hypot(press.x - previous.x, press.y - previous.y) <= 5
}

export function validateClosedTrimPlan(plan) {
  if (!plan || plan.components.length < 2) throw new Error('Hranice nerozdělila scan na dvě oblasti. Posuňte její body a zkuste uzavření znovu.')
  return plan
}

export function isNearTrimStart(diagonal, nodes, point) {
  if (nodes.length<3 || !point || !nodes[0]?.point) return false
  const first=nodes[0].point,radius=Math.max(.1,Math.min(1.15,diagonal*.0067))*1.6
  return Math.hypot(...point.map((value,i)=>value-first[i]))<=radius
}
