import test from 'node:test'
import assert from 'node:assert/strict'
import {createTextPreviewCache,createTextFrameQueue} from '../app/model-builder/text-preview-cache.mjs'

test('validation, rendering and last-valid fallback share one wrap per placement',()=>{
 let calls=0,disposed=0
 const cache=createTextPreviewCache(()=>{calls++;return {valid:true,geometry:{dispose(){disposed++}}}})
 const a={position:[0,0,10],normal:[0,0,1]},b={position:[1,0,9.95],normal:[.1,0,.995]}
 const validation=cache.get(a),render=cache.get(structuredClone(a))
 assert.equal(validation,render);assert.equal(calls,1);assert.equal(disposed,0)
 cache.get(b);assert.equal(cache.get(a),render);assert.equal(calls,2)
 cache.dispose();cache.dispose();assert.equal(disposed,2)
})

test('projection cache releases old geometry and parameter changes cannot reuse stale results',()=>{
 let disposed=0
 const create=()=>createTextPreviewCache(()=>({geometry:{dispose(){disposed++}}}),2)
 const cache=create(),point=x=>({position:[x,0,0],normal:[0,0,1]})
 const old=cache.get(point(0));cache.get(point(1));cache.get(point(2))
 assert.equal(disposed,1)
 cache.dispose();assert.equal(disposed,3)
 const changed=create();assert.notEqual(changed.get(point(0)),old);changed.dispose();assert.equal(disposed,4)
})

test('fast movements project only the latest point and release flushes the final position once',()=>{
 const callbacks=new Map(),applied=[];let sequence=0
 const queue=createTextFrameQueue(p=>applied.push(p),cb=>{callbacks.set(++sequence,cb);return sequence},id=>callbacks.delete(id))
 queue.push('first');queue.push('middle');queue.push('latest')
 assert.equal(callbacks.size,1);assert.deepEqual(applied,[])
 const callback=callbacks.values().next().value;callbacks.clear();callback()
 assert.deepEqual(applied,['latest'])
 queue.push('released');queue.flush();queue.flush()
 assert.deepEqual(applied,['latest','released']);assert.equal(callbacks.size,0)
 queue.push('outside surface');queue.clear();assert.equal(callbacks.size,0)
 assert.deepEqual(applied,['latest','released'])
})
