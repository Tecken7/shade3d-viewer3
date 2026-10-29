import fs from 'node:fs/promises'
import path from 'node:path'
import Module from 'manifold-3d'
import {indexed} from '../app/model-builder/engine.mjs'
import {decorateFinishedModel,contactArea} from '../app/model-builder/finished-model-tags.mjs'
import {readBinarySTL,encodeClosedSTL} from './lib/finished-model-stl.mjs'

const args=process.argv.slice(2),files=[],config={logo:true,tags:[]};let directory='',tag='',weight=500,size=4,mode='emboss',depth=.4,holesFile=''
for(let i=0;i<args.length;i++){
 const key=args[i]
 if(key==='--help'){console.log('node scripts/tag-finished-model.mjs model.stl [další.stl] --out složka [--tag "MODEL 04"] [--no-logo] [--logo-size 1.8] [--weight 500] [--size 4] [--engrave] [--depth 0.4] [--holes-report report.json]\nVstup: hotové 3Shape STL, spodek v ose Z. Logo Inter je výchozí, souřadnice exportu zůstanou zachované. {name} v tagu se nahradí názvem souboru.');process.exit(0)}
 if(key==='--out')directory=args[++i]
 else if(key==='--tag')tag=args[++i]
 else if(key==='--weight')weight=Number(args[++i])
 else if(key==='--size')size=Number(args[++i])
 else if(key==='--logo-size')config.logoSize=Number(args[++i])
 else if(key==='--depth')depth=Number(args[++i])
 else if(key==='--holes-report')holesFile=args[++i]
 else if(key==='--no-logo')config.logo=false
 else if(key==='--logo')config.logo=true
 else if(key==='--engrave')mode='engrave'
 else if(key.startsWith('--'))throw Error(`Neznámá volba ${key}`)
 else files.push(key)
}
if(!files.length||!directory)throw Error('Zadejte vstupní STL a --out složku.')
if(![200,300,400,500,600,700,800].includes(weight)||!Number.isFinite(size)||!Number.isFinite(depth))throw Error('Neplatný řez nebo velikost písma.')
const M=await Module();M.setup()
const font=async name=>JSON.parse(await fs.readFile(new URL('../public/wasm/model-builder/'+name,import.meta.url),'utf8'))
const fonts={[weight]:await font(`inter${weight===400?'':`-${weight}`}-font.json`),logo:await font('arthetic-logo-font.json')}
const holeReport=holesFile?JSON.parse(await fs.readFile(holesFile,'utf8')):null,summary=[]
await fs.mkdir(directory,{recursive:true})
for(const file of files){
 const name=path.basename(file,path.extname(file)),report={source:path.basename(file)}
 try{
  const raw=readBinarySTL(await fs.readFile(file));let baseZ=Infinity,maxZ=-Infinity
  for(let i=2;i<raw.length;i+=3){baseZ=Math.min(baseZ,raw[i]);maxZ=Math.max(maxZ,raw[i])}
  const normalized=new Float32Array(raw.length)
  for(let i=0;i<raw.length;i+=3){normalized[i]=raw[i];normalized[i+1]=raw[i+2]-baseZ;normalized[i+2]=-raw[i+1]}
  const input=indexed(normalized,{exact:true}),holes=(holeReport?.holes||[]).map(h=>({...h,position:[h.position[0],h.position[2]-baseZ,-h.position[1]],normal:[h.normal[0],h.normal[2],-h.normal[1]]})),base={positions:Float32Array.from(input.vertices),indices:Uint32Array.from(input.faces),placement:{baseY:0,direction:-1},holes,stats:{}}
  if(contactArea(base)<10)throw Error('Nerozpoznáno rovné dno v ose Z. Model vyžaduje ruční orientaci.')
  const cfg={...config,tags:tag?[{text:tag.replaceAll('{name}',name),weight,size,mode,depth}]:[]}
  const result=await decorateFinishedModel(M,base,cfg,fonts,message=>console.log(name+': '+message))
  Object.assign(report,{status:result.status,message:result.message,items:result.items.map(item=>({...item,position:[item.position[0],-item.position[2],item.position[1]+baseZ],normal:[item.normal[0],-item.normal[2],item.normal[1]]})),contactAreaBefore:result.contactAreaBefore,contactAreaAfter:result.contactAreaAfter})
  if(result.status==='ready'){
   const positions=result.output.positions.slice()
   for(let i=0;i<positions.length;i+=3){const y=positions[i+1];positions[i+1]=-positions[i+2];positions[i+2]=y+baseZ}
   const encoded=encodeClosedSTL(positions,result.output.indices),bytes=encoded.bytes,output=path.resolve(directory,name+'-tagged.stl')
   const checked=indexed(readBinarySTL(bytes),{exact:true}),mesh=new M.Mesh({numProp:3,vertProperties:Float32Array.from(checked.vertices),triVerts:Uint32Array.from(checked.faces)});mesh.merge();const solid=new M.Manifold(mesh),parts=solid.decompose()
   try{if(solid.status()!=='NoError'||parts.length!==1)throw Error('Výsledek není jeden uzavřený model.');Object.assign(report,{triangles:encoded.triangles,openEdges:0,nonManifold:0,components:parts.length});await fs.writeFile(output,bytes,{flag:'wx'});report.output=path.basename(output)}finally{parts.forEach(part=>part.delete());solid.delete()}
  }
 }catch(error){report.status='error';report.message=error.message}
 summary.push(report);await fs.writeFile(path.join(directory,name+'-tags.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report))
}
await fs.writeFile(path.join(directory,'tagging-report.json'),JSON.stringify(summary,null,2))
if(summary.some(item=>item.status!=='ready'))process.exitCode=2
