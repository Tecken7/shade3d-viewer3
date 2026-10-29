import {textWeight} from './text-font.mjs'
export const BUILDER_STEPS=['scan','edit','trim','orient','base','text','result']
export const BUILDER_STEP_LABELS={scan:'Scan',edit:'Úprava',trim:'Ořez',orient:'Orientace',base:'Báze',text:'Text',result:'Výsledek'}
export function nextBuilderStage(stage){return BUILDER_STEPS[Math.min(BUILDER_STEPS.length-1,BUILDER_STEPS.indexOf(stage)+1)]}
export function canApplyBuilderText(options,status,busy=false){
 return !busy&&(!options.text.trim()||!!(options.textPosition&&options.textNormal&&status?.valid))&&(!options.textLogoEnabled||!!(options.textLogoPosition&&options.textLogoNormal&&status?.logo?.valid))
}

// Base creation stays independent of the optional, later label step.
export function builderGeometryOptions(options,stage){
 return stage==='base'?{...options,text:'',textPosition:null,textNormal:null,textLogoEnabled:false}:options
}

export function builderTextSignature(options){
 return JSON.stringify([options.text,options.textSize,textWeight(options.textWeight),options.textDepth,options.textMode,options.textRotation,options.textPosition,options.textNormal,!!options.textLogoEnabled,options.textLogoPosition,options.textLogoNormal,options.textLogoSize,options.textLogoRotation])
}
