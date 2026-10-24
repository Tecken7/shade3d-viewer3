// Incoming postMessage data is JSON-shaped. Preserve references for equivalent state.
export function sameSceneValue(a, b) {
 if (Object.is(a,b)) return true
 if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false
 const keys=Object.keys(a),other=Object.keys(b)
 return keys.length===other.length && keys.every(key=>Object.hasOwn(b,key)&&sameSceneValue(a[key],b[key]))
}
export const stableSceneValue=(previous,next)=>sameSceneValue(previous,next)?previous:next
