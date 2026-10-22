import test from 'node:test'
import assert from 'node:assert/strict'
import {buildTrimRegions} from '../app/model-builder/trim-regions.mjs'

function cornerCut(points){
 const context={triangles:[{corners:[[0,0,0],[1,0,0],[0,1,0]].map(sourcePos=>({sourcePos})),edgeKeys:['a','b','c']}],edgeTriangles:new Map([['a',[0,1]],['b',[0,2]],['c',[0,1]]])}
 const plan={piecesByTriangle:new Map([[0,points.slice(1).map((b,i)=>({a:points[i],b}))]]),componentIds:[-2,1,1]}
 return {context,plan}
}

test('a trim chain following the perimeter through a corner has no phantom region',()=>{
 const {context,plan}=cornerCut([[.5,0,0],[0,0,0],[0,.00003,0]])
 const records=buildTrimRegions(context,plan).get(0)
 assert.equal(records.length,1)
 assert.equal(records[0].component,1)
 const area=records[0].polygon.reduce((sum,a,i,p)=>{const b=p[(i+1)%p.length];return sum+a[0]*b[1]-b[0]*a[1]},0)/2
 assert.ok(Math.abs(area-.5)<1e-14)
})

test('a genuinely small corner fragment is retained instead of being removed by an area threshold',()=>{
 const {context,plan}=cornerCut([[.00003,0,0],[0,.00003,0]])
 const records=buildTrimRegions(context,plan).get(0)
 assert.equal(records.length,2)
 assert.deepEqual(records.map(r=>r.component).sort(),[1,1])
})

test('a real unconnected region still reports the topology error',()=>{
 const {context,plan}=cornerCut([[.5,0,0],[0,.5,0]])
 context.edgeTriangles=new Map()
 assert.throws(()=>buildTrimRegions(context,plan),/Část ořezu nemá návaznost/)
})

