import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {runStepsAsync} from '../app/model-builder/cooperative-work.mjs'
const source=fs.readFileSync(new URL('../app/ClientPage.jsx',import.meta.url),'utf8')
const start=source.indexOf('  const beginCadEditStage =')
const body=source.slice(start,source.indexOf('  const handleCadEditClick',start))
function fixture(fail=false){
 const states={},events=[],object={},context={},loops=[]
 let heartbeat=false
 const values={useCallback:fn=>fn,cadUpperUrl:'scan',cadLowerUrl:'',cadUpperName:'Upper',cadLowerName:'',cadBusy:false,modelObjectsRef:{current:{scan:object}},cadSessionRef:{current:null},
 repairWaitForBusyPaint:async()=>{setTimeout(()=>heartbeat=true,0)},
 prepareRepairVerticesAsync:async value=>{assert.equal(value,object);events.push('vertices')},
 buildTrimMeshContextSteps:function*(){yield;assert.equal(heartbeat,true);events.push('context');if(fail)throw Error('Failed');return context},
 findRepairBoundaryLoopSteps:function* (value){assert.equal(value,context);yield;events.push('loops');return loops},
 runStepsAsync:steps=>runStepsAsync(steps,{budget:0}),refreshCadEdit:(obj,ctx,ls)=>{assert.equal(obj,object);assert.equal(ctx,context);assert.equal(ls,loops);events.push('commit')}
 }
 for(const name of new Set(body.match(/\bset\w+(?=\()/g)))values[name]=value=>states[name]=value
 return {run:new Function(...Object.keys(values),body+';return beginCadEditStage')(...Object.values(values)),states,events}
}
test('builder preparation yields to input and commits only complete context and boundaries',async()=>{const f=fixture();const pending=f.run();assert.equal(f.states.setCadBusy,true);await pending;assert.deepEqual(f.events,['vertices','context','loops','commit']);assert.equal(f.states.setCadStage,'edit');assert.equal(f.states.setCadBusy,false)})
test('failed builder preparation leaves the picker available and clears busy state',async()=>{const f=fixture(true);await f.run();assert.equal(f.states.setCadStage,undefined);assert.equal(f.states.setCadBusy,false);assert.equal(f.states.setCadMessage,'Failed');assert.ok(!f.events.includes('commit'))})
test('camera remains available during initial builder preparation, with later commit locks intact',()=>{
 const expression=source.slice(source.indexOf('<TouchTrackballControls key={`main-trackball-')).match(/enabled=\{([^}]+)\}/)[1]
 const state={sliceDrawing:false,builderDragging:false,builderPlacing:false,sliceOverlayInteracting:false,alignmentBusy:false,cadBusy:true,cadStage:'scan',trimDraggingPoint:null,trimBusy:false,trimStage:'model'}
 const enabled=overrides=>{const s={...state,...overrides};return new Function(...Object.keys(s),'return '+expression)(...Object.values(s))}
 assert.equal(enabled({}),true);assert.equal(enabled({cadStage:'base'}),true);assert.equal(enabled({cadStage:'orient'}),false);assert.equal(enabled({sliceDrawing:true}),false)
})
