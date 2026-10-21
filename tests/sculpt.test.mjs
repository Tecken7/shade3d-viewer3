import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import {sculptMesh,sculptDab,sculptGeometry} from '../app/model-builder/sculpt.mjs'
import {meshTopology} from '../app/model-builder/engine.mjs'
import {paintedEdgeSelection} from '../app/model-builder/edge-edit.mjs'
function grid(n=12,step=.25){
 const p=[],f=[],colors=[],uv=[]
 for(let y=0;y<=n;y++)for(let x=0;x<=n;x++){p.push((x-n/2)*step,(y-n/2)*step,0);colors.push(.2,.5,.7);uv.push(x/n,y/n)}
 for(let y=0;y<n;y++)for(let x=0;x<n;x++){const a=y*(n+1)+x,b=a+1,c=a+n+1,d=c+1;f.push(a,b,d,a,d,c)}
 return sculptMesh(p,f,colors,uv)
}
const topology=m=>meshTopology(m.vertices,m.faces)
test('add/subtract change only the connected brush footprint and retain colours and UVs',()=>{
 const a=grid(),b=structuredClone(a),original=a.vertices.slice()
 sculptDab(a,[0,0,0],{radius:.6,strength:.5,tool:'add'})
 sculptDab(b,[0,0,0],{radius:.6,strength:.5,tool:'subtract'})
 const center=original.findIndex((v,i)=>i%3===0&&v===0&&original[i+1]===0)
 assert.ok(a.vertices[center+2]>0);assert.ok(b.vertices[center+2]<0)
 for(let i=0;i<original.length;i+=3)if(Math.hypot(original[i],original[i+1])>.6)assert.deepEqual(a.vertices.slice(i,i+3),original.slice(i,i+3))
 assert.deepEqual(a.colors,grid().colors);assert.deepEqual(a.uvs,grid().uvs)
 assert.equal(topology(a).nonManifold,0)
})
test('smooth reduces local noise while keeping the open rim fixed',()=>{
 const m=grid(),center=(6*13+6)*3;m.vertices[center+2]=.25
 const first=m.vertices.slice(0,39)
 sculptDab(m,[0,0,.25],{radius:.8,strength:.8,tool:'smooth'})
 assert.ok(m.vertices[center+2]<.25);assert.deepEqual(m.vertices.slice(0,39),first)
})
test('edge smoothing changes the jagged rim, leaves remote anatomy unchanged and keeps topology',()=>{
 const m=grid();for(let x=1;x<12;x++)m.vertices[x*3+1]+=(x%2)*.12
 const before=m.vertices.slice(),oldTopology=topology(m)
 sculptDab(m,[0,-1.5,0],{radius:.9,strength:.8,tool:'edge'})
 assert.notDeepEqual(m.vertices,before)
 assert.deepEqual(m.vertices.slice(39),before.slice(39))
 assert.equal(topology(m).openEdges,oldTopology.openEdges);assert.equal(topology(m).nonManifold,0)
})
test('constant detail refines locally with shared edges; higher resolution creates finer detail',()=>{
 const m=grid(6,.8),finer=structuredClone(m),before=m.faces.length
 const r=sculptDab(m,[0,0,0],{radius:1.2,strength:.3,tool:'add',dyntopo:true,resolution:3})
 sculptDab(finer,[0,0,0],{radius:1.2,strength:.3,tool:'add',dyntopo:true,resolution:6})
 assert.ok(r.split>0);assert.ok(m.faces.length>before);assert.ok(finer.faces.length>m.faces.length)
 assert.equal(topology(m).loops.length,1);assert.equal(topology(m).nonManifold,0)
 assert.equal(m.colors.length,m.vertices.length);assert.equal(m.uvs.length,m.vertices.length/3*2)
 const exported=sculptGeometry(m);assert.ok(exported.positions instanceof Float32Array);assert.ok(exported.indices instanceof Uint32Array)
})
test('constant detail can safely simplify dense interior edges without closing the boundary',()=>{
 const m=grid(10,.04),before=m.faces.length
 const result=sculptDab(m,[0,0,0],{radius:.3,strength:.2,dyntopo:true,resolution:3})
 assert.ok(result.collapsed>0);assert.ok(m.faces.length<before)
 assert.equal(topology(m).loops.length,1);assert.equal(topology(m).nonManifold,0)
})
test('sculpting never jumps to a nearby disconnected back surface',()=>{
 const m=grid(),n=m.vertices.length/3,original=structuredClone(m)
 m.vertices.push(...original.vertices.map((v,i)=>i%3===2?v-.05:v));m.faces.push(...original.faces.map(i=>i+n));m.colors.push(...original.colors);m.uvs.push(...original.uvs)
 const back=m.vertices.slice(n*3)
 sculptDab(m,[0,0,0],{radius:.6,strength:.8})
 assert.deepEqual(m.vertices.slice(n*3),back)
})
test('brush-painted boundary selection handles the circular seam',()=>{
 const loop={boundary:Array.from({length:20},()=>({}))}
 assert.deepEqual(paintedEdgeSelection([loop],new Set(['0:18','0:19','0:0','0:1'])),[{loop:0,index:18},{loop:0,index:1}])
 assert.deepEqual(paintedEdgeSelection([loop],new Set(['0:2'])),[])
})
test('invalid detail settings cannot modify the mesh',()=>{
 const m=grid(),before=structuredClone(m)
 assert.throws(()=>sculptDab(m,[0,0,0],{resolution:0}),/nastavení/)
 assert.deepEqual(m,before)
})
