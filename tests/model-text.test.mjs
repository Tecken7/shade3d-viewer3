import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import Module from 'manifold-3d'
import * as THREE from 'three'
import {buildModel,applyModelText,meshTopology} from '../app/model-builder/engine.mjs'
import {DEFAULTS} from '../app/model-builder/defaults.mjs'
import {builderTextSignature} from '../app/model-builder/builder-workflow.mjs'
import {textPreviewTransform} from '../app/model-builder/text-preview-motion.mjs'

const M=await Module();M.setup()
const font=JSON.parse(fs.readFileSync(new URL('../public/wasm/model-builder/inter-font.json',import.meta.url)))
const contour=[[-20,-15],[-8,-15],[-8,4],[-5,9],[5,9],[8,4],[8,-15],[20,-15],[20,6],[13,18],[-13,18],[-20,6]].map(p=>new THREE.Vector2(...p)),scan=[]
for(const triangle of THREE.ShapeUtils.triangulateShape(contour,[])){
 const vertices=triangle.map(i=>[contour[i].x,0,contour[i].y]),[a,b,c]=vertices.map(p=>new THREE.Vector3(...p))
 if(b.sub(a).cross(c.sub(a)).y>0)vertices.reverse();scan.push(...vertices.flat())
}
let base
const getBase=async()=>base??=(await buildModel(M,new Float32Array(scan),{arch:'upper',totalHeight:25,smoothing:0,hollow:true,cutHoles:true},font))
const label={text:'Žluť',textSize:4,textDepth:.5,textMode:'emboss',textPosition:[-20,12,0],textNormal:[-1,0,0],baseDirection:1}

test('Inter includes Czech glyphs and model labels default to 4 mm',()=>{
 assert.equal(DEFAULTS.textSize,4);assert.equal(font.familyName,'Inter')
 assert.ok([...'Příliš žluťoučký kůň'].every(c=>font.glyphs[c]))
})
test('label-only edits preserve the prepared hollow base and drainage without rebuilding either',async()=>{
 const base=await getBase(),before=base.positions.slice(),messages=[]
 const kernel={...M,Manifold:new Proxy(M.Manifold,{get(target,key){if(['levelSet','cylinder'].includes(key))throw Error('Base reconstruction attempted');return Reflect.get(target,key)}})}
 const result=await applyModelText(kernel,base,label,font,message=>messages.push(message))
 assert.ok(result.stats.volume>base.stats.volume)
 assert.deepEqual(base.positions,before);assert.deepEqual(result.holes,base.holes);assert.deepEqual(result.placement,base.placement)
 assert.ok(!messages.some(message=>/dutinu|otvor|bázi/.test(message)))
 const check=meshTopology(Array.from(result.positions),Array.from(result.indices));assert.equal(check.openEdges,0);assert.equal(check.nonManifold,0)
 const updated=await applyModelText(kernel,base,{...label,text:'A'},font)
 assert.ok(updated.stats.volume<result.stats.volume,'replacing a label starts from the clean base, with no old letters accumulated')
 const removed=await applyModelText(kernel,base,{...label,text:''},font)
 assert.deepEqual(removed.positions,base.positions);assert.deepEqual(removed.indices,base.indices)
})
test('a cached label can only be reused for identical content, dimensions and placement',()=>{
 const signature=builderTextSignature(label)
 assert.equal(builderTextSignature(structuredClone(label)),signature)
 for(const patch of [{text:'A'},{textSize:5},{textPosition:[-20,13,0]},{textMode:'engrave'}])assert.notEqual(builderTextSignature({...label,...patch}),signature)
})
test('fast text motion carries the anchor and normal while preserving all letter distances',()=>{
 const origin={position:[1,2,3],normal:[0,0,1]},target={position:[8,4,5],normal:[1,0,0]},matrix=textPreviewTransform(origin,target)
 const anchor=new THREE.Vector3(...origin.position).applyMatrix4(matrix)
 assert.ok(anchor.distanceTo(new THREE.Vector3(...target.position))<1e-10)
 assert.ok(new THREE.Vector3(...origin.normal).transformDirection(matrix).distanceTo(new THREE.Vector3(...target.normal))<1e-10)
 const a=new THREE.Vector3(2,2,3),b=new THREE.Vector3(4,5,3),distance=a.distanceTo(b)
 assert.ok(Math.abs(a.applyMatrix4(matrix).distanceTo(b.applyMatrix4(matrix))-distance)<1e-10)
})
