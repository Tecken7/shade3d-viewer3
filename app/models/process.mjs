import {readSTL,encodeSTL} from './stl.mjs'
import {convertFinishedBase} from './convert-finished-base.mjs'
import {hollowFinishedModel} from './hollow-finished-model.mjs'
import {indexed,fromManifold} from '../model-builder/engine.mjs'
import {decorateFinishedModel,contactArea} from '../model-builder/finished-model-tags.mjs'
export async function processFinishedModel(M,buffer,settings,fonts,progress=()=>{}){
 let raw=readSTL(buffer);const hollow=settings.convertBase?hollowFinishedModel(M,raw,settings,progress):{raw,hollowed:false};raw=hollow.raw;let baseZ=Infinity
 for(let i=2;i<raw.length;i+=3)baseZ=Math.min(baseZ,raw[i])
 const local=raw.slice();for(let i=0;i<local.length;i+=3){local[i+1]=raw[i+2]-baseZ;local[i+2]=-raw[i+1]}
 const source=indexed(local,{exact:true}),original={positions:Float32Array.from(source.vertices),indices:Uint32Array.from(source.faces),placement:{baseY:0,direction:-1},holes:[],stats:{}}
 const before=contactArea(original)
 if(before<10)throw Error('Model nemá rovnou dosedací plochu dole v ose Z. Nejprve jej orientujte jako pro tisk.')
 let base=settings.convertBase?await convertFinishedBase(M,raw,{...settings,repairCoincident:hollow.hollowed,sourceFunctionalContours:hollow.functionalContours},progress):original
 const context={baseZ:base.baseZ??baseZ,before,hollowed:hollow.hollowed,settings,drainSource:settings.convertBase&&settings.holes!==false?{raw,sourceFunctionalContours:hollow.functionalContours}:undefined}
 if(base.drainReview)return {status:'needs-drains',positions:base.positions,indices:base.indices,drainReview:base.drainReview,drainManual:{...context,raw,sourceFunctionalContours:hollow.functionalContours},message:base.drainReview.message,report:{contactBefore:before}}
 return finishPreparedModel(M,base,context,fonts,progress)
}

async function finishPreparedModel(M,base,context,fonts,progress){
 const {settings,labelDrafts}=context,logo=labelDrafts?.find(t=>t.brand)
 const config=labelDrafts?{tags:labelDrafts.filter(t=>!t.brand),logo:!!logo,logoSize:logo?.size,logoPlacement:logo}:{logo:settings.logo,logoSize:settings.logoSize,tags:settings.tag?.trim()?[{text:settings.tag,size:settings.tagSize,weight:500,depth:.4}]:[]}
 const result=await decorateFinishedModel(M,base,{allowManual:true,...config},fonts,progress)
 const manual={base,...context,pending:result.drafts??result.pending??[],items:result.items}
 const drainEdit=context.drainSource&&base.drainDrafts?{...context,...context.drainSource,labelDrafts:manual.pending}:undefined
 if(result.status!=='ready')return {status:'needs-placement',positions:base.positions,indices:base.indices,manual,drainEdit,drainDrafts:base.drainDrafts,message:result.message,report:{contactBefore:context.before,contactAfter:contactArea(base)}}
 const ready=await finalizeFinishedModel(M,result.output,{...context,labels:result.items},progress)
 return {...ready,labelEdit:manual.pending.length?manual:undefined,drainEdit}
}

export async function reviewManualDrains(M,manual,holes,progress=()=>{}){
 const settings={...manual.settings,reviewDrains:true,manualHoles:undefined,reviewHoles:holes,sourceFunctionalContours:manual.sourceFunctionalContours,repairCoincident:manual.hollowed},base=await convertFinishedBase(M,manual.raw,settings,progress)
 if(!base.drainReview)throw Error('Náhled otvorů se nepodařilo připravit.')
 return {status:'needs-drains',positions:base.positions,indices:base.indices,drainReview:base.drainReview,drainManual:manual,message:base.drainReview.message,report:{contactBefore:manual.before}}
}

export async function finishManualDrains(M,manual,holes,fonts,progress=()=>{}){
 const settings={...manual.settings,reviewDrains:false,reviewHoles:undefined,manualHoles:holes,sourceFunctionalContours:manual.sourceFunctionalContours,repairCoincident:manual.hollowed},base=await convertFinishedBase(M,manual.raw,settings,progress)
 if(base.drainReview)throw Error('Potvrďte prosím polohu odtokových válců.')
 return finishPreparedModel(M,base,{baseZ:manual.baseZ,before:manual.before,hollowed:manual.hollowed,settings:manual.settings,drainSource:manual.drainSource??{raw:manual.raw,sourceFunctionalContours:manual.sourceFunctionalContours},labelDrafts:manual.labelDrafts},fonts,progress)
}

export async function finalizeFinishedModel(M,base,{baseZ,before,hollowed=false,settings,labels},progress=()=>{}){
 const after=contactArea(base)
 if(settings.convertBase&&after+.05<before)throw Error('Úprava by zmenšila dosedací plochu. Zkuste menší bevel nebo jinou výšku úpravy.')
 progress('Ověřuji STL pro tisk…')
 const world=base.positions.slice()
 for(let i=0;i<world.length;i+=3){const y=world[i+1];world[i+1]=-world[i+2];world[i+2]=y+baseZ}
 let stl=encodeSTL(world,base.indices)
 // Re-import the exact Float32 export, not only the pre-export manifold.
 // Float rounding may isolate numerical sheets smaller than 0.00001 mm³.
 // Remove only those, then validate the newly encoded bytes again.
 for(let attempt=0;attempt<2;attempt++){
  const check=indexed(readSTL(stl),{exact:true}),mesh=new M.Mesh({numProp:3,vertProperties:Float32Array.from(check.vertices),triVerts:Uint32Array.from(check.faces)});mesh.merge()
  const solid=new M.Manifold(mesh),parts=solid.decompose()
  try{
   if(solid.status()!=='NoError')throw Error('Kontrola výsledku: model není jeden uzavřený celek.')
   if(parts.length===1)break
   const retained=parts.filter(p=>Math.abs(p.volume())>1e-5)
   if(attempt||retained.length!==1)throw Error('Kontrola výsledku: model není jeden uzavřený celek.')
   const clean=fromManifold(retained[0]);stl=encodeSTL(Float32Array.from(clean.vertices),Uint32Array.from(clean.faces))
  }finally{parts.forEach(p=>p.delete());solid.delete()}
 }
 return {status:'ready',stl,positions:base.positions,indices:base.indices,drainDrafts:base.drainDrafts,report:{contactBefore:before,contactAfter:after,hollowed,extendedBy:base.extendedBy??0,baseMode:base.baseMode??'extended',protectedRegions:base.protectedRegions??0,drains:base.holes||[],warnings:base.warnings||[],labels,components:1,openEdges:0,nonManifold:0,replaceHeight:settings.convertBase?base.replaceHeight??settings.replaceHeight:0}}
}

export async function finishManualLabels(M,manual,pending,fonts,progress=()=>{}){
 return finishPreparedModel(M,manual.base,{baseZ:manual.baseZ,before:manual.before,hollowed:manual.hollowed,settings:manual.settings,drainSource:manual.drainSource,labelDrafts:pending},fonts,progress)
}
