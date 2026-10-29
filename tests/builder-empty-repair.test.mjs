import test from 'node:test'
import assert from 'node:assert/strict'
import {BUILDER_STEPS,nextBuilderStage,canApplyBuilderText,builderGeometryOptions} from '../app/model-builder/builder-workflow.mjs'

test('builder flow has repair inside Edit and Text after Base',()=>{
 let stage='scan';const visited=[stage]
 while(stage!=='result'){stage=nextBuilderStage(stage);visited.push(stage)}
 assert.deepEqual(visited,['scan','edit','trim','orient','base','text','result'])
 assert.deepEqual(visited,BUILDER_STEPS)
})
test('a completed trim proceeds straight to orientation',()=>assert.equal(nextBuilderStage('trim'),'orient'))
test('optional text can be skipped, but floating or invalid labels cannot be applied',()=>{
 const options={text:'',textPosition:null,textNormal:null}
 assert.equal(canApplyBuilderText(options,null),true)
 assert.equal(canApplyBuilderText({...options,text:'Arthetic'},null),false)
 const placed={text:'Arthetic',textPosition:[0,1,2],textNormal:[1,0,0]}
 assert.equal(canApplyBuilderText(placed,{valid:false}),false)
 assert.equal(canApplyBuilderText(placed,{valid:true},true),false)
 assert.equal(canApplyBuilderText(placed,{valid:true}),true)
})

test('regenerating a base defers its label and keeps the original text and drain settings',()=>{
 const options={text:'TEST',textPosition:[1,2,3],textNormal:[1,0,0],cutHoles:true,holes:[{enabled:true}]}
 const base=builderGeometryOptions(options,'base')
 assert.equal(base.text,'');assert.equal(base.textPosition,null);assert.equal(base.cutHoles,true)
 assert.equal(options.text,'TEST');assert.deepEqual(base.holes,options.holes)
 assert.equal(builderGeometryOptions(options,'text'),options)
})
