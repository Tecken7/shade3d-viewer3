import {readSTL,encodeSTL} from './stl.mjs'
import {convertFinishedBase} from './convert-finished-base.mjs'
import {indexed} from '../model-builder/engine.mjs'
import {decorateFinishedModel,contactArea} from '../model-builder/finished-model-tags.mjs'
export async function processFinishedModel(M,buffer,settings,fonts,progress=()=>{}){
 const raw=readSTL(buffer);let baseZ=Infinity
 for(let i=2;i<raw.length;i+=3)baseZ=Math.min(baseZ,raw[i])
 const local=raw.slice();for(let i=0;i<local.length;i+=3){local[i+1]=raw[i+2]-baseZ;local[i+2]=-raw[i+1]}
 const source=indexed(local,{exact:true}),original={positions:Float32Array.from(source.vertices),indices:Uint32Array.from(source.faces),placement:{baseY:0,direction:-1},holes:[],stats:{}}
 const before=contactArea(original)
 if(before<10)throw Error('Model nemá rovnou dosedací plochu dole v ose Z. Nejprve jej orientujte jako pro tisk.')
 let base=settings.convertBase?await convertFinishedBase(M,raw,settings,progress):original
 const result=await decorateFinishedModel(M,base,{logo:settings.logo,logoSize:settings.logoSize,tags:settings.tag?.trim()?[{text:settings.tag,size:settings.tagSize,weight:500,depth:.4}]:[]},fonts,progress)
 if(result.status!=='ready')throw Error(result.message)
 base=result.output
 const after=contactArea(base)
 if(settings.convertBase&&after+.05<before)throw Error('Úprava by zmenšila dosedací plochu. Zkuste menší bevel nebo jinou výšku úpravy.')
 progress('Ověřuji STL pro tisk…')
 const world=base.positions.slice()
 for(let i=0;i<world.length;i+=3){const y=world[i+1];world[i+1]=-world[i+2];world[i+2]=y+baseZ}
 const stl=encodeSTL(world,base.indices)
 // Re-import the exact Float32 export, not only the pre-export manifold.
 const check=indexed(readSTL(stl),{exact:true}),mesh=new M.Mesh({numProp:3,vertProperties:Float32Array.from(check.vertices),triVerts:Uint32Array.from(check.faces)});mesh.merge()
 const solid=new M.Manifold(mesh),parts=solid.decompose()
 try{if(solid.status()!=='NoError'||parts.length!==1)throw Error('Kontrola výsledku: model není jeden uzavřený celek.')}finally{parts.forEach(p=>p.delete());solid.delete()}
 return {stl,positions:base.positions,indices:base.indices,report:{contactBefore:before,contactAfter:after,labels:result.items,components:1,openEdges:0,nonManifold:0,replaceHeight:settings.convertBase?base.replaceHeight??settings.replaceHeight:0}}
}
