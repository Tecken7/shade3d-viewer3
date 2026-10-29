import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as THREE from 'three'
const source=fs.readFileSync(new URL('../app/ClientPage.jsx',import.meta.url),'utf8'),body=source.slice(source.indexOf('function buildValidatedTrimSurfaceBoundary('),source.indexOf('function trimSharedEdgeNodes('))
const segment=i=>({spanIndex:i,pieces:[{triangleIndex:42,a:[0,0,0],b:[1,0,0]}]})
function setup(spans,failAfterCorrection=false){
 const retries=[],nodes=Array.from({length:8},(_,i)=>({point:[i,0,0]})),original=structuredClone(nodes)
 const fn=new Function('buildTrimSurfaceSplineSegments','buildTrimBoundaryPlan','trimVec',body+';return buildValidatedTrimSurfaceBoundary')((context,controls,closed,count,direct)=>{assert.deepEqual(controls,original);retries.push([...direct]);return spans.map(segment)},()=>{if(retries.length===1||failAfterCorrection)throw Object.assign(Error('crossing'),{triangleIndex:42});return {components:[[1],[2]]}},p=>new THREE.Vector3(...p))
 return {run:()=>fn({},nodes),retries}
}
test('a projection fold only reroutes its adjacent control spans and validates the replacement',()=>{
 const {run,retries}=setup([2,3]);assert.equal(run().plan.components.length,2);assert.deepEqual(retries,[[],[2,3]])
})
test('a genuine crossing of distant control spans is never auto-routed away',()=>{
 const {run,retries}=setup([2,6]);assert.throws(run,/crossing/);assert.equal(retries.length,1)
})
test('a failed local correction stays rejected instead of marking the loop closed',()=>{
 const {run,retries}=setup([2,3],true);assert.throws(run,/crossing/);assert.equal(retries.length,2)
})

test('automatic local routing refuses a replacement that detours farther than the drawn span',()=>{
 let calls=0
 const fn=new Function('buildTrimSurfaceSplineSegments','buildTrimBoundaryPlan','trimVec',body+';return buildValidatedTrimSurfaceBoundary')((context,controls,closed,count,direct)=>{const s=segment(1);if(direct.size)s.pieces[0].b=[3,0,0];return [s]},()=>{calls++;throw Object.assign(Error('crossing'),{triangleIndex:42})},p=>new THREE.Vector3(...p))
 assert.throws(()=>fn({},Array.from({length:4},()=>({point:[0,0,0]}))),/příliš dlouhá/);assert.equal(calls,1)
})
