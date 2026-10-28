import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
const source=fs.readFileSync(new URL('../app/ClientPage.jsx',import.meta.url),'utf8').replace(/\r\n/g,'\n')
const start=source.indexOf('  useEffect(()=>{\n    if(!cadStandalone || cadStage!=="repair"'),end=source.indexOf('  const changeRepairVariant',start)
const body=source.slice(start,end)
function run(overrides={}){
 let scheduled=null,cleared=false,advanced=false,cleanup
 const values={cadStandalone:true,cadStage:'repair',cadBusy:false,repairBusy:false,repairAnalysisComplete:true,repairContext:{},repairSelection:'scan',cadFileUrl:'scan',repairHoles:[],continueCadAfterRepair:()=>advanced=true,...overrides}
 new Function(...Object.keys(values),'useEffect','window',body)(...Object.values(values),fn=>{cleanup=fn()},{setTimeout:fn=>{scheduled=fn;return 1},clearTimeout:()=>cleared=true})
 return {get scheduled(){return !!scheduled},fire:()=>scheduled?.(),cleanup,get advanced(){return advanced},get cleared(){return cleared}}
}
test('a completed empty repair automatically advances and cleans up its delayed transition',()=>{const result=run();assert.equal(result.scheduled,true);result.fire();assert.equal(result.advanced,true);result.cleanup();assert.equal(result.cleared,true)})
test('pending, failed, stale or nonempty analyses never skip the repair step',()=>{
 for(const state of [{cadStage:'trim'},{repairBusy:true},{cadBusy:true},{repairAnalysisComplete:false},{repairContext:null},{repairSelection:'another scan'},{repairHoles:[{id:1}]}])assert.equal(run(state).scheduled,false)
})
