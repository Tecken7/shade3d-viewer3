export const LAB_LOGO_FONT='/wasm/model-builder/arthetic-logo-font.json'
// Private glyph slots let T appear in both weights in the same closed text mesh.
export const LAB_LOGO_TEXT='\ue000\ue001\ue002HETIC'
export function labLogoOptions(options){
 return {...options,text:options.textLogoEnabled?LAB_LOGO_TEXT:'',textSize:options.textLogoSize??2.6,textDepth:.4,textWeight:400,textMode:'emboss',textRotation:options.textLogoRotation??0,textPosition:options.textLogoPosition,textNormal:options.textLogoNormal}
}
export const labLogoPatch=patch=>Object.fromEntries(Object.entries(patch).filter(([key])=>['textPosition','textNormal','textSize','textRotation'].includes(key)).map(([key,value])=>['textLogo'+key.slice(4),value]))
