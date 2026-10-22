export function isClosingPointPress(previous, press) {
  return !!previous && press.time >= previous.time && press.time - previous.time <= 420 && Math.hypot(press.x - previous.x, press.y - previous.y) <= 5
}

export function validateClosedTrimPlan(plan) {
  if (!plan || plan.components.length < 2) throw new Error('Hranice nerozdělila scan na dvě oblasti. Posuňte její body a zkuste uzavření znovu.')
  return plan
}
