import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {isClosingPointPress,validateClosedTrimPlan} from '../app/model-builder/trim-interaction.mjs'

test('double press survives small pointer jitter but never treats a drag or slow repeat as closure',()=>{
  const first={time:100,x:50,y:60}
  assert.equal(isClosingPointPress(null,first),false)
  assert.equal(isClosingPointPress(first,{time:300,x:53,y:62}),true)
  assert.equal(isClosingPointPress(first,{time:300,x:60,y:60}),false)
  assert.equal(isClosingPointPress(first,{time:600,x:50,y:60}),false)
})

test('closure prepares selectable regions before publishing closed state and releases drag suppression',()=>{
  const source=fs.readFileSync(new URL('../app/ClientPage.jsx',import.meta.url),'utf8')
  const start=source.indexOf('  const closeTrimLoop = useCallback(')
  const body=source.slice(start,source.indexOf('\n  }, [',start)).split('useCallback(')[1]+'\n  }'
  for(const valid of [true,false]){
    const states={},segments=[{pieces:[]}],context={},plan={components:valid?[[1],[2]]:[[1]]}
    const env={trimContext:context,trimClosed:false,trimControlNodes:[1,2,3],buildTrimSurfaceSplineSegments:()=>segments,buildTrimBoundaryPlan:()=>plan,validateClosedTrimPlan,
      trimBoundaryPlanCacheRef:{current:null},trimPendingDragHitRef:{current:'stale'},trimSuppressClickUntilRef:{current:Infinity},cameraInteractingRef:{current:true},console:{error(){}}}
    for(const name of body.match(/\bset\w+(?=\()/g))env[name]=value=>{states[name]=value}
    new Function(...Object.keys(env),`return (${body})`)(...Object.values(env))()
    if(valid){
      assert.equal(states.setTrimClosed,true)
      assert.equal(env.trimBoundaryPlanCacheRef.current.plan,plan)
      assert.equal(states.setTrimDraggingPoint,null)
      assert.equal(env.trimPendingDragHitRef.current,null)
      assert.equal(env.cameraInteractingRef.current,false)
      assert.ok(Number.isFinite(env.trimSuppressClickUntilRef.current))
    }else{
      assert.notEqual(states.setTrimClosed,true)
      assert.match(states.setTrimMessage,/nerozdělila/)
    }
  }
})
