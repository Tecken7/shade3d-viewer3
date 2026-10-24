export const DEFAULT_LIGHTING = Object.freeze({ brightness: 1, azimuth: 0, elevation: 45, softness: .35, preset: 'default' })
export const LIGHTING_PRESETS = {
 default: DEFAULT_LIGHTING,
 even: { brightness: 1, azimuth: 0, elevation: 55, softness: .9, preset: 'even' },
 detail: { brightness: 1, azimuth: 65, elevation: 25, softness: .08, preset: 'detail' },
}
export function normalizeLighting(value = {}) {
 const clamp = (key, min, max) => Number.isFinite(value?.[key]) ? Math.max(min, Math.min(max, value[key])) : DEFAULT_LIGHTING[key]
 return { brightness: clamp('brightness', .2, 2), azimuth: clamp('azimuth', -180, 180), elevation: clamp('elevation', 5, 85), softness: clamp('softness', 0, 1), preset: value?.preset == null ? 'default' : Object.hasOwn(LIGHTING_PRESETS, value.preset) ? value.preset : 'custom' }
}
