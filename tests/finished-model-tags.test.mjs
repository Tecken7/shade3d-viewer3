import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import Module from 'manifold-3d'
import {indexed,meshTopology} from '../app/model-builder/engine.mjs'
import {decorateFinishedModel,contactArea} from '../app/model-builder/finished-model-tags.mjs'
import {readBinarySTL,encodeClosedSTL} from '../scripts/lib/finished-model-stl.mjs'
const M=await Module();M.setup()
const data=name=>JSON.parse(fs.readFileSync(new URL('../public/wasm/model-builder/'+name,import.meta.url)))
const fonts={500:data('inter-500-font.json'),400:data('inter-font.json'),logo:data('arthetic-logo-font.json')}
const outer=M.Manifold.cube([60,16,35],true).translate([0,8,0]),inner=M.Manifold.cube([55,20,30],true).translate([0,5,0]),solid=outer.subtract(inner),mesh=solid.getMesh(),expanded=[]
for(const id of mesh.triVerts)expanded.push(...mesh.vertProperties.slice(id*mesh.numProp,id*mesh.numProp+3))
const converted=indexed(new Float32Array(expanded),{exact:true}),base={positions:Float32Array.from(converted.vertices),indices:Uint32Array.from(converted.faces),placement:{baseY:0,direction:-1},stats:{},holes:[]}
solid.delete();inner.delete();outer.delete()

test('finished hollow models receive an outer Inter tag and an inner mixed-weight logo without rebuilding their base',async()=>{
 const before=base.positions.slice(),result=await decorateFinishedModel(M,base,{logo:true,tags:[{text:'MODEL 04',weight:500}]},fonts)
 assert.equal(result.status,'ready',result.message);assert.deepEqual(base.positions,before)
 assert.equal(result.items.length,2);assert.equal(result.items[1].weight,'ART 800 / HETIC 400')
 assert.ok(Math.abs(result.contactAreaAfter-contactArea(base))<.001)
 for(const label of result.items){const inward=-label.position[0]*label.normal[0]-label.position[2]*label.normal[2];assert.ok(label.side==='inner'?inward>0:inward<0)}
 const topology=meshTopology(Array.from(result.output.positions),Array.from(result.output.indices));assert.equal(topology.openEdges,0);assert.equal(topology.nonManifold,0)
 const exported=encodeClosedSTL(result.output.positions,result.output.indices),roundtrip=indexed(readBinarySTL(exported.bytes),{exact:true}),check=meshTopology(roundtrip.vertices,roundtrip.faces)
 assert.equal(check.openEdges,0);assert.equal(check.nonManifold,0)
})
test('failed automatic fitting requests manual placement and leaves the complete input untouched',async()=>{
 const positions=base.positions.slice(),result=await decorateFinishedModel(M,base,{logo:true,tags:[{text:'W'.repeat(60),size:12,weight:500}]},fonts)
 assert.equal(result.status,'needs-placement');assert.equal(result.output,null);assert.deepEqual(base.positions,positions)
})
test('disabled logo with no tags is an unchanged pass-through',async()=>{
 const result=await decorateFinishedModel(M,base,{logo:false,tags:[]},fonts)
 assert.equal(result.output,base);assert.equal(result.items.length,0);assert.equal(result.contactAreaBefore,result.contactAreaAfter)
})
test('invalid STL bytes and unsupported text are rejected before exporting',async()=>{
 assert.throws(()=>readBinarySTL(Buffer.alloc(10)))
 await assert.rejects(()=>decorateFinishedModel(M,base,{tags:[{text:'TEST 🦷',weight:500}]},fonts),/nepodporuje/)
})

test('several tags reserve their footprint and can coexist with the interior logo',async()=>{
 const result=await decorateFinishedModel(M,base,{logo:true,tags:[{text:'MODEL 04',weight:500},{text:'CASE A',weight:400,size:3}]},fonts)
 assert.equal(result.status,'ready',result.message);assert.equal(result.items.length,3)
 const unique=new Set(result.items.map(label=>JSON.stringify(label.position)));assert.equal(unique.size,3)
 assert.ok(Math.abs(result.contactAreaBefore-result.contactAreaAfter)<.001)
})
