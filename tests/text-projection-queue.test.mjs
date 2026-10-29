import test from 'node:test'
import assert from 'node:assert/strict'
import {createTextProjectionQueue} from '../app/model-builder/text-projection-queue.mjs'
test('obsolete wrapping results neither render nor commit; only latest release commits',()=>{
 const jobs=[],shown=[],commits=[],queue=createTextProjectionQueue(job=>jobs.push(job),(data,point)=>shown.push(point))
 queue.request('first');queue.request('middle');queue.request('released',data=>commits.push(data.valid));queue.request('released')
 assert.equal(jobs.length,1);queue.receive({id:1,valid:true});assert.equal(jobs.length,2);assert.deepEqual(shown,[]);assert.deepEqual(commits,[])
 queue.receive({id:3,valid:true});assert.deepEqual(shown,['released']);assert.deepEqual(commits,[true])
 queue.request('released',data=>commits.push(data.valid));assert.equal(jobs.length,2);assert.deepEqual(commits,[true,true])
})
test('invalid release remains an explicit invalid proposal and disposed workers cannot commit',()=>{
 const shown=[],commits=[],queue=createTextProjectionQueue(()=>{},(data,point)=>shown.push([point,data.valid]))
 queue.request('invalid',data=>{if(data.valid)commits.push('invalid')});queue.receive({id:1,valid:false})
 assert.deepEqual(shown,[['invalid',false]]);assert.deepEqual(commits,[])
 queue.request('late',()=>commits.push('late'));queue.close();queue.receive({id:2,valid:true});assert.deepEqual(commits,[])
})
